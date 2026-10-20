(function () {
  'use strict';

  function createBus() {
    const handlers = {};
    return {
      on(event, fn) {
        (handlers[event] || (handlers[event] = [])).push(fn);
        return this;
      },
      emitLocal(event, ...args) {
        const list = handlers[event];
        if (!list) return;
        list.slice().forEach((fn) => {
          try {
            fn(...args);
          } catch (err) {
            console.error(err);
          }
        });
      }
    };
  }

  function pollTransport() {
    const bus = createBus();
    const state = { token: null, username: '', guest: true, room: null, typingOut: false };
    const typingSeen = new Set();
    let sinceId = 0;
    let sinceTime = 0;
    let timer = null;
    let online = true;

    async function call(action, { method = 'GET', body, query } = {}) {
      const params = new URLSearchParams();
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== '') params.set(k, v);
        }
      }
      const qs = params.toString();
      const init = { method };
      if (body && method !== 'GET') {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`/api/${action}${qs ? '?' + qs : ''}`, init);
      return res.json();
    }

    function markOnline() {
      if (!online) {
        online = true;
        bus.emitLocal('connect');
      }
    }

    function markOffline() {
      if (online) {
        online = false;
        bus.emitLocal('disconnect');
      }
    }

    function applyTyping(names) {
      for (const name of names) {
        if (!typingSeen.has(name)) {
          typingSeen.add(name);
          bus.emitLocal('typing', { room: state.room, username: name, isTyping: true });
        }
      }
      for (const name of [...typingSeen]) {
        if (!names.includes(name)) {
          typingSeen.delete(name);
          bus.emitLocal('typing', { room: state.room, username: name, isTyping: false });
        }
      }
    }

    async function tick() {
      if (!state.room) return;
      try {
        const data = await call('poll', {
          query: {
            token: state.token || '',
            username: state.guest ? state.username : '',
            room: state.room,
            sinceId: String(sinceId),
            sinceTime: String(sinceTime),
            typing: state.typingOut ? '1' : '0'
          }
        });
        markOnline();
        if (!data.ok) return;
        sinceTime = (data.serverTime || Date.now()) - 1000;
        for (const m of data.messages || []) {
          if (m.id > sinceId) sinceId = m.id;
          bus.emitLocal('message', m);
        }
        for (const id of data.deletes || []) {
          bus.emitLocal('message-deleted', { id, room: state.room });
        }
        bus.emitLocal('presence', { room: state.room, users: data.users || [] });
        applyTyping((data.typing || []).filter((u) => u !== state.username));
      } catch {
        markOffline();
      }
    }

    function startPolling() {
      if (timer) return;
      tick();
      timer = setInterval(tick, 2000);
    }

    return {
      on: bus.on,
      start() {
        bus.emitLocal('connect');
      },
      emit(event, payload, ack) {
        if (typeof payload === 'function') {
          ack = payload;
          payload = undefined;
        }
        const cb = typeof ack === 'function' ? ack : null;
        const fail = (error) => {
          if (cb) cb({ ok: false, error: error || 'Request failed.' });
        };

        switch (event) {
          case 'get-rooms':
            call('rooms')
              .then((d) => cb && cb(d.rooms || []))
              .catch(() => cb && cb(['General']));
            break;

          case 'get-dms':
            call('dms', { query: { token: payload && payload.token } })
              .then((d) => cb && cb(d.dms || []))
              .catch(() => cb && cb([]));
            break;

          case 'register':
          case 'login':
            call('auth', { method: 'POST', body: Object.assign({ action: event }, payload) })
              .then((d) => (cb ? cb(d) : null))
              .catch(() => fail());
            break;

          case 'auth':
            call('auth', { method: 'POST', body: { action: 'verify', token: payload && payload.token } })
              .then((d) => (cb ? cb(d) : null))
              .catch(() => fail('Session expired. Please log in again.'));
            break;

          case 'logout':
            call('auth', { method: 'POST', body: { action: 'logout', token: payload && payload.token } })
              .then(() => cb && cb({ ok: true }))
              .catch(() => fail());
            break;

          case 'join':
            call('join', { method: 'POST', body: payload })
              .then((res) => {
                if (res.ok) {
                  state.token = (payload && payload.token) || state.token;
                  state.username = res.username;
                  state.guest = res.guest;
                  state.room = res.room;
                  sinceId = 0;
                  sinceTime = 0;
                  typingSeen.clear();
                  startPolling();
                }
                if (cb) cb(res);
                tick();
              })
              .catch(() => fail());
            break;

          case 'message': {
            const body = typeof payload === 'string' ? { text: payload } : payload || {};
            call('message', {
              method: 'POST',
              body: {
                token: state.token || '',
                username: state.guest ? state.username : '',
                room: state.room,
                text: body.text,
                file: body.file
              }
            })
              .then((d) => {
                if (d && d.ok && d.message) bus.emitLocal('message', d.message);
              })
              .catch(() => {});
            break;
          }

          case 'typing':
            state.typingOut = Boolean(payload);
            call('typing', {
              method: 'POST',
              body: {
                token: state.token || '',
                username: state.guest ? state.username : '',
                room: state.room,
                typing: state.typingOut
              }
            }).catch(() => {});
            break;

          case 'edit-message':
            call('edit', {
              method: 'POST',
              body: {
                token: state.token || '',
                username: state.guest ? state.username : '',
                room: state.room,
                id: payload && payload.id,
                text: payload && payload.text
              }
            })
              .then((d) => (cb ? cb(d) : null))
              .catch(() => fail());
            break;

          case 'delete-message':
            call('delete', {
              method: 'POST',
              body: {
                token: state.token || '',
                username: state.guest ? state.username : '',
                room: state.room,
                id: payload && payload.id
              }
            })
              .then((d) => (cb ? cb(d) : null))
              .catch(() => fail());
            break;

          default:
            break;
        }
      }
    };
  }

  window.createChatTransport = function () {
    return fetch('/api/capabilities')
      .then((r) => r.json())
      .then((cap) => {
        if (cap && cap.sockets) {
          return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = '/socket.io/socket.io.js';
            script.onload = () => resolve(window.io());
            script.onerror = () => resolve(pollTransport());
            document.head.appendChild(script);
          });
        }
        return pollTransport();
      })
      .catch(() => pollTransport());
  };
})();
