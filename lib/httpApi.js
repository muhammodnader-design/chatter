const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const actions = require('./actions');

const MAX_UPLOAD = 4 * 1024 * 1024;
const MAX_JSON = 256 * 1024;

const ALLOWED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'pdf', 'txt', 'md', 'csv', 'json', 'log',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z', 'tar', 'gz',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov'
]);

const EXT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', log: 'text/plain',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) reject(Object.assign(new Error('Payload too large'), { code: 'TOO_LARGE' }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('Aborted'), { code: 'ABORTED' })));
  });
}

async function readJson(req, limit = MAX_JSON) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

async function handleUpload(req, res, q) {
  const name = String(q.name || '').slice(0, 120);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!name || !ALLOWED_EXT.has(ext)) {
    return json(res, 400, { ok: false, error: 'File type not allowed.' });
  }
  let body;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch (err) {
    if (err.code === 'TOO_LARGE') return json(res, 413, { ok: false, error: 'File too large (max 4 MB).' });
    throw err;
  }
  if (!body.length) {
    return json(res, 400, { ok: false, error: 'Empty file.' });
  }
  const stored = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  let url;
  const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN) || Boolean(process.env.BLOB_STORE_ID);
  if (hasBlob) {
    try {
      const { put } = require('@vercel/blob');
      const blob = await put(`chatter/${stored}`, body, {
        access: 'public',
        allowOverwrite: true
      });
      url = blob.url;
    } catch (err) {
      console.error('[upload] blob store failed:', err);
      return json(res, 500, { ok: false, error: 'Upload storage unavailable.' });
    }
  } else {
    const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stored), body);
    url = `/uploads/${stored}`;
  }
  return json(res, 200, {
    ok: true,
    url,
    name,
    size: body.length,
    type: EXT_TYPES[ext] || 'application/octet-stream'
  });
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let action = '';
    const m = url.pathname.match(/^\/api\/(.+)$/);
    if (m) {
      action = m[1].split('/')[0];
    } else if (req.params && typeof req.params[0] === 'string') {
      action = req.params[0].split('/')[0];
    }
    const q = Object.fromEntries(url.searchParams);
    const method = (req.method || 'GET').toUpperCase();

    let body = null;
    const getBody = async () => {
      if (!body) body = await readJson(req);
      return body;
    };

    switch (action) {
      case 'capabilities':
        return json(res, 200, { ok: true, sockets: !process.env.VERCEL, maxUpload: MAX_UPLOAD });

      case 'rooms': {
        if (method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        return json(res, 200, { ok: true, rooms: await actions.listRooms() });
      }

      case 'dms': {
        if (method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        return json(res, 200, { ok: true, dms: await actions.listDms(q.token) });
      }

      case 'auth': {
        const b = await getBody();
        const verb = String(b.action || 'verify');
        if (verb === 'register') return json(res, 200, await actions.register(b));
        if (verb === 'login') return json(res, 200, await actions.login(b));
        if (verb === 'logout') return json(res, 200, await actions.logout(b.token));
        return json(res, 200, await actions.verify(b.token || q.token));
      }

      case 'join': {
        const b = method === 'POST' ? await getBody() : {};
        const r = await actions.joinRoom({
          token: b.token || q.token,
          username: b.username || q.username,
          room: b.room || q.room
        });
        return json(res, 200, r);
      }

      case 'poll': {
        const b = method === 'POST' ? await getBody() : {};
        const pick = (k) => (b[k] !== undefined && b[k] !== null && b[k] !== '' ? b[k] : q[k]);
        const r = await actions.poll({
          token: pick('token'),
          username: pick('username'),
          room: pick('room'),
          sinceId: pick('sinceId'),
          sinceTime: pick('sinceTime'),
          typing: pick('typing') === true || pick('typing') === 'true' || pick('typing') === '1'
        });
        if (!r.ok && r.unauthorized) return json(res, 401, r);
        return json(res, 200, r);
      }

      case 'message': {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        const b = await getBody();
        const as = await actions.identity({ token: b.token, username: b.username });
        if (!as) return json(res, 401, { ok: false, error: 'Not logged in.' });
        const access = await actions.resolveRoomAccess({ room: b.room, username: as.username, accountId: as.accountId });
        if (!access.ok) return json(res, 403, access);
        const r = await actions.postMessage({ room: access.room, text: b.text, file: b.file, as });
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, id: r.message.id, message: r.message } : r);
      }

      case 'edit': {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        const b = await getBody();
        const as = await actions.identity({ token: b.token, username: b.username });
        if (!as) return json(res, 401, { ok: false, error: 'Not logged in.' });
        const r = await actions.editMessage({ room: b.room, id: b.id, text: b.text, as });
        return json(res, 200, r);
      }

      case 'delete': {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        const b = await getBody();
        const as = await actions.identity({ token: b.token, username: b.username });
        if (!as) return json(res, 401, { ok: false, error: 'Not logged in.' });
        const r = await actions.deleteMessage({ room: b.room, id: b.id, as });
        return json(res, 200, r);
      }

      case 'typing': {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        const b = await getBody();
        const r = await actions.setTyping({ token: b.token, username: b.username, room: b.room, typing: b.typing });
        if (!r.ok && r.error === 'Not logged in.') return json(res, 401, r);
        return json(res, 200, r);
      }

      case 'upload': {
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        return handleUpload(req, res, q);
      }

      default:
        return json(res, 404, { ok: false, error: 'Not found.' });
    }
  } catch (err) {
    if (err && err.code === 'ABORTED') return;
    console.error('[api]', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Request failed.' });
  }
}

module.exports = { handleApi, MAX_UPLOAD };
