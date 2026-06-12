"use strict";
/* drumlab frontend — vanilla JS, WaveSurfer 7.8.6 (waveforms) + Tone.js 14.8.49 (clock/synth) */

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

/* ------------------------------------------------------------------ */
/* audio engine                                                        */
/* ------------------------------------------------------------------ */
const engine = {
  started: false,
  lanes: { input: null, stem: null },   // {ws, player, gain}
  part: null,
  synths: null,
  duration: 0,
  pxPerSec: 40,
  tempo: null,
};

function makeSynths() {
  const bus = new Tone.Gain(parseFloat($("gain-midi").value)).toDestination();

  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.04, octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
  }).connect(bus);

  const snareBP = new Tone.Filter(1800, "bandpass").connect(bus);
  const snare = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.13, sustain: 0 },
  }).connect(snareBP);

  const hihat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.02 },
    harmonicity: 5.1, modulationIndex: 32, resonance: 6000, octaves: 1.2,
  }).connect(bus);

  const tom = new Tone.MembraneSynth({
    pitchDecay: 0.06, octaves: 3,
    envelope: { attack: 0.001, decay: 0.25, sustain: 0 },
  }).connect(bus);

  const cymbal = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 1.1, release: 0.4 },
    harmonicity: 4.1, modulationIndex: 40, resonance: 5000, octaves: 1.5,
  }).connect(bus);

  function metalHit(synth, freq, dur, time, vel) {
    try { synth.triggerAttackRelease(freq, dur, time, vel); }
    catch (e) { try { synth.triggerAttackRelease(dur, time, vel); } catch (e2) { /* ignore */ } }
  }

  return {
    bus,
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

function disposeLane(name) {
  const lane = engine.lanes[name];
  if (!lane) return;
  try { lane.ws.destroy(); } catch (e) {}
  try { lane.player.unsync(); lane.player.dispose(); } catch (e) {}
  try { lane.gain.dispose(); } catch (e) {}
  engine.lanes[name] = null;
  const cont = $(name === "input" ? "wave-input" : "wave-stem");
  cont.innerHTML = '<div class="placeholder">' + (name === "input" ? "no input loaded" : "no drum stem yet") + "</div>";
}

async function loadLane(name, url) {
  disposeLane(name);
  const cont = $(name === "input" ? "wave-input" : "wave-stem");
  cont.innerHTML = "";

  const gain = new Tone.Gain(parseFloat($(name === "input" ? "gain-input" : "gain-stem").value)).toDestination();
  const player = new Tone.Player();
  await player.load(url);
  player.connect(gain);
  player.sync().start(0);

  const ws = WaveSurfer.create({
    container: cont,
    url: url,
    height: Math.max(60, cont.clientHeight - 4),
    waveColor: name === "input" ? "#4a6f96" : "#4f8f6a",
    progressColor: name === "input" ? "#76a8d8" : "#7cc79b",
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
  engine.lanes[name] = { ws, player, gain };

  recomputeDuration();
  setLog(name + " audio loaded (" + player.buffer.duration.toFixed(1) + "s)");
}

function recomputeDuration() {
  let d = 0;
  for (const k of ["input", "stem"]) {
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
}

/* transport ---------------------------------------------------------- */
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

function seekAll(t) {
  t = Math.max(0, engine.duration ? Math.min(t, engine.duration) : t);
  const wasPlaying = Tone.Transport.state === "started";
  if (wasPlaying) Tone.Transport.pause();
  Tone.Transport.seconds = t;
  updateCursors(t);
  if (wasPlaying) Tone.Transport.start("+0.05");
}

function updateCursors(t) {
  for (const k of ["input", "stem"]) {
    const lane = engine.lanes[k];
    if (lane) { try { lane.ws.setTime(t); } catch (e) {} }
  }
}

function renderPlayButton() {
  $("btn-play").innerHTML = Tone.Transport.state === "started" ? "&#10074;&#10074;" : "&#9654;";
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + s.toFixed(3).padStart(6, "0");
}

/* scroll + zoom sync -------------------------------------------------- */
let syncingScroll = false;

function mirrorScroll(fromName) {
  if (syncingScroll) return;
  const src = engine.lanes[fromName];
  if (!src || typeof src.ws.getScroll !== "function") return;
  syncingScroll = true;
  const px = src.ws.getScroll();
  for (const k of ["input", "stem"]) {
    if (k === fromName) continue;
    const lane = engine.lanes[k];
    if (lane && typeof lane.ws.setScroll === "function") {
      try { if (Math.abs(lane.ws.getScroll() - px) > 1) lane.ws.setScroll(px); } catch (e) {}
    }
  }
  roll.scrollPx = px;
  syncingScroll = false;
}

function setScrollAll(px) {
  px = Math.max(0, px);
  roll.scrollPx = px;
  syncingScroll = true;
  for (const k of ["input", "stem"]) {
    const lane = engine.lanes[k];
    if (lane && typeof lane.ws.setScroll === "function") {
      try { lane.ws.setScroll(px); } catch (e) {}
    }
  }
  syncingScroll = false;
}

function zoomToSlider() {
  const v = parseFloat($("zoom").value);
  engine.pxPerSec = Math.min(1200, 4 * Math.pow(2, v / 12));
  for (const k of ["input", "stem"]) {
    const lane = engine.lanes[k];
    if (lane) { try { lane.ws.zoom(engine.pxPerSec); } catch (e) {} }
  }
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

  // row separators + labels
  ctx.font = "10px Consolas, monospace";
  for (let i = 0; i < rows; i++) {
    const y = i * rowH;
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.025)" : "transparent";
    ctx.fillRect(0, y, W, rowH);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // second gridlines when zoomed in enough
  if (px > 24) {
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (let s = Math.ceil(t0); s <= t1; s++) {
      const x = s * px - roll.scrollPx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  // hits
  if (roll.events) {
    const markW = Math.max(2, Math.min(6, px / 30));
    for (let i = 0; i < rows; i++) {
      const cls = ROLL_ORDER[i];
      const times = roll.events[cls] || [];
      ctx.fillStyle = COLORS[cls];
      const y = i * rowH + rowH * 0.18;
      const h = rowH * 0.64;
      let lo = lowerBound(times, t0 - 0.05);
      for (let j = lo; j < times.length && times[j] <= t1 + 0.05; j++) {
        ctx.fillRect(times[j] * px - roll.scrollPx - markW / 2, y, markW, h);
      }
    }
  }

  // row labels (fixed at left)
  for (let i = 0; i < rows; i++) {
    const cls = ROLL_ORDER[i];
    ctx.fillStyle = COLORS[cls];
    ctx.fillText(cls, 4, i * rowH + 11);
  }

  // playhead
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

$("roll-wrap").addEventListener("click", (e) => {
  const t = (roll.scrollPx + e.offsetX) / engine.pxPerSec;
  seekAll(t);
});
$("roll-wrap").addEventListener("wheel", (e) => {
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  setScrollAll(roll.scrollPx + d);
}, { passive: false });

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
  for (const c of CLASSES) {
    const el = $("count-" + c.id);
    if (el) el.textContent = (d.events[c.id] || []).length + "×";
  }
  drawRoll();
}

/* ------------------------------------------------------------------ */
/* controls: sliders                                                   */
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
/* controls: upload / run / stop                                       */
/* ------------------------------------------------------------------ */
function getDevice() { return document.querySelector('input[name="device"]:checked').value; }
function getMode() { return document.querySelector('input[name="entry"]:checked').value; }

async function doUpload(file) {
  if (!file) return;
  $("file-name").textContent = "uploading + converting …";
  try {
    const r = await api("/api/upload", { method: "POST", body: (() => { const fd = new FormData(); fd.append("file", file); return fd; })() });
    $("file-name").textContent = r.input.name + " · " + r.input.duration.toFixed(1) + "s";
    setLog("uploaded " + r.input.name);
  } catch (e) {
    $("file-name").textContent = "";
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

document.querySelectorAll('input[name="entry"]').forEach((r) =>
  r.addEventListener("change", () => {
    $("panel-demucs").classList.toggle("disabled", getMode() === "direct");
  })
);

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

/* gains */
$("gain-input").addEventListener("input", (e) => {
  const lane = engine.lanes.input;
  if (lane) lane.gain.gain.value = parseFloat(e.target.value);
});
$("gain-stem").addEventListener("input", (e) => {
  const lane = engine.lanes.stem;
  if (lane) lane.gain.gain.value = parseFloat(e.target.value);
});
$("gain-midi").addEventListener("input", (e) => {
  if (engine.synths) engine.synths.bus.gain.value = parseFloat(e.target.value);
});

/* transport buttons + keyboard */
$("btn-play").addEventListener("click", togglePlay);
$("btn-rewind").addEventListener("click", () => seekAll(0));
$("zoom").addEventListener("input", zoomToSlider);
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
      $("file-name").textContent = s.input.name + " · " + s.input.duration.toFixed(1) + "s";
      $("tempo-display").textContent = "";
      seekAll(0);
      loadLane("input", "/api/audio/input?v=" + s.input.id).catch((e) => setLog("waveform: " + e.message, true));
    }
    if (s.stem && s.stem.key !== lastStemKey) {
      lastStemKey = s.stem.key;
      loadLane("stem", "/api/audio/stem?v=" + s.stem.key).catch((e) => setLog("waveform: " + e.message, true));
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
    if (engine.duration && t >= engine.duration) {
      Tone.Transport.pause();
      Tone.Transport.seconds = engine.duration;
    }
    renderPlayButton();
  }
  drawRoll();
  requestAnimationFrame(raf);
}

/* init */
buildSliders();
engine.synths = makeSynths();
zoomToSlider();
new ResizeObserver(() => drawRoll()).observe($("roll-wrap"));
poll(true);
requestAnimationFrame(raf);
setLog("drumlab ready — upload a file to start");
