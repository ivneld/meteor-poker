const $ = (id) => document.getElementById(id);

const NAME_KEY = 'scrum-poker:name';
const CLIENT_KEY = 'scrum-poker:client';
const MAX_RECONNECT_MS = 8000;

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

function showHome(missingRoom) {
  $('home').hidden = false;
  if (missingRoom) {
    $('home-error').textContent = `${missingRoom}번 방을 찾을 수 없습니다. 방 번호를 확인하거나 새 방을 만드세요.`;
    $('home-error').hidden = false;
  }

  $('create-room').addEventListener('click', async () => {
    $('create-room').disabled = true;
    try {
      const response = await fetch('/api/rooms', { method: 'POST' });
      if (!response.ok) throw new Error(response.statusText);
      const { id } = await response.json();
      location.href = `/r/${id}`;
    } catch {
      $('home-error').textContent = '방을 만들지 못했습니다. 서버 연결을 확인하고 다시 시도하세요.';
      $('home-error').hidden = false;
      $('create-room').disabled = false;
    }
  });

  $('enter-room').addEventListener('submit', (event) => {
    event.preventDefault();
    location.href = `/r/${$('room-input').value.trim()}`;
  });
}

async function showRoom(roomId) {
  const response = await fetch(`/api/rooms/${roomId}`);
  if (response.status === 404) {
    location.replace(`/?missing=${roomId}`);
    return;
  }

  const name = storage.get(localStorage, NAME_KEY);
  if (name) {
    enterRoom(roomId, name);
    return;
  }
  $('name-title').textContent = `${roomId}번 방에 입장`;
  $('name-view').hidden = false;
  $('name-input').focus();
  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const entered = $('name-input').value.trim();
    if (!entered) return;
    storage.set(localStorage, NAME_KEY, entered);
    $('name-view').hidden = true;
    enterRoom(roomId, entered);
  });
}

function enterRoom(roomId, initialName) {
  let name = initialName;
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
      send({ type: 'join', clientId: clientId(), name });
    });
    socket.addEventListener('message', (event) => {
      state = JSON.parse(event.data);
      render();
    });
    socket.addEventListener('close', (event) => {
      if (leaving) {
        location.href = '/';
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
    $('room-label').textContent = `방 ${room.id}`;
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
  $('room-view').hidden = false;
  connect();
}

const roomMatch = location.pathname.match(/^\/r\/(\d{4})$/);
if (roomMatch) {
  showRoom(roomMatch[1]);
} else {
  showHome(new URLSearchParams(location.search).get('missing')?.replace(/\D/g, '').slice(0, 4));
}
