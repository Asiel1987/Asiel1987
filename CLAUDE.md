# Asiel Farm Shop — Project Guide for Claude Sessions

## Project Overview

Asiel Farm Shop is a mobile-first PWA marketplace connecting farmers and customers in
**Tanzania (TZ)** and **Kenya (KE)** markets. It supports:

- OTP phone authentication (Africa's Talking SMS gateway)
- Multi-currency display (TZS, KES, USD, and 12 others) with live FX rates
- Mobile money payments: M-Pesa Kenya (Safaricom Daraja), M-Pesa TZ / TigoPesa /
  Airtel via Selcom aggregator
- Card payments via Stripe (Visa, Mastercard, Amex, Discover) with Luhn validation
- Role-based access: Customer, Farmer, Admin
- VFD fiscal receipt integration (NepTech / TRA Tanzania)
- Google Play distribution as a TWA (Trusted Web Activity) via Bubblewrap

---

## Repo Structure

```
/home/user/Asiel1987/          ← repo root = React/Vite frontend
├── src/
│   ├── App.jsx                ← entire frontend app (single-file architecture)
│   └── main.jsx               ← React entry point
├── public/                    ← static assets, manifest.webmanifest, sw.js, icons
├── dist/                      ← Vite build output (gitignored, auto-generated)
├── tests/
│   └── e2e/                   ← Playwright end-to-end tests
│       ├── playwright.config.js
│       ├── auth.spec.js       ← OTP login flow
│       ├── buy-flow.spec.js   ← full purchase flow
│       └── market.spec.js     ← market page features
├── .github/
│   └── workflows/
│       ├── ci.yml             ← PR/push checks (frontend build + backend tests + e2e)
│       └── deploy.yml         ← production deployment (Vercel + Railway)
├── docker-compose.yml         ← local dev stack (postgres, redis, backend, frontend)
├── bubblewrap.config.json     ← TWA config for Google Play submission
├── vite.config.js
├── package.json
├── .env.development           ← frontend dev env vars (VITE_ prefix)
├── .env.production            ← frontend prod env vars (VITE_ prefix, no secrets)
└── backend/                   ← Node.js/Express API
    ├── src/
    │   └── index.js           ← Express app entry point
    ├── migrations/            ← SQL migration files
    ├── Dockerfile             ← multi-stage production image
    ├── package.json
    └── .env.example           ← backend env var template (never commit .env)
```

---

## How to Run Locally

### Option A — Docker Compose (recommended, runs everything)

```bash
# Copy and fill in backend secrets (only needed once)
cp backend/.env.example backend/.env
# $EDITOR backend/.env

# Start the full stack (postgres, redis, backend, frontend)
docker-compose up
```

Services:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- Postgres: localhost:5432 (db=asiel_farm, user=asiel, pass=localdev)
- Redis: localhost:6379

### Option B — Manual (separate terminals)

```bash
# Terminal 1 — Frontend (demo mode, no backend required)
npm run dev
# → http://localhost:5173  (port set in vite.config.js)

# Terminal 2 — Backend
cd backend
npm run dev
# → http://localhost:3001
```

For manual backend startup you still need Postgres and Redis running locally
(or point DATABASE_URL / REDIS_URL at cloud services).

---

## Environment Variables

### Frontend — `.env.development`

| Variable | Purpose |
|---|---|
| `VITE_API_BASE` | Backend base URL. **Empty string = demo mode** (no backend required) |
| `VITE_APP_ENV` | `development` or `production` |
| `VITE_STRIPE_PK` | Stripe publishable key (`pk_test_*` in dev, `pk_live_*` in prod) |

### Frontend — `.env.production`

Same variables as above but with production values. These are baked into the JS
bundle at build time — **never put secret keys here**.

### Backend — `backend/.env` (from `backend/.env.example`)

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `production` / `test` |
| `PORT` | HTTP port (default 3001) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection URL |
| `SESSION_SECRET` | 64-byte random hex for express-session cookie signing |
| `FRONTEND_URL` | Exact frontend origin for CORS (no trailing slash) |
| `AFRICASTALKING_USERNAME` | Africa's Talking username (`sandbox` for dev) |
| `AFRICASTALKING_API_KEY` | Africa's Talking API key |
| `AFRICASTALKING_SENDER_ID` | SMS sender ID (`AsielFarm`) |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_*` / `sk_live_*`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `SELCOM_API_URL` | Selcom aggregator base URL |
| `SELCOM_API_KEY` | Selcom API key |
| `SELCOM_API_SECRET` | Selcom API secret |
| `SELCOM_VENDOR` | Selcom vendor ID |
| `MPESA_CONSUMER_KEY` | Safaricom Daraja consumer key |
| `MPESA_CONSUMER_SECRET` | Safaricom Daraja consumer secret |
| `MPESA_SHORTCODE` | Lipa Na M-Pesa business shortcode |
| `MPESA_PASSKEY` | Lipa Na M-Pesa online passkey |
| `MPESA_CALLBACK_URL` | Publicly reachable callback URL for STK push |
| `MPESA_ENV` | `sandbox` or `live` |
| `OPENEXCHANGERATES_APP_ID` | Open Exchange Rates app ID (FX data) |
| `VFD_API_URL` | NepTech VFD API base URL |
| `VFD_USERNAME` | VFD username |
| `VFD_PASSWORD` | VFD password |
| `VFD_TIN` | Company TIN registered with TRA |
| `VFD_VRN` | Company VRN registered with TRA |
| `VFD_SERIAL` | VFD serial number |

---

## Branch Convention

| Branch | Purpose |
|---|---|
| `main` | Production — every push triggers Vercel + Railway deploy |
| `claude/*` | Changes made by Claude Code — CI runs on push and PR |

Example branch name: `claude/add-search-filters` or `claude/fix-mpesa-callback`.

---

## Build Commands

### Frontend

```bash
npm run build        # Vite production build → dist/
npm run preview      # Preview built dist/ locally (port 4173)
npm run dev          # Development server with HMR (port 5173 per docker-compose; 3000 per vite.config)
```

### Backend

```bash
# Development
cd backend && npm run dev       # nodemon with auto-restart

# Production image
docker build -t asiel-api ./backend
docker run -p 3001:3001 --env-file backend/.env asiel-api
```

---

## Test Commands

### End-to-end (Playwright)

```bash
# Install browsers first (once)
npx playwright install --with-deps chromium

# Build frontend, serve it, then run e2e tests
npm run build
npx serve dist --listen 4173 &
npx playwright test

# Run a specific spec
npx playwright test tests/e2e/auth.spec.js

# Open Playwright UI mode
npx playwright test --ui
```

### Backend unit/integration tests

```bash
cd backend
npm test             # jest --runInBand --forceExit
```

Tests require a running Postgres and Redis instance — use docker-compose or set
DATABASE_URL / REDIS_URL env vars pointing at test instances.

---

## CI/CD Pipeline

### `ci.yml` — Runs on push/PR to `main` and `claude/*`

1. **frontend-check** — `npm ci` + `npm run build`
2. **backend-check** — spins up postgres:16 + redis:7 service containers, then
   `npm ci`, starts the server, waits on `/health`, runs `npm test`
3. **e2e** (needs both above) — installs Chromium, builds frontend, serves on
   port 4173, runs Playwright; uploads `playwright-report/` artifact on failure

### `deploy.yml` — Runs on push to `main` only

1. **deploy-frontend** — `npx vercel --prod --token $VERCEL_TOKEN`
   (secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`)
2. **deploy-backend** (needs deploy-frontend) — `npx railway up`
   (secrets: `RAILWAY_TOKEN`, `RAILWAY_SERVICE_ID`)

---

## Key Architectural Decisions

### Demo mode (VITE_API_BASE = "")

When `VITE_API_BASE` is an empty string, the frontend runs in full demo mode:
- No backend calls are made; all data is seeded from in-memory fixtures.
- OTP code `123456` always succeeds.
- Payment flows auto-transition to success after ~2.6 seconds.
- This allows the app to be demoed or tested without any infrastructure.

### tokenStore abstraction

The token store is a thin module that swaps its storage mechanism based on environment:
- **Demo / development**: `localStorage` (simple, inspectable in DevTools)
- **Production**: httpOnly cookie set by the backend (XSS-safe)

All auth code calls `tokenStore.get()` / `tokenStore.set()` / `tokenStore.clear()` —
never accesses localStorage or cookies directly.

### CSRF protection (`_csrfToken` + `X-CSRF-Token` header)

A module-level variable `_csrfToken` holds the current CSRF token received from
the backend. Every mutating fetch request attaches it as the `X-CSRF-Token` header.
The backend validates this header using `csurf` middleware. The token is refreshed
on session start.

### `secureId()` — all IDs use crypto.getRandomValues

All client-generated IDs (cart line items, ephemeral session tokens, etc.) are
created with `crypto.getRandomValues` wrapped in a `secureId()` helper rather than
`Math.random()`. This prevents ID guessing and collision in multi-tab scenarios.

### SSE uses `withCredentials: true` (no token in URL)

Server-Sent Event connections include `withCredentials: true` so the session cookie
is sent along with the request. The auth token is never placed in the URL (which
would appear in server logs and browser history).

### Luhn check in `validateCardFields()`

`validateCardFields(num, name, expiry, cvv)` performs a full Luhn algorithm check
before any Stripe API call. This prevents unnecessary network round-trips for
obviously invalid card numbers and gives the user instant feedback.

### `ErrorBoundary` resets on logout via `_resetEB()`

The top-level React `ErrorBoundary` exposes a module-level `_resetEB()` function.
On logout, the auth flow calls `_resetEB()` to reset any caught error state before
re-rendering the login screen — preventing stale error UI from persisting across
sessions.

---

## Google Play (TWA)

`bubblewrap.config.json` at the repo root contains the Trusted Web Activity
configuration for wrapping the PWA as an Android app via the Bubblewrap CLI:

```bash
# Install Bubblewrap CLI
npm install -g @bubblewrap/cli

# Generate Android project
bubblewrap init --manifest https://asiel.farm/manifest.webmanifest

# Build APK / AAB
bubblewrap build
```

Package ID: `tz.asiel.farm.twa`  
Min Android: Lollipop (API 21) via Chrome Custom Tabs fallback  
Notifications: enabled — requires the Digital Asset Links file at
`https://asiel.farm/.well-known/assetlinks.json`.
