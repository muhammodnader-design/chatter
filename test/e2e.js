const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 3100;
const URL = `http://localhost:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `chatter-e2e-${Date.now()}.db`);

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`); };
const connect = () => io(URL, { transports: ['websocket'] });
const once = (sock, ev) => new Promise((r) => sock.once(ev, r));
const emitAck = (sock, ev, payload) => new Promise((r) => sock.emit(ev, payload, r));

let server;
const sockets = [];

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHAT_DB: DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}/`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = null;
}

function cleanup() {
  for (const s of sockets) s.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch {}
  }
}

async function main() {
  console.log(`Starting server on port ${PORT} (db: ${path.basename(DB_FILE)})...`);
  startServer();
  if (!(await waitForServer())) throw new Error('Server did not start within 10s');
  console.log('Server is up. Running tests...\n');

  const a = connect(); const b = connect(); const c = connect(); const d = connect();
  sockets.push(a, b, c, d);
  await once(a, 'connect');

  /* --- Auth: register --- */
  const reg1 = await emitAck(a, 'register', { username: 'Alice', password: 'secret123', confirm: 'secret123' });
  check('register Alice succeeds', reg1.ok === true && typeof reg1.token === 'string');

  const regShortName = await emitAck(a, 'register', { username: 'Al', password: 'secret123', confirm: 'secret123' });
  check('register rejects short username', regShortName.ok === false);

  const regShortPw = await emitAck(b, 'register', { username: 'Bob', password: 'abc', confirm: 'abc' });
  check('register rejects short password', regShortPw.ok === false);

  const regBob = await emitAck(b, 'register', { username: 'Bob', password: 'hunter2000', confirm: 'hunter2000' });
  check('register Bob succeeds', regBob.ok === true);

  const regDup = await emitAck(c, 'register', { username: 'alice', password: 'other999', confirm: 'other999' });
  check('duplicate username rejected (case-insensitive)', regDup.ok === false);

  const regMismatch = await emitAck(c, 'register', { username: 'Cara', password: 'secret123', confirm: 'secret456' });
  check('password confirmation mismatch rejected', regMismatch.ok === false);

  /* --- Auth: login --- */
  const loginBad = await emitAck(a, 'login', { username: 'Alice', password: 'wrongpass' });
  check('login with wrong password rejected', loginBad.ok === false);

  const login = await emitAck(a, 'login', { username: 'Alice', password: 'secret123' });
  check('login with correct password succeeds', login.ok === true && typeof login.token === 'string');

  const authBad = await emitAck(a, 'auth', { token: 'not-a-real-token' });
  check('auth with invalid token rejected', authBad.ok === false);

  const authOk = await emitAck(a, 'auth', { token: reg1.token });
  check('auth with valid token returns username', authOk.ok === true && authOk.username === 'Alice');

  /* --- Join with token vs guest --- */
  const pA = once(a, 'presence');
  const joinA = await emitAck(a, 'join', { token: reg1.token, username: 'Mallory', room: 'General' });
  await pA;
  check('token join uses account name (spoof ignored)', joinA.ok === true && joinA.username === 'Alice');
  check('account join marked not guest', joinA.guest === false);

  const pD = once(a, 'presence');
  const joinD = await emitAck(d, 'join', { username: 'Dave', room: 'General' });
  await pD;
  check('guest join succeeds', joinD.ok === true && joinD.guest === true);

  const guestAccName = await emitAck(c, 'join', { username: 'bob', room: 'General' });
  check('guest cannot take account name', guestAccName.ok === false);

  const pB = once(a, 'presence');
  const joinB = await emitAck(b, 'join', { token: regBob.token, room: 'General' });
  const presB = await pB;
  check('Bob joins General via token', joinB.ok === true && joinB.username === 'Bob');
  check('presence lists Alice, Bob, Dave', ['Alice', 'Bob', 'Dave'].every((n) => presB.users.includes(n)));

  const guestDup = await emitAck(c, 'join', { username: 'Dave', room: 'General' });
  check('duplicate name in room rejected', guestDup.ok === false);

  const badRoom = await emitAck(c, 'join', { username: 'Cara', room: 'bad/room!' });
  check('invalid room name rejected', badRoom.ok === false);

  /* --- Realtime --- */
  const t1 = once(a, 'typing');
  d.emit('typing', true);
  const t = await t1;
  check('typing event relayed', t.username === 'Dave' && t.isTyping === true);

  const m1 = once(a, 'message');
  d.emit('message', 'hello alice!');
  const msg = await m1;
  check('message delivered realtime', msg.text === 'hello alice!' && msg.username === 'Dave');

  const echoed = [];
  const echoDone = new Promise((r) => {
    const h = (m) => { echoed.push(m); if (m.text === 'hi dave') { a.off('message', h); r(); } };
    a.on('message', h);
    a.emit('message', 'hi dave');
  });
  await echoDone;
  check('sender receives own message', echoed.some((m) => m.text === 'hi dave'));

  const longMsg = await new Promise((r) => {
    const h = (m) => { if (m.text.length === 500) { b.off('message', h); r(m); } };
    b.on('message', h);
    b.emit('message', 'x'.repeat(600));
  });
  check('overlong message truncated to 500', longMsg.text.length === 500);

  /* --- Multi-tab same account --- */
  const e = connect(); sockets.push(e);
  const pTab = once(a, 'presence');
  const joinTab2 = await emitAck(e, 'join', { token: reg1.token, room: 'General' });
  await pTab;
  check('same account may open second tab in room', joinTab2.ok === true && joinTab2.username === 'Alice');
  const pE = once(a, 'presence');
  e.close();
  await pE;

  /* --- Room switching & isolation --- */
  const joinCara = await emitAck(c, 'join', { username: 'Cara', room: 'Random' });
  check('new room created on join', joinCara.ok === true && joinCara.room === 'Random');
  c.emit('message', 'random note');

  const p2 = once(a, 'presence');
  const switchB = await emitAck(b, 'join', { token: regBob.token, room: 'Random' });
  check('room switch works', switchB.ok === true && switchB.room === 'Random');
  check('room history isolated', !switchB.history.some((m) => m.text === 'hello alice!'));
  const pres2 = await p2;
  check('presence updated after switch', !pres2.users.includes('Bob'));

  /* --- Logout --- */
  const out = await emitAck(b, 'logout', { token: regBob.token });
  check('logout succeeds', out.ok === true);
  const authAfter = await emitAck(b, 'auth', { token: regBob.token });
  check('token invalid after logout', authAfter.ok === false);

  /* --- Persistence across server restart --- */
  const loginAgain = await emitAck(b, 'login', { username: 'Bob', password: 'hunter2000' });
  check('re-login after logout works', loginAgain.ok === true);

  /* --- Direct messages --- */
  const dms0 = await new Promise((r) => a.emit('get-dms', { token: reg1.token }, r));
  check('get-dms initially empty', Array.isArray(dms0) && dms0.length === 0);

  const dmsGuest = await new Promise((r) => d.emit('get-dms', {}, r));
  check('get-dms without token returns empty', Array.isArray(dmsGuest) && dmsGuest.length === 0);

  const dmGuestJoin = await emitAck(d, 'join', { username: 'Dave', room: 'dm:alice:bob' });
  check('guest cannot open a DM', dmGuestJoin.ok === false);

  const pBobLeaves = once(c, 'presence');
  const bobDm = await emitAck(b, 'join', { token: loginAgain.token, room: 'dm:alice:bob' });
  await pBobLeaves;
  check('Bob opens DM with Alice', bobDm.ok === true && bobDm.dmWith === 'Alice');

  const caraReg = await emitAck(c, 'register', { username: 'Cara', password: 'secret123', confirm: 'secret123' });
  check('register Cara succeeds', caraReg.ok === true);
  const caraDm = await emitAck(c, 'join', { token: caraReg.token, room: 'dm:alice:bob' });
  check('third party blocked from DM', caraDm.ok === false);

  const selfDm = await emitAck(a, 'join', { token: reg1.token, room: 'dm:alice:alice' });
  check('self-DM rejected', selfDm.ok === false);

  const bobSecret = new Promise((r) => {
    const h = (m) => { if (m.text === 'secret plans') { b.off('message', h); r(true); } };
    b.on('message', h);
    b.emit('message', 'secret plans');
  });
  check('message sent inside DM', await bobSecret === true);

  let dmSystemMsg = null;
  const watchSystem = (m) => { if (m.system) dmSystemMsg = m; };
  b.on('message', watchSystem);
  const pAliceDm = once(a, 'presence');
  const aliceDm = await emitAck(a, 'join', { token: reg1.token, room: 'dm:alice:bob' });
  await pAliceDm;
  await new Promise((r) => setTimeout(r, 300));
  b.off('message', watchSystem);
  check('no join-spam system messages in DM', dmSystemMsg === null);
  check('Alice joins DM, sees Bob', aliceDm.ok === true && aliceDm.dmWith === 'Bob' && aliceDm.users.includes('Bob'));
  check('DM history includes secret message', aliceDm.history.some((m) => m.text === 'secret plans'));
  check('DM history excludes public chat', !aliceDm.history.some((m) => m.text === 'hello alice!'));

  const dmsAlice = await new Promise((r) => a.emit('get-dms', { token: reg1.token }, r));
  check('Alice DM list shows Bob', dmsAlice.length === 1 && dmsAlice[0].with === 'Bob' && dmsAlice[0].room === 'dm:alice:bob');

  const roomsNoDm = await new Promise((r) => a.emit('get-rooms', r));
  check('DM rooms excluded from room list', !roomsNoDm.some((room) => room.startsWith('dm:')));

  const pAliceBack = once(a, 'presence');
  const aliceBack = await emitAck(a, 'join', { token: reg1.token, room: 'General' });
  await pAliceBack;
  check('Alice back in General with no DM leak', aliceBack.ok === true && !aliceBack.history.some((m) => m.text === 'secret plans'));

  const rmSeen = new Promise((r) => {
    const h = (m) => { if (m.text === 'remember me') { a.off('message', h); r(m); } };
    a.on('message', h);
    a.emit('message', 'remember me');
  });
  const rmMsg = await rmSeen;
  check('message flow before restart', rmMsg.text === 'remember me');

  /* --- File sharing --- */
  const up = await fetch(`${URL}/api/upload?name=note.txt`, { method: 'POST', body: Buffer.from('hello file') });
  const upJson = await up.json();
  check('file upload succeeds', up.ok && upJson.ok === true && /^\/uploads\/[a-f0-9]{24}\.txt$/.test(upJson.url || ''));

  const served = await fetch(`${URL}${upJson.url}`);
  const servedText = await served.text();
  check('uploaded file is served back', served.status === 200 && servedText === 'hello file');

  const badExt = await fetch(`${URL}/api/upload?name=evil.exe`, { method: 'POST', body: Buffer.from('x') });
  check('disallowed file type rejected', badExt.status === 400);

  const bigUp = await fetch(`${URL}/api/upload?name=big.png`, { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024 + 1) });
  check('oversized upload rejected (4 MB cap)', bigUp.status === 413);

  const fileMsgSeen = once(d, 'message');
  a.emit('message', {
    text: 'check this file',
    file: { url: upJson.url, name: upJson.name, size: upJson.size, type: upJson.type }
  });
  const fm = await fileMsgSeen;
  check('message with file delivered', fm.text === 'check this file' && fm.file && fm.file.url === upJson.url);

  const badFileSeen = once(d, 'message');
  a.emit('message', { text: 'sneaky', file: { url: '/uploads/../../server.js', name: 'server.js', size: 1, type: 'text/javascript' } });
  const bf = await badFileSeen;
  check('path-traversal file url stripped', bf.text === 'sneaky' && !bf.file);

  const missSeen = once(d, 'message');
  a.emit('message', { text: 'ghost', file: { url: `/uploads/${'ab'.repeat(12)}.png`, name: 'x.png', size: 5, type: 'image/png' } });
  const miss = await missSeen;
  check('nonexistent file attachment stripped', miss.text === 'ghost' && !miss.file);

  /* --- Edit / delete --- */
  const editedSeen = once(d, 'message-edited');
  const editRes = await new Promise((r) => a.emit('edit-message', { id: fm.id, text: 'check this file (v2)' }, r));
  const editedEvt = await editedSeen;
  check('edit own message succeeds', editRes.ok === true);
  check('edit broadcast to room', editedEvt.id === fm.id && editedEvt.text === 'check this file (v2)');

  const editHist = await emitAck(a, 'join', { token: reg1.token, room: 'General' });
  const editedMsg = editHist.history.find((m) => m.id === fm.id);
  check('edited text in history with flag', Boolean(editedMsg && editedMsg.text === 'check this file (v2)' && editedMsg.edited === true));

  const foreignEdit = await new Promise((r) => d.emit('edit-message', { id: fm.id, text: 'hacked' }, r));
  check('cannot edit others message', foreignEdit.ok === false);

  const foreignDel = await new Promise((r) => d.emit('delete-message', { id: fm.id }, r));
  check('cannot delete others message', foreignDel.ok === false);

  const daveEdit = await new Promise((r) => d.emit('edit-message', { id: msg.id, text: 'hello alice! (edited)' }, r));
  check('guest can edit own message', daveEdit.ok === true);

  const delSeen = once(d, 'message-deleted');
  const delRes = await new Promise((r) => a.emit('delete-message', { id: rmMsg.id }, r));
  const delEvt = await delSeen;
  check('delete own message succeeds', delRes.ok === true);
  check('delete broadcast to room', delEvt.id === rmMsg.id);

  console.log('\nRestarting server to test persistence...');
  for (const s of sockets) s.close();
  await stopServer();
  startServer();
  if (!(await waitForServer())) throw new Error('Server did not restart within 10s');

  const a2 = connect(); const b2 = connect();
  sockets.push(a2, b2);

  const authRestart = await emitAck(a2, 'auth', { token: reg1.token });
  check('session survives restart', authRestart.ok === true && authRestart.username === 'Alice');

  const roomsAfter = await new Promise((r) => a2.emit('get-rooms', r));
  check('rooms persist across restart', roomsAfter.includes('General') && roomsAfter.includes('Random'));

  const rejoin = await emitAck(a2, 'join', { token: reg1.token, room: 'General' });
  check('rejoin after restart', rejoin.ok === true);
  const texts = rejoin.history.map((m) => m.text);
  check('message history persists across restart', texts.includes('check this file (v2)') && texts.includes('hello alice! (edited)'));
  check('deleted message stays deleted after restart', !texts.includes('remember me'));
  check('history oldest-first order', rejoin.history.length > 1 && rejoin.history[0].time <= rejoin.history[rejoin.history.length - 1].time);

  const ef = rejoin.history.find((m) => m.text === 'check this file (v2)');
  check('edited flag persists across restart', Boolean(ef && ef.edited));
  const histFile = rejoin.history.find((m) => m.text === 'check this file (v2)');
  check('file message persists across restart', Boolean(histFile && histFile.file && histFile.file.url === upJson.url));
  const stillUp = await fetch(`${URL}${upJson.url}`);
  check('uploaded file survives restart', stillUp.status === 200);

  const dmsAfter = await new Promise((r) => a2.emit('get-dms', { token: reg1.token }, r));
  check('DM list persists across restart', dmsAfter.some((d) => d.with === 'Bob' && d.room === 'dm:alice:bob'));

  const dmRejoin = await emitAck(a2, 'join', { token: reg1.token, room: 'dm:alice:bob' });
  check('DM history persists across restart', dmRejoin.ok === true && dmRejoin.history.some((m) => m.text === 'secret plans'));

  const relogin = await emitAck(b2, 'login', { username: 'bob', password: 'hunter2000' });
  check('login works after restart (case-insensitive)', relogin.ok === true);

  const guestAfter = await emitAck(b2, 'join', { username: 'Dave', room: 'General' });
  check('fresh guest can join after restart', guestAfter.ok === true);

  /* --- REST API (the code path Vercel runs on) --- */
  const hdrs = { 'Content-Type': 'application/json' };
  const caps = await (await fetch(`${URL}/api/capabilities`)).json();
  check('capabilities endpoint reports sockets locally', caps.ok === true && caps.sockets === true && caps.maxUpload > 0);

  const restReg = await (
    await fetch(`${URL}/api/auth`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ action: 'register', username: 'Resty', password: 'secret123', confirm: 'secret123' })
    })
  ).json();
  check('REST register works', restReg.ok === true && typeof restReg.token === 'string');

  const restJoin = await (
    await fetch(`${URL}/api/join`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ token: restReg.token, room: 'General' })
    })
  ).json();
  check('REST join works', restJoin.ok === true && restJoin.username === 'Resty' && restJoin.guest === false && Array.isArray(restJoin.history));

  const restPost = await (
    await fetch(`${URL}/api/message`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ token: restReg.token, room: 'General', text: 'rest hello' })
    })
  ).json();
  check('REST post message works', restPost.ok === true && typeof restPost.id === 'number');

  const restPoll = await (
    await fetch(`${URL}/api/poll?token=${restReg.token}&room=General&sinceId=0&sinceTime=0&typing=0`)
  ).json();
  check('REST poll returns new message', restPoll.ok === true && restPoll.messages.some((m) => m.text === 'rest hello'));
  check('REST poll includes presence', Array.isArray(restPoll.users) && restPoll.users.includes('Resty'));

  const restEdit = await (
    await fetch(`${URL}/api/edit`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ token: restReg.token, room: 'General', id: restPost.id, text: 'rest hello v2' })
    })
  ).json();
  check('REST edit message works', restEdit.ok === true && restEdit.edit.text === 'rest hello v2');

  const restPollEdit = await (
    await fetch(`${URL}/api/poll?token=${restReg.token}&room=General&sinceId=${restPost.id}&sinceTime=0&typing=0`)
  ).json();
  check('poll redelivers edited message', restPollEdit.ok === true && restPollEdit.messages.some((m) => m.id === restPost.id && m.text === 'rest hello v2' && m.edited === true));

  const restDel = await (
    await fetch(`${URL}/api/delete`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ token: restReg.token, room: 'General', id: restPost.id })
    })
  ).json();
  check('REST delete message works', restDel.ok === true && restDel.delete.id === restPost.id);

  const restPollDel = await (
    await fetch(`${URL}/api/poll?token=${restReg.token}&room=General&sinceId=0&sinceTime=0&typing=0`)
  ).json();
  check('poll reports deletion', restPollDel.ok === true && restPollDel.deletes.includes(restPost.id) && !restPollDel.messages.some((m) => m.id === restPost.id));

  const restNoAuth = await fetch(`${URL}/api/message`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ room: 'General', text: 'nope' })
  });
  check('REST rejects missing identity', restNoAuth.status === 401);

  const restGuest = await (
    await fetch(`${URL}/api/join`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ username: 'RestGuest', room: 'General' })
    })
  ).json();
  check('REST guest join works', restGuest.ok === true && restGuest.guest === true);

  const restTyping = await (
    await fetch(`${URL}/api/typing`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ token: restReg.token, room: 'General', typing: true })
    })
  ).json();
  check('REST typing heartbeat works', restTyping.ok === true);

  await stopServer();
  cleanup();

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
process.on('SIGINT', async () => { cleanup(); await stopServer(); process.exit(1); });

main().catch(async (e) => {
  console.error(e);
  cleanup();
  await stopServer();
  process.exit(1);
});
