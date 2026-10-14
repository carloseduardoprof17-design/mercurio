'use strict';
// MERCÚRIO — metal líquido por raymarching (WebGL2, sem bibliotecas).
// Cada pixel lança um raio e procura a superfície descrita por funções de distância (SDF).
// Formas diferentes se misturam como líquido (mix + smooth-min) e a física (gotas, mola,
// ondas) roda na CPU e chega ao shader como uniforms.
(() => {
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) { document.getElementById('nogl').hidden = false; return; }

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); document.getElementById('nogl').hidden = false; });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FOCAL = 1.9, CAM_Z = 5.2, MAX_DROPS = 10, MAX_RIPS = 4;
  const STATES = [
    ['Gota', 'Tensão superficial: a menor área para o mesmo volume.'],
    ['Coroa', 'Impacto: a coroa de Worthington sobe e se desfaz em gotas.'],
    ['Escultura', 'Fita com três meias-voltas: a seção gira 540° enquanto percorre o anel.'],
    ['Sólido', 'Resfriado: a rugosidade sobe e o reflexo se espalha.'],
  ];

  const VS = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime, uState, uLiquid, uHeat, uScale, uVisc, uRough, uTint, uWob;
uniform int uSteps, uDropN;
uniform mat3 uRot;      // objeto <- mundo (os reflexos ficam presos ao estúdio)
uniform vec4 uDent;     // amassado do cursor: xyz ponto, w força
uniform vec4 uDrops[${MAX_DROPS}];
uniform vec4 uRips[${MAX_RIPS}]; // xyz origem, w idade (<0 = inativa)

#define PI 3.14159265
const float FOCAL = ${FOCAL.toFixed(2)};
const float CAM_Z = ${CAM_Z.toFixed(2)};
const float BOUND = 2.9;
const float FLOOR_Y = -1.15;

float smin(float a, float b, float k){ float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sdEllipsoid(vec3 p, vec3 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
float sdBox2(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float sdCapsuleY(vec3 p, float h, float r){ p.y -= clamp(p.y, 0., h); return length(p) - r; }

// 01 · gota
float shDrop(vec3 p){ return length(p) - 1.0; }

// 02 · coroa de impacto: poça + parede que afina + gotas nas pontas + jato central
float shCrown(vec3 p){
  float t = uTime, B = -.55;
  float d = sdEllipsoid(p - vec3(0., B, 0.), vec3(1.6, .2, 1.6));
  float a = atan(p.z, p.x), rr = length(p.xz);
  float h = .62 + .16 * sin(a * 7. + t * 1.3) + .05 * sin(a * 13. - t * 2.);
  float y = p.y - B;
  float th = mix(.12, .035, clamp(y / h, 0., 1.));
  d = smin(d, sdBox2(vec2(rr - 1.02, y - h * .5), vec2(th, h * .5), th * .9) * .8, .2);
  float sec = 2. * PI / 7., a0 = (PI * .5 - t * 1.3) / 7.;
  float ai = mod(a - a0 + sec * .5, sec) - sec * .5;
  vec3 pr = vec3(rr * cos(ai), y, rr * sin(ai));
  float bob = .5 + .5 * sin(t * 2.1);
  d = smin(d, length(pr - vec3(1.02, .78 + .16 * bob, 0.)) - .085, .12);
  float jh = .55 + .25 * sin(t * 1.1);
  d = smin(d, sdCapsuleY(p - vec3(0., B, 0.), jh, .11), .25);
  d = smin(d, length(p - vec3(0., B + jh + .32 + .06 * sin(t * 2.3), 0.)) - .14, .1);
  return d;
}

// 03/04 · escultura: fita com três meias-voltas (seção retangular girando 540° no anel)
float shSculpt(vec3 p){
  p.yz *= rot(.6); p.xy *= rot(.3);
  float a = atan(p.z, p.x);
  vec2 q = vec2(length(p.xz) - .95, p.y);
  q *= rot(a * 1.5 + uTime * .2 * uLiquid);
  return sdBox2(q, vec2(.4, .085), .07) * .6;
}

float shape(int i, vec3 p){ return i == 0 ? shDrop(p) : i == 1 ? shCrown(p) : shSculpt(p); }

float body(vec3 p){
  float s = uWob;                          // gelatina: achata em y, alarga em xz
  p.y /= 1. + s; p.xz *= 1. + .5 * s;
  float ia = floor(uState), f = uState - ia;
  int A = int(min(ia, 2.)), B = int(min(ia + 1., 2.));
  float d = shape(A, p);
  if (A != B && f > .001) {
    float e = f * f * (3. - 2. * f);
    d = mix(d, shape(B, p), e) - .22 * sin(PI * f);   // incha no meio: parece fluir, não teleportar
  }
  float amp = (.035 + .075 * uHeat) * uVisc * uLiquid;
  float t = uTime * (1. + uHeat * 1.6);
  vec3 q = p * 2.3;
  float n = sin(q.x + t * 1.1) * sin(q.y * 1.2 - t * .9) * sin(q.z * .9 + t * .7)
          + .5 * sin(q.x * 2.1 - t * 1.7 + q.z) * sin(q.y * 2.3 + t * 1.3);
  return (d + amp * n) / (1. + abs(s));
}

float map(vec3 pw){
  float d = body(uRot * pw / uScale) * uScale;
  vec3 dv = pw - uDent.xyz;
  d += uDent.w * .2 * exp(-dot(dv, dv) * 5.);
  for (int i = 0; i < ${MAX_RIPS}; i++) {
    float age = uRips[i].w;
    if (age < 0.) continue;
    float r = length(pw - uRips[i].xyz), front = age * 1.1 + .15;
    d += .028 * exp(-age * 1.4) * exp(-r * 1.1) * sin(r * 14. - age * 15.) * smoothstep(front + .25, front, r);
  }
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uDropN) break;
    d = smin(d, length(pw - uDrops[i].xyz) - uDrops[i].w, .32);
  }
  return d;
}

vec3 nrm(vec3 p){
  const vec2 k = vec2(1, -1); const float e = .0012;
  return normalize(k.xyy * map(p + k.xyy * e) + k.yyx * map(p + k.yyx * e) + k.yxy * map(p + k.yxy * e) + k.xxx * map(p + k.xxx * e));
}

vec2 sphereHit(vec3 ro, vec3 rd){
  float b = dot(ro, rd), c = dot(ro, ro) - BOUND * BOUND, h = b * b - c;
  if (h < 0.) return vec2(-1.);
  h = sqrt(h); return vec2(max(-b - h, 0.), -b + h);
}

float march(vec3 ro, vec3 rd, int steps){
  vec2 tb = sphereHit(ro, rd);
  if (tb.y < 0.) return -1.;
  float t = tb.x;
  for (int i = 0; i < 160; i++) {
    if (i >= steps) break;
    float d = map(ro + rd * t);
    if (abs(d) < .001 * (1. + t)) return t;
    t += d * .8;
    if (t > tb.y) break;
  }
  return -1.;
}

// estúdio procedural: caixas de luz retangulares em volta de um ciclorama escuro
float softbox(vec3 d, vec3 c, vec3 up, vec2 sz, float r){
  float cd = dot(d, c);
  if (cd <= 0.) return 0.;
  vec3 u = normalize(cross(up, c)), v = cross(c, u);
  vec2 q = abs(vec2(dot(d, u), dot(d, v)) / cd);
  vec2 e = vec2(.012 + r * .9);
  vec2 m = smoothstep(sz + e, sz - e, q);
  return m.x * m.y;
}
vec3 env(vec3 d, float r){
  vec3 c = mix(vec3(.004), vec3(.05), smoothstep(-.3, .9, d.y));
  c += vec3(.09) * exp(-abs(d.y + .05) * 16. / (1. + r * 8.));
  float s = 1. - r * .55;
  c += 1.6 * s * softbox(d, normalize(vec3(-.95, .3, .45)), vec3(0, 1, 0), vec2(.35, .9), r);
  c += .9 * s * softbox(d, normalize(vec3(0., -.55, 1.)), vec3(0, 1, 0), vec2(1.2, .18), r);
  c += vec3(.035) * smoothstep(.3, 1., d.z) * smoothstep(-.4, .4, d.y);   // estúdio atrás da câmera
  c += 4.2 * s * softbox(d, normalize(vec3(-.55, .75, .6)), vec3(0, 1, 0), vec2(.55, .26), r) * vec3(1., .99, .97);
  c += 2.4 * s * softbox(d, normalize(vec3(.95, .15, .35)), vec3(0, 1, 0), vec2(.06, .9), r);
  c += 1.3 * s * softbox(d, normalize(vec3(-.92, .05, -.15)), vec3(0, 1, 0), vec2(.045, .75), r);
  c += .8 * s * softbox(d, normalize(vec3(.15, .98, -.15)), vec3(0, 0, 1), vec2(1.1, .9), r);
  c += .55 * s * softbox(d, normalize(vec3(.45, -.25, 1.)), vec3(0, 1, 0), vec2(.3, .1), r);
  return c;
}

vec3 metalF0(){
  vec3 warm = vec3(1., .8, .58), cool = vec3(.78, .87, 1.);
  return mix(vec3(.92), uTint > 0. ? warm : cool, abs(uTint) * .85);
}

vec3 shade(vec3 p, vec3 rd, bool bounce){
  vec3 n = nrm(p), F0 = metalF0();
  float rough = clamp(uRough + (1. - uLiquid) * .2, 0., 1.);
  vec3 r = reflect(rd, n);
  float ndv = clamp(dot(n, -rd), 0., 1.);
  vec3 F = F0 + (1. - F0) * pow(1. - ndv, 5.);
  float ca = .035 * (1. - ndv) * (1. - ndv);   // aberração cromática só na borda
  vec3 refl = vec3(env(normalize(r + n * ca), rough).r, env(r, rough).g, env(normalize(r - n * ca), rough).b);
  if (bounce) {                                 // interreflexão: o metal se vê nas gotas
    vec3 o = p + n * .012;
    float t2 = march(o, r, 36);
    if (t2 > 0.) { vec3 p2 = o + r * t2; refl = env(reflect(r, nrm(p2)), rough + .08) * F0 * .8; }
  }
  float occ = 0., sc = 1.;
  for (int i = 1; i <= 4; i++) { float h = .03 + .08 * float(i); occ += (h - map(p + n * h)) * sc; sc *= .6; }
  float ao = clamp(1. - 1.6 * occ, 0., 1.);
  return refl * F * (.35 + .65 * ao) * (1. + uHeat * .22);
}

vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  float m = min(uRes.x, uRes.y);   // retrato: enquadra pela largura
  vec2 uv = (2. * gl_FragCoord.xy - uRes) / m;
  vec3 ro = vec3(0., 0., CAM_Z), rd = normalize(vec3(uv, -FOCAL));
  float g = exp(-dot(uv - vec2(0., .1), uv - vec2(0., .1)) * 1.1);
  vec3 col = vec3(.0032, .0032, .0036) * (1. - .1 * dot(uv, uv)) + vec3(.009) * g;

  // passo primário com antisserrilhado pela aproximação mínima do raio
  vec2 tb = sphereHit(ro, rd);
  float px = 2. / (m * FOCAL);
  bool hit = false; float t = tb.x, bestR = 1e9, bestT = 0.;
  if (tb.y > 0.) {
    for (int i = 0; i < 160; i++) {
      if (i >= uSteps) break;
      float d = map(ro + rd * t);
      float rr = d / t;
      if (rr < bestR) { bestR = rr; bestT = t; }
      if (d < .35 * px * t) { hit = true; break; }
      t += d * .8;
      if (t > tb.y) break;
    }
  }

  // piso de estúdio escuro e brilhante: reflexo e sombra de contato
  if (rd.y < 0.) {
    float tf = (FLOOR_Y - ro.y) / rd.y;
    if (!hit || tf < t) {
      vec3 pf = ro + rd * tf;
      vec3 fl = vec3(.0022) + vec3(.008) * exp(-dot(pf.xz, pf.xz) * .15);
      float sh = smoothstep(.0, 1.3, map(pf));
      fl *= .25 + .75 * sh;
      vec3 rr = reflect(rd, vec3(0, 1, 0));
      float tr = march(pf, rr, 48);
      float fres = .03 + .97 * pow(1. - abs(rd.y), 5.);
      if (tr > 0.) fl += shade(pf + rr * tr, rr, false) * (.08 + .3 * fres) * exp(-tr * 1.1);
      col = mix(fl, col, smoothstep(6., 16., tf));
      if (hit) hit = false;
      if (bestT > tf) bestR = 1e9;   // a borda do metal na frente do piso continua suavizada
    }
  }

  if (hit) col = shade(ro + rd * t, rd, true);
  else if (bestR < 1.5 * px) col = mix(shade(ro + rd * bestT, rd, false), col, smoothstep(.35 * px, 1.5 * px, bestR));

  col = aces(col * 1.15);
  col = pow(col, vec3(1. / 2.2));
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.) * 91.) - .5) * .016;
  outColor = vec4(col, 1.);
}`;

  // ---------- GL ----------
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.error(err);
    document.getElementById('nogl').hidden = false;
    return;
  }
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  const U = {};
  for (const n of ['uRes', 'uTime', 'uState', 'uLiquid', 'uHeat', 'uScale', 'uVisc', 'uRough', 'uTint', 'uWob', 'uSteps', 'uDropN', 'uRot', 'uDent', 'uDrops', 'uRips'])
    U[n] = gl.getUniformLocation(prog, n);

  // ---------- estado ----------
  const S = {
    time: 0, state: 0, target: 0, heat: 0, scale: reduced ? 1 : .12, intro: reduced ? 1 : 0,
    yaw: .6, pitch: .22, yawV: 0, pitchV: 0,
    dent: [0, 0, 3], dentT: [0, 0, 3], dentW: 0,
    wob: 0, wobV: 0, drops: [], rips: [],
    visc: 1, rough: .06, tint: 0, steps: 96, res: 1, auto: true,
  };
  const deep = parseInt(new URLSearchParams(location.search).get('s'), 10) - 1; // ?s=1..4 abre num estado
  if (deep >= 0 && deep <= 3) { S.state = S.target = deep; S.intro = S.scale = 1; }
  const dropBuf = new Float32Array(MAX_DROPS * 4), ripBuf = new Float32Array(MAX_RIPS * 4);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const len = v => Math.hypot(v[0], v[1], v[2]);
  const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

  // chegada: gotas soltas convergem e se fundem na massa
  if (S.intro < 1) for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2 + rnd(-.3, .3), r = rnd(1.9, 2.4), y = rnd(-.9, 1.1);
    S.drops.push({ p: [Math.cos(a) * r, y, Math.sin(a) * r * .6], v: [-Math.sin(a) * 1.2, 0, Math.cos(a) * 1.2], r: rnd(.14, .24), age: .3 });
  }

  // ---------- cursor no mundo ----------
  function rayDir(cx, cy) {
    const w = innerWidth, h = innerHeight, m = Math.min(w, h);
    const d = [(2 * cx - w) / m, -(2 * cy - h) / m, -FOCAL], l = len(d);
    return [d[0] / l, d[1] / l, d[2] / l];
  }
  // ponto onde o raio toca a esfera de raio R; se errar, o ponto do raio mais perto do centro
  function rayPoint(cx, cy, R = 1) {
    const d = rayDir(cx, cy), b = CAM_Z * d[2], c = CAM_Z * CAM_Z - R * R, h = b * b - c;
    const t = h >= 0 ? -b - Math.sqrt(h) : -b;
    return { p: [d[0] * t, d[1] * t, CAM_Z + d[2] * t], on: h >= 0 };
  }

  const ptr = { x: innerWidth / 2, y: innerHeight / 2, vx: 0, vy: 0, inside: false, down: false, moved: false, sx: 0, sy: 0, t0: 0, touch: false };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    Object.assign(ptr, { down: true, moved: false, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), inside: true, touch: e.pointerType !== 'mouse' });
  });
  canvas.addEventListener('pointermove', e => {
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    ptr.vx = dx; ptr.vy = dy; ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true;
    if (!ptr.down) return;
    if (!ptr.moved && Math.hypot(e.clientX - ptr.sx, e.clientY - ptr.sy) > 6) { ptr.moved = true; canvas.classList.add('drag'); }
    if (ptr.moved) {
      S.yaw += dx * .006; S.pitch = Math.max(-1.1, Math.min(1.1, S.pitch + dy * .006));
      S.yawV = dx * .006 * 60; S.pitchV = dy * .006 * 60;
    }
  });
  const up = () => {
    if (!ptr.down) return;
    if (!ptr.moved && performance.now() - ptr.t0 < 260) pluck();
    ptr.down = false; canvas.classList.remove('drag');
    if (ptr.touch) ptr.inside = false;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!ptr.down) ptr.inside = false; });

  // clique: arranca uma gota (no metal sólido, só um "ping")
  function pluck() {
    const { p } = rayPoint(ptr.x, ptr.y, .98);
    const l = len(p) || 1, n = [p[0] / l, p[1] / l, p[2] / l];
    if (!reduced) {
      S.rips.push({ o: p, t: S.time });
      if (S.rips.length > MAX_RIPS) S.rips.shift();
    }
    S.wobV += reduced ? 0 : 1.6;
    if (liquid() < .3) return;
    const sp = rnd(2.4, 3.4), k = .004;
    S.drops.push({
      p: [p[0] + n[0] * .12, p[1] + n[1] * .12, p[2] + n[2] * .12],
      v: [n[0] * sp + ptr.vx * k * 60 + rnd(-.4, .4), n[1] * sp - ptr.vy * k * 60 + rnd(.2, .8), n[2] * sp + rnd(-.4, .4)],
      r: rnd(.1, .2), age: 0,
    });
    if (S.drops.length > MAX_DROPS) S.drops.shift();
  }
  const liquid = () => 1 - smooth(2, 3, S.state);

  // rolagem / teclado: troca de estado com encaixe
  let snapTimer = 0;
  addEventListener('wheel', e => {
    e.preventDefault();
    S.target = Math.max(0, Math.min(3, S.target + e.deltaY * .0016));
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => { S.target = Math.round(S.target); }, 140);
  }, { passive: false });
  const go = i => { S.target = Math.max(0, Math.min(3, i)); };
  addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ' && e.target.closest && e.target.closest('button')) return; // espaço já aciona o botão
    const cur = Math.round(S.target);
    if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(cur + 1); }
    else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(cur - 1); }
    else if (e.key >= '1' && e.key <= '4') go(+e.key - 1);
    else if (e.key === 'd' || e.key === 'D') dbg.hidden = !dbg.hidden;
  });
  document.querySelectorAll('#states button').forEach(b => b.addEventListener('click', () => go(+b.dataset.s)));

  // ---------- painel de depuração ----------
  const $ = id => document.getElementById(id);
  const dbg = $('debug');
  const bind = (id, key, fmt) => {
    const el = $(id), out = $('o-' + id);
    const set = () => { S[key] = +el.value; out.textContent = fmt(S[key]); };
    el.addEventListener('input', set); set();
  };
  bind('steps', 'steps', v => v.toFixed(0));
  bind('visc', 'visc', v => v.toFixed(2));
  bind('rough', 'rough', v => v.toFixed(2));
  bind('tint', 'tint', v => v.toFixed(2));
  $('auto').addEventListener('change', e => { S.auto = e.target.checked; });

  // ---------- legenda ----------
  const cap = document.querySelector('.caption'), btns = [...document.querySelectorAll('#states button')];
  let shown = 0;
  function caption(i) {
    if (i === shown) return;
    shown = i;
    $('cur').textContent = String(i + 1).padStart(2, '0');
    $('sname').textContent = STATES[i][0];
    $('sdesc').textContent = STATES[i][1];
    btns.forEach((b, j) => b.setAttribute('aria-current', j === i ? 'true' : 'false'));
    cap.classList.remove('swap'); void cap.offsetWidth; cap.classList.add('swap');
  }

  // ---------- resolução adaptativa ----------
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5) * S.res;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    $('res').textContent = S.res.toFixed(2);
  }
  addEventListener('resize', resize);
  resize();

  // ---------- laço ----------
  const M = new Float32Array(9);
  let last = performance.now(), frames = 0, fpsT = last;
  function frame(now) {
    const dt = Math.max(0, Math.min((now - last) / 1000, 1 / 20));
    last = now;
    if (!reduced) S.time += dt;

    // FPS e escala automática
    frames++;
    if (now - fpsT > 500) {
      const fps = frames * 1000 / (now - fpsT);
      $('fps').textContent = fps.toFixed(0);
      if (S.auto && now > 2500) {   // espera o shader aquecer
        if (fps < 48 && S.res > .35) { S.res = Math.max(.35, S.res - .1); resize(); }
        else if (fps > 57 && S.res < 1) { S.res = Math.min(1, S.res + .05); resize(); }
      }
      frames = 0; fpsT = now;
    }

    // chegada
    if (S.intro < 1) { S.intro = Math.min(1, S.intro + dt / 1.8); const e = 1 - Math.pow(1 - S.intro, 3); S.scale = .12 + .88 * e; }

    // estado (mola exponencial)
    S.state += (S.target - S.state) * (1 - Math.exp(-dt * 2.6));
    if (Math.abs(S.target - S.state) < 1e-4) S.state = S.target;
    caption(Math.round(S.state));

    // calor: segurar sem arrastar
    const holding = ptr.down && !ptr.moved && now - ptr.t0 > 220 && liquid() > .3;
    S.heat += ((holding ? 1 : 0) - S.heat) * (1 - Math.exp(-dt * (holding ? 1.4 : 2.2)));
    $('heat').style.width = (S.heat * 100).toFixed(1) + '%';

    // rotação com inércia e giro lento
    if (!(ptr.down && ptr.moved)) {
      S.yawV *= Math.exp(-dt * 2.5); S.pitchV *= Math.exp(-dt * 2.5);
      S.yaw += (S.yawV + (reduced ? 0 : .12)) * dt;
      S.pitch += S.pitchV * dt;
      S.pitch += (.22 - S.pitch) * (1 - Math.exp(-dt * .8));
    }

    // amassado do cursor (persegue o cursor com atraso viscoso)
    const rp = rayPoint(ptr.x, ptr.y, 1);
    const near = Math.max(0, 1.35 - len(rp.p)) / .35;
    const want = ptr.inside && !(ptr.down && ptr.moved) ? Math.min(1, near) * (.7 + Math.min(Math.hypot(ptr.vx, ptr.vy) / 40, 1) * .5) : 0;
    S.dentT = rp.p;
    const kd = 1 - Math.exp(-dt * 9);
    for (let i = 0; i < 3; i++) S.dent[i] += (S.dentT[i] - S.dent[i]) * kd;
    S.dentW += (want * liquid() - S.dentW) * (1 - Math.exp(-dt * 6));
    ptr.vx *= .85; ptr.vy *= .85;
    $('xyz').textContent = `x ${S.dent[0].toFixed(2)} · y ${S.dent[1].toFixed(2)} · z ${S.dent[2].toFixed(2)}`;

    // gelatina
    S.wobV += (-70 * S.wob - 5 * S.wobV) * dt;
    S.wob = Math.max(-.22, Math.min(.22, S.wob + S.wobV * dt));

    // gotas: mola para o centro + gravidade + arrasto; absorvidas perto do núcleo
    for (const d of S.drops) {
      d.age += dt;
      const r = len(d.p);
      for (let i = 0; i < 3; i++) {
        const a = -8 * d.p[i] - 1.1 * d.v[i] - (i === 1 ? 1.5 : 0);
        d.v[i] += a * dt; d.p[i] += d.v[i] * dt;
      }
      if (r > 2.3) { const s = 2.3 / r; for (let i = 0; i < 3; i++) { d.p[i] *= s; d.v[i] *= .5; } }
      if (d.age > .35 && r < .85 * S.scale) { d.r *= Math.exp(-dt * 7); if (!d.hit) { d.hit = true; S.wobV -= .5; } }
    }
    S.drops = S.drops.filter(d => d.r > .012);
    S.rips = S.rips.filter(r => S.time - r.t < 3);

    // uniforms
    dropBuf.fill(0); S.drops.forEach((d, i) => dropBuf.set([...d.p, d.r], i * 4));
    ripBuf.fill(-1); S.rips.forEach((r, i) => ripBuf.set([...r.o, S.time - r.t], i * 4));
    const c = Math.cos(S.yaw), s = Math.sin(S.yaw), cb = Math.cos(S.pitch), sb = Math.sin(S.pitch);
    M.set([c, 0, -s, s * sb, cb, c * sb, s * cb, -sb, c * cb]); // (Ry·Rx)ᵀ em linhas

    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, S.time);
    gl.uniform1f(U.uState, S.state);
    gl.uniform1f(U.uLiquid, liquid());
    gl.uniform1f(U.uHeat, S.heat);
    gl.uniform1f(U.uScale, S.scale);
    gl.uniform1f(U.uVisc, S.visc);
    gl.uniform1f(U.uRough, S.rough);
    gl.uniform1f(U.uTint, S.tint);
    gl.uniform1f(U.uWob, S.wob);
    gl.uniform1i(U.uSteps, S.steps);
    gl.uniform1i(U.uDropN, S.drops.length);
    gl.uniformMatrix3fv(U.uRot, true, M);
    gl.uniform4f(U.uDent, S.dent[0], S.dent[1], S.dent[2], S.dentW);
    gl.uniform4fv(U.uDrops, dropBuf);
    gl.uniform4fv(U.uRips, ripBuf);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
