import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/fire.js': ['fire.js', 'text/javascript; charset=utf-8'],
  '/meteor.png': ['meteor.png', 'image/png'],
};

export const DECKS = {
  standard: ['0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'],
  fibonacci: ['1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'],
  powers: ['1', '2', '4', '8', '16', '32', '?', '☕'],
};

const MAX_NAME_LENGTH = 20;
const MAX_ROOM_NAME_LENGTH = 30;
const MAX_PASSWORD_LENGTH = 64;
const MAX_BODY_BYTES = 4096;
const MAX_CARD_LENGTH = 3;
const MAX_CUSTOM_CARDS = 20;
const HEARTBEAT_MS = 15_000;
const SWEEP_MS = 60_000;

const sliceChars = (value, length) => [...value].slice(0, length).join('');

function parseName(value, length = MAX_NAME_LENGTH) {
  return typeof value === 'string' ? sliceChars(value.trim(), length) : '';
}

function hashPassword(password) {
  const salt = randomBytes(16);
  return { salt, hash: scryptSync(password, salt, 32) };
}

function verifyPassword({ salt, hash }, password) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  return timingSafeEqual(scryptSync(password, salt, 32), hash);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) return null;
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return null;
  }
}

function parseCustomDeck(value) {
  if (!Array.isArray(value)) return null;
  const cards = [...new Set(value.map((card) => (typeof card === 'string' ? card.trim() : '')))];
  const valid = cards.length >= 2
    && cards.length <= MAX_CUSTOM_CARDS
    && cards.every((card) => card && [...card].length <= MAX_CARD_LENGTH);
  return valid ? cards : null;
}

export function summarize(votes) {
  const counts = new Map();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  const numbers = votes.filter((vote) => /^-?\d+(\.\d+)?$/.test(vote)).map(Number).sort((a, b) => a - b);

  let average = null;
  let median = null;
  if (numbers.length > 0) {
    const middle = Math.floor(numbers.length / 2);
    const sum = numbers.reduce((total, number) => total + number, 0);
    average = Math.round((sum / numbers.length) * 10) / 10;
    median = numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  }

  return {
    average,
    median,
    consensus: votes.length > 1 && counts.size === 1,
    counts: [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
  };
}

function lanAddress() {
  const candidates = Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ ...address, name })))
    .filter(({ family, internal }) => family === 'IPv4' && !internal);
  // Wi-Fi/이더넷을 VPN(utun)이나 가상 브리지보다 우선한다.
  return (candidates.find(({ name }) => /^(en|eth|wlan)/.test(name)) ?? candidates[0])?.address;
}

function publicBase(req, port) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers.host ?? `localhost:${port}`;
  const lan = lanAddress();
  // localhost로 연 사람이 공유한 링크는 다른 기기에서 열리지 않으므로 LAN 주소로 바꾼다.
  if (lan && /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) return `http://${lan}:${port}`;
  const protocol = req.headers['x-forwarded-proto']?.split(',')[0] ?? 'http';
  return `${protocol}://${host}`;
}

export function createApp({ graceMs = 60_000, emptyRoomMs = 30 * 60_000, wrongPasswordDelayMs = 1000 } = {}) {
  const rooms = new Map();

  function createRoom({ name, password }) {
    if (rooms.size >= 9000) return null;
    let id;
    do {
      id = String(1000 + (randomBytes(2).readUInt16BE() % 9000));
    } while (rooms.has(id));
    const room = {
      id,
      name: parseName(name, MAX_ROOM_NAME_LENGTH) || `방 ${id}`,
      password: password ? hashPassword(password) : null,
      createdAt: Date.now(),
      deckId: 'standard',
      deck: DECKS.standard,
      hostOnly: false,
      revealed: false,
      hostPid: null,
      participants: new Map(),
      emptySince: Date.now(),
    };
    rooms.set(id, room);
    return room;
  }

  const summaryOf = (room) => ({
    id: room.id,
    name: room.name,
    locked: room.password !== null,
    participants: room.participants.size,
  });

  function stateFor(room, participant) {
    const participants = [...room.participants.values()];
    return {
      type: 'state',
      room: {
        id: room.id,
        name: room.name,
        joinUrl: `${participant.base}/r/${room.id}`,
        deck: room.deck,
        deckId: room.deckId,
        hostOnly: room.hostOnly,
        revealed: room.revealed,
      },
      you: {
        pid: participant.pid,
        vote: participant.vote,
        isHost: room.hostPid === participant.pid,
        canControl: !room.hostOnly || room.hostPid === participant.pid,
      },
      participants: participants.map((other) => ({
        pid: other.pid,
        name: other.name,
        online: other.ws !== null,
        isHost: room.hostPid === other.pid,
        voted: other.vote !== null,
        // 공개 전에는 다른 사람의 투표값을 절대 내려보내지 않는다.
        vote: room.revealed ? other.vote : null,
      })),
      stats: room.revealed
        ? summarize(participants.map(({ vote }) => vote).filter((vote) => vote !== null))
        : null,
    };
  }

  function broadcast(room) {
    for (const participant of room.participants.values()) {
      if (participant.ws?.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify(stateFor(room, participant)));
      }
    }
  }

  function removeParticipant(room, participant) {
    room.participants.delete(participant.clientId);
    if (room.hostPid === participant.pid) {
      const remaining = [...room.participants.values()];
      room.hostPid = (remaining.find(({ ws }) => ws) ?? remaining[0])?.pid ?? null;
    }
    if (room.participants.size === 0) room.emptySince = Date.now();
    broadcast(room);
  }

  function clearVotes(room) {
    room.revealed = false;
    for (const participant of room.participants.values()) participant.vote = null;
  }

  function join(ws, room, base, message) {
    const clientId = typeof message.clientId === 'string' ? message.clientId.slice(0, 64) : '';
    const name = parseName(message.name);
    if (!clientId || !name) return null;

    let participant = room.participants.get(clientId);
    if (participant) {
      clearTimeout(participant.removeTimer);
      if (participant.ws && participant.ws !== ws) participant.ws.close(4001, 'replaced');
    } else {
      participant = { clientId, pid: randomBytes(6).toString('hex'), vote: null };
      room.participants.set(clientId, participant);
      room.hostPid ??= participant.pid;
    }
    Object.assign(participant, { ws, base, name });
    room.emptySince = null;
    return participant;
  }

  const handlers = {
    vote(room, participant, { value }) {
      if (room.revealed) return false;
      if (value !== null && !room.deck.includes(value)) return false;
      participant.vote = value;
      return true;
    },
    reveal(room, participant) {
      const hasVotes = [...room.participants.values()].some(({ vote }) => vote !== null);
      if (!canControl(room, participant) || !hasVotes) return false;
      room.revealed = true;
      return true;
    },
    clear(room, participant) {
      if (!canControl(room, participant)) return false;
      clearVotes(room);
      return true;
    },
    settings(room, participant, { deckId, cards, hostOnly }) {
      if (room.hostPid !== participant.pid) return false;
      if (typeof hostOnly === 'boolean') room.hostOnly = hostOnly;
      if (deckId !== undefined) {
        const deck = deckId === 'custom' ? parseCustomDeck(cards) : Object.hasOwn(DECKS, deckId) && DECKS[deckId];
        if (!deck) return false;
        Object.assign(room, { deckId, deck });
        clearVotes(room);
      }
      return true;
    },
    rename(room, participant, { name }) {
      const parsed = parseName(name);
      if (!parsed) return false;
      participant.name = parsed;
      return true;
    },
  };

  const canControl = (room, participant) => !room.hostOnly || room.hostPid === participant.pid;

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const port = server.address().port;
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'POST' && pathname === '/api/rooms') {
        const body = await readJson(req);
        const valid = body
          && (body.name === undefined || typeof body.name === 'string')
          && (body.password === undefined || (typeof body.password === 'string' && body.password.length <= MAX_PASSWORD_LENGTH));
        if (!valid) return sendJson(400, { error: 'invalid_request' });
        const room = createRoom(body);
        return room ? sendJson(201, summaryOf(room)) : sendJson(503, { error: 'no_rooms_available' });
      }
      if (req.method !== 'GET') return sendJson(405, { error: 'method_not_allowed' });

      if (pathname === '/api/rooms') {
        return sendJson(200, [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(summaryOf));
      }

      const roomMatch = pathname.match(/^\/api\/rooms\/(\d{4})$/);
      if (roomMatch) {
        const room = rooms.get(roomMatch[1]);
        return room ? sendJson(200, summaryOf(room)) : sendJson(404, { error: 'room_not_found' });
      }

      const qrMatch = pathname.match(/^\/qr\/(\d{4})\.svg$/);
      if (qrMatch) {
        if (!rooms.has(qrMatch[1])) return sendJson(404, { error: 'room_not_found' });
        const svg = await QRCode.toString(`${publicBase(req, port)}/r/${qrMatch[1]}`, { type: 'svg', margin: 1 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }

      const file = STATIC_FILES[pathname];
      if (file) {
        res.writeHead(200, { 'Content-Type': file[1] });
        return res.end(await readFile(path.join(PUBLIC_DIR, file[0])));
      }
      if (pathname === '/' || /^\/r\/\d{4}$/.test(pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(await readFile(path.join(PUBLIC_DIR, 'index.html')));
      }
      sendJson(404, { error: 'not_found' });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(500, { error: 'internal_error' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', (ws, req) => {
    const roomId = new URL(req.url, 'http://localhost').searchParams.get('room');
    const room = rooms.get(roomId);
    if (!room) return ws.close(4004, 'room_not_found');

    const base = publicBase(req, server.address().port);
    let participant = null;
    let denied = false;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
      if (denied) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.type === 'join') {
        // 이미 방에 있는 참가자의 재접속은 비밀번호를 다시 묻지 않는다.
        const known = participant || room.participants.has(message.clientId);
        if (!known && room.password && !verifyPassword(room.password, message.password)) {
          denied = true;
          setTimeout(() => ws.close(4003, 'wrong_password'), wrongPasswordDelayMs);
          return;
        }
        participant = join(ws, room, base, message) ?? participant;
        if (participant) broadcast(room);
        return;
      }
      if (message?.type === 'leave') {
        if (participant) removeParticipant(room, participant);
        // close 핸들러가 유예 타이머를 다시 걸지 않도록 연결을 먼저 끊어둔다.
        participant = null;
        ws.close(1000, 'left');
        return;
      }
      if (!participant || !Object.hasOwn(handlers, message?.type)) return;
      if (handlers[message.type](room, participant, message)) broadcast(room);
    });

    ws.on('close', () => {
      // 재접속으로 소켓이 교체된 뒤에 도착한 이전 소켓의 close는 무시한다.
      if (!participant || participant.ws !== ws) return;
      const leaving = participant;
      leaving.ws = null;
      // unref: 서버를 닫을 때 남은 유예 타이머가 프로세스 종료를 막지 않게 한다.
      leaving.removeTimer = setTimeout(() => removeParticipant(room, leaving), graceMs).unref();
      broadcast(room);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const sweep = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.emptySince !== null && Date.now() - room.emptySince > emptyRoomMs) rooms.delete(room.id);
    }
  }, SWEEP_MS);

  return {
    server,
    close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const room of rooms.values()) {
        for (const participant of room.participants.values()) clearTimeout(participant.removeTimer);
      }
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createApp();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Local:   http://localhost:${port}`);
    const lan = lanAddress();
    if (lan) console.log(`Network: http://${lan}:${port}`);
    if (process.env.PUBLIC_URL) console.log(`Public:  ${process.env.PUBLIC_URL}`);
  });
}
