// Verify every model in FREE_IMAGE_MODELS is really served by the anonymous
// image.pollinations.ai endpoint.
//
//   node scripts/check-free-models.js
//
// Why this exists: that endpoint never errors on a model it cannot serve. It
// silently generates with whatever it does have and returns HTTP 200, so an
// entry that stops working degrades invisibly — the picker keeps offering it
// while every generation quietly returns something else. Several entries in
// the original list were dead this way for months.
//
// The check reads the `x-model-used` response header, which reports the model
// actually used. Do not try to detect this by comparing image bytes between
// models: the endpoint caches on prompt+size+seed and ignores the model, so
// two models can return byte-identical cached images, and a stale entry can
// look "distinct" long after that model stopped being served.
//
// Each request uses a unique prompt so it is a cache miss and the header
// describes a fresh generation. Generations are slow; allow a few minutes.
//
// No API key involved — this checks the unauthenticated path on purpose.
const fs = require('fs');
const path = require('path');

const BASE = 'https://image.pollinations.ai';
const SIZE = 256;
const SEED = 9;
const TIMEOUT_MS = 180000;

// Read the list out of server.js rather than duplicating it — a copy here
// would drift, which is the exact failure this script exists to catch.
function readFreeModels() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const block = src.match(/const FREE_IMAGE_MODELS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find FREE_IMAGE_MODELS in server.js');
  const models = [...block[1].matchAll(/id:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'/g)]
    .map(m => ({ id: m[1], name: m[2] }));
  if (!models.length) throw new Error('FREE_IMAGE_MODELS parsed as empty');
  return models;
}

async function probe(model, nonce) {
  // Unique prompt per probe so the response is a fresh generation, not a
  // cached image produced by some other model.
  const prompt = `free model check ${nonce} ${model}`;
  const url = `${BASE}/prompt/${encodeURIComponent(prompt)}`
    + `?width=${SIZE}&height=${SIZE}&nologo=true`
    + `&model=${encodeURIComponent(model)}&seed=${SEED}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return {
    status: res.status,
    used: res.headers.get('x-model-used'),
    cache: res.headers.get('x-cache'),
    type: (res.headers.get('content-type') || '').split(';')[0],
  };
}

async function main() {
  const models = readFreeModels();
  const nonce = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  console.log(`checking ${models.length} free models against ${BASE}`);
  console.log('reading x-model-used on a fresh (uncached) generation each\n');

  const failures = [];
  for (const m of models) {
    let r;
    try {
      r = await probe(m.id, nonce);
    } catch (err) {
      console.log(`  ${m.id.padEnd(14)} request failed: ${err.message}`);
      failures.push(`${m.id}: request failed (${err.message})`);
      continue;
    }

    const used = r.used || '<no header>';
    console.log(`  ${m.id.padEnd(14)} status=${r.status} x-model-used=${used}${r.cache ? ` x-cache=${r.cache}` : ''}`);

    if (r.status !== 200) {
      failures.push(`${m.id}: HTTP ${r.status}`);
    } else if (!r.used) {
      // Without the header there is no reliable way to tell what ran, and
      // byte comparison is not a valid substitute (see the note up top).
      failures.push(`${m.id}: no x-model-used header — cannot verify`);
    } else if (r.used.toLowerCase() !== m.id.toLowerCase()) {
      failures.push(`${m.id}: served by "${r.used}" instead — not actually free`);
    }
  }

  if (failures.length) {
    console.log('\nFAIL');
    failures.forEach(f => console.log(`  - ${f}`));
    console.log('\nAn entry served by a different model should come out of');
    console.log('FREE_IMAGE_MODELS in server.js. Leaving it there means the picker');
    console.log('offers it, and logged-in users are pinned to the free endpoint for');
    console.log('it too — so they get the substitute instead of the real model.');
    process.exit(1);
  }
  console.log(`\nPASS — all ${models.length} free models are genuinely served`);
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
