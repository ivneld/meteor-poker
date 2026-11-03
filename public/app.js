import { startFire } from './fire.js';

const $ = (id) => document.getElementById(id);
const fire = startFire($('fire'));

const NAME_KEY = 'scrum-poker:name';
const CLIENT_KEY = 'scrum-poker:client';
const PASSWORD_KEY = 'scrum-poker:created-password';
const MAX_RECONNECT_MS = 8000;
// 방 화면에서는 카드를 고르는 데 방해되지 않게 불길을 낮춘다.
const ROOM_FIRE = 0.55;

const storage = {
  get(area, key) {
    try {
      return area.getItem(key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      area.setItem(key, value);
    } catch {
      // 사생활 보호 모드 등에서는 이번 접속 동안만 값을 유지한다.
    }
  },
};

// 탭마다 별개의 참가자가 되도록 sessionStorage에 둔다.
// crypto.randomUUID는 http://<LAN IP> 같은 비보안 출처에서 쓸 수 없다.
function clientId() {
  let id = storage.get(sessionStorage, CLIENT_KEY);
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    storage.set(sessionStorage, CLIENT_KEY, id);
  }
  return id;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

const LOCK_ICON = '<svg class="lock" viewBox="0 0 16 16" aria-label="비밀번호 필요" role="img"><rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const ROOM_LIST_REFRESH_MS = 5000;

function showHomeError(message) {
  $('home-error').textContent = message;
  $('home-error').hidden = false;
}

async function refreshRoomList() {
  let rooms;
  try {
    const response = await fetch('/api/rooms');
    if (!response.ok) return;
    rooms = await response.json();
  } catch {
    return;
  }
  $('room-empty').hidden = rooms.length > 0;
  $('room-list').replaceChildren(...rooms.map((room) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/r/${room.id}`;
    const title = document.createElement('span');
    title.className = 'room-title';
    title.textContent = room.name;
    const meta = document.createElement('span');
    meta.className = 'room-meta';
    meta.textContent = `${room.participants}명`;
    link.append(title, meta);
    if (room.locked) link.insertAdjacentHTML('beforeend', LOCK_ICON);
    item.append(link);
    return item;
  }));
}

function showHome(missingRoom) {
  $('home').hidden = false;
  if (missingRoom) showHomeError(`${missingRoom}번 방을 찾을 수 없습니다. 목록에서 다른 방을 고르거나 새 방을 만드세요.`);

  refreshRoomList();
  setInterval(refreshRoomList, ROOM_LIST_REFRESH_MS);

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('create-room').disabled = true;
    const password = $('room-password').value;
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('room-name').value, password }),
      });
      if (!response.ok) throw new Error(response.statusText);
      const { id } = await response.json();
      // 방을 만든 사람이 비밀번호를 한 번 더 입력하지 않도록 이 탭에만 잠시 넘겨준다.
      if (password) storage.set(sessionStorage, `${PASSWORD_KEY}:${id}`, password);
      location.href = `/r/${id}`;
    } catch {
      showHomeError('방을 만들지 못했습니다. 서버 연결을 확인하고 다시 시도하세요.');
      $('create-room').disabled = false;
    }
  });
}

async function showRoom(roomId) {
  const response = await fetch(`/api/rooms/${roomId}`);
  if (response.status === 404) {
    location.replace(`/?missing=${roomId}`);
    return;
  }
  const room = await response.json();
  const savedName = storage.get(localStorage, NAME_KEY);
  const createdPassword = storage.get(sessionStorage, `${PASSWORD_KEY}:${roomId}`);
  try {
    sessionStorage.removeItem(`${PASSWORD_KEY}:${roomId}`);
  } catch {
    // 저장소를 쓸 수 없으면 지울 것도 없다.
  }

  function showEntry(error) {
    $('room-view').hidden = true;
    $('name-view').hidden = false;
    $('name-title').textContent = room.name;
    $('password-field').hidden = !room.locked;
    $('password-input').required = room.locked;
    $('entry-error').textContent = error ?? '';
    $('entry-error').hidden = !error;
    const nameFilled = Boolean($('name-input').value.trim());
    (nameFilled && room.locked ? $('password-input') : $('name-input')).focus();
  }

  const session = enterRoom(roomId, (triedPassword) => {
    $('password-input').value = '';
    // 비밀번호 없이 재접속을 먼저 시도했다 거절된 경우라면 오류 없이 입력만 받는다.
    showEntry(triedPassword ? '비밀번호가 맞지 않습니다. 다시 입력하세요.' : undefined);
  });

  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('name-input').value.trim();
    if (!name) return;
    storage.set(localStorage, NAME_KEY, name);
    $('entry-error').hidden = true;
    session.join(name, $('password-input').value);
  });

  $('name-input').value = savedName ?? '';
  $('password-input').value = createdPassword ?? '';
  // 이 탭이 이미 방에 있던 참가자라면 서버가 비밀번호 없이 재접속을 받아준다.
  const mayBeMember = Boolean(storage.get(sessionStorage, CLIENT_KEY));
  if (savedName && (!room.locked || createdPassword || mayBeMember)) {
    session.join(savedName, createdPassword ?? '');
  } else {
    showEntry();
  }
}

function enterRoom(roomId, onDenied) {
  let name = '';
  let password = '';
  let socket = null;
  let attempts = 0;
  let leaving = false;
  let state = null;
  let renderedDeck = '';
  const seats = new Map();

  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws?room=${roomId}`);
    socket.addEventListener('open', () => {
      attempts = 0;
      $('banner').hidden = true;
      send({ type: 'join', clientId: clientId(), name, password });
    });
    socket.addEventListener('message', (event) => {
      state = JSON.parse(event.data);
      $('name-view').hidden = true;
      $('room-view').hidden = false;
      fire.setIntensity(ROOM_FIRE);
      render();
    });
    socket.addEventListener('close', (event) => {
      if (leaving) {
        location.href = '/';
        return;
      }
      if (event.code === 4003) {
        onDenied(password);
        return;
      }
      if (event.code === 4004) {
        location.replace(`/?missing=${roomId}`);
        return;
      }
      if (event.code === 4001) {
        $('banner').textContent = '다른 탭에서 이 방을 열어서 이 탭의 연결을 닫았습니다.';
        $('banner').hidden = false;
        return;
      }
      $('banner').textContent = '연결이 끊겼습니다. 다시 연결하는 중입니다.';
      $('banner').hidden = false;
      setTimeout(connect, Math.min(500 * 2 ** attempts++, MAX_RECONNECT_MS));
    });
  }

  function makeSeat(pid) {
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.innerHTML = `
      <div class="flip"><div class="face back"></div><div class="face front"></div></div>
      <div class="who"><span class="seat-name"></span><span class="seat-host" hidden>방장</span></div>`;
    seats.set(pid, seat);
    $('seats').append(seat);
    return seat;
  }

  function renderSeats() {
    const present = new Set(state.participants.map(({ pid }) => pid));
    for (const [pid, seat] of seats) {
      if (!present.has(pid)) {
        seat.remove();
        seats.delete(pid);
      }
    }
    for (const participant of state.participants) {
      const seat = seats.get(participant.pid) ?? makeSeat(participant.pid);
      seat.classList.toggle('voted', participant.voted);
      seat.classList.toggle('revealed', state.room.revealed && participant.voted);
      seat.classList.toggle('offline', !participant.online);
      seat.classList.toggle('me', participant.pid === state.you.pid);
      // 뒤집히는 동안 앞면이 비어 보이지 않도록 다음 공개 전까지 값을 남겨둔다.
      if (participant.vote !== null) seat.querySelector('.front').textContent = participant.vote;
      seat.querySelector('.seat-name').textContent = participant.name;
      seat.querySelector('.seat-host').hidden = !participant.isHost;
      seat.title = participant.online ? participant.name : `${participant.name} (연결 끊김)`;
    }
  }

  function renderHand() {
    const deckKey = state.room.deck.join('\n');
    if (deckKey !== renderedDeck) {
      renderedDeck = deckKey;
      $('hand').replaceChildren(...state.room.deck.map((card) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card';
        button.textContent = card;
        button.dataset.card = card;
        button.addEventListener('click', () => {
          send({ type: 'vote', value: state.you.vote === card ? null : card });
        });
        return button;
      }));
    }
    for (const button of $('hand').children) {
      const selected = button.dataset.card === state.you.vote;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = state.room.revealed;
    }
  }

  function renderResult() {
    const { stats } = state;
    $('result').hidden = !stats;
    if (!stats) return;
    $('consensus').hidden = !stats.consensus;
    $('numbers').hidden = stats.average === null;
    $('average').textContent = stats.average ?? '';
    $('median').textContent = stats.median ?? '';
    $('counts').replaceChildren(...stats.counts.map(({ value, count }) => {
      const item = document.createElement('li');
      item.textContent = `${value} 카드 ${count}명`;
      return item;
    }));
  }

  function renderActions() {
    const { room, you, participants } = state;
    const voted = participants.filter((participant) => participant.voted).length;
    $('reveal').hidden = room.revealed || !you.canControl;
    $('reveal').disabled = voted === 0;
    $('clear').hidden = !room.revealed || !you.canControl;
    if (room.revealed) {
      $('status').textContent = you.canControl ? '' : '방장이 다음 라운드를 시작하면 다시 투표합니다.';
    } else if (voted === 0) {
      $('status').textContent = '아래에서 카드를 고르세요.';
    } else {
      const waiting = you.canControl ? '' : ' 방장이 카드를 공개합니다.';
      $('status').textContent = `${participants.length}명 중 ${voted}명 투표 완료.${waiting}`;
    }
  }

  function renderSide() {
    const { room, you } = state;
    $('room-label').textContent = room.name;
    $('room-number').textContent = room.id;
    $('join-url').textContent = room.joinUrl;
    $('join-url').href = room.joinUrl;
    $('rename').textContent = name;
    $('settings').hidden = !you.isHost;
    $('host-only').checked = room.hostOnly;
    if (document.activeElement !== $('deck-select')) $('deck-select').value = room.deckId;
    $('custom-deck').hidden = $('deck-select').value !== 'custom';
  }

  function render() {
    renderSeats();
    renderHand();
    renderResult();
    renderActions();
    renderSide();
  }

  $('reveal').addEventListener('click', () => send({ type: 'reveal' }));
  $('clear').addEventListener('click', () => send({ type: 'clear' }));
  $('invite-toggle').addEventListener('click', () => $('side').classList.add('open'));

  $('leave').addEventListener('click', () => {
    leaving = true;
    $('leave').disabled = true;
    if (socket?.readyState !== WebSocket.OPEN) {
      location.href = '/';
      return;
    }
    // 서버가 퇴장을 처리하고 연결을 닫으면 close 핸들러가 시작 화면으로 보낸다.
    send({ type: 'leave' });
    setTimeout(() => { location.href = '/'; }, 1500);
  });
  $('side-close').addEventListener('click', () => $('side').classList.remove('open'));

  $('rename').addEventListener('click', () => {
    const entered = prompt('새 이름', name)?.trim();
    if (!entered) return;
    name = entered;
    storage.set(localStorage, NAME_KEY, name);
    $('rename').textContent = name;
    send({ type: 'rename', name });
  });

  $('copy').addEventListener('click', async () => {
    await copyText(state.room.joinUrl);
    $('copy').textContent = '링크 복사됨';
    setTimeout(() => { $('copy').textContent = '링크 복사'; }, 1500);
  });

  $('deck-select').addEventListener('change', () => {
    const deckId = $('deck-select').value;
    $('custom-deck').hidden = deckId !== 'custom';
    if (deckId !== 'custom') send({ type: 'settings', deckId });
  });

  $('custom-deck').addEventListener('submit', (event) => {
    event.preventDefault();
    const cards = [...new Set($('custom-input').value.split(',').map((card) => card.trim()).filter(Boolean))];
    const valid = cards.length >= 2 && cards.length <= 20 && cards.every((card) => [...card].length <= 3);
    $('custom-error').textContent = '카드는 2~20장, 카드당 3자 이내로 입력하세요.';
    $('custom-error').hidden = valid;
    if (valid) send({ type: 'settings', deckId: 'custom', cards });
  });

  $('host-only').addEventListener('change', () => {
    send({ type: 'settings', hostOnly: $('host-only').checked });
  });

  $('qr').src = `/qr/${roomId}.svg`;

  return {
    join(enteredName, enteredPassword) {
      // 입장 버튼을 연달아 눌러도 연결은 하나만 연다.
      if (socket && socket.readyState !== WebSocket.CLOSED) return;
      name = enteredName;
      password = enteredPassword;
      connect();
    },
  };
}

const roomMatch = location.pathname.match(/^\/r\/(\d{4})$/);
if (roomMatch) {
  showRoom(roomMatch[1]);
} else {
  showHome(new URLSearchParams(location.search).get('missing')?.replace(/\D/g, '').slice(0, 4));
}
