// Smoke-test the sketch-description path end to end against the real API.
//
//   node scripts/test-vision.js            # uses assets/icon-source.png
//   node scripts/test-vision.js my-sketch.png
//
// Reads POLLINATIONS_API_KEY from .env. Prints the model picked, the raw reply,
// and the parsed description/filename. Never prints the key.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE = 'https://gen.pollinations.ai';
const PREFERENCE = ['openai', 'gemini', 'claude'];
const IMG = process.argv[2] || 'assets/icon-source.png';

const auth = () => (process.env.POLLINATIONS_API_KEY
  ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` }
  : {});

async function main() {
  console.log('key present:', Boolean(process.env.POLLINATIONS_API_KEY));

  const listRes = await fetch(`${BASE}/v1/models`, { headers: auth() });
  console.log('model list status:', listRes.status);
  const models = (await listRes.json()).data || [];

  const vision = models.filter(m =>
    (m.input_modalities || []).includes('image') && (m.output_modalities || []).includes('text'));
  console.log(`models: ${models.length}, vision-capable: ${vision.length}`);
  vision.forEach(m => console.log(`  ${m.id}`));

  const ids = vision.map(m => m.id);
  const model = process.env.POLLINATIONS_TEXT_MODEL || PREFERENCE.find(id => ids.includes(id)) || ids[0];
  if (!model) {
    console.error('FAIL: no vision-capable model available for this key');
    process.exit(1);
  }

  const b64 = fs.readFileSync(path.resolve(IMG)).toString('base64');
  const mime = /\.jpe?g$/i.test(IMG) ? 'image/jpeg' : 'image/png';
  console.log(`payload: ${IMG} (${Math.round(b64.length / 1024)}KB base64), model: ${model}`);

  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth() },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `This is a child's hand-drawn sketch of a jewelry piece.
Describe what type of jewelry it is and its key design features in 2-3 sentences.
Focus on the shape, any gems or stones, and the overall style.
Reply with valid JSON only, no markdown, in this exact shape:
{"description": "<the description>", "filename": "<2-4 words, hyphen-separated, lowercase>"}`,
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
    }),
  });

  const body = await res.text();
  console.log(`status: ${res.status} in ${Date.now() - started}ms`);

  if (res.status === 402) {
    console.error('FAIL: pollen balance empty. Claim the tier grant or top up at enter.pollinations.ai');
    console.error(body.slice(0, 300));
    process.exit(1);
  }
  if (!res.ok) {
    console.error('FAIL:', body.slice(0, 400));
    process.exit(1);
  }

  const json = JSON.parse(body);
  console.log('usage:', JSON.stringify(json.usage || {}));
  const content = json.choices?.[0]?.message?.content ?? '';
  console.log('--- raw reply ---');
  console.log(content);

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    console.error('FAIL: reply contains no JSON object');
    process.exit(1);
  }
  const parsed = JSON.parse(content.slice(start, end + 1));
  console.log('--- parsed ---');
  console.log('description:', parsed.description);
  console.log('filename:', parsed.filename);
  console.log(parsed.description && parsed.filename ? 'PASS' : 'FAIL: missing field');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
