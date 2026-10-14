// Planning poker. Zero dependencies, Node >=18. Run: node server.js  (see env vars below)
// Env: PORT (3000), HOST (0.0.0.0), DATA_DIR (./data), PASSWORD (optional, required as ?key= when set)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const INDEX = path.join(__dirname, 'index.html');
const DECK = [0, 1, 2, 3, 5, 8, 13, 21];
const MAX_FIELD = 10000, MAX_BODY = 5e6, COUNTDOWN = 3000, GRACE = 5000, TTL = 30 * 864e5;
const rooms = new Map();

function newRoom() {
  return {
    headers: ['Summary', 'Key', 'Description', 'Link', 'Estimate'],
    stories: [], // row objects keyed by header, plus internal _id (never exported)
    current: -1,
    rounds: {}, // storyId -> { votes: { pid: { value, name } }, revealed }
    updatedAt: 0,
    players: {}, // pid -> { name, conns, spectator } (never persisted)
    clients: new Set(),
    timer: null, revealAt: null,
  };
}
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, newRoom());
  return rooms.get(id);
}
const newId = () => crypto.randomBytes(6).toString('hex');

// ---- persistence ----
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const out = {};
  for (const [id, r] of rooms) {
    if (!r.updatedAt) continue;
    out[id] = { headers: r.headers, stories: r.stories, current: r.current, rounds: r.rounds, updatedAt: r.updatedAt };
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.warn('persist failed:', e.message); }
}
function touch(room) {
  room.updatedAt = Date.now();
  if (!saveTimer) saveTimer = setTimeout(flush, 500);
}
function load() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('could not load', DATA_FILE + ':', e.message); return; }
  for (const [id, d] of Object.entries(data || {})) {
    if (!/^[\w-]{1,40}$/.test(id) || !d || !(d.updatedAt > Date.now() - TTL)) continue;
    const r = newRoom();
    Object.assign(r, { headers: d.headers, stories: d.stories, current: d.current, rounds: d.rounds || {}, updatedAt: d.updatedAt });
    for (const s of r.stories) s._id = s._id || newId();
    rooms.set(id, r);
  }
}

// RFC4180-ish CSV parser (handles quoted fields with commas/newlines/"")
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

function toCSV(headers, stories) {
  const esc = v => {
    v = v == null ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [headers, ...stories.map(s => headers.map(h => s[h]))] // s._id never exported
    .map(r => r.map(esc).join(',')).join('\n') + '\n';
}

function findHeader(headers, name) {
  return headers.find(h => h.trim().toLowerCase() === name.toLowerCase());
}

// UI field name -> CSV column name
const FIELD_COLS = { key: 'Key', title: 'Description', summary: 'Summary', link: 'Link', estimate: 'Estimate' };

function applyFields(room, story, fields = {}) {
  for (const [f, colName] of Object.entries(FIELD_COLS)) {
    if (!(f in fields)) continue;
    let col = findHeader(room.headers, colName);
    if (!col) { col = colName; room.headers.push(col); }
    story[col] = String(fields[f] ?? '').slice(0, MAX_FIELD);
  }
}

function setEstimate(room, story, value) {
  let est = findHeader(room.headers, 'Estimate');
  if (!est) { est = 'Estimate'; room.headers.push(est); }
  story[est] = String(value ?? '').slice(0, MAX_FIELD);
}

// ---- rounds ----
const curStory = room => room.stories[room.current];
function curRound(room, create) {
  const s = curStory(room);
  if (!s) return null;
  if (!room.rounds[s._id] && create) room.rounds[s._id] = { votes: {}, revealed: false };
  return room.rounds[s._id] || null;
}

function computeResult(round) {
  const vals = Object.values(round.votes).map(v => v.value);
  const nums = vals.filter(v => v.trim() !== '' && isFinite(Number(v))).map(Number);
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const suggested = avg == null ? null : String(DECK.find(c => c >= avg) ?? Math.ceil(avg));
  return {
    avg: avg == null ? null : Math.round(avg * 100) / 100,
    suggested, counts,
    consensus: vals.length >= 2 && new Set(vals).size === 1,
  };
}

function cancelTimer(room) {
  clearTimeout(room.timer); room.timer = null; room.revealAt = null;
}

function doReveal(room) {
  cancelTimer(room);
  const round = curRound(room, true);
  if (!round || round.revealed) return;
  round.revealed = true;
  const { suggested } = computeResult(round);
  if (suggested != null) setEstimate(room, curStory(room), suggested);
  touch(room);
  broadcast(room);
}

// start/cancel auto-reveal countdown depending on current round state
function evaluate(room) {
  const round = curRound(room);
  const active = Object.entries(room.players).filter(([, p]) => p.conns > 0 && !p.spectator);
  if (round && !round.revealed && active.length && active.every(([pid]) => pid in round.votes)) {
    if (!room.timer) {
      room.revealAt = Date.now() + COUNTDOWN;
      room.timer = setTimeout(() => doReveal(room), COUNTDOWN);
    }
  } else if (room.timer) cancelTimer(room);
}

function publicState(room) {
  const col = n => findHeader(room.headers, n);
  const stories = room.stories.map(s => {
    const rd = room.rounds[s._id];
    return {
      id: s._id,
      key: s[col('Key')] || '',
      title: s[col('Description')] || '',
      summary: s[col('Summary')] || '',
      link: s[col('Link')] || '',
      estimate: s[col('Estimate')] || '',
      voteCount: rd ? Object.keys(rd.votes).length : 0,
      revealed: !!(rd && rd.revealed),
    };
  });
  const round = curRound(room);
  const votes = round ? round.votes : {};
  const revealed = !!(round && round.revealed);
  const players = Object.entries(room.players).map(([pid, p]) => ({
    pid, name: p.name, spectator: !!p.spectator, online: p.conns > 0,
    voted: pid in votes, vote: revealed && votes[pid] ? votes[pid].value : null,
  }));
  for (const [pid, v] of Object.entries(votes)) {
    if (pid in room.players) continue;
    players.push({ pid, name: v.name, spectator: false, online: false, voted: true, vote: revealed ? v.value : null });
  }
  return {
    now: Date.now(), stories, current: room.current, revealed, revealAt: room.revealAt,
    players, result: revealed ? computeResult(round) : null,
  };
}

function broadcast(room) {
  const data = 'data: ' + JSON.stringify(publicState(room)) + '\n\n';
  for (const res of room.clients) res.write(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', big = false;
    req.on('data', c => {
      if (big) return;
      b += c;
      if (b.length > MAX_BODY) { big = true; b = ''; reject({ status: 413 }); }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const PID_RE = /^(?!__proto__$)[\w-]{1,64}$/;
const isIdx = (room, i) => Number.isInteger(i) && i >= 0 && i < room.stories.length;

function handleAction(room, pid, a) {
  const player = room.players[pid];
  switch (a.type) {
    case 'vote': {
      const round = curRound(room, true);
      if (!round || round.revealed || (player && player.spectator)) return;
      if (a.value == null) delete round.votes[pid];
      else round.votes[pid] = { value: String(a.value).slice(0, 8), name: player ? player.name : 'anon' };
      break;
    }
    case 'reveal':
      if (curRound(room, true)) doReveal(room);
      break;
    case 'reset': {
      const round = curRound(room);
      if (round) room.rounds[curStory(room)._id] = { votes: {}, revealed: false };
      cancelTimer(room);
      break;
    }
    case 'select':
      if (isIdx(room, a.index)) { room.current = a.index; cancelTimer(room); }
      break;
    case 'estimate': {
      const s = curStory(room);
      if (s) setEstimate(room, s, a.value);
      break;
    }
    case 'spectator': {
      if (!player) return;
      player.spectator = !!a.value;
      const round = curRound(room);
      if (player.spectator && round && !round.revealed) delete round.votes[pid];
      break;
    }
    case 'import': {
      const rows = parseCSV(String(a.csv || ''));
      if (rows.length < 1) return;
      const headers = rows[0].map(h => h.trim().slice(0, 200));
      if (!findHeader(headers, 'Estimate')) headers.push('Estimate');
      room.headers = headers;
      room.stories = rows.slice(1).map(r => {
        const s = Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').slice(0, MAX_FIELD)]));
        s._id = newId();
        return s;
      });
      room.current = room.stories.length ? 0 : -1;
      room.rounds = {};
      cancelTimer(room);
      break;
    }
    case 'add': {
      const s = Object.fromEntries(room.headers.map(x => [x, '']));
      applyFields(room, s, a.fields);
      s._id = newId();
      room.stories.push(s);
      if (room.current < 0) room.current = 0;
      break;
    }
    case 'edit':
      if (isIdx(room, a.index)) applyFields(room, room.stories[a.index], a.fields);
      break;
    case 'delete': {
      if (!isIdx(room, a.index)) return;
      const [gone] = room.stories.splice(a.index, 1);
      delete room.rounds[gone._id];
      if (a.index < room.current) room.current--;
      else if (a.index === room.current) {
        room.current = Math.min(room.current, room.stories.length - 1);
        cancelTimer(room);
      }
      break;
    }
    default: return; // unknown: ignore
  }
  touch(room);
}

// ---- http ----
function authOk(key) {
  if (!PASSWORD) return true;
  const h = s => crypto.createHash('sha256').update(String(s)).digest(); // equal length for timingSafeEqual
  return crypto.timingSafeEqual(h(key || ''), h(PASSWORD));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://x');
  const q = n => url.searchParams.get(n);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (!authOk(q('key'))) { res.writeHead(401); return res.end('unauthorized'); }

  const room = q('room');
  if (!room) { res.writeHead(400); return res.end('missing room'); }
  if (!/^[\w-]{1,40}$/.test(room)) { res.writeHead(400); return res.end('bad room'); }

  if (req.method === 'GET' && url.pathname === '/export') {
    const r = rooms.get(room) || newRoom();
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="estimates-${room}.csv"`,
    });
    return res.end(toCSV(r.headers, r.stories));
  }

  const pidOk = PID_RE.test(q('pid') || '');

  if (req.method === 'GET' && url.pathname === '/events') {
    const pid = q('pid');
    if (!pidOk) { res.writeHead(400); return res.end('bad pid'); }
    const name = (q('name') || '').trim().slice(0, 40) || 'anon';
    const r = getRoom(room);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const p = r.players[pid] = r.players[pid] || { name, conns: 0, spectator: false };
    p.name = name;
    p.conns++;
    r.clients.add(res);
    evaluate(r);
    broadcast(r);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      r.clients.delete(res);
      if (r.players[pid] !== p || --p.conns > 0) return;
      evaluate(r);
      broadcast(r);
      // grace period so page reloads / reconnects don't drop the vote
      setTimeout(() => {
        if (r.players[pid] !== p || p.conns > 0) return;
        delete r.players[pid];
        const round = curRound(r);
        if (round && !round.revealed) { delete round.votes[pid]; touch(r); }
        evaluate(r);
        broadcast(r);
      }, GRACE);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/action') {
    try {
      const a = JSON.parse(await readBody(req));
      if (!a || typeof a !== 'object') throw new Error('bad body');
      const pid = a.pid ?? q('pid'); // pid from body (query also accepted)
      if (!PID_RE.test(pid || '')) { res.writeHead(400); return res.end('bad pid'); }
      const r = getRoom(room);
      handleAction(r, pid, a);
      evaluate(r);
      broadcast(r);
      res.writeHead(204); return res.end();
    } catch (e) {
      if (e && e.status === 413) { res.writeHead(413, { Connection: 'close' }); return res.end('too large'); }
      res.writeHead(400); return res.end(String(e && e.message || e));
    }
  }

  res.writeHead(404); res.end('not found');
});

load();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log(`Planning poker on http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`LAN: http://${i.address}:${PORT}`);
  console.log(`Public: ngrok http ${PORT}`);
  console.log(PASSWORD ? 'Password protection: ON (use ?key=...)' : 'Password protection: OFF');
});
