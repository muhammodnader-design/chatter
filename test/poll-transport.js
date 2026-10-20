const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const PORT = process.env.TEST_PORT || 3300;
const BASE = `http://localhost:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `chatter-poll-${Date.now()}.db`);
const TRANSPORT_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'transport.js'), 'utf8');

const results = [];
const check = (name, cond) => {
  results.push([name, cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
};

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

function loadTransport() {
  const context = {
    console,
    URLSearchParams,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      if (url === '/api/capabilities') {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, sockets: false, maxUpload: 4194304 }) });
      }
      return fetch(url.startsWith('http') ? url : BASE + url, init);
    },
    document: {
      createElement: () => ({}),
      head: { appendChild: () => {} }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(TRANSPORT_SRC, context, { filename: 'transport.js' });
  return context;
}

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHAT_DB: DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  console.log(`Starting poll-transport suite on port ${PORT}...`);
  startServer();
  if (!(await waitForServer())) throw new Error('Server did not start');

  const ctx1 = loadTransport();
  const ctx2 = loadTransport();
  const t1 = await ctx1.window.createChatTransport();
  const t2 = await ctx2.window.createChatTransport();

  const ev1 = { messages: [], presence: [], typing: [], edited: [], deleted: [] };
  const ev2 = { messages: [], presence: [], typing: [], edited: [], deleted: [] };
  const wire = (t, ev) => {
    t.on('message', (m) => ev.messages.push(m));
    t.on('presence', (p) => ev.presence.push(p));
    t.on('typing', (ty) => ev.typing.push(ty));
    t.on('message-edited', (e) => ev.edited.push(e));
    t.on('message-deleted', (e) => ev.deleted.push(e));
  };
  wire(t1, ev1);
  wire(t2, ev2);

  let connected1 = false;
  t1.on('connect', () => {
    connected1 = true;
  });
  t1.start();
  check('poll: start() fires connect', connected1 === true);

  const rooms = await new Promise((r) => t1.emit('get-rooms', r));
  check('poll: get-rooms supports callback-as-payload', Array.isArray(rooms) && rooms.includes('General'));

  const reg = await new Promise((r) =>
    t1.emit('register', { username: 'Poller', password: 'secret123', confirm: 'secret123' }, r)
  );
  check('poll: register acks with token', reg.ok === true && typeof reg.token === 'string');

  const j2 = await new Promise((r) => t2.emit('join', { username: 'Watcher', room: 'General' }, r));
  check('poll: guest join acks', j2.ok === true && j2.guest === true && Array.isArray(j2.history));

  const j1 = await new Promise((r) => t1.emit('join', { token: reg.token, room: 'General' }, r));
  check('poll: account join acks', j1.ok === true && j1.username === 'Poller' && j1.guest === false);

  check(
    'poll: presence arrives for both clients via tick',
    await waitFor(
      () =>
        ev1.presence.some((p) => p.users.includes('Poller') && p.users.includes('Watcher')) &&
        ev2.presence.some((p) => p.users.includes('Poller') && p.users.includes('Watcher'))
    )
  );

  t1.emit('message', { text: 'poll hello' });
  check(
    'poll: sender gets local echo',
    await waitFor(() => ev1.messages.some((m) => m.text === 'poll hello'))
  );
  check(
    'poll: other client receives message via poll',
    await waitFor(() => ev2.messages.some((m) => m.text === 'poll hello' && typeof m.id === 'number'))
  );

  t1.emit('typing', true);
  check(
    'poll: typing flag delivered to other client',
    await waitFor(() => ev2.typing.some((t) => t.username === 'Poller' && t.isTyping === true))
  );
  t1.emit('typing', false);
  check(
    'poll: typing clear delivered',
    await waitFor(() => ev2.typing.some((t) => t.username === 'Poller' && t.isTyping === false))
  );

  const posted = ev2.messages.find((m) => m.text === 'poll hello');
  const editRes = await new Promise((r) => t1.emit('edit-message', { id: posted.id, text: 'poll hello v2' }, r));
  check('poll: edit acks ok', editRes.ok === true);
  check(
    'poll: edited message redelivered to other client',
    await waitFor(() => ev2.messages.some((m) => m.id === posted.id && m.text === 'poll hello v2' && m.edited === true))
  );

  const delRes = await new Promise((r) => t1.emit('delete-message', { id: posted.id }, r));
  check('poll: delete acks ok', delRes.ok === true && delRes.delete.id === posted.id);
  check(
    'poll: deletion event delivered to other client',
    await waitFor(() => ev2.deleted.some((d) => d.id === posted.id))
  );

  const dms = await new Promise((r) => t1.emit('get-dms', { token: reg.token }, r));
  check('poll: get-dms acks with array', Array.isArray(dms));

  const authBad = await new Promise((r) => t1.emit('auth', { token: 'not-a-real-token' }, r));
  check('poll: invalid token rejected', authBad.ok === false);

  const out = await new Promise((r) => t1.emit('logout', { token: reg.token }, r));
  check('poll: logout acks ok', out.ok === true);

  server.kill();
  try {
    for (const suffix of ['', '-wal', '-shm']) fs.unlinkSync(DB_FILE + suffix);
  } catch {}

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', (e) => {
  console.error(e);
  try {
    server.kill();
  } catch {}
  process.exit(1);
});

main().catch((e) => {
  console.error(e);
  try {
    server.kill();
  } catch {}
  process.exit(1);
});
