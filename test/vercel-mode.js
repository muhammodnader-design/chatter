const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = 3400;
const URL = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `vercelmode-${Date.now()}.db`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CHAT_DB: DB, VERCEL: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
server.stderr.on('data', (d) => {
  stderr += d;
  process.stderr.write(`[server] ${d}`);
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

async function main() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${URL}/`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const results = [];
  const caps = await (await fetch(`${URL}/api/capabilities`)).json();
  results.push(['VERCEL=1: capabilities reports sockets:false', caps.ok === true && caps.sockets === false]);
  results.push(['missing Turso config warns', /TURSO_DATABASE_URL not set/.test(stderr)]);

  const reg = await (
    await fetch(`${URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'register', username: 'VercelUser', password: 'secret123', confirm: 'secret123' })
    })
  ).json();
  results.push(['REST auth still works in VERCEL=1 mode', reg.ok === true]);

  server.kill();
  try {
    for (const s of ['', '-wal', '-shm']) fs.unlinkSync(DB + s);
  } catch {}

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
