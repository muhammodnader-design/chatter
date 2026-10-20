# Chatter

A lightweight realtime chat app: rooms, direct messages, accounts, file sharing, edit/delete, presence and typing indicators. Works two ways from one codebase:

- **Locally** — Express + Socket.io + SQLite (`chat.db`): instant realtime, zero config.
- **On Vercel** — serverless REST API + polling + Turso (cloud SQLite) + Vercel Blob: deployable free-tier, no WebSockets needed.

The frontend detects the mode automatically via `GET /api/capabilities` and picks the right transport (`public/transport.js`) — everything else is shared.

## Features

- Public rooms (create by joining) + direct messages (accounts only)
- Register/login with hashed passwords, guest mode, session auto-restore
- Realtime messages, presence, typing indicators (events locally, polling on Vercel)
- File attachments: images inline, other files as chips (4 MB cap, extension whitelist)
- Edit/delete your own messages, `(edited)` tag
- Message history survives restarts (SQLite/Turso)
- Responsive UI: mobile drawer, safe-area insets, 44px touch targets

## Quick start (local)

```
run.bat            # install deps if needed, start server, open http://localhost:3000
run.bat --no-browser
```

or manually:

```
npm install
npm start          # node server.js → http://localhost:3000
```

Requires Node 22+ (uses the built-in `node:sqlite`). Data lives in `chat.db`; uploads in `uploads/`.

## Tests

```
test.bat
```

Runs four suites (117 checks):

| Suite | What it covers |
|---|---|
| `test/e2e.js` | Full socket flow + REST API parity (87) |
| `test/poll-transport.js` | Polling client against a live server (17) |
| `test/smoke.js` | Static assets + capabilities endpoint (10) |
| `test/vercel-mode.js` | `VERCEL=1` mode detection (3) |

## Deploying to Vercel

### 1. Create a Turso database (free tier is fine)

```
turso db create chatter
turso db tokens create chatter
```

Note the two values it prints: `TURSO_DATABASE_URL` (looks like `libsql://chatter-xxx.turso.io`) and `TURSO_AUTH_TOKEN`.

### 2. Enable Vercel Blob

In the Vercel dashboard: your project → **Storage** → **Blob** → create a store. This auto-sets `BLOB_READ_WRITE_TOKEN` in your project env.

### 3. Set environment variables

Project → **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | from step 1 |
| `TURSO_AUTH_TOKEN` | from step 1 |

(`BLOB_READ_WRITE_TOKEN` is set automatically by step 2.)

### 4. Deploy

```
vercel --prod        # or just: deploy.bat
```

That's it. Without the env vars it still deploys and runs, but falls back to a non-persistent SQLite DB with a console warning — set both for a real deployment.

### How the Vercel version works

- All API routes are served by one serverless function (`api/index.js` → `lib/httpApi.js`) via the rewrite in `vercel.json`.
- The client polls `GET /api/poll?...` every 2s for new/edited messages, deletions, members and typing state.
- Uploads go to `POST /api/upload` and are stored in Vercel Blob; in local mode they're written to `uploads/` and served statically.
- Presence lives in a `presence` table with heartbeats (members refresh every 45s, typing expires after 8s).

## Environment variables

| Variable | Local | Vercel | Purpose |
|---|---|---|---|
| `PORT` | optional (default 3000) | — | Server port |
| `CHAT_DB` | optional | — | SQLite file path (default `chat.db`) |
| `UPLOAD_DIR` | optional | — | Upload folder (default `uploads/`) |
| `TURSO_DATABASE_URL` / `LIBSQL_URL` | — | required for persistence | Cloud DB URL |
| `TURSO_AUTH_TOKEN` / `LIBSQL_AUTH_TOKEN` | — | required for persistence | Cloud DB token |
| `BLOB_READ_WRITE_TOKEN` | — | set by Vercel Blob | File storage |

## Project layout

```
server.js          Express + Socket.io layer (thin, local mode)
db.js              SQLite (local) / libSQL-Turso (remote) driver
lib/actions.js     Shared business logic (auth, rooms, DMs, messages, poll)
lib/httpApi.js     HTTP API used by both Express and Vercel
api/index.js       Vercel serverless entry
public/            Frontend (vanilla JS; transport.js picks socket vs polling)
test/              e2e + poll + smoke + vercel-mode suites
run.bat            Start full stack locally
test.bat           Run all test suites
deploy.bat         vercel --prod
```
