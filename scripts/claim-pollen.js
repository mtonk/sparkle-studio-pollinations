// Complete the Pollinations onboarding tasks that are just "make one request",
// each worth 0.25 pollen, using the cheapest model in each category.
//
//   node scripts/claim-pollen.js          # run both
//   node scripts/claim-pollen.js image    # just the image task
//   node scripts/claim-pollen.js audio    # just the audio task
//
// Costs: image ~0.0001 pollen (sana), audio ~0.00005 pollen (universal-2 on a
// ~1s clip). Both rewards are 0.25, so each run nets ~+0.25.
//
// The "Use a Pollinations app" task can't be scripted — it needs you to log in
// to a third-party app in their directory with your account.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = 'https://gen.pollinations.ai';
const KEY = process.env.POLLINATIONS_API_KEY;
const IMAGE_MODEL = 'sana';        // 0.0001 pollen/image, cheapest of 31
const AUDIO_MODEL = 'universal-2'; // 0.0000417 pollen/audio second, cheapest of 3

if (!KEY) {
  console.error('POLLINATIONS_API_KEY missing from .env — the reward only lands if the request is authenticated.');
  process.exit(1);
}

async function claimImage() {
  console.log(`\n[image] ${IMAGE_MODEL}, 256x256, minimal prompt`);
  const res = await fetch(`${BASE}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: 'a small silver ring', size: '256x256', n: 1 }),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`[image] FAIL ${res.status}: ${body.slice(0, 300)}`);
    return false;
  }

  // Response is JSON with a url or b64_json; either counts as a successful request.
  let shape = 'unknown';
  try {
    const json = JSON.parse(body);
    const first = json.data?.[0] || {};
    shape = first.b64_json ? `b64_json (${Math.round(first.b64_json.length / 1024)}KB)` : first.url ? 'url' : Object.keys(first).join(',');
  } catch {
    shape = `${Math.round(body.length / 1024)}KB non-JSON`;
  }
  console.log(`[image] OK ${res.status} — ${shape}`);
  return true;
}

// macOS `say` gives us a tiny real speech clip; shorter clip = lower cost.
function makeClip() {
  const wav = path.join(os.tmpdir(), 'pollen-clip.wav');
  execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', 'sparkle']);
  const bytes = fs.statSync(wav).size;
  const seconds = (bytes - 44) / (16000 * 2);
  console.log(`\n[audio] ${AUDIO_MODEL}, ${seconds.toFixed(2)}s clip (${bytes}b)`);
  return wav;
}

async function claimAudio() {
  const wav = makeClip();
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', AUDIO_MODEL);
  form.append('response_format', 'json');

  const res = await fetch(`${BASE}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` }, // no Content-Type: fetch sets the multipart boundary
    body: form,
    signal: AbortSignal.timeout(120000),
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`[audio] FAIL ${res.status}: ${body.slice(0, 300)}`);
    return false;
  }

  let text = body.slice(0, 200);
  try { text = JSON.parse(body).text ?? text; } catch {}
  console.log(`[audio] OK ${res.status} — transcript: ${JSON.stringify(text)}`);
  return true;
}

(async () => {
  const which = process.argv[2];
  const results = [];
  if (!which || which === 'image') results.push(['image', await claimImage()]);
  if (!which || which === 'audio') results.push(['audio', await claimAudio()]);

  console.log('\n--- summary ---');
  results.forEach(([name, ok]) => console.log(`${name}: ${ok ? 'PASS — task should show complete' : 'FAIL'}`));
  console.log('Check the balance and checklist at enter.pollinations.ai.');
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})();
