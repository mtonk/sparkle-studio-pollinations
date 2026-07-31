require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '5mb' }));

// Never ship a hard-coded session secret in a public repo — cookies signed with
// a known secret can be forged. Use SESSION_SECRET when set; otherwise fall back
// to a random per-process secret so local dev still works (sessions reset on
// restart) and warn loudly.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    'WARNING: SESSION_SECRET is not set. Using a random secret — all sessions ' +
    'reset on restart. Set SESSION_SECRET in .env before deploying.'
  );
}

// Behind a TLS-terminating proxy in production, trust it and mark cookies secure.
if (isProd) app.set('trust proxy', 1);

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 24 * 60 * 60 * 1000 },
}));

app.use('/icons', express.static('public/icons'));
app.get('/manifest.json', (req, res) => res.sendFile('manifest.json', { root: 'public' }));

if (process.env.APP_PASSWORD) {
  const expected = Buffer.from(process.env.APP_PASSWORD);
  app.use((req, res, next) => {
    const deny = () => res.set('WWW-Authenticate', 'Basic realm="Sparkle Studio"').sendStatus(401);
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Basic ')) return deny();
    const [, , pass] = Buffer.from(auth.slice(6), 'base64').toString().match(/^([^:]*):(.*)$/) || [];
    const given = Buffer.from(pass ?? '');
    // Constant-time comparison so response timing doesn't leak the password.
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return deny();
    next();
  });
}

app.use(express.static('public'));

// --- Rate limiting ---
//
// Protects the API from abuse (e.g. someone scripting the generation endpoints).
// Static assets, icons, and the manifest are served above and stay unthrottled.
// Keys off the client IP; in production `trust proxy` (set above) makes that the
// real client rather than the load balancer.

// Broad cap across all /api endpoints.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Whoa, slow down a little! Please wait a bit and try again.' },
});

// Tighter cap on the expensive endpoints (image generation + vision), which
// each cost compute and potentially pollen.
const generateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "You're making sparkles super fast! Take a short break and try again in a minute." },
});

app.use('/api', apiLimiter);
app.use(['/api/generate', '/api/resolve-prompt'], generateLimiter);

// --- Pollinations helpers ---

const GEN_BASE = 'https://gen.pollinations.ai';
const IMAGE_FREE_BASE = 'https://image.pollinations.ai';
const POLLINATIONS_TIMEOUT_MS = Number(process.env.POLLINATIONS_TIMEOUT_MS || 45000);

function pollinationsAuth(apiKey) {
  if (apiKey) return { Authorization: `Bearer ${apiKey}` };
  if (process.env.POLLINATIONS_API_KEY) return { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` };
  return {};
}

function pollinationsVisionModel() {
  return process.env.POLLINATIONS_TEXT_MODEL || 'openai';
}

function toChatMessages(promptParts) {
  const parts = Array.isArray(promptParts) ? promptParts : [{ text: promptParts }];
  return [{
    role: 'user',
    content: parts.map(p => p.inlineData
      ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }
      : { type: 'text', text: p.text }),
  }];
}

async function pollinationsText(promptParts, apiKey) {
  const model = pollinationsVisionModel();
  const body = JSON.stringify({ model, messages: toChatMessages(promptParts), max_tokens: 400 });
  const started = Date.now();
  console.log(`Pollinations ${model}: sending ${Math.round(body.length / 1024)}KB`);

  let res;
  try {
    res = await fetch(`${GEN_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...pollinationsAuth(apiKey) },
      body,
      signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Pollinations ${model} failed after ${Date.now() - started}ms: ${err.message}`);
  }

  console.log(`Pollinations ${model}: ${res.status} in ${Date.now() - started}ms`);

  if (res.status === 402) {
    throw userError("You're out of pollen! Top up your Pollinations account at enter.pollinations.ai, then try again.", 402);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Internal detail — logged server-side, never shown to the user.
    throw Object.assign(new Error(`Pollinations text failed (${res.status}): ${body.slice(0, 500)}`), { status: res.status });
  }

  const choice = (await res.json()).choices?.[0];
  const text = choice?.message?.content;
  if (!text) {
    throw new Error(`Pollinations ${model} returned no content (finish_reason: ${choice?.finish_reason})`);
  }
  return text;
}

// --- Prompt resolution ---

const JSON_REPLY_INSTRUCTION = `Reply with valid JSON only, no markdown, in this exact shape:
{"description": "<the description>", "filename": "<2-4 words, hyphen-separated, lowercase, no extension, e.g. pearl-drop-earrings>"}`;

function sanitizeFilename(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-').slice(0, 60);
}

function slugFromDescription(description) {
  return sanitizeFilename((description || '').split(/\s+/).slice(0, 4).join('-')) || 'sparkle-jewelry';
}

function parseDescriptionAndFilename(raw) {
  try {
    const text = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { description: '', filename: '' };
    const json = JSON.parse(text.slice(start, end + 1));
    return { description: String(json.description || '').trim(), filename: sanitizeFilename(json.filename) };
  } catch {
    return { description: '', filename: '' };
  }
}

function hasVisionKey(apiKey) {
  return !!apiKey;
}

async function resolvePrompt(sketchBase64, description, apiKey) {
  let finalDescription = description;
  let filename = '';

  if (sketchBase64 && hasVisionKey(apiKey)) {
    try {
      const base64Data = sketchBase64.replace(/^data:image\/\w+;base64,/, '');
      const parts = description
        ? [
            {
              text: `A child is designing a piece of jewelry. You are given their hand-drawn sketch and their written description.
            The two may disagree: the sketch may have been updated, and the description may mix deliberate edits with leftover text about an older sketch.
            Write one updated description of the jewelry in 2-3 sentences, specific enough that an artist could recreate it.
            The written text wins for colors, materials, and explicit wishes.
            The sketch wins for the overall shape, layout, and number of elements.
            If the text contains instructions (like "make it more purple"), apply them.
            Written description: "${description}"
            ${JSON_REPLY_INSTRUCTION}`,
            },
            { inlineData: { mimeType: 'image/png', data: base64Data } },
          ]
        : [
            {
              text: `This is a child's hand-drawn sketch of a jewelry piece.
            Describe what type of jewelry it is and its key design features in 2-3 sentences.
            Focus on the shape, any gems or stones, and the overall style.
            Be specific enough that an artist could recreate it.
            ${JSON_REPLY_INSTRUCTION}`,
            },
            { inlineData: { mimeType: 'image/png', data: base64Data } },
          ];
      const raw = await pollinationsText(parts, apiKey);
      const parsed = parseDescriptionAndFilename(raw);
      finalDescription = parsed.description || raw.trim();
      filename = parsed.filename;
      console.log(description ? 'Merged description:' : 'Sketch description:', finalDescription);
    } catch (err) {
      console.log('Vision model failed, falling back to text:', err.message);
    }
  } else if (sketchBase64 && !hasVisionKey(apiKey)) {
    console.log('No vision key available — using text description only');
  }

  if (!finalDescription && sketchBase64 && !description?.trim()) {
    throw userError(
      'To turn a drawing into jewelry, add a short description or log in with Pollinations.'
    );
  }

  if (!filename) filename = slugFromDescription(finalDescription || description);

  const imagePrompt = `Professional jewelry photography, studio lighting, pure white background. ` +
    `${finalDescription || description} ` +
    `Photorealistic render, sparkly gemstones, highly polished metal, sharp focus, high resolution.`;

  return { prompt: imagePrompt, description: finalDescription || description, filename };
}

// --- Image generation ---

// Models the anonymous image.pollinations.ai endpoint actually serves, which
// is only sana — it accepts any model name and silently generates with sana
// anyway, so entries here must be verified, not assumed. Run
// `node scripts/check-free-models.js` to re-check.
//
// Listing a model here also pins it to the free endpoint when a key is
// present, so anything added wrongly costs logged-in users the real model.
const FREE_IMAGE_MODELS = [
  { id: 'sana', name: 'Sana Sprint 1.6B', tier: 'free' },
];

async function generateFreeImage(prompt, model, filename) {
  const modelParam = model || 'flux';
  const seed = Math.floor(Math.random() * 999999);
  const url = `${IMAGE_FREE_BASE}/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=${encodeURIComponent(modelParam)}&seed=${seed}`;
  console.log(`Generating via free Pollinations (model: ${modelParam})`);
  const response = await fetch(url, { signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Free Pollinations image failed: ${response.status} ${text}`);
  }
  const contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const imageBuffer = await response.arrayBuffer();
  return `data:${contentType};base64,${Buffer.from(imageBuffer).toString('base64')}`;
}

function mimeFromBase64(b64) {
  const head = b64.trim().slice(0, 20);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png';
}

async function generateAuthenticatedImage(prompt, model, apiKey, filename) {
  const modelId = model || 'flux';
  console.log(`Generating via authenticated Pollinations (model: ${modelId})`);

  const body = {
    model: modelId,
    prompt,
    n: 1,
    response_format: 'b64_json',
  };

  const res = await fetch(`${GEN_BASE}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...pollinationsAuth(apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS),
  });

  if (res.status === 402) {
    throw userError("You're out of pollen! Top up your Pollinations account at enter.pollinations.ai, then try again.", 402);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Internal detail — logged server-side, never shown to the user.
    throw new Error(`Pollinations image generation failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned from Pollinations');

  return `data:${mimeFromBase64(b64)};base64,${b64}`;
}

// --- Error handling ---
//
// Errors we deliberately want the user to read are created with userError() and
// carry `expose: true`. Everything else (upstream failures, bugs) is logged in
// full on the server and the client gets a friendly, generic message — so we
// never leak status codes or upstream response bodies into the UI.

function userError(message, status = 400) {
  return Object.assign(new Error(message), { expose: true, status });
}

function sendError(res, err, context) {
  const status = Number(err.status) || 500;
  // Full detail (message + stack) stays server-side for debugging.
  console.error(`[${context}]`, err.stack || err.message);
  const message = err.expose
    ? err.message
    : 'Oops — the sparkle machine hiccupped. Please try again in a moment!';
  res.status(status).json({ error: message });
}

// --- Session & Auth ---

function sessionKey(req) {
  return req.session?.apiKey || '';
}

// POST /api/session — store the BYOP key from the OAuth callback
app.post('/api/session', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  req.session.apiKey = apiKey;
  req.session.user = null;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed' });
    res.json({ ok: true });
  });
});

// GET /api/session — return the current login state + cached user
app.get('/api/session', async (req, res) => {
  const key = sessionKey(req);
  if (!key) return res.json({ loggedIn: false });

  if (req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }

  try {
    const r = await fetch('https://enter.pollinations.ai/api/device/userinfo', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.json({ loggedIn: true, user: { preferred_username: 'BYOP' } });
    const user = await r.json();
    req.session.user = user;
    res.json({ loggedIn: true, user });
  } catch {
    res.json({ loggedIn: true, user: { preferred_username: 'BYOP' } });
  }
});

// DELETE /api/session — logout
app.delete('/api/session', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /auth/callback — fragment-capture page for the OAuth redirect
app.get('/auth/callback', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Signing in...</title></head><body><script>
(function(){var h=location.hash;if(!h||!h.includes('api_key=')){location.href='/';return}
var p=new URLSearchParams(h.slice(1)),k=p.get('api_key'),s=p.get('state'),ss
try{ss=sessionStorage.getItem('byop-state');sessionStorage.removeItem('byop-state')}catch(e){}
if(s&&ss&&s!==ss){location.href='/';return}
if(p.get('error')==='access_denied'){location.href='/';return}
if(!k){location.href='/';return}
fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:k})})
.then(function(){location.href='/'}).catch(function(){location.href='/'})
})();
</script></body></html>`);
});

// --- Routes ---

// GET /api/models
// Returns available image models. If a session has an apiKey, also fetches
// premium models the key can access.
app.get('/api/models', async (req, res) => {
  const apiKey = sessionKey(req);

  if (apiKey) {
    try {
      const r = await fetch(`${GEN_BASE}/image/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`Models fetch failed: ${r.status}`);
      const all = await r.json();
      const authModels = (all || [])
        // Community models are user-published and unvetted — skip them.
        .filter(m => !m.community)
        // The picker drives image generation only; the endpoint also lists video models.
        .filter(m => (m.output_modalities || []).includes('image'))
        .filter(m => (m.input_modalities || []).includes('text'))
        .map(m => ({
          id: m.name,
          name: m.title || m.name,
          tier: 'premium',
        }));
      const merged = [...FREE_IMAGE_MODELS, ...authModels];
      const seen = new Set();
      const unique = [];
      for (const m of merged) {
        if (!seen.has(m.id)) { seen.add(m.id); unique.push(m); }
      }
      unique.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return res.json({ models: unique, authenticated: true });
    } catch (err) {
      console.error('[models] failed to fetch authenticated models:', err.stack || err.message);
      const sortedFree = [...FREE_IMAGE_MODELS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return res.json({ models: sortedFree, authenticated: false, error: 'Could not load premium models — showing free models.' });
    }
  }

  const sortedFree = [...FREE_IMAGE_MODELS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  res.json({ models: sortedFree, authenticated: false });
});

// POST /api/resolve-prompt
// Returns { prompt, description, filename } for image generation.
app.post('/api/resolve-prompt', async (req, res) => {
  const { imageData, description } = req.body;
  const apiKey = sessionKey(req);

  if (!imageData && !description?.trim()) {
    return res.status(400).json({ error: 'Please draw something or describe your jewelry' });
  }

  try {
    const result = await resolvePrompt(imageData, description?.trim(), apiKey);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'resolve-prompt');
  }
});

// POST /api/generate
app.post('/api/generate', async (req, res) => {
  const { imageData, description, model, prompt, filename } = req.body;
  const apiKey = sessionKey(req);

  if (!description?.trim() && !prompt && !imageData) {
    return res.status(400).json({ error: 'Please draw something or describe your jewelry' });
  }

  try {
    let finalPrompt = prompt;
    let finalDescription = description;
    let finalFilename = sanitizeFilename(filename);

    if (!finalPrompt) {
      if (imageData) {
        const resolved = await resolvePrompt(imageData, description?.trim(), apiKey);
        finalDescription = resolved.description;
        finalPrompt = resolved.prompt;
        finalFilename = finalFilename || resolved.filename;
      } else {
        finalPrompt = `Professional jewelry photography, studio lighting, pure white background. ` +
          `${description} ` +
          `Photorealistic render, sparkly gemstones, highly polished metal, sharp focus, high resolution.`;
        finalFilename = finalFilename || slugFromDescription(description);
      }
    }

    let imageUrl;
    const isFreeModel = FREE_IMAGE_MODELS.some(m => m.id === model);
    if (apiKey && !isFreeModel) {
      imageUrl = await generateAuthenticatedImage(finalPrompt, model, apiKey, finalFilename);
    } else {
      imageUrl = await generateFreeImage(finalPrompt, model, finalFilename);
    }

    if (!finalFilename) finalFilename = slugFromDescription(finalDescription || description);

    res.json({ imageUrl, description: finalDescription || description, filename: finalFilename });
  } catch (err) {
    sendError(res, err, 'generate');
  }
});

// --- Reference image search (unchanged from original) ---

const USER_AGENT = 'SparkleStudio/0.1 (kids jewelry drawing app)';
const SEARCH_LIMIT = 12;

async function searchOpenverse(query) {
  const params = new URLSearchParams({ q: query, page_size: String(SEARCH_LIMIT), mature: 'false' });
  const res = await fetch(`https://api.openverse.org/v1/images/?${params}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  return ((await res.json()).results || [])
    .filter(r => r.thumbnail && r.url)
    .map(r => ({ thumb: r.thumbnail, full: r.url, credit: r.creator || 'Openverse' }));
}

async function searchCommons(query) {
  const scoped = /jewel/i.test(query) ? query : `${query} jewelry`;
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `${scoped} filetype:bitmap`, gsrnamespace: '6',
    gsrlimit: String(SEARCH_LIMIT), prop: 'imageinfo',
    iiprop: 'url|extmetadata', iiurlwidth: '300',
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Commons ${res.status}`);
  return Object.values((await res.json()).query?.pages || {})
    .map(page => {
      const info = (page.imageinfo || [])[0];
      if (!info?.thumburl) return null;
      const artist = (info.extmetadata?.Artist?.value || '').replace(/<[^>]*>/g, '').trim();
      return { thumb: info.thumburl, full: info.url, credit: artist || 'Wikimedia Commons' };
    })
    .filter(Boolean);
}

app.get('/api/search', async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: 'Query required' });
  for (const source of [searchOpenverse, searchCommons]) {
    try {
      const images = await source(q);
      console.log(`Search "${q}" via ${source.name}: ${images.length} results`);
      if (images.length) return res.json(images);
    } catch (err) {
      console.log(`Search "${q}" via ${source.name} failed: ${err.message}`);
    }
  }
  res.json([]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sparkle Studio (Pollinations) running at http://localhost:${PORT}`);
});
