// 화면 아래에서 타오르는 불꽃과 위로 날리는 불씨를 그린다.
// 캔버스를 화면의 절반 해상도로 그려서 늘리면 불꽃이 자연스럽게 번지고 그리는 비용도 준다.
const SCALE = 0.35;
const FRAME_MS = 1000 / 60;
// 갓 생긴 불꽃의 노란빛에서 사그라드는 검붉은 빛까지
const FLAME_COLORS = ['255,214,120', '255,164,52', '255,104,30', '214,52,16', '96,18,6'];
// 불꽃 입자를 위로 길쭉하게 그려서 동그란 빛망울이 아니라 혀처럼 보이게 한다.
const FLAME_STRETCH = 1.9;
const EMBER_COLOR = '255,190,90';

function makeSprite(rgb) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${rgb},1)`);
  gradient.addColorStop(0.35, `rgba(${rgb},.55)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return canvas;
}

export function startFire(canvas) {
  const context = canvas.getContext('2d');
  const flameSprites = FLAME_COLORS.map(makeSprite);
  const emberSprite = makeSprite(EMBER_COLOR);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let intensity = 1;
  let flames = [];
  let embers = [];
  let time = 0;
  let last = performance.now();
  let frame = 0;

  function resize() {
    width = Math.ceil(innerWidth * SCALE);
    height = Math.ceil(innerHeight * SCALE);
    canvas.width = width;
    canvas.height = height;
  }

  // 시간에 따라 움직이는 물결로 불꽃 혀가 생기고 사라지는 자리를 정한다.
  const tongue = (x) => Math.sin(x * 0.045 + time * 0.021) + Math.sin(x * 0.011 - time * 0.034) + Math.sin(x * 0.09 + time * 0.05) * 0.5;

  function spawnFlame() {
    const x = Math.random() * width;
    const strength = (tongue(x) + 2.5) / 5;
    if (Math.random() > strength) return;
    const life = 30 + Math.random() * 45;
    flames.push({
      x,
      y: height + 8,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -(0.5 + Math.random() * 0.9) * intensity * (0.4 + strength * 1.3),
      size: (8 + Math.random() * 14) * (0.7 + intensity * 0.4),
      seed: Math.random() * 100,
      life,
      age: 0,
    });
  }

  function spawnEmber() {
    embers.push({
      x: Math.random() * width,
      y: height + 2,
      vx: (Math.random() - 0.5) * 0.3,
      vy: -(0.25 + Math.random() * 0.7),
      size: 1 + Math.random() * 1.8,
      seed: Math.random() * 100,
      life: 160 + Math.random() * 220,
      age: 0,
    });
  }

  function drawGlow() {
    const glow = context.createLinearGradient(0, height, 0, height * (1 - 0.45 * intensity));
    const flicker = 0.32 + Math.sin(time * 0.13) * 0.04 + Math.sin(time * 0.37) * 0.03;
    glow.addColorStop(0, `rgba(255,90,20,${flicker})`);
    glow.addColorStop(1, 'rgba(255,90,20,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }

  function step(dt) {
    time += dt;
    const spawns = (width / 9) * intensity * dt;
    for (let i = 0; i < spawns; i++) spawnFlame();
    if (Math.random() < 0.35 * intensity * dt) spawnEmber();

    flames = flames.filter((flame) => {
      flame.age += dt;
      flame.x += (flame.vx + Math.sin(flame.seed + flame.age * 0.16) * 0.22) * dt;
      flame.y += flame.vy * dt;
      return flame.age < flame.life;
    });
    embers = embers.filter((ember) => {
      ember.age += dt;
      ember.x += (ember.vx + Math.sin(ember.seed + ember.age * 0.05) * 0.4) * dt;
      ember.y += ember.vy * dt;
      return ember.age < ember.life && ember.y > -4;
    });
  }

  function draw() {
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, width, height);
    drawGlow();
    context.globalCompositeOperation = 'lighter';
    for (const flame of flames) {
      const t = flame.age / flame.life;
      const size = flame.size * (1 - t * 0.7);
      const tall = size * FLAME_STRETCH;
      context.globalAlpha = (1 - t) ** 1.3 * 0.32;
      context.drawImage(flameSprites[Math.min(FLAME_COLORS.length - 1, Math.floor(t * FLAME_COLORS.length))], flame.x - size / 2, flame.y - tall / 2, size, tall);
    }
    for (const ember of embers) {
      const t = ember.age / ember.life;
      context.globalAlpha = (1 - t) * (0.6 + Math.sin(ember.seed + ember.age * 0.3) * 0.4);
      const size = ember.size * 3;
      context.drawImage(emberSprite, ember.x - size / 2, ember.y - size / 2, size, size);
    }
    context.globalAlpha = 1;
  }

  function loop(now) {
    // 120Hz 화면에서도 60Hz와 같은 속도로 타도록 경과 시간으로 움직인다. 탭이 잠들었다 깨면 한 번에 너무 많이 움직이지 않게 자른다.
    const dt = Math.min((now - last) / FRAME_MS, 3);
    last = now;
    step(dt);
    draw();
    frame = requestAnimationFrame(loop);
  }

  function start() {
    cancelAnimationFrame(frame);
    if (reducedMotion.matches) {
      // 움직임을 줄인 사용자에게는 멈춰 있는 불빛만 보여준다.
      context.clearRect(0, 0, width, height);
      drawGlow();
      return;
    }
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  resize();
  addEventListener('resize', () => {
    resize();
    if (reducedMotion.matches) start();
  });
  reducedMotion.addEventListener('change', start);
  start();

  return {
    // 시작 화면에서는 불길을 높게, 방 화면에서는 카드를 가리지 않게 낮게 둔다.
    setIntensity(value) {
      intensity = value;
      if (reducedMotion.matches) start();
    },
  };
}
