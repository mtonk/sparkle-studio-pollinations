# ✨ Sparkle Studio

**Draw jewelry, then make it sparkle.** A playful web app for kids: sketch a
piece of jewelry (or just describe it), and an AI turns it into a polished,
photorealistic render. Powered entirely by [Pollinations.ai](https://pollinations.ai).

<!-- Add a screenshot or GIF here -->

## What it does

- **Draw** on a canvas with pencil, shapes (circle, rectangle, heart), eraser,
  fill, undo/redo, and a color picker.
- **Find ideas** by searching royalty-free reference images from
  [Openverse](https://openverse.org) and [Wikimedia Commons](https://commons.wikimedia.org).
- **Describe** the piece in words, sketch it, or both — the app reconciles the
  two (text wins for colors/materials, the sketch wins for shape/layout).
- **Generate** a studio-lit, photorealistic jewelry render and download it.
- **Install** as a PWA (has a manifest and icons) for a full-screen app feel.

## How it works

```
Browser (canvas + UI)
   │  POST /api/resolve-prompt   sketch + text  → description + prompt
   │  POST /api/generate         prompt/model   → base64 image
   │  GET  /api/search?q=…       query          → reference images
   ▼
Express server (server.js)  ──►  Pollinations.ai
   • gen.pollinations.ai        (vision + authenticated image generation)
   • image.pollinations.ai      (free image generation)
```

The server is a thin proxy: it builds prompts, calls Pollinations, and never
exposes API keys to the browser. There is no database — sessions are in-memory.

### Two ways to use it

| Mode | How | What you get |
|------|-----|--------------|
| **Free tier** | No login | Text-to-image with a set of free Flux/Turbo models (no key sent to Pollinations). Sketch-to-description (vision) is unavailable. |
| **BYOP (Bring Your Own Pollen)** | Log in via Pollinations OAuth | Your own pollen powers premium models, higher resolution, and sketch understanding (vision). Your key is stored server-side in the session only, never sent to the browser. |

Vision and premium generation always use the logged-in user's own key — the
server never spends a shared key on a visitor's behalf.

## Quick start

Requires **Node.js ≥ 20**.

```bash
git clone https://github.com/mtonk/sparkle-studio-pollinations.git
cd sparkle-studio-pollinations
npm install
cp .env.example .env      # then edit .env (see below)
npm run dev               # or: npm start
```

Open <http://localhost:3000>.

## Configuration

All configuration is via `.env` (copy from `.env.example`). Every value is
optional for local play, but read the notes for production:

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | **Set this in production.** Signs session cookies. If empty, a random secret is generated at startup and sessions reset on every restart. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `POLLINATIONS_API_KEY` | Read only by the helper scripts in `scripts/`, **not** by the web server. The app uses each logged-in user's own (BYOP) key for vision/premium and no key for free generation. |
| `APP_PASSWORD` | If set, the whole app is behind HTTP Basic auth (icons and manifest stay public). |
| `NODE_ENV` | Set to `production` when deployed behind HTTPS — enables `Secure` cookies and trusts your proxy's `X-Forwarded-*` headers. |
| `PORT` | Port to listen on (default `3000`). |
| `POLLINATIONS_TEXT_MODEL` | Vision/text model to use (default `openai`). |
| `POLLINATIONS_TIMEOUT_MS` | Upstream request timeout (default `45000`). |

## Scripts

- `npm start` — run the server.
- `npm run dev` — run with `nodemon` (auto-reload).
- `node scripts/test-vision.js [image.png]` — smoke-test the sketch→description
  path against the live API. Never prints your key.
- `node scripts/claim-pollen.js [image|audio]` — completes the cheap Pollinations
  onboarding tasks (one tiny image / audio request each) to claim starter pollen.
- `scripts/make-icons.sh` — regenerate PWA icons from `assets/icon-source.svg`.

## Security notes

`.env` is gitignored and contains no committed secrets. A few things to know
before exposing this publicly:

- **Set `SESSION_SECRET`.** Session cookies hold each user's Pollinations key;
  a known/weak secret lets them be forged.
- **No shared server key is spent on visitors.** Vision/premium use the
  logged-in user's own key; free generation uses none. (If you later wire
  `POLLINATIONS_API_KEY` into the request path to offer vision to logged-out
  users, gate the app with `APP_PASSWORD` and add rate limiting first.)
- **No rate limiting is built in.** `/api/generate`, `/api/resolve-prompt`, and
  `/api/search` are open by default. For a public deployment, put a rate limiter
  (e.g. `express-rate-limit`) or a reverse proxy in front to prevent abuse.
- **Sessions are in-memory** (Express default `MemoryStore`) — fine for a single
  process, but use a persistent store for multi-instance production.

## Tech stack

- **Backend:** Node.js, Express, express-session
- **Frontend:** vanilla JS, [Fabric.js](http://fabricjs.com/) (canvas),
  [Lucide](https://lucide.dev/) (icons) — both vendored, no build step
- **AI:** [Pollinations.ai](https://pollinations.ai) for vision and image generation
- **Images:** Openverse + Wikimedia Commons for reference search

## Credits

Built with [Pollinations.ai](https://pollinations.ai). Reference images from
Openverse and Wikimedia Commons contributors.

## License

[MIT](./LICENSE) © Mark Tonkelowitz.

Bundled/dependency licenses (all permissive): Express, express-session,
Fabric.js — MIT; dotenv — BSD-2-Clause; Lucide — ISC.
