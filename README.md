# Chatter

**Realtime chat that just works — open the link, pick a name, start talking.**

**Live app → [chat-app-lovat-tau-34.vercel.app](https://chat-app-lovat-tau-34.vercel.app)**

Chatter is a modern chat product for communities, teams and friends: rooms, direct messages, file sharing, presence and typing indicators — wrapped in a clean, responsive interface that runs in any modern browser, on desktop and phone. No ads. No tracking. Nothing to install.

## Why Chatter

- **Instant onboarding** — join as a guest in one click, or create an account in seconds. Sessions are remembered, so you come back to where you left off.
- **Truly realtime** — messages, presence and typing indicators appear instantly. The transport adapts automatically: WebSockets where available, efficient polling on serverless — you never think about it.
- **Rich messages** — images render inline, files appear as download chips, and everything can be edited or deleted with an `(edited)` tag.
- **Private by design** — passwords are salted and hashed with scrypt; direct messages are enforced server-side, so nobody can read a DM they're not part of; zero third-party trackers.
- **Yours to customize** — dark/light theme, text size, notification sound, enter-to-send, join/leave filters — all in the settings tab.
- **Protected from abuse** — built-in rate limiting on message floods and login brute force.

## Features

### Messaging
- Public rooms — create one simply by joining its name
- Direct messages between accounts, private by server enforcement
- Realtime delivery with live presence list and typing indicators
- Edit and delete your own messages; full history survives restarts

### Sharing
- Attach files up to 4 MB — images inline, other types as named chips
- Extension whitelist and storage sandboxing (no path traversal)

### Accounts
- Register or log in with scrypt-hashed passwords — or stay anonymous as a guest
- Profile cards — click any member to view their bio and avatar color; edit your own bio and color
- Automatic session restore, password change from the settings tab

### Experience
- Responsive layout: mobile drawer, safe-area insets, 44px touch targets
- Settings: theme, text size, enter-to-send, system messages, sound on new messages
- Keyboard-friendly with labelled controls throughout

## Getting started

### Use Chatter
Open **[chat-app-lovat-tau-34.vercel.app](https://chat-app-lovat-tau-34.vercel.app)** — that's it. Nothing to install.

### Run it yourself

```bash
git clone https://github.com/muhammodnader-design/chatter.git
cd chatter
npm install
npm start        # → http://localhost:3000
```

On Windows: `run.bat`. Requires Node 22+ (uses the built-in `node:sqlite`). Data lives in `chat.db`, uploads in `uploads/`.

## Quality

146 automated checks across four suites — run them with `test.bat`:

| Suite | Coverage |
|---|---|
| `test/e2e.js` | Full socket flow + REST API parity (110) |
| `test/poll-transport.js` | Polling client against a live server (22) |
| `test/smoke.js` | Static assets + capabilities endpoint (11) |
| `test/vercel-mode.js` | Serverless mode detection (3) |

## How it works

One codebase, two transports. The client asks `GET /api/capabilities` and picks the right one automatically (`public/transport.js`):

- **Self-hosted** — Express + Socket.io + SQLite: instant WebSockets, zero config.
- **Serverless (Vercel)** — a single function (`api/index.js`), REST + 2s polling, Turso/libSQL for cloud persistence, Vercel Blob for uploads.

Message payloads are identical in both modes, and the parity is covered by tests. The frontend is dependency-free vanilla JS.

## Configuration (self-hosting)

```
vercel --prod     # deploys as-is — add the env vars below for persistent data
```

| Variable | Purpose |
|---|---|
| `PORT` | Server port (local, default 3000) |
| `CHAT_DB` / `UPLOAD_DIR` | Local SQLite path / uploads folder |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | Cloud database for serverless persistence |
| `BLOB_READ_WRITE_TOKEN` | File storage (set automatically by Vercel Blob) |

Without Turso the serverless deployment runs on ephemeral storage — fine for trying it out; set the env vars for production data.

## Project layout

```
server.js          Express + Socket.io layer (thin, local mode)
db.js              SQLite (local) / libSQL-Turso (remote) driver
lib/actions.js     Shared business logic (auth, rooms, DMs, messages, poll)
lib/rateLimit.js   Flood + brute-force protection
lib/httpApi.js     HTTP API used by both Express and Vercel
api/index.js       Vercel serverless entry
public/            Frontend (vanilla JS; transport.js picks socket vs polling)
test/              e2e + poll + smoke + vercel-mode suites
run.bat            Start full stack locally
test.bat           Run all test suites
deploy.bat         vercel --prod
```

---

**[Source on GitHub](https://github.com/muhammodnader-design/chatter)** — issues and pull requests welcome.
