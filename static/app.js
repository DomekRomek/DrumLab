"use strict";
/* drumlab frontend V0.2 — vanilla JS, WaveSurfer 7.8.6 (waveforms) + Tone.js 14.8.49 (clock/synth) */

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let d;
    try { d = (await r.json()).detail; } catch (e) { d = r.statusText; }
    throw new Error(d || ("HTTP " + r.status));
  }
  return r.json();
}

function postJSON(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* class config — UI order; model channel mapping handled server-side  */
/* ------------------------------------------------------------------ */
const CLASSES = [
  { id: "kick",   label: "Kick",    def: 0.22 },
  { id: "snare",  label: "Snare",   def: 0.24 },
  { id: "hihat",  label: "Hi-hat",  def: 0.22 },
  { id: "tom",    label: "Toms",    def: 0.32 },
  { id: "cymbal", label: "Cymbals", def: 0.30 },
];
const COLORS = { kick: "#e74c3c", snare: "#f0a432", hihat: "#2ecc71", tom: "#3a9ad9", cymbal: "#a06fd6" };
const ROLL_ORDER = ["kick", "snare", "hihat", "tom", "cymbal"]; // top -> bottom rows
// default per-instrument synth gains (hi-hat/cymbal tamed — raw synths are piercing)
const CLASS_GAIN_DEF = { kick: 1.0, snare: 0.85, hihat: 0.3, tom: 0.9, cymbal: 0.45 };
const LANE_NAMES = ["input", "stem", "nodrums"];
const LANE_CONT = { input: "wave-input", stem: "wave-stem", nodrums: "wave-nodrums" };
const LANE_PLACEHOLDER = { input: "no input loaded", stem: "no drum stem yet", nodrums: "no demucs backing yet" };
const LANE_COLORS = {
  input:   { wave: "#4a6f96", prog: "#76a8d8" },
  stem:    { wave: "#4f8f6a", prog: "#7cc79b" },
  nodrums: { wave: "#8a7a4d", prog: "#c4ad6e" },
};

/* ------------------------------------------------------------------ */
/* knob component (rotary, drag-vertical / wheel / dblclick-reset)     */
/* ------------------------------------------------------------------ */
function createKnob(hostId, opts) {
  const o = Object.assign({ min: 0, max: 1.5, value: 1.0, size: 38, color: "#4ea1ff", label: "", fmt: (v) => v.toFixed(2) }, opts);
  const host = $(hostId);
  const wrap = document.createElement("div");
  wrap.className = "knob";
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = o.size * dpr;
  canvas.height = o.size * dpr;
  canvas.style.width = o.size + "px";
  canvas.style.height = o.size + "px";
  const label = document.createElement("span");
  label.className = "knob-label";
  label.textContent = o.label;
  wrap.appendChild(canvas);
  if (o.label) wrap.appendChild(label);
  host.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  const defVal = o.value;
  let value = o.value;
  const A0 = 0.75 * Math.PI, A1 = 2.25 * Math.PI; // 270° sweep

  function draw() {
    const s = o.size, c = s / 2, r = s / 2 - 3;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    ctx.lineWidth = Math.max(2.5, s / 14);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2e323b";
    ctx.beginPath(); ctx.arc(c, c, r, A0, A1); ctx.stroke();
    const frac = (value - o.min) / (o.max - o.min);
    const a = A0 + frac * (A1 - A0);
    ctx.strokeStyle = o.color;
    ctx.beginPath(); ctx.arc(c, c, r, A0, a); ctx.stroke();
    ctx.strokeStyle = "#d6d9e0";
    ctx.lineWidth = Math.max(1.5, s / 22);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r * 0.35, c + Math.sin(a) * r * 0.35);
    ctx.lineTo(c + Math.cos(a) * r * 0.85, c + Math.sin(a) * r * 0.85);
    ctx.stroke();
    wrap.title = (o.label ? o.label + ": " : "") + o.fmt(value);
  }

  function setValue(v, fire) {
    value = Math.min(o.max, Math.max(o.min, v));
    draw();
    if (fire !== false && o.onChange) o.onChange(value);
  }

  let dragY = null, dragV = null;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    dragY = e.clientY; dragV = value;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragY === null) return;
    const range = o.max - o.min;
    const fine = e.shiftKey ? 0.25 : 1;
    setValue(dragV + (dragY - e.clientY) * (range / 150) * fine);
  });
  canvas.addEventListener("pointerup", () => { dragY = null; });
  canvas.addEventListener("pointercancel", () => { dragY = null; });
  canvas.addEventListener("dblclick", () => setValue(defVal));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    setValue(value + (e.deltaY < 0 ? 1 : -1) * (o.max - o.min) / 40);
  }, { passive: false });

  setValue(value, false);
  return { get: () => value, set: setValue };
}

/* ------------------------------------------------------------------ */
/* stereo meters (dBFS, peak hold)                                     */
/* ------------------------------------------------------------------ */
const meterState = new WeakMap(); // canvas -> {peaks:[l,r]}

function dbToFrac(db) {
  if (!isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function drawStereoMeter(canvas, dbs, withScale) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  let st = meterState.get(canvas);
  if (!st) { st = { peaks: [-90, -90] }; meterState.set(canvas, st); }
  ctx.clearRect(0, 0, W, H);
  const padB = withScale ? 11 : 0;
  const barH = (H - padB - 6) / 2;
  const marks = [-48, -24, -12, -6, -3, 0];

  for (let ch = 0; ch < 2; ch++) {
    const y = 2 + ch * (barH + 2);
    const db = dbs[ch];
    st.peaks[ch] = Math.max(db, st.peaks[ch] - 0.45); // peak fall ~27 dB/s
    ctx.fillStyle = "#181b20";
    ctx.fillRect(0, y, W, barH);
    const f = dbToFrac(db);
    const gx = (v) => dbToFrac(v) * W;
    // green / yellow / red segments up to the level
    const segs = [[-60, -12, "#2f9e57"], [-12, -3, "#d9a62e"], [-3, 0, "#c0463f"]];
    for (const [a, b, col] of segs) {
      const x0 = gx(a), x1 = Math.min(gx(b), f * W);
      if (x1 > x0) { ctx.fillStyle = col; ctx.fillRect(x0, y, x1 - x0, barH); }
    }
    const pf = dbToFrac(st.peaks[ch]);
    if (pf > 0.01) {
      ctx.fillStyle = st.peaks[ch] > -3 ? "#ff6b61" : "#d6d9e0";
      ctx.fillRect(pf * W - 1, y, 1.5, barH);
    }
  }
  // scale ticks
  ctx.fillStyle = "#8b919e";
  ctx.strokeStyle = "rgba(139,145,158,0.4)";
  ctx.font = "8px Consolas, monospace";
  for (const m of marks) {
    const x = dbToFrac(m) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - padB); ctx.stroke();
    if (withScale) ctx.fillText(m === 0 ? "0" : String(m), Math.min(x + 1, W - 16), H - 2);
  }
}

function makeTap(node) {
  // up-mix through an explicit 2ch gain so mono sources still meter on both bars
  let pre = node;
  try {
    const up = Tone.getContext().rawContext.createGain();
    up.channelCount = 2;
    up.channelCountMode = "explicit";
    up.channelInterpretation = "speakers";
    Tone.connect(node, up);
    pre = up;
  } catch (e) { /* fall back to direct split */ }
  const split = new Tone.Split(2);
  Tone.connect(pre, split);
  const l = new Tone.Meter({ smoothing: 0.8 });
  const r = new Tone.Meter({ smoothing: 0.8 });
  split.connect(l, 0, 0);
  split.connect(r, 1, 0);
  return { get: () => [l.getValue(), r.getValue()] };
}

/* ------------------------------------------------------------------ */
/* audio graph                                                         */
/* ------------------------------------------------------------------ */
const engine = {
  started: false,
  lanes: { input: null, stem: null, nodrums: null },  // {ws, player}
  part: null,
  synths: null,
  duration: 0,
  pxPerSec: 40,
  tempo: null,
};

const master = new Tone.Gain(1.0);
master.connect(Tone.getDestination());
const laneGains = {
  input: new Tone.Gain(0.9).connect(master),
  stem: new Tone.Gain(0.9).connect(master),
  nodrums: new Tone.Gain(0.9).connect(master),
};
const midiBus = new Tone.Gain(0.8).connect(master);
const classGains = {};
for (const c of CLASSES) classGains[c.id] = new Tone.Gain(CLASS_GAIN_DEF[c.id]).connect(midiBus);

const taps = {
  master: makeTap(master),
  input: makeTap(laneGains.input),
  stem: makeTap(laneGains.stem),
  nodrums: makeTap(laneGains.nodrums),
};

function makeSynths() {
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.04, octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
  }).connect(classGains.kick);

  const snareBP = new Tone.Filter(1800, "bandpass").connect(classGains.snare);
  const snare = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.13, sustain: 0 },
  }).connect(snareBP);

  const hihat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.02 },
    harmonicity: 5.1, modulationIndex: 32, resonance: 6000, octaves: 1.2,
  }).connect(classGains.hihat);

  const tom = new Tone.MembraneSynth({
    pitchDecay: 0.06, octaves: 3,
    envelope: { attack: 0.001, decay: 0.25, sustain: 0 },
  }).connect(classGains.tom);

  const cymbal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.1, release: 0.4 },
    harmonicity: 4.1, modulationIndex: 40, resonance: 5000, octaves: 1.5,
  }).connect(classGains.cymbal);

  function metalHit(synth, freq, dur, time, vel) {
    try { synth.triggerAttackRelease(freq, dur, time, vel); }
    catch (e) { try { synth.triggerAttackRelease(dur, time, vel); } catch (e2) { /* ignore */ } }
  }

  return {
    trigger(cls, time) {
      try {
        if (cls === "kick") kick.triggerAttackRelease("C1", 0.25, time);
        else if (cls === "snare") snare.triggerAttackRelease(0.12, time, 0.9);
        else if (cls === "tom") tom.triggerAttackRelease("A2", 0.2, time);
        else if (cls === "hihat") metalHit(hihat, 320, 0.05, time, 0.5);
        else if (cls === "cymbal") metalHit(cymbal, 240, 1.2, time, 0.45);
      } catch (e) { /* never break the transport */ }
    },
  };
}

/* lanes ---------------------------------------------------------------- */
function disposeLane(name) {
  const lane = engine.lanes[name];
  if (!lane) return;
  try { lane.ws.destroy(); } catch (e) {}
  try { lane.player.unsync(); lane.player.dispose(); } catch (e) {}
  engine.lanes[name] = null;
  $(LANE_CONT[name]).innerHTML = '<div class="placeholder">' + LANE_PLACEHOLDER[name] + "</div>";
}

async function loadLane(name, url) {
  disposeLane(name);
  const cont = $(LANE_CONT[name]);
  cont.innerHTML = "";

  const player = new Tone.Player();
  await player.load(url);
  player.connect(laneGains[name]);
  player.sync().start(0);

  const ws = WaveSurfer.create({
    container: cont,
    url: url,
    height: Math.max(56, cont.clientHeight - 4),
    waveColor: LANE_COLORS[name].wave,
    progressColor: LANE_COLORS[name].prog,
    cursorColor: "#e8e8e8",
    cursorWidth: 1,
    normalize: true,
    interact: true,
    autoScroll: true,
    autoCenter: false,
    minPxPerSec: engine.pxPerSec,
    hideScrollbar: false,
  });
  ws.on("interaction", (t) => seekAll(t));
  ws.on("scroll", () => mirrorScroll(name));
  engine.lanes[name] = { ws, player };

  recomputeDuration();
  setLog(name + " audio loaded (" + player.buffer.duration.toFixed(1) + "s)");
}

function recomputeDuration() {
  let d = 0;
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane && lane.player.buffer) d = Math.max(d, lane.player.buffer.duration);
  }
  if (roll.events) {
    for (const cls in roll.events) {
      const a = roll.events[cls];
      if (a.length) d = Math.max(d, a[a.length - 1] + 2);
    }
  }
  engine.duration = d;
  applyZoom();
}

/* transport ------------------------------------------------------------ */
async function ensureAudio() {
  if (!engine.started) {
    await Tone.start();
    engine.started = true;
  }
}

async function togglePlay() {
  await ensureAudio();
  if (Tone.Transport.state === "started") {
    Tone.Transport.pause();
  } else {
    if (engine.duration && Tone.Transport.seconds >= engine.duration - 0.05) Tone.Transport.seconds = 0;
    Tone.Transport.start();
  }
  renderPlayButton();
}

function stopTransport() {
  Tone.Transport.pause();
  Tone.Transport.seconds = 0;
  updateCursors(0);
  renderPlayButton();
}

function seekAll(t) {
  t = Math.max(0, engine.duration ? Math.min(t, engine.duration) : t);
  const wasPlaying = Tone.Transport.state === "started";
  if (wasPlaying) Tone.Transport.pause();
  Tone.Transport.seconds = t;
  updateCursors(t);
  if (wasPlaying) Tone.Transport.start("+0.05");
}

function updateCursors(t) {
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane) { try { lane.ws.setTime(t); } catch (e) {} }
  }
}

function renderPlayButton() {
  const playing = Tone.Transport.state === "started";
  const btn = $("btn-play");
  btn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
  btn.classList.toggle("playing", playing);
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + s.toFixed(3).padStart(6, "0");
}

/* loop ------------------------------------------------------------------ */
const loop = { active: false, start: 0, end: 0, preview: null };

function setLoop(a, b) {
  if (b < a) { const x = a; a = b; b = x; }
  a = Math.max(0, a);
  b = Math.min(engine.duration || b, b);
  if (b - a < 0.05) return;
  loop.active = true;
  loop.start = a;
  loop.end = b;
  try {
    Tone.Transport.setLoopPoints(a, b);
    Tone.Transport.loop = true;
  } catch (e) {}
  $("loop-chip").classList.remove("hidden");
  $("loop-range").textContent = a.toFixed(2) + "–" + b.toFixed(2) + "s";
}

function clearLoop() {
  loop.active = false;
  loop.preview = null;
  try { Tone.Transport.loop = false; } catch (e) {}
  $("loop-chip").classList.add("hidden");
}

$("loop-clear").addEventListener("click", clearLoop);

function ensureOverlay(bodyEl) {
  let ov = bodyEl.querySelector(":scope > .loop-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "loop-overlay";
    bodyEl.appendChild(ov);
  }
  return ov;
}

function updateLoopOverlays() {
  const region = loop.preview || (loop.active ? [loop.start, loop.end] : null);
  const bodies = [$("wave-input"), $("wave-stem"), $("wave-nodrums"), $("roll-wrap")];
  for (const body of bodies) {
    const ov = ensureOverlay(body);
    if (!region) { ov.style.display = "none"; continue; }
    const x0 = region[0] * engine.pxPerSec - roll.scrollPx;
    const x1 = region[1] * engine.pxPerSec - roll.scrollPx;
    ov.style.display = "block";
    ov.style.left = Math.min(x0, x1) + "px";
    ov.style.width = Math.abs(x1 - x0) + "px";
  }
}

/* scroll + zoom sync ----------------------------------------------------- */
let syncingScroll = false;

function mirrorScroll(fromName) {
  if (syncingScroll) return;
  const src = engine.lanes[fromName];
  if (!src || typeof src.ws.getScroll !== "function") return;
  syncingScroll = true;
  const px = src.ws.getScroll();
  for (const k of LANE_NAMES) {
    if (k === fromName) continue;
    const lane = engine.lanes[k];
    if (lane && typeof lane.ws.setScroll === "function") {
      try { if (Math.abs(lane.ws.getScroll() - px) > 1) lane.ws.setScroll(px); } catch (e) {}
    }
  }
  roll.scrollPx = px;
  syncingScroll = false;
}

function maxScroll() {
  const w = $("roll-wrap").clientWidth || 800;
  return Math.max(0, (engine.duration || 0) * engine.pxPerSec - w);
}

function setScrollAll(px) {
  px = Math.min(maxScroll(), Math.max(0, px));
  roll.scrollPx = px;
  syncingScroll = true;
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane && typeof lane.ws.setScroll === "function") {
      try { lane.ws.setScroll(px); } catch (e) {}
    }
  }
  syncingScroll = false;
}

function fitPx() {
  const w = $("roll-wrap").clientWidth || 800;
  return w / Math.max(0.001, engine.duration || 30);
}

function applyZoom() {
  const v = parseFloat($("zoom").value) / 100; // 0 = whole file fits, 1 = max
  const fit = fitPx();
  const maxPx = Math.max(fit * 1.001, 800);
  engine.pxPerSec = fit * Math.pow(maxPx / fit, v);
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane) { try { lane.ws.zoom(engine.pxPerSec); } catch (e) {} }
  }
  roll.scrollPx = Math.min(roll.scrollPx, maxScroll());
  drawRoll();
}

$("zoom").addEventListener("input", applyZoom);
$("zoom-in").addEventListener("click", () => { $("zoom").value = Math.min(100, parseFloat($("zoom").value) + 8); applyZoom(); });
$("zoom-out").addEventListener("click", () => { $("zoom").value = Math.max(0, parseFloat($("zoom").value) - 8); applyZoom(); });
window.addEventListener("resize", applyZoom);

/* wheel scrubs all lanes left/right */
for (const id of ["wave-input", "wave-stem", "wave-nodrums", "roll-wrap"]) {
  $(id).addEventListener("wheel", (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    setScrollAll(roll.scrollPx + d);
  }, { passive: false });
}

/* ------------------------------------------------------------------ */
/* piano roll                                                          */
/* ------------------------------------------------------------------ */
const roll = {
  canvas: $("roll"),
  ctx: $("roll").getContext("2d"),
  events: null,
  scrollPx: 0,
};

function drawRoll() {
  const c = roll.canvas;
  const wrap = $("roll-wrap");
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W === 0 || H === 0) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const ctx = roll.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const rows = ROLL_ORDER.length;
  const rowH = H / rows;
  const px = engine.pxPerSec;
  const t0 = roll.scrollPx / px;
  const t1 = (roll.scrollPx + W) / px;

  ctx.font = "10px Consolas, monospace";
  for (let i = 0; i < rows; i++) {
    const y = i * rowH;
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.025)" : "transparent";
    ctx.fillRect(0, y, W, rowH);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  if (px > 24) {
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (let s = Math.ceil(t0); s <= t1; s++) {
      const x = s * px - roll.scrollPx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  if (roll.events) {
    const markW = Math.max(2, Math.min(6, px / 30));
    for (let i = 0; i < rows; i++) {
      const cls = ROLL_ORDER[i];
      const times = roll.events[cls] || [];
      ctx.fillStyle = COLORS[cls];
      const y = i * rowH + rowH * 0.18;
      const h = rowH * 0.64;
      const lo = lowerBound(times, t0 - 0.05);
      for (let j = lo; j < times.length && times[j] <= t1 + 0.05; j++) {
        ctx.fillRect(times[j] * px - roll.scrollPx - markW / 2, y, markW, h);
      }
    }
  }

  for (let i = 0; i < rows; i++) {
    const cls = ROLL_ORDER[i];
    ctx.fillStyle = COLORS[cls];
    ctx.fillText(cls, 4, i * rowH + 11);
  }

  const t = Tone.Transport.seconds;
  const x = t * px - roll.scrollPx;
  if (x >= 0 && x <= W) {
    ctx.strokeStyle = "#e8e8e8";
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* roll pointer: click = seek (or edit), drag = loop selection */
let rollDrag = null;

$("roll-wrap").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  $("roll-wrap").setPointerCapture(e.pointerId);
  rollDrag = { x0: e.offsetX, y0: e.offsetY, moved: false };
});

$("roll-wrap").addEventListener("pointermove", (e) => {
  if (!rollDrag) return;
  if (Math.abs(e.offsetX - rollDrag.x0) > 5) rollDrag.moved = true;
  if (rollDrag.moved) {
    const tA = (roll.scrollPx + rollDrag.x0) / engine.pxPerSec;
    const tB = (roll.scrollPx + e.offsetX) / engine.pxPerSec;
    loop.preview = [Math.min(tA, tB), Math.max(tA, tB)];
  }
});

$("roll-wrap").addEventListener("pointerup", (e) => {
  if (!rollDrag) return;
  const drag = rollDrag;
  rollDrag = null;
  loop.preview = null;
  if (drag.moved) {
    const tA = (roll.scrollPx + drag.x0) / engine.pxPerSec;
    const tB = (roll.scrollPx + e.offsetX) / engine.pxPerSec;
    setLoop(tA, tB);
    return;
  }
  if ($("midi-edit").checked) toggleNote(e.offsetX, e.offsetY);
  else seekAll((roll.scrollPx + e.offsetX) / engine.pxPerSec);
});

$("roll-wrap").addEventListener("pointercancel", () => { rollDrag = null; loop.preview = null; });

/* edit mode -------------------------------------------------------------- */
function toggleNote(x, y) {
  if (!roll.events) {
    setLog("nothing to edit yet — run ADTOF first", true);
    return;
  }
  const wrap = $("roll-wrap");
  const rowH = wrap.clientHeight / ROLL_ORDER.length;
  const row = Math.min(ROLL_ORDER.length - 1, Math.max(0, Math.floor(y / rowH)));
  const cls = ROLL_ORDER[row];
  const t = (roll.scrollPx + x) / engine.pxPerSec;
  const tol = 6 / engine.pxPerSec;
  const arr = roll.events[cls];
  const j = lowerBound(arr, t);
  let hit = -1;
  if (j < arr.length && Math.abs(arr[j] - t) <= tol) hit = j;
  else if (j > 0 && Math.abs(arr[j - 1] - t) <= tol) hit = j - 1;
  if (hit >= 0) {
    arr.splice(hit, 1);
    setLog("removed " + cls + " @ " + t.toFixed(3) + "s");
  } else {
    arr.splice(j, 0, Math.round(t * 1e5) / 1e5);
    if (engine.started) engine.synths.trigger(cls, Tone.now());
    setLog("added " + cls + " @ " + t.toFixed(3) + "s");
  }
  rebuildPart(roll.events);
  updateCounts();
  drawRoll();
  pushEventsDebounced();
}

let pushTimer = null;
function pushEventsDebounced() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const r = await postJSON("/api/events/update", { events: roll.events });
      lastPickRev = r.rev;
    } catch (e) { setLog("edit sync: " + e.message, true); }
  }, 300);
}

function updateCounts() {
  if (!roll.events) return;
  for (const c of CLASSES) {
    const el = $("count-" + c.id);
    if (el) el.textContent = (roll.events[c.id] || []).length + "×";
  }
}

/* ------------------------------------------------------------------ */
/* MIDI part                                                           */
/* ------------------------------------------------------------------ */
function rebuildPart(events) {
  if (engine.part) { try { engine.part.dispose(); } catch (e) {} engine.part = null; }
  const flat = [];
  for (const cls in events) for (const t of events[cls]) flat.push({ time: t, cls: cls });
  flat.sort((a, b) => a.time - b.time);
  if (!flat.length) return;
  engine.part = new Tone.Part((time, ev) => engine.synths.trigger(ev.cls, time), flat).start(0);
}

async function fetchEvents() {
  const d = await api("/api/events");
  roll.events = d.events;
  engine.tempo = d.tempo;
  $("tempo-display").textContent = "~" + d.tempo.toFixed(1) + " bpm";
  rebuildPart(d.events);
  recomputeDuration();
  updateCounts();
  drawRoll();
}

/* ------------------------------------------------------------------ */
/* controls: threshold sliders                                         */
/* ------------------------------------------------------------------ */
function buildSliders() {
  const host = $("sliders");
  for (const c of CLASSES) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.innerHTML =
      '<span class="cls" style="color:' + COLORS[c.id] + '">' + c.label + "</span>" +
      '<input type="range" id="th-' + c.id + '" min="0" max="1" step="0.005" value="' + c.def + '">' +
      '<span class="val" id="val-' + c.id + '">' + c.def.toFixed(3) + "</span>" +
      '<span class="count" id="count-' + c.id + '"></span>';
    host.appendChild(row);
    const slider = row.querySelector("input");
    slider.addEventListener("input", () => {
      $("val-" + c.id).textContent = parseFloat(slider.value).toFixed(3);
      if ($("ad-live").checked) debouncedPick();
    });
  }
}

function currentThresholds() {
  const th = {};
  for (const c of CLASSES) th[c.id] = parseFloat($("th-" + c.id).value);
  return th;
}

let pickTimer = null;
let pickInFlight = false;
let pickQueued = false;

function debouncedPick() {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(runPick, 70);
}

async function runPick() {
  if (pickInFlight) { pickQueued = true; return; }
  pickInFlight = true;
  try {
    const r = await postJSON("/api/adtof/pick", { thresholds: currentThresholds() });
    lastPickRev = r.rev;
    await fetchEvents();
  } catch (e) {
    setLog("pick: " + e.message, true);
  } finally {
    pickInFlight = false;
    if (pickQueued) { pickQueued = false; debouncedPick(); }
  }
}

/* ------------------------------------------------------------------ */
/* controls: upload / mode / run / stop                                */
/* ------------------------------------------------------------------ */
function getDevice() { return document.querySelector('input[name="device"]:checked').value; }
function getMode() { return document.querySelector('input[name="entry"]:checked').value; }

function applyMode() {
  const direct = getMode() === "direct";
  $("panel-demucs").classList.toggle("disabled", direct);
  $("lane-stem").classList.toggle("hidden", direct);
  $("lane-nodrums").classList.toggle("hidden", direct);
}
document.querySelectorAll('input[name="entry"]').forEach((r) => r.addEventListener("change", applyMode));

function fmtSize(bytes) {
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
  return m + ":" + String(s).padStart(2, "0");
}

function renderInputMeta(input) {
  const dz = $("dropzone");
  if (!input) {
    $("meta-display").textContent = "no file loaded";
    $("file-name").innerHTML = "&nbsp;";
    $("file-meta").innerHTML = "&nbsp;";
    dz.classList.remove("has-art");
    dz.style.backgroundImage = "";
    return;
  }
  const chs = input.channels === 1 ? "mono" : input.channels === 2 ? "stereo" : input.channels + "ch";
  const parts = [
    (input.ext || "?").toUpperCase(),
    (input.samplerate / 1000).toFixed(1).replace(/\.0$/, "") + " kHz",
    chs,
    fmtDur(input.duration),
    fmtSize(input.size || 0),
  ];
  $("meta-display").textContent = input.name + "  ·  " + parts.join(" · ");
  $("file-name").textContent = input.name;
  $("file-meta").textContent = parts.join(" · ");
  if (input.art) {
    dz.classList.add("has-art");
    dz.style.backgroundImage = "url(/api/art?v=" + input.id + ")";
  } else {
    dz.classList.remove("has-art");
    dz.style.backgroundImage = "";
  }
}

async function doUpload(file) {
  if (!file) return;
  $("file-name").textContent = "uploading + converting …";
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await api("/api/upload", { method: "POST", body: fd });
    setLog("uploaded " + r.input.name);
  } catch (e) {
    $("file-name").innerHTML = "&nbsp;";
    setLog("upload failed: " + e.message, true);
  }
}

$("dropzone").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => doUpload(e.target.files[0]));
$("dropzone").addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").classList.add("drag"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("drag"));
$("dropzone").addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropzone").classList.remove("drag");
  doUpload(e.dataTransfer.files[0]);
});

$("dm-run").addEventListener("click", async () => {
  try {
    await postJSON("/api/demucs/run", {
      model: $("dm-model").value,
      shifts: parseInt($("dm-shifts").value || "0", 10),
      overlap: parseFloat($("dm-overlap").value || "0.25"),
      segment: $("dm-segment").value ? parseInt($("dm-segment").value, 10) : null,
      device: getDevice(),
    });
    poll(true);
  } catch (e) { setLog("demucs: " + e.message, true); }
});
$("dm-stop").addEventListener("click", () => postJSON("/api/demucs/stop", {}).catch(() => {}));

$("ad-run").addEventListener("click", async () => {
  try {
    await postJSON("/api/adtof/run", {
      source: getMode() === "demucs" ? "stem" : "input",
      fps: parseInt($("ad-fps").value || "100", 10),
      thresholds: currentThresholds(),
      device: getDevice(),
    });
    poll(true);
  } catch (e) { setLog("adtof: " + e.message, true); }
});
$("ad-stop").addEventListener("click", () => postJSON("/api/adtof/stop", {}).catch(() => {}));

/* downloads */
function bindDownload(btnId, kind) {
  $(btnId).addEventListener("click", () => {
    window.location.href = "/api/download/" + kind + "?grid=" + encodeURIComponent($("out-grid").value);
  });
}
bindDownload("dl-stem", "stem");
bindDownload("dl-midi", "midi");
bindDownload("dl-midi-quant", "midi_quant");
bindDownload("dl-musicxml", "musicxml");

/* knobs */
const knobs = {
  master: createKnob("knob-master", {
    label: "master", size: 36, value: 1.0,
    onChange: (v) => { master.gain.value = v; },
  }),
  input: createKnob("knob-input", {
    label: "gain", size: 40, value: 0.9,
    onChange: (v) => { laneGains.input.gain.value = v; },
  }),
  stem: createKnob("knob-stem", {
    label: "gain", size: 40, value: 0.9,
    onChange: (v) => { laneGains.stem.gain.value = v; },
  }),
  nodrums: createKnob("knob-nodrums", {
    label: "gain", size: 40, value: 0.9,
    onChange: (v) => { laneGains.nodrums.gain.value = v; },
  }),
  midi: createKnob("knob-midi", {
    label: "midi", size: 36, value: 0.8,
    onChange: (v) => { midiBus.gain.value = v; },
  }),
};
for (const c of CLASSES) {
  knobs[c.id] = createKnob("knob-" + c.id, {
    label: c.label.slice(0, 3).toLowerCase(), size: 24, value: CLASS_GAIN_DEF[c.id],
    color: COLORS[c.id],
    onChange: (v) => { classGains[c.id].gain.value = v; },
  });
}

/* transport buttons + keyboard */
$("btn-play").addEventListener("click", togglePlay);
$("btn-stop").addEventListener("click", stopTransport);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    togglePlay();
  }
});

/* ------------------------------------------------------------------ */
/* status polling                                                      */
/* ------------------------------------------------------------------ */
let lastInputId = null;
let lastStemKey = null;
let lastPickRev = 0;
let pollTimer = null;

function setLog(msg, isErr) {
  const el = $("log-line");
  el.textContent = msg || "";
  el.className = isErr ? "err" : "";
}

function renderJob(prefix, job) {
  const chip = $(prefix + "-status");
  chip.textContent = job.status;
  chip.className = "chip " + job.status;
  $(prefix + "-msg").textContent = job.message || "";
  const bar = $(prefix + "-bar");
  bar.style.width = job.progress != null ? (job.progress * 100).toFixed(1) + "%" : (job.status === "running" ? "100%" : "0%");
  bar.style.opacity = job.progress != null || job.status !== "running" ? "1" : "0.35";
  $(prefix + "-run").disabled = job.status === "running";
  $(prefix + "-stop").disabled = job.status !== "running";
}

async function poll(fast) {
  clearTimeout(pollTimer);
  let running = false;
  try {
    const s = await api("/api/state");
    renderJob("dm", s.jobs.demucs);
    renderJob("ad", s.jobs.adtof);
    running = s.jobs.demucs.status === "running" || s.jobs.adtof.status === "running";

    if (s.input && s.input.id !== lastInputId) {
      lastInputId = s.input.id;
      lastStemKey = null;
      lastPickRev = 0;
      roll.events = null;
      if (engine.part) { try { engine.part.dispose(); } catch (e) {} engine.part = null; }
      disposeLane("stem");
      disposeLane("nodrums");
      clearLoop();
      renderInputMeta(s.input);
      $("tempo-display").textContent = "";
      seekAll(0);
      loadLane("input", "/api/audio/input?v=" + s.input.id).catch((e) => setLog("waveform: " + e.message, true));
    }
    if (s.stem && s.stem.key !== lastStemKey) {
      lastStemKey = s.stem.key;
      loadLane("stem", "/api/audio/stem?v=" + s.stem.key).catch((e) => setLog("waveform: " + e.message, true));
      if (s.stem.nodrums) {
        loadLane("nodrums", "/api/audio/nodrums?v=" + s.stem.key).catch((e) => setLog("waveform: " + e.message, true));
      }
    }
    if (s.pick && s.pick.rev !== lastPickRev) {
      lastPickRev = s.pick.rev;
      fetchEvents().catch((e) => setLog("events: " + e.message, true));
    }

    $("dl-stem").disabled = !s.stem;
    const havePick = !!s.pick;
    $("dl-midi").disabled = !havePick;
    $("dl-midi-quant").disabled = !havePick;
    $("dl-musicxml").disabled = !havePick;

    const lastLog = (s.jobs.demucs.status === "running" ? s.jobs.demucs.log : s.jobs.adtof.log) || [];
    if (running && lastLog.length) setLog(lastLog[lastLog.length - 1]);
    if (s.jobs.demucs.status === "error") setLog("demucs: " + s.jobs.demucs.message, true);
    else if (s.jobs.adtof.status === "error") setLog("adtof: " + s.jobs.adtof.message, true);
  } catch (e) {
    setLog("server unreachable: " + e.message, true);
  }
  pollTimer = setTimeout(poll, running || fast ? 400 : 1200);
}

/* ------------------------------------------------------------------ */
/* render loop                                                         */
/* ------------------------------------------------------------------ */
function raf() {
  const t = Tone.Transport.seconds;
  $("time-display").textContent = fmtTime(t);
  if (Tone.Transport.state === "started") {
    updateCursors(t);
    if (!loop.active && engine.duration && t >= engine.duration) {
      Tone.Transport.pause();
      Tone.Transport.seconds = engine.duration;
    }
  }
  renderPlayButton();
  drawRoll();
  updateLoopOverlays();

  drawStereoMeter($("master-meter"), taps.master.get(), true);
  for (const k of LANE_NAMES) {
    if (engine.lanes[k]) drawStereoMeter($("meter-" + k), taps[k].get(), false);
  }
  requestAnimationFrame(raf);
}

/* init */
buildSliders();
engine.synths = makeSynths();
applyMode();
applyZoom();
new ResizeObserver(() => drawRoll()).observe($("roll-wrap"));
poll(true);
requestAnimationFrame(raf);
setLog("drumlab ready — upload a file to start");
