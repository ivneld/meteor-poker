import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp, summarize } from '../server.js';

async function startServer(options) {
  const app = createApp({ wrongPasswordDelayMs: 0, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return { app, port, base: `http://127.0.0.1:${port}` };
}

// 연결이 끊긴 참가자가 빨리 빠지도록 유예를 짧게 둔 서버
let server;
// 유예가 짧으면 나가기 없이도 빠지므로, 나가기는 유예가 긴 서버에서 확인한다.
let longGraceServer;

before(async () => {
  server = await startServer({ graceMs: 100 });
  longGraceServer = await startServer({ graceMs: 60_000 });
});

after(() => Promise.all([server.app.close(), longGraceServer.app.close()]));

async function createRoom(body, target = server) {
  const response = await fetch(`${target.base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

class Player {
  constructor(roomId, clientId, name, password, target = server) {
    this.states = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${target.port}/ws?room=${roomId}`);
    this.ws.on('message', (data) => {
      this.states.push(JSON.parse(data));
      this.waiters.splice(0).forEach((resolve) => resolve());
    });
    this.closed = new Promise((resolve) => this.ws.on('close', resolve));
    this.ready = new Promise((resolve) => this.ws.on('open', () => {
      this.send({ type: 'join', clientId, name, password });
      resolve();
    }));
  }

  get state() {
    return this.states.at(-1);
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async until(predicate) {
    while (!this.state || !predicate(this.state)) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    return this.state;
  }
}

const seat = (roomId, ...names) => seatOn(server, roomId, ...names);

async function seatOn(target, roomId, ...names) {
  const players = [];
  for (const name of names) {
    const player = new Player(roomId, `client-${name}-${roomId}`, name, undefined, target);
    await player.ready;
    await player.until((state) => state.participants.some((other) => other.name === name));
    players.push(player);
  }
  return players;
}

const named = (state, name) => state.participants.find((participant) => participant.name === name);

test('투표값은 공개 전까지 다른 참가자에게 전달되지 않는다', async () => {
  const [alice, bob] = await seat(await createRoom(), 'alice', 'bob');

  alice.send({ type: 'vote', value: '8' });
  const state = await bob.until((current) => named(current, 'alice').voted);
  assert.doesNotMatch(JSON.stringify(state.participants), /"8"/);
  assert.equal(named(state, 'alice').vote, null);
  assert.equal(state.stats, null);

  bob.send({ type: 'vote', value: '3' });
  await alice.until((current) => named(current, 'bob').voted);
  alice.send({ type: 'reveal' });
  const revealed = await bob.until((current) => current.room.revealed);
  assert.equal(named(revealed, 'alice').vote, '8');
  assert.equal(revealed.stats.average, 5.5);
  assert.equal(revealed.stats.median, 5.5);
});

test('공개 후 투표를 막고 다음 라운드에서 초기화한다', async () => {
  const [alice, bob] = await seat(await createRoom(), 'alice', 'bob');
  alice.send({ type: 'vote', value: '5' });
  await alice.until((state) => state.you.vote === '5');
  bob.send({ type: 'reveal' });
  await alice.until((state) => state.room.revealed);

  alice.send({ type: 'vote', value: '1' });
  bob.send({ type: 'clear' });
  const cleared = await alice.until((state) => !state.room.revealed);
  assert.equal(cleared.you.vote, null);
  assert.equal(named(cleared, 'alice').voted, false);
});

test('투표가 없으면 공개되지 않고 덱에 없는 카드는 거부한다', async () => {
  const [alice] = await seat(await createRoom(), 'alice');
  alice.send({ type: 'reveal' });
  alice.send({ type: 'vote', value: '999' });
  alice.send({ type: 'rename', name: 'alice2' });
  const state = await alice.until((current) => named(current, 'alice2'));
  assert.equal(state.room.revealed, false);
  assert.equal(state.you.vote, null);
});

test('방장 전용 설정을 켜면 참가자는 공개할 수 없다', async () => {
  const [host, guest] = await seat(await createRoom(), 'host', 'guest');
  assert.equal(host.state.you.isHost, true);

  guest.send({ type: 'settings', hostOnly: true });
  guest.send({ type: 'rename', name: 'guest2' });
  await host.until((state) => named(state, 'guest2'));
  assert.equal(host.state.room.hostOnly, false);

  host.send({ type: 'settings', hostOnly: true });
  await guest.until((state) => state.room.hostOnly);
  assert.equal(guest.state.you.canControl, false);

  host.send({ type: 'vote', value: '5' });
  await guest.until((state) => named(state, 'host').voted);
  guest.send({ type: 'reveal' });
  guest.send({ type: 'rename', name: 'guest3' });
  await host.until((state) => named(state, 'guest3'));
  assert.equal(host.state.room.revealed, false);

  host.send({ type: 'reveal' });
  await guest.until((state) => state.room.revealed);
});

test('덱 변경은 투표를 지우고 잘못된 직접 입력 덱은 거부한다', async () => {
  const [host] = await seat(await createRoom(), 'host');
  host.send({ type: 'vote', value: '5' });
  await host.until((state) => state.you.vote === '5');

  host.send({ type: 'settings', deckId: 'custom', cards: ['TOO LONG', 'A'] });
  host.send({ type: 'settings', deckId: '__proto__' });
  host.send({ type: 'settings', deckId: 'custom', cards: ['A', 'B', 'A'] });
  const state = await host.until((current) => current.room.deckId === 'custom');
  assert.deepEqual(state.room.deck, ['A', 'B']);
  assert.equal(state.you.vote, null);
});

test('유예 시간 안에 재접속하면 투표가 유지된다', async () => {
  const roomId = await createRoom();
  const [alice, bob] = await seat(roomId, 'alice', 'bob');
  alice.send({ type: 'vote', value: '5' });
  await bob.until((state) => named(state, 'alice').voted);

  alice.ws.terminate();
  await bob.until((state) => !named(state, 'alice').online);
  const [again] = await seat(roomId, 'alice');
  const state = await again.until((current) => current.you.vote === '5');
  assert.equal(named(state, 'alice').online, true);
  assert.equal(state.you.isHost, true);
  assert.equal(state.participants.length, 2);
});

test('같은 참가자가 새로 접속하면 이전 소켓을 닫는다', async () => {
  const roomId = await createRoom();
  const [first] = await seat(roomId, 'alice');
  await seat(roomId, 'alice');
  assert.equal(await new Promise((resolve) => first.ws.on('close', resolve)), 4001);
});

test('방장이 떠나면 남은 참가자가 방장이 된다', async () => {
  const [host, guest] = await seat(await createRoom(), 'host', 'guest');
  host.ws.terminate();
  const state = await guest.until((current) => current.participants.length === 1);
  assert.equal(state.you.isHost, true);
});

test('방 목록은 이름, 인원, 잠금 여부만 알려준다', async () => {
  const openId = await createRoom({ name: '  결제팀 스프린트  ' });
  const lockedId = await createRoom({ password: 'secret' });
  await seat(openId, 'alice');

  const rooms = await (await fetch(`${server.base}/api/rooms`)).json();
  const open = rooms.find((room) => room.id === openId);
  const locked = rooms.find((room) => room.id === lockedId);
  assert.deepEqual(open, { id: openId, name: '결제팀 스프린트', locked: false, participants: 1 });
  assert.deepEqual(locked, { id: lockedId, name: `방 ${lockedId}`, locked: true, participants: 0 });
  assert.ok(rooms.indexOf(locked) < rooms.indexOf(open), '최근에 만든 방이 먼저 나온다');
  assert.doesNotMatch(JSON.stringify(rooms), /secret|salt|hash/);
});

test('잘못된 방 생성 요청은 400', async () => {
  for (const body of ['{', JSON.stringify({ password: 1 }), JSON.stringify({ password: 'x'.repeat(65) })]) {
    const response = await fetch(`${server.base}/api/rooms`, { method: 'POST', body });
    assert.equal(response.status, 400);
  }
});

test('비밀번호가 걸린 방은 틀린 비밀번호로 들어갈 수 없다', async () => {
  const roomId = await createRoom({ password: 'secret' });
  for (const password of [undefined, '', 'wrong']) {
    const intruder = new Player(roomId, `intruder-${password}`, 'intruder', password);
    assert.equal(await intruder.closed, 4003);
    assert.equal(intruder.states.length, 0);
  }

  const member = new Player(roomId, 'member', 'member', 'secret');
  await member.ready;
  const state = await member.until((current) => named(current, 'member'));
  assert.equal(state.participants.length, 1);
});

test('비밀번호 방에 이미 있는 참가자는 비밀번호 없이 재접속한다', async () => {
  const roomId = await createRoom({ password: 'secret' });
  const first = new Player(roomId, 'member', 'member', 'secret');
  await first.ready;
  await first.until((state) => named(state, 'member'));
  first.ws.terminate();

  const again = new Player(roomId, 'member', 'member');
  await again.ready;
  const state = await again.until((current) => named(current, 'member')?.online);
  assert.equal(state.participants.length, 1);
});

test('나가기를 누르면 유예 없이 바로 빠지고 방장이 넘어간다', async () => {
  const [host, guest] = await seatOn(longGraceServer, await createRoom(undefined, longGraceServer), 'host', 'guest');
  host.send({ type: 'leave' });
  assert.equal(await host.closed, 1000);
  const state = await guest.until((current) => current.participants.length === 1);
  assert.equal(state.you.isHost, true);
});

test('없는 방은 404이고 소켓은 4004로 닫힌다', async () => {
  assert.equal((await fetch(`${server.base}/api/rooms/0000`)).status, 404);
  assert.equal((await fetch(`${server.base}/qr/0000.svg`)).status, 404);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?room=0000`);
  assert.equal(await new Promise((resolve) => ws.on('close', resolve)), 4004);
});

test('QR은 SVG로 제공되고 공유 링크는 localhost가 아니다', async () => {
  const roomId = await createRoom();
  const response = await fetch(`${server.base}/qr/${roomId}.svg`);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.match(await response.text(), /<svg/);

  const [alice] = await seat(roomId, 'alice');
  assert.match(alice.state.room.joinUrl, new RegExp(`/r/${roomId}$`));
  assert.doesNotMatch(alice.state.room.joinUrl, /127\.0\.0\.1|localhost/);
});

test('summarize는 숫자가 아닌 카드를 평균에서 제외한다', () => {
  assert.deepEqual(summarize(['3', '?', '5', '☕']).average, 4);
  assert.equal(summarize(['XS', 'L']).average, null);
  assert.equal(summarize(['5', '5']).consensus, true);
  assert.equal(summarize(['5']).consensus, false);
  assert.equal(summarize(['1', '2', '100']).median, 2);
});
