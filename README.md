# Task Management System — Backend

Node.js + Express REST API for the Khud Kifalat Shobajat (Dawat-e-Islami) Task Management System.

> Status: **Phase 3 — Authentication only.** Google Sign-In verification, JWT issuance/
> verification, auth + role middleware, `POST /auth/google`, `GET /auth/me`, and the
> non-production `POST /auth/dev-login` are implemented. No Users/Lookup/Task CRUD, no business
> workflows yet. See `../docs/` for the full specification — `../docs/11-auth.md` for the Google
> Sign-In design, `../docs/06-backend.md` §1 for `auth.service.js`, `../docs/05-apis.md` §2 for
> the endpoint contract.

## Layering

```
routes → controllers (thin) → services (business logic) → models (Mongoose schemas)
```

Controllers never talk to Mongoose models directly.

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in real values
npm run dev
```

`GET http://localhost:5000/health` should return `{ "status": "ok", ... }`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start with nodemon (auto-restart). |
| `npm start` | Start with plain node (production). |
| `npm test` | Run the Jest test suite (uses `.env.test`, never `.env`). |
| `npm run lint` | Run ESLint. |
| `npm run format` | Run Prettier (writes changes). |

## Environment variables

See `.env.example` for the full list and comments. Required right now: `MONGODB_URI`,
`JWT_SECRET`, `FRONTEND_URL`, `GOOGLE_CLIENT_ID`. Google Drive / SMTP variables are declared but
optional until their respective modules are implemented — `src/config/env.js` documents this per
variable.

`GOOGLE_ALLOWED_HD` is always optional: leave it empty to allow any verified Google account found
in the `users` collection; set it to a Workspace domain to additionally enforce that domain as
defense-in-depth. No domain is ever hardcoded in code.

## Testing

Tests run against `.env.test` (dummy, non-secret values, safe to commit) — Jest sets
`NODE_ENV=test` automatically, and `src/config/env.js` loads `.env.test` whenever that's the case.
Tests import `src/app.js` directly (never `src/server.js`), so they never open a real port and
never require a live MongoDB connection.

Model tests (`tests/models/*.test.js`) run against a real, temporary MongoDB provided by
`mongodb-memory-server` — one shared instance for the whole run, started in
`tests/setup/globalSetup.js` and stopped in `tests/setup/globalTeardown.js`. The first run on a
machine downloads a `mongod` binary (cached afterwards under `~/.cache/mongodb-binaries`); every
run after that is fast and fully offline.
