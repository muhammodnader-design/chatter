let socket = null;
const pendingSocketHandlers = [];

function on(event, handler) {
  if (socket) socket.on(event, handler);
  else pendingSocketHandlers.push([event, handler]);
}

createChatTransport().then((transport) => {
  socket = transport;
  pendingSocketHandlers.forEach(([event, handler]) => socket.on(event, handler));
  pendingSocketHandlers.length = 0;
  if (transport.start) transport.start();
});

const $ = (id) => document.getElementById(id);
const welcome = $('welcome');
const chat = $('chat');
const joinForm = $('join-form');
const tabs = $('tabs');
const nameLabel = $('name-label');
const nameInput = $('name-input');
const passBlock = $('pass-block');
const passInput = $('pass-input');
const confirmBlock = $('confirm-block');
const pass2Input = $('pass2-input');
const roomInput = $('room-input');
const roomChips = $('room-chips');
const authBtn = $('auth-btn');
const joinError = $('join-error');
const roomList = $('room-list');
const dmList = $('dm-list');
const addDmBtn = $('add-dm');
const roomTitle = $('room-title');
const roomSub = $('room-sub');
const messagesEl = $('messages');
const composer = $('composer');
const msgInput = $('msg-input');
const fileInput = $('file-input');
const attachBtn = $('attach-btn');
const typingEl = $('typing');
const memberList = $('member-list');
const onlineCount = $('online-count');
const leaveBtn = $('leave');
const addRoomBtn = $('add-room');
const menuBtn = $('menu-btn');
const sidebar = $('sidebar');
const backdrop = $('sidebar-backdrop');
const meName = $('me-name');
const meAvatar = $('me-avatar');

let mode = 'login';
let selectedRoom = 'General';
let state = { username: '', room: '', guest: true, token: null, dmWith: null };
let typingFlagOn = false;
let typingFlagTimer = null;
const remoteTyping = new Map();

nameInput.value = localStorage.getItem('chatter.username') || '';

/* ---------- Helpers ---------- */

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function fillAvatar(el, name) {
  el.textContent = initials(name);
  el.style.background = `hsl(${hashHue(name)}, 58%, 46%)`;
}

function timeOf(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function renderFile(file) {
  const wrap = document.createElement('div');
  wrap.className = 'file-attach';
  if (file.type && file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = file.url;
    img.alt = file.name || 'image';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(file.url, '_blank'));
    wrap.appendChild(img);
  } else {
    const a = document.createElement('a');
    a.className = 'file-chip';
    a.href = file.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${file.name || 'file'} · ${formatSize(file.size || 0)}`;
    wrap.appendChild(a);
  }
  return wrap;
}

async function uploadAndSend(file) {
  if (!file || !state.room) return;
  attachBtn.disabled = true;
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file
    });
    const info = await res.json().catch(() => ({}));
    if (!res.ok || !info.ok) {
      alert(info.error || 'Upload failed.');
      return;
    }
    const text = msgInput.value.trim();
    socket.emit('message', {
      text,
      file: { url: info.url, name: info.name, size: info.size, type: info.type }
    });
    msgInput.value = '';
    msgInput.style.height = 'auto';
    msgInput.focus();
  } catch {
    alert('Upload failed.');
  } finally {
    attachBtn.disabled = false;
  }
}

function saveSession(token, username) {
  localStorage.setItem('chatter.token', token);
  localStorage.setItem('chatter.username', username);
  state.token = token;
}

function clearSession() {
  localStorage.removeItem('chatter.token');
  state.token = null;
}

/* ---------- Welcome screen ---------- */

function renderChips(rooms) {
  roomChips.innerHTML = '';
  if (!rooms.length) rooms = ['General'];
  if (!rooms.includes(selectedRoom)) selectedRoom = rooms[0];
  rooms.forEach((room) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (room === selectedRoom && !roomInput.value ? ' active' : '');
    chip.textContent = room;
    chip.addEventListener('click', () => {
      selectedRoom = room;
      roomInput.value = '';
      renderChips(rooms);
    });
    roomChips.appendChild(chip);
  });
}

function setMode(next) {
  mode = next;
  [...tabs.children].forEach((t) => t.classList.toggle('active', t.dataset.mode === next));
  const guest = next === 'guest';
  passBlock.hidden = guest;
  confirmBlock.hidden = next !== 'register';
  nameLabel.textContent = guest ? 'Display name' : 'Username';
  nameInput.placeholder = guest ? 'e.g. Alex' : 'e.g. alex';
  authBtn.textContent = next === 'login' ? 'Log in & join' : next === 'register' ? 'Create account & join' : 'Join as guest';
  joinError.textContent = '';
}

tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) setMode(tab.dataset.mode);
});

roomInput.addEventListener('input', () => {
  [...roomChips.children].forEach((c) => c.classList.toggle('active', !roomInput.value && c.textContent === selectedRoom));
});

function showWelcome(error) {
  chat.classList.remove('active');
  welcome.classList.add('active');
  joinError.textContent = error || '';
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinError.textContent = '';
  const username = nameInput.value.trim();
  const room = roomInput.value.trim() || selectedRoom;

  if (!room) { joinError.textContent = 'Pick or type a room.'; return; }
  if (!username) { joinError.textContent = mode === 'guest' ? 'Enter a display name.' : 'Enter a username.'; return; }

  if (mode === 'guest') {
    join({ username, room });
    return;
  }

  const password = passInput.value;
  if (!password) { joinError.textContent = 'Enter your password.'; return; }

  if (mode === 'login') {
    socket.emit('login', { username, password }, (res) => {
      if (!res.ok) { joinError.textContent = res.error; return; }
      saveSession(res.token, res.username);
      join({ token: res.token, room });
    });
    return;
  }

  if (password.length < 6) { joinError.textContent = 'Password must be at least 6 characters.'; return; }
  if (password !== pass2Input.value) { joinError.textContent = 'Passwords do not match.'; return; }
  socket.emit('register', { username, password, confirm: password }, (res) => {
    if (!res.ok) { joinError.textContent = res.error; return; }
    saveSession(res.token, res.username);
    join({ token: res.token, room });
  });
});

function join(creds, onFail) {
  socket.emit('join', creds, (res) => {
    if (!res.ok) {
      if (onFail) onFail(res.error);
      else joinError.textContent = res.error;
      return;
    }
    state = {
      username: res.username,
      room: res.room,
      guest: res.guest,
      token: creds.token || state.token,
      dmWith: res.dmWith || null
    };
    localStorage.setItem('chatter.room', res.room);
    if (!res.guest) localStorage.setItem('chatter.username', res.username);
    enterChat(res);
  });
}

/* ---------- Session restore ---------- */

on('connect', () => {
  const token = localStorage.getItem('chatter.token');
  if (!token) {
    socket.emit('get-rooms', renderChips);
    return;
  }
  socket.emit('auth', { token }, (res) => {
    if (!res.ok) {
      clearSession();
      socket.emit('get-rooms', renderChips);
      return;
    }
    const room = localStorage.getItem('chatter.room') || 'General';
    state.token = token;
    join({ token, room }, (error) => {
      clearSession();
      showWelcome(error);
      socket.emit('get-rooms', renderChips);
    });
  });
});

/* ---------- Chat screen ---------- */

function enterChat(res) {
  welcome.classList.remove('active');
  chat.classList.add('active');
  joinError.textContent = '';

  meName.textContent = state.username;
  fillAvatar(meAvatar, state.username);
  leaveBtn.textContent = state.guest ? 'Leave' : 'Log out';

  messagesEl.innerHTML = '';
  if (!res.history.length) showEmpty();
  res.history.forEach(addMessage);

  updateRoomHeader(res.room, res.users.length);
  renderMembers(res.users);
  socket.emit('get-rooms', renderRoomList);
  refreshDms();

  msgInput.placeholder = res.dmWith ? `Message @${res.dmWith}` : `Message #${res.room}`;
  msgInput.focus();
}

function showEmpty() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = 'No messages yet — say hello!';
  messagesEl.appendChild(div);
}

/* ---------- Messages ---------- */

function addSystemLine(text) {
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollDown();
}

function fillBubble(bubble, msg) {
  bubble.replaceChildren();
  if (msg.text) bubble.appendChild(document.createTextNode(msg.text));
  if (msg.file) bubble.appendChild(renderFile(msg.file));
}

function ensureEdited(meta) {
  if (meta.querySelector('.edited-tag')) return;
  const tag = document.createElement('span');
  tag.className = 'edited-tag';
  tag.textContent = '(edited)';
  meta.appendChild(tag);
}

const PENCIL_D = 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z';
const TRASH_D = 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14';

function msgActionBtn(title, d, danger, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-action' + (danger ? ' danger' : '');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  btn.appendChild(svg);
  btn.addEventListener('click', onClick);
  return btn;
}

function addActions(meta, row, msg) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.appendChild(msgActionBtn('Edit', PENCIL_D, false, () => startEdit(row)));
  actions.appendChild(msgActionBtn('Delete', TRASH_D, true, () => {
    if (confirm('Delete this message?')) {
      socket.emit('delete-message', { id: msg.id }, (res) => {
        if (!res.ok) alert(res.error);
      });
    }
  }));
  meta.appendChild(actions);
}

function startEdit(row) {
  const msg = row._msg;
  const bubble = row.querySelector('.bubble');
  if (!msg || !bubble || row.querySelector('.edit-box')) return;

  const box = document.createElement('div');
  box.className = 'edit-box';
  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  ta.maxLength = 500;
  ta.value = msg.text;
  const bar = document.createElement('div');
  bar.className = 'edit-bar';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'edit-save';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'edit-cancel';
  cancel.textContent = 'Cancel';
  bar.append(save, cancel);
  box.append(ta, bar);
  bubble.replaceChildren(box);

  const finish = () => {
    box.remove();
    fillBubble(bubble, msg);
  };
  cancel.addEventListener('click', finish);
  save.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    socket.emit('edit-message', { id: msg.id, text }, (res) => {
      if (!res.ok) {
        alert(res.error);
        finish();
        return;
      }
      msg.text = text;
      msg.edited = true;
      finish();
      const meta = row.querySelector('.meta');
      if (meta) ensureEdited(meta);
    });
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save.click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  });
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

on('message-edited', ({ id, text }) => {
  const row = messagesEl.querySelector(`[data-id="${id}"]`);
  if (!row || !row._msg) return;
  row._msg.text = text;
  row._msg.edited = true;
  if (!row.querySelector('.edit-box')) {
    fillBubble(row.querySelector('.bubble'), row._msg);
  }
  const meta = row.querySelector('.meta');
  if (meta) ensureEdited(meta);
});

on('message-deleted', ({ id }) => {
  const row = messagesEl.querySelector(`[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('removing');
  setTimeout(() => row.remove(), 200);
});

function addMessage(msg) {
  if (msg.system) {
    addSystemLine(`${msg.text} · ${timeOf(msg.time)}`);
    return;
  }

  if (typeof msg.id === 'number') {
    const existing = messagesEl.querySelector(`[data-id="${msg.id}"]`);
    if (existing && existing._msg) {
      existing._msg.text = msg.text;
      existing._msg.file = msg.file || null;
      existing._msg.edited = Boolean(msg.edited);
      if (!existing.querySelector('.edit-box')) {
        fillBubble(existing.querySelector('.bubble'), existing._msg);
      }
      const meta = existing.querySelector('.meta');
      if (meta && msg.edited) ensureEdited(meta);
      return;
    }
  }

  const mine = msg.username === state.username;
  remoteTyping.delete(msg.username);
  renderTyping();

  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'msg' + (mine ? ' mine' : '');
  if (typeof msg.id === 'number') row.dataset.id = msg.id;
  row._msg = msg;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  fillAvatar(avatar, msg.username);

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = mine ? 'You' : msg.username;
  const when = document.createElement('span');
  when.textContent = timeOf(msg.time);
  meta.append(who, when);
  if (msg.edited) ensureEdited(meta);
  if (mine && typeof msg.id === 'number') addActions(meta, row, msg);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  fillBubble(bubble, msg);

  wrap.append(meta, bubble);
  row.append(avatar, wrap);
  messagesEl.appendChild(row);
  scrollDown();
}

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

on('message', addMessage);

on('forced-rename', ({ username, reason }) => {
  state.username = username;
  meName.textContent = username;
  fillAvatar(meAvatar, username);
  addSystemLine(`You were renamed to "${username}". ${reason}`);
});

/* ---------- Rooms ---------- */

function renderRoomList(rooms) {
  roomList.innerHTML = '';
  rooms.forEach((room) => {
    const li = document.createElement('li');
    li.textContent = room;
    if (room === state.room) li.classList.add('active');
    li.addEventListener('click', () => {
      switchRoom(room);
      setSidebar(false);
    });
    roomList.appendChild(li);
  });
}

function switchRoom(room) {
  if (room === state.room) return;
  const creds = state.token ? { token: state.token, room } : { username: state.username, room };
  join(creds, (error) => alert(error));
}

addRoomBtn.addEventListener('click', () => {
  const room = prompt('New room name (letters, numbers, spaces, - or _):');
  if (room && room.trim()) switchRoom(room.trim().slice(0, 24));
});

function updateRoomHeader(room, count) {
  const isDm = room.startsWith('dm:');
  roomTitle.textContent = isDm ? `@ ${state.dmWith || ''}`.trim() : `# ${room}`;
  roomSub.textContent = isDm ? `Direct message · ${count} online` : `${count} online`;
}

/* ---------- Direct messages ---------- */

function dmRoomName(a, b) {
  return 'dm:' + [a.toLowerCase(), b.toLowerCase()].sort().join(':');
}

function renderDmList(rows) {
  dmList.innerHTML = '';
  rows.forEach((row) => {
    const li = document.createElement('li');
    li.textContent = row.with;
    if (row.room === state.room) li.classList.add('active');
    li.title = `Message ${row.with}`;
    li.addEventListener('click', () => {
      switchRoom(row.room);
      setSidebar(false);
    });
    dmList.appendChild(li);
  });
}

function refreshDms() {
  if (!state.token) { renderDmList([]); return; }
  socket.emit('get-dms', { token: state.token }, renderDmList);
}

function openDm(withUser) {
  if (withUser === state.username) return;
  if (!state.token) {
    alert('Log in to use direct messages.');
    return;
  }
  switchRoom(dmRoomName(state.username, withUser));
}

addDmBtn.addEventListener('click', () => {
  if (!state.token) {
    alert('Log in to use direct messages.');
    return;
  }
  const name = prompt('Username to message:');
  if (name && name.trim()) openDm(name.trim());
});

/* ---------- Presence ---------- */

on('presence', ({ room, users }) => {
  if (room !== state.room) return;
  renderMembers(users);
  updateRoomHeader(room, users.length);
  socket.emit('get-rooms', renderRoomList);
});

function renderMembers(users) {
  onlineCount.textContent = users.length;
  memberList.innerHTML = '';
  users.forEach((name) => {
    const self = name === state.username;
    const li = document.createElement('li');
    if (self) li.classList.add('self');
    const status = document.createElement('span');
    status.className = 'status';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    fillAvatar(avatar, name);
    const label = document.createElement('span');
    label.textContent = self ? `${name} (you)` : name;
    li.append(status, avatar, label);
    if (!self) {
      li.title = `Message ${name}`;
      li.addEventListener('click', () => openDm(name));
    }
    memberList.appendChild(li);
  });
}

/* ---------- Typing ---------- */

function renderTyping() {
  const now = Date.now();
  for (const [name, until] of remoteTyping) {
    if (until < now) remoteTyping.delete(name);
  }
  const names = [...remoteTyping.keys()];
  if (!names.length) { typingEl.textContent = ''; return; }
  if (names.length === 1) typingEl.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) typingEl.textContent = `${names[0]} and ${names[1]} are typing…`;
  else typingEl.textContent = `${names.length} people are typing…`;
}
setInterval(renderTyping, 900);

on('typing', ({ room, username, isTyping }) => {
  if (room !== state.room || username === state.username) return;
  if (isTyping) remoteTyping.set(username, Date.now() + 3000);
  else remoteTyping.delete(username);
  renderTyping();
});

function signalTyping() {
  if (!typingFlagOn) {
    typingFlagOn = true;
    socket.emit('typing', true);
  }
  clearTimeout(typingFlagTimer);
  typingFlagTimer = setTimeout(() => {
    typingFlagOn = false;
    socket.emit('typing', false);
  }, 1200);
}

/* ---------- Composer ---------- */

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('message', text);
  msgInput.value = '';
  msgInput.style.height = 'auto';
  if (typingFlagOn) {
    typingFlagOn = false;
    clearTimeout(typingFlagTimer);
    socket.emit('typing', false);
  }
  msgInput.focus();
});

msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 132) + 'px';
  signalTyping();
});

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

/* ---------- Attachments ---------- */

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (file) uploadAndSend(file);
});

msgInput.addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    uploadAndSend(files[0]);
  }
});

messagesEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  messagesEl.classList.add('dragover');
});

messagesEl.addEventListener('dragleave', () => messagesEl.classList.remove('dragover'));

messagesEl.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl.classList.remove('dragover');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) uploadAndSend(files[0]);
});

/* ---------- Misc ---------- */

function setSidebar(open) {
  sidebar.classList.toggle('open', open);
  backdrop.hidden = !open;
}

leaveBtn.addEventListener('click', () => {
  const token = localStorage.getItem('chatter.token');
  if (token) {
    socket.emit('logout', { token }, () => {
      clearSession();
      location.reload();
    });
  } else {
    location.reload();
  }
});

menuBtn.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
backdrop.addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSidebar(false);
});

on('disconnect', () => {
  if (chat.classList.contains('active')) {
    addSystemLine('Disconnected — reconnecting…');
  }
});
