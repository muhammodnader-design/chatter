const windows = new Map();

function allow(key, limit, windowMs) {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || now >= entry.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

const AUTH_LIMIT = 8;
const AUTH_WINDOW = 5 * 60 * 1000;
const authFails = new Map();

function authKey(ip) {
  return String(ip || 'unknown');
}

function authLocked(ip) {
  const now = Date.now();
  const key = authKey(ip);
  const entry = authFails.get(key);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    authFails.delete(key);
    return false;
  }
  return entry.count >= AUTH_LIMIT;
}

function authFailure(ip) {
  const now = Date.now();
  const key = authKey(ip);
  const entry = authFails.get(key);
  if (!entry || now >= entry.resetAt) authFails.set(key, { count: 1, resetAt: now + AUTH_WINDOW });
  else entry.count += 1;
}

function authSuccess(ip) {
  authFails.delete(authKey(ip));
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key);
  }
  for (const [key, entry] of authFails) {
    if (now >= entry.resetAt) authFails.delete(key);
  }
}, 60000);
if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = { allow, authLocked, authFailure, authSuccess };
