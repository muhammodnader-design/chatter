const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 3200;
const URL = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `smoke-${Date.now()}.db`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CHAT_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

function get(u) {
  return fetch(`${URL}${u}`).then(async (r) => ({ status: r.status, text: await r.text() }));
}

async function main() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${URL}/`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const results = [];
  const idx = await get('/');
  results.push(['index serves', idx.status === 200]);
  results.push(['index references transport.js', idx.text.includes('transport.js')]);
  results.push(['index has no static socket.io tag', !idx.text.includes('/socket.io/socket.io.js')]);
  const files = ['/transport.js', '/app.js', '/style.css', '/socket.io/socket.io.js'];
  for (const f of files) {
    const r = await get(f);
    results.push([`${f} serves`, r.status === 200 && r.text.length > 0]);
  }
  const caps = await (await fetch(`${URL}/api/capabilities`)).json();
  results.push(['capabilities local: sockets true', caps.ok === true && caps.sockets === true]);
  const notFound = await fetch(`${URL}/api/nope`);
  results.push(['unknown api route 404s', notFound.status === 404]);
  const rooms = await (await fetch(`${URL}/api/rooms`)).json();
  results.push(['GET /api/rooms works', rooms.ok === true && Array.isArray(rooms.rooms)]);

  server.kill();
  try { fs.unlinkSync(DB); } catch {}

  let failed = 0;
  for (const [name, ok] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
    if (!ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
