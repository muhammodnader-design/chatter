const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');
const actions = require('./lib/actions');
const { handleApi } = require('./lib/httpApi');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

const users = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.all(['/api', '/api/*'], (req, res) => {
  handleApi(req, res);
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Request failed.' });
});

function systemMessage(room, text) {
  io.to(room).emit('message', { id: `${Date.now()}-sys`, system: true, text, time: Date.now() });
}

function emitPresence(room) {
  actions
    .members(room)
    .then((list) => io.to(room).emit('presence', { room, users: list }))
    .catch(() => {});
}

function respond(cb, res) {
  if (typeof cb === 'function') cb(res);
}

function wrapped(handler) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((err) => {
      console.error(err);
      const last = args[args.length - 1];
      if (typeof last === 'function') last({ ok: false, error: 'Request failed.' });
    });
  };
}

function splitArgs(a, b) {
  return typeof a === 'function' ? [undefined, a] : [a, b];
}

io.on('connection', (socket) => {
  socket.on(
    'register',
    wrapped(async (payload, cb) => respond(cb, await actions.register(payload || {})))
  );

  socket.on(
    'login',
    wrapped(async (payload, cb) => respond(cb, await actions.login(payload || {})))
  );

  socket.on(
    'auth',
    wrapped(async (payload, cb) => respond(cb, await actions.verify(payload && payload.token)))
  );

  socket.on(
    'logout',
    wrapped(async (payload, cb) => respond(cb, await actions.logout(payload && payload.token)))
  );

  socket.on(
    'get-rooms',
    wrapped(async (a, b) => {
      const cb = typeof a === 'function' ? a : b;
      respond(cb, await actions.listRooms());
    })
  );

  socket.on(
    'get-dms',
    wrapped(async (a, b) => {
      const [payload, cb] = splitArgs(a, b);
      respond(cb, await actions.listDms(payload && payload.token));
    })
  );

  socket.on(
    'join',
    wrapped(async (payload, cb) => {
      const res = await actions.joinRoom({
        token: payload && payload.token,
        username: payload && payload.username,
        room: payload && payload.room,
        checkPresence: false,
        scan: ({ room, username, accountId }) => {
          for (const [id, u] of users.entries()) {
            if (id === socket.id || u.room !== room) continue;
            if (u.username.toLowerCase() !== username.toLowerCase()) continue;
            if (accountId !== null && u.accountId === accountId) continue;
            if (accountId !== null && u.accountId === null) {
              const guestSock = io.sockets.sockets.get(id);
              const renamed = `${u.username}-${Math.floor(Math.random() * 900 + 100)}`;
              users.set(id, { ...u, username: renamed });
              db.touchPresence(room, renamed, null).catch(() => {});
              if (guestSock) {
                guestSock.emit('forced-rename', {
                  username: renamed,
                  reason: 'That display name belongs to an account.'
                });
              }
              continue;
            }
            return { ok: false, error: 'That name is already used in this room.' };
          }
          return { ok: true };
        }
      });
      if (!res.ok) return respond(cb, res);

      const previous = users.get(socket.id);
      const roomChanged = !previous || previous.room !== res.room;
      const aloneBefore = previous
        ? ![...users.entries()].some(
            ([id, u]) =>
              id !== socket.id &&
              u.room === previous.room &&
              u.username.toLowerCase() === previous.username.toLowerCase()
          )
        : true;

      users.set(socket.id, { username: res.username, room: res.room, accountId: res.accountId });

      if (previous && roomChanged) {
        socket.leave(previous.room);
        if (!db.isDmRoom(previous.room)) systemMessage(previous.room, `${previous.username} left the room`);
        if (aloneBefore) await db.removePresence(previous.room, previous.username);
        emitPresence(previous.room);
      }

      socket.join(res.room);
      if (roomChanged && !db.isDmRoom(res.room)) systemMessage(res.room, `${res.username} joined the room`);

      respond(cb, res);
      emitPresence(res.room);
    })
  );

  socket.on(
    'message',
    wrapped(async (payload) => {
      const user = users.get(socket.id);
      if (!user) return;
      const data =
        typeof payload === 'string'
          ? { text: payload }
          : payload && typeof payload === 'object'
            ? payload
            : {};
      const r = await actions.postMessage({
        room: user.room,
        text: data.text,
        file: data.file,
        as: { username: user.username, accountId: user.accountId }
      });
      if (!r.ok) return;
      io.to(user.room).emit('message', { ...r.message, sid: socket.id });
      socket.broadcast.to(user.room).emit('typing', { room: user.room, username: user.username, isTyping: false });
    })
  );

  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.broadcast.to(user.room).emit('typing', {
      room: user.room,
      username: user.username,
      isTyping: Boolean(isTyping)
    });
  });

  socket.on(
    'edit-message',
    wrapped(async (payload, cb) => {
      const user = users.get(socket.id);
      if (!user) return respond(cb, { ok: false, error: 'Not in a room.' });
      const r = await actions.editMessage({
        room: user.room,
        id: payload && payload.id,
        text: payload && payload.text,
        as: { username: user.username, accountId: user.accountId }
      });
      if (r.ok) io.to(user.room).emit('message-edited', r.edit);
      respond(cb, r);
    })
  );

  socket.on(
    'delete-message',
    wrapped(async (payload, cb) => {
      const user = users.get(socket.id);
      if (!user) return respond(cb, { ok: false, error: 'Not in a room.' });
      const r = await actions.deleteMessage({
        room: user.room,
        id: payload && payload.id,
        as: { username: user.username, accountId: user.accountId }
      });
      if (r.ok) io.to(user.room).emit('message-deleted', r.delete);
      respond(cb, r);
    })
  );

  socket.on(
    'disconnect',
    wrapped(async () => {
      const user = users.get(socket.id);
      if (!user) return;
      users.delete(socket.id);
      const alone = ![...users.values()].some(
        (u) => u.room === user.room && u.username.toLowerCase() === user.username.toLowerCase()
      );
      if (alone) await db.removePresence(user.room, user.username);
      if (!db.isDmRoom(user.room)) systemMessage(user.room, `${user.username} left the room`);
      emitPresence(user.room);
    })
  );
});

const keepalive = setInterval(() => {
  for (const u of users.values()) db.touchPresence(u.room, u.username, u.accountId).catch(() => {});
}, 30000);
if (typeof keepalive.unref === 'function') keepalive.unref();

server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
