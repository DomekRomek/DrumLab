"use strict";
/* DrumLab frontend — vanilla JS, WaveSurfer 7.8.6 (waveforms) + Tone.js 14.8.49 (clock/synth) */

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
const ROLL_LABEL = { kick: "Kick", snare: "Snare", hihat: "Hi-hat", tom: "Tom", cymbal: "Cymbal" };
// hidden per-instrument trim: evens out raw synth loudness so the user-facing
// knobs all sit at 0 dB (snare carries the groove; metals are tamed hard)
const CLASS_TRIM = { kick: 0.9, snare: 1.0, hihat: 0.22, tom: 0.9, cymbal: 0.22 };
// Demucs full-separation sources (display/lane order) + the derived backing. The
// backend writes the same four stems; names match, so order here is UI-only.
const SOURCES = ["drums", "bass", "vocals", "other"];
const STEM_LANES = [...SOURCES, "backing"];        // separation-driven lanes
const LANE_NAMES = ["input", ...STEM_LANES];       // all audio lanes (no MIDI)
const LANE_CONT = Object.fromEntries(LANE_NAMES.map((k) => [k, "wave-" + k]));
const LANE_LABEL = {
  input: "Input", drums: "Drums", bass: "Bass", other: "Other",
  vocals: "Vocals", backing: "Backing",
};
const LANE_PLACEHOLDER = {
  input: "No input loaded",
  drums: "Run separation to hear the drums",
  bass: "Run separation to hear the bass",
  other: "Run separation to hear the other parts",
  vocals: "Run separation to hear the vocals",
  backing: "Everything you don't split off, summed together",
};
const LANE_COLORS = {
  input:   { wave: "#4a6f96", prog: "#76a8d8" },
  drums:   { wave: "#4f8f6a", prog: "#7cc79b" },
  bass:    { wave: "#9c5fb0", prog: "#c184d6" },
  other:   { wave: "#5a7fb5", prog: "#85a8da" },
  vocals:  { wave: "#b5694a", prog: "#dd9576" },
  backing: { wave: "#8a7a4d", prog: "#c4ad6e" },
};
// every scrollable lane body (waveforms + the MIDI roll) — for scroll/zoom/resize sync
const LANE_BODIES = LANE_NAMES.map((k) => LANE_CONT[k]).concat("roll-wrap");
const STATUS_LABEL = { idle: "Idle", running: "Running…", done: "Complete", cancelled: "Stopped", error: "Error" };

/* ------------------------------------------------------------------ */
/* knob component (rotary; drag vertically, wheel, double-click reset) */
/* ------------------------------------------------------------------ */
function createKnob(hostId, opts) {
  const o = Object.assign({ min: 0, max: 1, value: 1, size: 38, color: "#4ea1ff", label: "", fmt: (v) => v.toFixed(2) }, opts);
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
  wrap.appendChild(canvas);
  wrap.appendChild(label);
  host.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  const defVal = (o.resetValue !== undefined) ? o.resetValue : o.value;
  let value = o.value;
  let dragY = null, dragV = null, hover = false;
  const A0 = 0.75 * Math.PI, A1 = 2.25 * Math.PI; // 270° sweep

  function refreshLabel() {
    // live readout while interacting, name otherwise
    label.textContent = (hover || dragY !== null) ? o.fmt(value) : (o.label || o.fmt(value));
  }

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
    refreshLabel();
    if (fire !== false && o.onChange) o.onChange(value);
  }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    dragY = e.clientY; dragV = value;
    refreshLabel();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragY === null) return;
    const range = o.max - o.min;
    const fine = e.shiftKey ? 0.25 : 1;
    setValue(dragV + (dragY - e.clientY) * (range / 150) * fine);
  });
  canvas.addEventListener("pointerup", () => { dragY = null; refreshLabel(); });
  canvas.addEventListener("pointercancel", () => { dragY = null; refreshLabel(); });
  canvas.addEventListener("pointerenter", () => { hover = true; refreshLabel(); });
  canvas.addEventListener("pointerleave", () => { hover = false; refreshLabel(); });
  canvas.addEventListener("dblclick", () => setValue(defVal));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    setValue(value + (e.deltaY < 0 ? 1 : -1) * (o.max - o.min) / 40);
  }, { passive: false });

  setValue(value, false);
  return { get: () => value, set: setValue };
}

/* logarithmic (dB) gain knob: position 0 = -inf, then -60 dB .. maxDb */
const KNOB_MIN_DB = -60;

function makeDbKnob(hostId, o) {
  const maxDb = o.maxDb !== undefined ? o.maxDb : 6;
  const posToDb = (p) => (p <= 0.004 ? -Infinity : KNOB_MIN_DB + p * (maxDb - KNOB_MIN_DB));
  const dbToPos = (db) => (!isFinite(db) ? 0 : Math.min(1, Math.max(0, (db - KNOB_MIN_DB) / (maxDb - KNOB_MIN_DB))));
  const fmt = (p) => {
    const db = posToDb(p);
    if (!isFinite(db)) return "-inf dB";
    return (db >= 0 ? "+" : "-") + Math.abs(db).toFixed(1) + " dB";
  };
  const apply = (p) => {
    const db = posToDb(p);
    o.onGain(isFinite(db) ? Math.pow(10, db / 20) : 0);
  };
  const startDb = o.startDb !== undefined ? o.startDb : 0;
  const knob = createKnob(hostId, {
    // pass a real default — an undefined color would override createKnob's and
    // leave the progress arc drawn in the grey track colour (i.e. invisible)
    label: o.label, size: o.size, color: o.color || "#4ea1ff",
    min: 0, max: 1,
    value: dbToPos(startDb),
    resetValue: dbToPos(0),
    fmt: fmt,
    onChange: apply,
  });
  apply(knob.get());
  return knob;
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
  ctx.fillStyle = "#8b919e";
  ctx.strokeStyle = "rgba(139,145,158,0.4)";
  ctx.font = "8px Consolas, monospace";
  const labeled = [-48, -24, -12, 0]; // -6/-3 get ticks only, labels would collide near 0
  for (const m of marks) {
    const x = dbToFrac(m) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - padB); ctx.stroke();
    if (withScale && labeled.includes(m)) {
      const text = String(m);
      const tx = m === 0 ? W - ctx.measureText(text).width - 1 : x + 1;
      ctx.fillText(text, tx, H - 2);
    }
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
/* audio graph + mixer (mute / solo)                                   */
/* ------------------------------------------------------------------ */
const engine = {
  started: false,
  lanes: Object.fromEntries(LANE_NAMES.map((k) => [k, null])),  // {ws, sched, height}
  part: null,
  synths: null,
  duration: 0,
  pxPerSec: 40,
  tempo: null,
  speed: 1.0,  // playback rate (pitch preserved); content = speed * Transport.seconds
};

const master = new Tone.Gain(1.0);
master.connect(Tone.getDestination());
const laneGains = {};
for (const k of LANE_NAMES) laneGains[k] = new Tone.Gain(0).connect(master);
laneGains.input.gain.value = 1.0;            // applyMix() takes over once it runs
const midiBus = new Tone.Gain(1.0).connect(master);
const classGains = {};
for (const c of CLASSES) classGains[c.id] = new Tone.Gain(CLASS_TRIM[c.id]).connect(midiBus);

// track mixer state; node gain = knob gain, gated by mute/solo.
// the separated stems sit at 0 dB but start muted — unmute to hear them.
const mix = { midi: { gain: 1, mute: false, solo: false, node: midiBus } };
for (const k of LANE_NAMES) {
  mix[k] = { gain: 1, mute: k !== "input", solo: false, node: laneGains[k] };
}

const MIX_TRACKS = [...LANE_NAMES, "midi"];

function applyMix() {
  const anySolo = Object.values(mix).some((m) => m.solo);
  for (const k in mix) {
    const m = mix[k];
    // solo wins over mute: a soloed track is audible even if its mute is engaged
    const audible = anySolo ? m.solo : !m.mute;
    m.node.gain.value = audible ? m.gain : 0;
  }
}

function bindMuteSolo(track) {
  const mBtn = $("mute-" + track), sBtn = $("solo-" + track);
  mBtn.addEventListener("click", () => {
    mix[track].mute = !mix[track].mute;
    mBtn.classList.toggle("active", mix[track].mute);
    applyMix();
  });
  sBtn.addEventListener("click", () => {
    // solo is exclusive: soloing a track clears every other solo. Clicking the
    // already-soloed track turns solo off entirely.
    const turningOn = !mix[track].solo;
    for (const t of MIX_TRACKS) {
      mix[t].solo = turningOn && t === track;
      $("solo-" + t).classList.toggle("active", mix[t].solo);
    }
    applyMix();
  });
}
for (const t of MIX_TRACKS) bindMuteSolo(t);
for (const t of STEM_LANES) $("mute-" + t).classList.add("active");  // stems start muted

const taps = { master: makeTap(master), midi: makeTap(midiBus) };
for (const k of LANE_NAMES) taps[k] = makeTap(laneGains[k]);

/* ------------------------------------------------------------------ */
/* drum synths (+ optional user-loaded one-shot samples per instrument) */
/* ------------------------------------------------------------------ */
const customSamples = {}; // cls -> Tone.ToneAudioBuffer; overrides the synth voice

function makeSynths() {
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.04, octaves: 6,
    envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
  }).connect(classGains.kick);

  // snare = bright noise crack + short tonal body
  const snareBP = new Tone.Filter(1700, "bandpass").connect(classGains.snare);
  const snareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
  }).connect(snareBP);
  const snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.02, octaves: 2,
    envelope: { attack: 0.001, decay: 0.11, sustain: 0 },
  }).connect(classGains.snare);

  const hihat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.06, release: 0.02 },
    harmonicity: 5.1, modulationIndex: 32, resonance: 6000, octaves: 1.2,
  }).connect(classGains.hihat);

  // tom = slow shallow pitch sweep + stick-attack noise (a fast deep sweep reads as a laser bloop)
  const tom = new Tone.MembraneSynth({
    pitchDecay: 0.08, octaves: 1.5,
    envelope: { attack: 0.002, decay: 0.4, sustain: 0 },
  }).connect(classGains.tom);
  const tomAttackHP = new Tone.Filter(2500, "highpass").connect(classGains.tom);
  const tomAttack = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.02, sustain: 0 },
  }).connect(tomAttackHP);

  // gentle ride: low modulation + low resonance gives a soft ping, not a crash wash
  const cymbal = new Tone.MetalSynth({
    envelope: { attack: 0.002, decay: 1.6, release: 0.8 },
    harmonicity: 3.1, modulationIndex: 14, resonance: 3500, octaves: 0.8,
  }).connect(classGains.cymbal);

  function metalHit(synth, freq, dur, time, vel) {
    try { synth.triggerAttackRelease(freq, dur, time, vel); }
    catch (e) { try { synth.triggerAttackRelease(dur, time, vel); } catch (e2) { /* ignore */ } }
  }

  return {
    trigger(cls, time) {
      try {
        const buf = customSamples[cls];
        if (buf && buf.loaded) {
          // user one-shot: plays at natural pitch/length (drum hits aren't time-stretched)
          const src = new Tone.ToneBufferSource(buf).connect(classGains[cls]);
          src.start(time);
          return;
        }
        if (cls === "kick") kick.triggerAttackRelease("C1", 0.25, time);
        else if (cls === "snare") {
          snareNoise.triggerAttackRelease(0.16, time, 1.0);
          snareBody.triggerAttackRelease("G3", 0.1, time, 0.5);
        } else if (cls === "tom") {
          tom.triggerAttackRelease("G2", 0.4, time, 0.9);
          tomAttack.triggerAttackRelease(0.02, time, 0.4);
        } else if (cls === "hihat") metalHit(hihat, 320, 0.05, time, 0.5);
        else if (cls === "cymbal") metalHit(cymbal, 330, 1.4, time, 0.35);
      } catch (e) { /* never break the transport */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/* lanes                                                               */
/* ------------------------------------------------------------------ */
function disposeLane(name) {
  const lane = engine.lanes[name];
  if (!lane) return;
  try { lane.ws.destroy(); } catch (e) {}
  try { lane.sched.dispose(); } catch (e) {}
  engine.lanes[name] = null;
  $(LANE_CONT[name]).innerHTML = '<div class="placeholder">' + LANE_PLACEHOLDER[name] + "</div>";
}

// Display peaks for WaveSurfer. One positive magnitude per bin — WaveSurfer's
// renderer takes abs() and mirrors top/bottom, so a plain envelope is what it wants
// (interleaving max/min makes it draw a zero-crossing comb). Resolution is matched to
// the max zoom width so it never looks blocky. A gentle perceptual power curve lifts
// quiet detail (hats) without turning loud masters into a solid block — a true dB
// taper over-compresses and does exactly that.
const DISPLAY_GAMMA = 0.65;
const DISPLAY_CEIL_DB = 3;   // headroom above 0 dBFS, so over-full-scale (clipping) peaks show
const DISPLAY_NORM = Math.pow(Math.pow(10, DISPLAY_CEIL_DB / 20), DISPLAY_GAMMA);
// magnitude (0..~1+) -> display fraction of half-height (0..1); edge = +CEIL dBFS
function warpAmp(mag) {
  return Math.min(1, Math.pow(mag, DISPLAY_GAMMA) / DISPLAY_NORM);
}
function dbToFracAmp(db) {
  return warpAmp(Math.pow(10, db / 20));
}
function computeDisplayPeaks(toneBuffer) {
  let buf;
  try { buf = toneBuffer.get(); } catch (e) { return null; }
  if (!buf) return null;
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const N = ch0.length;
  const bins = Math.max(4000, Math.min(1200000, Math.round(buf.duration * 1200)));
  const per = Math.max(1, Math.floor(N / bins));
  const count = Math.floor(N / per) || 1;
  const out = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    let mx = 0;
    const start = b * per, end = start + per;
    for (let i = start; i < end; i++) {
      const v = ch1 ? Math.max(Math.abs(ch0[i]), Math.abs(ch1[i])) : Math.abs(ch0[i]);
      if (v > mx) mx = v;
    }
    out[b] = warpAmp(mx);
  }
  return out;
}

// per-lane load token: the latest loadLane() for a lane wins; any earlier call
// still in flight self-destructs on completion instead of leaking a ws/scheduler.
const _laneToken = {};
async function loadLane(name, url, chunkQuery) {
  const token = (_laneToken[name] = {});
  disposeLane(name);
  const cont = $(LANE_CONT[name]);
  cont.innerHTML = "";

  // Decode the whole file ONCE to compute display peaks, then free it — playback
  // streams in chunks (bounded RAM), so we keep only the small peaks + duration.
  // WaveSurfer is display-only, fed precomputed log-compressed peaks.
  const buffer = new Tone.ToneAudioBuffer();
  await buffer.load(url);
  const duration = buffer.duration;
  const peaks = computeDisplayPeaks(buffer);
  buffer.dispose();   // release the full PCM; lane.sched re-streams it as chunks

  const ws = WaveSurfer.create({
    container: cont,
    peaks: peaks ? [peaks] : undefined,
    duration: duration,
    height: Math.max(56, cont.clientHeight - 4),
    waveColor: LANE_COLORS[name].wave,
    progressColor: LANE_COLORS[name].prog,
    cursorColor: "#e8e8e8",
    cursorWidth: 1,
    normalize: false,
    interact: true,
    autoScroll: true,
    autoCenter: false,
    minPxPerSec: engine.pxPerSec,
    hideScrollbar: false,
  });
  ws.on("interaction", (t) => seekAll(t));
  ws.on("scroll", () => mirrorScroll(name));
  buildAmpAxis(cont);
  const sched = makeChunkScheduler(name, chunkQuery);
  if (_laneToken[name] !== token) {   // a newer load superseded this one
    try { ws.destroy(); } catch (e) {}
    try { sched.dispose(); } catch (e) {}
    return;
  }
  engine.lanes[name] = { ws, sched, duration, height: 0 };

  if (Tone.Transport.state === "started") sched.start(nowContent());
  else sched.prefetch(engine.speed, nowContent());   // warm the playhead so play is instant
  recomputeDuration();
  setLog(LANE_LABEL[name] + " audio loaded (" + duration.toFixed(1) + " s)");
}

// dBFS reference lines through the same warp as the waveform. Even 6 dB steps so the
// spacing compresses monotonically toward the centre — the correct logarithmic look.
// 0 dBFS is an interior "clip" line; the band above it (to +CEIL dBFS) is headroom.
const AMP_AXIS_DB = [0, -6, -12, -18, -24];
function buildAmpAxis(cont) {
  const axis = document.createElement("div");
  axis.className = "amp-axis";
  const unit = document.createElement("div");
  unit.className = "amp-label amp-unit";
  unit.textContent = "dBFS";
  axis.appendChild(unit);
  // centre line = zero amplitude (-inf dBFS)
  const mid = document.createElement("div");
  mid.className = "amp-line zero";
  mid.style.top = "50%";
  axis.appendChild(mid);
  for (const db of AMP_AXIS_DB) {
    const frac = dbToFracAmp(db); // 0..1 of half height
    const cls = db === 0 ? "amp-line clip" : "amp-line";
    for (const sign of [-1, 1]) {
      const line = document.createElement("div");
      line.className = cls;
      line.style.top = (50 - sign * frac * 50) + "%";
      axis.appendChild(line);
    }
    const label = document.createElement("div");
    label.className = db === 0 ? "amp-label clip" : "amp-label";
    label.style.top = (50 - frac * 50) + "%";
    label.textContent = db === 0 ? "0" : db;
    axis.appendChild(label);
  }
  cont.appendChild(axis);
}

/* manual audio drive — chunk schedulers are not transport-synced so speed can
   differ from the clock. content position C = speed * Transport.seconds. */
function laneList() {
  return LANE_NAMES.map((k) => engine.lanes[k]).filter(Boolean);
}
function nowContent() {
  return engine.speed * Tone.Transport.seconds;
}

/* ------------------------------------------------------------------ */
/* chunked streaming playback (bounded RAM, sample-locked to the MIDI) */
/* ------------------------------------------------------------------ */
// Each lane plays a sliding window of short chunks pulled from /api/audio_chunk
// and scheduled on the Web Audio clock at their absolute transport times, so the
// audio stays locked to the MIDI no matter when a chunk finishes decoding, and no
// lane ever holds the whole song. Speed != 1 streams a pre-stretched copy at rate
// 1.0 (pitch preserved server-side). CHUNK_SEC must match app.py.
const CHUNK_SEC = 8.0;
const CHUNK_AHEAD = 2;    // chunks scheduled ahead of the playhead
const CHUNK_BEHIND = 1;   // chunks kept cached behind it
const SCHED_TICK_MS = 120;

function makeChunkScheduler(laneName, chunkQuery) {
  const dest = laneGains[laneName];
  const extraQ = chunkQuery || "";
  const cache = new Map();    // "speed:i" -> Tone.ToneAudioBuffer (decoded)
  const pending = new Map();  // "speed:i" -> Promise
  const live = new Map();     // i -> ToneBufferSource (null = scheduling in flight)
  let activeSpeed = null;
  let gen = 0;                // bumped on every (re)start/stop to void stale fetches
  let disposed = false;
  const k = (speed, i) => speed.toFixed(4) + ":" + i;

  function fetchChunk(speed, i) {
    const key = k(speed, i);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      const buf = new Tone.ToneAudioBuffer();
      await buf.load("/api/audio_chunk?lane=" + laneName + "&i=" + i + "&speed=" + speed.toFixed(4) + extraQ);
      pending.delete(key);
      if (disposed) { buf.dispose(); throw new Error("disposed"); }
      cache.set(key, buf);
      return buf;
    })();
    pending.set(key, p);
    return p;
  }

  // stop() and dispose() in separate try blocks: Tone's stop() asserts in some
  // states, and if it threw before dispose() the source would stay connected
  // (and audible). dispose() must always run to disconnect the node.
  function killSrc(s) {
    if (!s) return;
    try { s.stop(); } catch (e) {}
    try { s.dispose(); } catch (e) {}
  }

  function stopLive() {
    gen++;
    for (const src of live.values()) killSrc(src);
    live.clear();
    activeSpeed = null;
  }

  function evict(speed, lo, hi) {
    for (const i of [...live.keys()]) {
      if (i < lo) { killSrc(live.get(i)); live.delete(i); }
    }
    const sp = speed.toFixed(4);
    for (const key of [...cache.keys()]) {
      const [ksp, kidx] = key.split(":");
      if (ksp !== sp || +kidx < lo - 1 || +kidx > hi + 1) {
        try { cache.get(key).dispose(); } catch (e) {}
        cache.delete(key);
      }
    }
  }

  // schedule unscheduled chunks in the window. Each chunk's start time and
  // mid-buffer offset are computed when its buffer RESOLVES (not when it's
  // enqueued), from the live transport position — a fetch can take ms (cached
  // slice) to seconds (fresh atempo render), and using the enqueue-time values
  // would start late buffers at stale times/offsets (overlap on speed-up, a
  // behind-the-playhead cut-out on slow-down). A chunk the playhead has already
  // passed by resolve time is dropped rather than started.
  function pump(content) {
    if (disposed || Tone.Transport.state !== "started") return;
    const speed = engine.speed;
    if (activeSpeed !== null && activeSpeed !== speed) stopLive();
    activeSpeed = speed;
    const ctx = Tone.getContext();
    const cur = Math.floor(content / CHUNK_SEC);
    const hi = cur + CHUNK_AHEAD;
    const g = gen;
    for (let i = Math.max(0, cur); i <= hi; i++) {
      if (live.has(i)) continue;
      live.set(i, null);                          // reserve the slot while fetching
      fetchChunk(speed, i).then((buf) => {
        if (disposed || g !== gen || engine.speed !== speed
            || Tone.Transport.state !== "started" || live.get(i) !== null) {
          if (live.get(i) === null) live.delete(i);
          return;
        }
        // recompute timing from the live playhead so a late buffer lands right
        const nowCtx = ctx.currentTime;
        const nowT = Tone.Transport.seconds;
        const nowContentLive = speed * nowT;
        const chunkStart = i * CHUNK_SEC;
        if (nowContentLive >= chunkStart + CHUNK_SEC) { // window moved past it
          live.delete(i);
          return;
        }
        let when, offset;
        if (nowContentLive > chunkStart) {           // current chunk: start now, mid-buffer
          offset = (nowContentLive - chunkStart) / speed;
          when = nowCtx + 0.02;
        } else {                                     // ahead chunk: anchor to its transport time
          offset = 0;
          when = nowCtx + (chunkStart / speed - nowT);
        }
        const src = new Tone.ToneBufferSource(buf).connect(dest);
        try { src.start(when, offset); live.set(i, src); }
        catch (e) { live.delete(i); try { src.dispose(); } catch (_) {} }
      }).catch(() => { if (live.get(i) === null) live.delete(i); });
    }
    evict(speed, cur - CHUNK_BEHIND, hi);
  }

  return {
    laneName,
    fetch: fetchChunk,
    prefetch(speed, content) {
      const c = Math.max(0, Math.floor(content / CHUNK_SEC));
      for (let i = c; i <= c + 1; i++) fetchChunk(speed, i).catch(() => {});
    },
    start(content) { stopLive(); pump(content); },
    pump,
    stop() { stopLive(); },
    dispose() {
      disposed = true; stopLive();
      for (const b of cache.values()) { try { b.dispose(); } catch (e) {} }
      cache.clear(); pending.clear();
    },
  };
}

let _schedTimer = null;
function startScheduling() {
  if (_schedTimer) return;
  _schedTimer = setInterval(() => {
    if (Tone.Transport.state !== "started") return;
    const content = nowContent();
    for (const lane of laneList()) lane.sched.pump(content);
  }, SCHED_TICK_MS);
}

function startLanePlayer(lane, offset) { lane.sched.start(Math.max(0, offset)); }
function startAudio(offset) {
  startScheduling();
  for (const lane of laneList()) lane.sched.start(Math.max(0, offset));
}
function stopAudio() {
  for (const lane of laneList()) lane.sched.stop();
}

function recomputeDuration() {
  let d = 0;
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane && lane.duration) d = Math.max(d, lane.duration);
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

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */
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
    stopAudio();
  } else {
    let c = nowContent();
    if (engine.duration && c >= engine.duration - 0.05) { c = 0; Tone.Transport.seconds = 0; }
    // Start the transport FIRST: startAudio's pump() bails unless the transport is
    // already "started", so scheduling audio before this left the first chunks to the
    // next ~120 ms interval tick while the MIDI began instantly (audio lagged on play).
    Tone.Transport.start();
    startAudio(c);
  }
  renderPlayButton();
}

function stopTransport() {
  Tone.Transport.pause();
  stopAudio();
  Tone.Transport.seconds = 0;
  updateCursors(0);
  renderPlayButton();
}

function seekAll(c) {
  c = Math.max(0, engine.duration ? Math.min(c, engine.duration) : c);
  const wasPlaying = Tone.Transport.state === "started";
  if (wasPlaying) { Tone.Transport.pause(); stopAudio(); }
  Tone.Transport.seconds = c / engine.speed;
  updateCursors(c);
  // transport before audio (see togglePlay): pump() needs state "started" to schedule
  if (wasPlaying) { Tone.Transport.start("+0.03"); startAudio(c); }
}

// A speed change needs a one-time server render of the stretched audio (cached
// after). We debounce the knob so a sweep triggers one render, and — while playing
// — keep the current speed audible until the new chunks are ready, then swap at the
// live playhead so there's no silent gap.
let _speedTimer = null, _speedTarget = null;
function setSpeedDebounced(s) {
  _speedTarget = s;
  if (_speedTimer) clearTimeout(_speedTimer);
  _speedTimer = setTimeout(() => { _speedTimer = null; setSpeed(s); }, 300);
}

function setSpeed(s) {
  const commit = () => {
    if (_speedTarget !== s) return;   // superseded by a newer target
    const c = nowContent();
    engine.speed = s;
    Tone.Transport.seconds = c / s;
    rebuildPart(roll.events || {});
    if (loop.active) { try { Tone.Transport.setLoopPoints(loop.start / s, loop.end / s); } catch (e) {} }
    updateCursors(c);
    if (Tone.Transport.state === "started") { stopAudio(); startAudio(c); }
    else for (const lane of laneList()) lane.sched.prefetch(s, c);
  };
  if (Math.abs(s - engine.speed) < 1e-4) return;
  if (Tone.Transport.state === "started" && laneList().length) {
    // pre-render the stretched audio at the playhead before swapping (no gap)
    const cur = Math.max(0, Math.floor(nowContent() / CHUNK_SEC));
    if (s !== 1.0) setLog("Rendering " + s.toFixed(2) + "× audio …");
    Promise.all(laneList().map((l) => l.sched.fetch(s, cur))).then(commit).catch(commit);
  } else commit();
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

/* ------------------------------------------------------------------ */
/* loop                                                                */
/* ------------------------------------------------------------------ */
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
    // loop points are in transport (real) seconds = content / speed
    Tone.Transport.setLoopPoints(a / engine.speed, b / engine.speed);
    Tone.Transport.loop = true;
  } catch (e) {}
  $("loop-chip").classList.remove("hidden");
  $("loop-range").textContent = a.toFixed(2) + "–" + b.toFixed(2) + " s";
  $("loop-deselect").disabled = false;
}

// restart the audio players at the loop start when the transport wraps
Tone.Transport.on("loop", () => {
  if (Tone.Transport.state === "started") startAudio(loop.active ? loop.start : 0);
});

function clearLoop() {
  loop.active = false;
  loop.preview = null;
  try { Tone.Transport.loop = false; } catch (e) {}
  $("loop-chip").classList.add("hidden");
  $("loop-deselect").disabled = true;
}

$("loop-clear").addEventListener("click", clearLoop);
$("loop-deselect").addEventListener("click", clearLoop);

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
  const bodies = LANE_BODIES.map((id) => $(id));
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

/* ------------------------------------------------------------------ */
/* scroll + zoom sync                                                  */
/* ------------------------------------------------------------------ */
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

let wsZoomTimer = null;

function applyZoom() {
  const v = parseFloat($("zoom").value) / 100; // 0 = whole file fits, 1 = max
  const fit = fitPx();
  const maxPx = Math.max(fit * 1.001, 800);
  engine.pxPerSec = fit * Math.pow(maxPx / fit, v);
  roll.scrollPx = Math.min(roll.scrollPx, maxScroll());
  drawRoll();
  // waveform re-render is the expensive part — debounce it so the slider stays fluid
  clearTimeout(wsZoomTimer);
  wsZoomTimer = setTimeout(applyWsZoom, 90);
}

function applyWsZoom() {
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (lane) { try { lane.ws.zoom(engine.pxPerSec); } catch (e) {} }
  }
}

$("zoom").addEventListener("input", applyZoom);
$("zoom-in").addEventListener("click", () => { $("zoom").value = Math.min(100, parseFloat($("zoom").value) + 8); applyZoom(); });
$("zoom-out").addEventListener("click", () => { $("zoom").value = Math.max(0, parseFloat($("zoom").value) - 8); applyZoom(); });
window.addEventListener("resize", applyZoom);

/* keep waveform heights in step with lane size (lanes grow when others hide) */
function syncLaneHeights() {
  for (const k of LANE_NAMES) {
    const lane = engine.lanes[k];
    if (!lane) continue;
    const h = Math.max(56, $(LANE_CONT[k]).clientHeight - 4);
    if (lane.height !== h) {
      lane.height = h;
      try { lane.ws.setOptions({ height: h }); } catch (e) {}
    }
  }
  drawRoll();
}

const laneRO = new ResizeObserver(() => requestAnimationFrame(syncLaneHeights));
for (const id of LANE_BODIES) laneRO.observe($(id));

/* wheel scrubs all lanes left/right */
for (const id of LANE_BODIES) {
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
    ctx.fillText(ROLL_LABEL[cls], 4, i * rowH + 11);
  }

  const t = nowContent();
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
  if (editMode) toggleNote(e.offsetX, e.offsetY);
  else seekAll((roll.scrollPx + e.offsetX) / engine.pxPerSec);
});

$("roll-wrap").addEventListener("pointercancel", () => { rollDrag = null; loop.preview = null; });

/* ------------------------------------------------------------------ */
/* edit mode                                                           */
/* ------------------------------------------------------------------ */
let editMode = false;

$("midi-edit").addEventListener("click", () => {
  editMode = !editMode;
  $("midi-edit").classList.toggle("active", editMode);
  setLog(editMode
    ? "Edit mode on — click a roll row to add a hit, click an existing hit to remove it"
    : "Edit mode off");
});

const GRID_STEPS_Q = { "1/8": 0.5, "1/16": 0.25, "1/16T": 1 / 6, "1/32": 0.125 };

function gentleSnap(t) {
  // snap to the export grid when close to a gridline (30 % of a step), else place freely
  if (!engine.tempo) return t;
  const gridQ = GRID_STEPS_Q[$("out-grid").value] || 0.25;
  const step = gridQ * 60 / engine.tempo;
  const snapped = Math.round(t / step) * step;
  return Math.abs(snapped - t) <= step * 0.3 ? snapped : t;
}

function toggleNote(x, y) {
  if (!roll.events) {
    setLog("Nothing to edit yet — run the transcription first", true);
    return;
  }
  const wrap = $("roll-wrap");
  const rowH = wrap.clientHeight / ROLL_ORDER.length;
  const row = Math.min(ROLL_ORDER.length - 1, Math.max(0, Math.floor(y / rowH)));
  const cls = ROLL_ORDER[row];
  let t = (roll.scrollPx + x) / engine.pxPerSec;
  const tol = 6 / engine.pxPerSec;
  const arr = roll.events[cls];
  let j = lowerBound(arr, t);
  let hit = -1;
  if (j < arr.length && Math.abs(arr[j] - t) <= tol) hit = j;
  else if (j > 0 && Math.abs(arr[j - 1] - t) <= tol) hit = j - 1;
  if (hit >= 0) {
    setLog("Removed " + cls + " hit at " + arr[hit].toFixed(3) + " s");
    arr.splice(hit, 1);
  } else {
    t = Math.max(0, gentleSnap(t));
    j = lowerBound(arr, t);
    arr.splice(j, 0, Math.round(t * 1e5) / 1e5);
    if (engine.started) engine.synths.trigger(cls, Tone.now());
    setLog("Added " + cls + " hit at " + t.toFixed(3) + " s");
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
    } catch (e) { setLog("Edit sync failed: " + e.message, true); }
  }, 300);
}

function updateCounts() {
  for (const c of CLASSES) {
    const el = $("count-" + c.id);
    if (el) el.textContent = roll.events ? (roll.events[c.id] || []).length + "×" : "";
  }
}

/* ------------------------------------------------------------------ */
/* MIDI part                                                           */
/* ------------------------------------------------------------------ */
function rebuildPart(events) {
  if (engine.part) { try { engine.part.dispose(); } catch (e) {} engine.part = null; }
  const flat = [];
  // schedule in transport time = content time / speed, so MIDI tracks the audio rate
  for (const cls in events) for (const t of events[cls]) flat.push({ time: t / engine.speed, cls: cls });
  flat.sort((a, b) => a.time - b.time);
  if (!flat.length) return;
  engine.part = new Tone.Part((time, ev) => engine.synths.trigger(ev.cls, time), flat).start(0);
}

async function fetchEvents() {
  const d = await api("/api/events");
  roll.events = d.events;
  engine.tempo = d.tempo;
  const manual = Math.abs(d.tempo - d.detected_tempo) > 0.001;
  $("tempo-display").textContent = d.tempo.toFixed(1) + " BPM" + (manual ? " (manual)" : "");
  $("out-tempo").textContent = manual
    ? "Manual tempo: " + d.tempo.toFixed(1) + " BPM · detected " + d.detected_tempo.toFixed(1) + " BPM"
    : "Detected tempo: " + d.tempo.toFixed(1) + " BPM (set your DAW session tempo to this)";
  rebuildPart(d.events);
  recomputeDuration();
  updateCounts();
  drawRoll();
}

/* ------------------------------------------------------------------ */
/* threshold sliders                                                   */
/* ------------------------------------------------------------------ */
function buildSliders() {
  const host = $("sliders");
  for (const c of CLASSES) {
    const row = document.createElement("div");
    row.className = "slider-row";
    row.title = "Detection threshold for " + c.label.toLowerCase() + " — lower finds more hits, higher fewer";
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
    setLog("Threshold update failed: " + e.message, true);
  } finally {
    pickInFlight = false;
    if (pickQueued) { pickQueued = false; debouncedPick(); }
  }
}

/* ------------------------------------------------------------------ */
/* upload / mode                                                       */
/* ------------------------------------------------------------------ */
function getDevice() { return document.querySelector('input[name="device"]:checked').value; }

/* ------------------------------------------------------------------ */
/* separation selection: which sources to split off, which to download */
/* ------------------------------------------------------------------ */
// splitSel: sources that get their own lane (the rest sum into Backing).
const splitSel = { drums: true, bass: false, vocals: false, other: false };
// showBacking: user's intent to keep the Backing track (toggled via its pill / × ).
let showBacking = true;
// dlSel: audio lanes ticked for "Download selected" (the □ button on each lane) —
// the stems, Backing, and the raw Input (e.g. grab the original at a changed speed).
const dlSel = {};
for (const k of LANE_NAMES) dlSel[k] = false;
const stageHidden = { dm: false, ad: false };

// sources present on disk (all four, until a separation tells us otherwise)
function presentSources() {
  return (lastState && lastState.stems) ? lastState.stems.sources : SOURCES;
}
function backingParts() { return presentSources().filter((s) => !splitSel[s]); }
// Backing only makes sense as its own track when it's a proper, non-empty subset:
// all sources split off -> empty; nothing split off -> identical to the input.
function backingMakesSense() {
  const off = presentSources().filter((s) => splitSel[s]).length;
  return off >= 1 && backingParts().length >= 1;
}

function laneVisible(name) {
  if (name === "backing") return !stageHidden.dm && showBacking && backingMakesSense();
  if (SOURCES.includes(name)) return !stageHidden.dm && splitSel[name];
  return true;
}

function loadStemLane(name, url, q) {
  loadLane(name, url, q)
    .catch((e) => setLog("Waveform failed: " + e.message, true))
    .finally(() => { if (!laneVisible(name) && engine.lanes[name]) disposeLane(name); });  // untoggled mid-load
}

function renderStemLanes() {
  const stems = lastState && lastState.stems;
  const avail = presentSources();
  for (const s of SOURCES) {
    $("lane-" + s).classList.toggle("hidden", !laneVisible(s));
    if (splitSel[s] && stems && avail.includes(s) && !engine.lanes[s]) {
      loadStemLane(s, "/api/audio/" + s + "?v=" + stems.key);
    } else if (!splitSel[s] && engine.lanes[s]) {
      disposeLane(s);
    }
  }
  // backing = the unsplit sources, summed on the server (keyed by composition)
  $("lane-backing").classList.toggle("hidden", !laneVisible("backing"));
  const sig = backingParts().join(",");
  if (stems && showBacking && backingMakesSense()) {
    if (engine._backingSig !== sig) {
      engine._backingSig = sig;
      const q = "&parts=" + encodeURIComponent(sig);
      loadStemLane("backing", "/api/audio/backing?v=" + stems.key + "_" + encodeURIComponent(sig) + q, q);
    }
  } else if (engine.lanes.backing) {
    engine._backingSig = null;
    disposeLane("backing");
  }
  syncSplitPills();
  updateDlSelected();
}

// keep the Split-off pills (incl. Backing) in step with the selection state
function syncSplitPills() {
  for (const pill of document.querySelectorAll("#dm-split .split-pill[data-src]")) {
    pill.classList.toggle("on", !!splitSel[pill.dataset.src]);
  }
  const bk = $("split-backing");
  const sensible = backingMakesSense();
  bk.disabled = !sensible;
  bk.classList.toggle("on", sensible && showBacking);
}

function updateDlSelected() {
  for (const k of LANE_NAMES) {
    const btn = $("dlsel-" + k);
    if (btn) btn.classList.toggle("active", !!dlSel[k]);
  }
  $("dl-selected").disabled = selectedStems().length === 0;
}

// split-off pills (one per source) + the Backing toggle pill
for (const pill of document.querySelectorAll("#dm-split .split-pill[data-src]")) {
  pill.addEventListener("click", () => {
    splitSel[pill.dataset.src] = !splitSel[pill.dataset.src];
    renderStemLanes();
  });
}
$("split-backing").addEventListener("click", () => {
  if (!backingMakesSense()) return;
  showBacking = !showBacking;
  renderStemLanes();
});

// per-lane download-select (□) and remove (×) buttons
for (const k of LANE_NAMES) {
  $("dlsel-" + k).addEventListener("click", () => { dlSel[k] = !dlSel[k]; updateDlSelected(); });
  const rm = $("rm-" + k);
  if (rm) rm.addEventListener("click", () => {
    if (k === "backing") showBacking = false;   // Backing's × just hides the track
    else splitSel[k] = false;                    // a source's × folds it back into Backing
    renderStemLanes();
  });
}

// per-stage eye toggles: grey the panel out in place + hide its tracks
$("dm-eye").addEventListener("click", () => {
  stageHidden.dm = !stageHidden.dm;
  $("dm-eye").classList.toggle("off", stageHidden.dm);
  $("panel-demucs").classList.toggle("stage-off", stageHidden.dm);
  renderStemLanes();
});
$("ad-eye").addEventListener("click", () => {
  stageHidden.ad = !stageHidden.ad;
  $("ad-eye").classList.toggle("off", stageHidden.ad);
  $("panel-adtof").classList.toggle("stage-off", stageHidden.ad);
  $("lane-midi").classList.toggle("hidden", stageHidden.ad);
});

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
    $("meta-display").textContent = "No file loaded";
    $("file-name").innerHTML = "&nbsp;";
    $("file-meta").innerHTML = "&nbsp;";
    dz.classList.remove("has-art");
    dz.style.backgroundImage = "";
    return;
  }
  const chs = input.channels === 1 ? "mono" : input.channels === 2 ? "stereo" : input.channels + " ch";
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
  $("file-name").textContent = "Uploading and converting …";
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await api("/api/upload", { method: "POST", body: fd });
    setLog("Loaded " + r.input.name);
    poll(true);
  } catch (e) {
    $("file-name").innerHTML = "&nbsp;";
    setLog("Upload failed: " + e.message, true);
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

/* ------------------------------------------------------------------ */
/* library / playlist — party shuffle + curated queue, RAM only        */
/* ------------------------------------------------------------------ */
// The queue lives entirely client-side; the server only indexes files (/api/library)
// and loads one by path (/api/load_path, which feeds the same poll() refresh as upload).
const PARTY_TARGET = 5;   // keep at least this many songs queued while party shuffle is on
const HISTORY_MAX = 5;    // how many previously-played songs Prev can step back through
const playlist = {
  songs: [],          // [{path, name, artist}] — the indexed library
  configured: false,  // any --library / picked root present?
  queue: [],          // upcoming [{path,name,artist}]; index 0 = the next to load
  history: [],        // previously-played songs, most-recent-last (cap HISTORY_MAX)
  current: null,      // the song currently loaded via the queue (null if uploaded manually)
  party: false,
  loading: false,
};

function updateShuffleBtn() {
  const btn = $("btn-shuffle");
  const on = playlist.party && playlist.configured;
  btn.disabled = !playlist.configured;
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  btn.title = !playlist.configured
    ? "Select a library folder to enable party shuffle"
    : playlist.party
      ? "Party shuffle ON — auto-queuing random songs. Click to turn off."
      : "Party shuffle OFF — click to auto-queue random songs from your library.";
}

function renderQueue() {
  const list = $("queue-list");
  const q = playlist.queue;
  $("queue-count").textContent = q.length ? q.length + " queued" : "";
  $("queue-prev").disabled = playlist.history.length === 0 || playlist.loading;
  $("queue-next").disabled = q.length === 0 || playlist.loading;
  $("queue-clear").disabled = q.length === 0;
  $("queue-empty").classList.toggle("hidden", q.length > 0);
  list.innerHTML = "";
  q.forEach((song, i) => {
    const row = document.createElement("div");
    row.className = "queue-row" + (i === 0 ? " next" : "");
    row.title = "Load " + song.name + (song.artist ? " — " + song.artist : "");
    const txt = document.createElement("div");
    txt.className = "qr-text";
    const nm = document.createElement("div"); nm.className = "qr-name"; nm.textContent = song.name;
    const ar = document.createElement("div"); ar.className = "qr-artist"; ar.textContent = song.artist || "";
    txt.appendChild(nm); txt.appendChild(ar);
    const del = document.createElement("button");
    del.className = "qr-del"; del.innerHTML = "&times;"; del.title = "Remove from queue";
    del.addEventListener("click", (e) => { e.stopPropagation(); removeFromQueue(i); });
    row.appendChild(txt); row.appendChild(del);
    row.addEventListener("click", () => loadFromQueue(i));
    list.appendChild(row);
  });
}

function partyFill() {
  if (!playlist.party || !playlist.songs.length) return;
  const queued = new Set(playlist.queue.map((s) => s.path));
  const allowDupes = playlist.songs.length <= PARTY_TARGET;
  let guard = 0;
  while (playlist.queue.length < PARTY_TARGET && guard++ < 1000) {
    const pick = playlist.songs[Math.floor(Math.random() * playlist.songs.length)];
    if (queued.has(pick.path) && !allowDupes) continue;
    queued.add(pick.path);
    playlist.queue.push(pick);
  }
}

function enqueue(song) { playlist.queue.push(song); renderQueue(); }

function removeFromQueue(i) {
  playlist.queue.splice(i, 1);
  partyFill();
  renderQueue();
}

function clearQueue() { playlist.queue = []; renderQueue(); }

async function loadSong(song) {
  if (playlist.loading) return;
  playlist.loading = true;
  chainAdtof = null;   // dropping the old song cancels any separation->transcription chain
  renderQueue();
  $("file-name").textContent = "Loading " + song.name + " …";
  try {
    const r = await postJSON("/api/load_path", { path: song.path });
    setLog("Loaded " + r.input.name);
    poll(true);
  } catch (e) {
    setLog("Load failed: " + e.message, true);
  } finally {
    playlist.loading = false;
    renderQueue();
  }
}

// Make `song` the current track; the song it replaces moves onto the history stack.
function goToSong(song) {
  if (playlist.current) {
    playlist.history.push(playlist.current);
    if (playlist.history.length > HISTORY_MAX) playlist.history.shift();
  }
  playlist.current = song;
  renderQueue();
  loadSong(song);
}

function loadFromQueue(i) {
  if (playlist.loading) return;
  const song = playlist.queue[i];
  if (!song) return;
  playlist.queue.splice(0, i + 1);   // drop the chosen song and any you skipped past
  partyFill();
  goToSong(song);
}

function nextSong() {
  if (playlist.loading) return;
  if (!playlist.queue.length) partyFill();
  if (playlist.queue.length) loadFromQueue(0);
}

// Step back to the previously-played song; the current one returns to the queue front,
// keeping Prev/Next symmetric.
function prevSong() {
  if (playlist.loading || !playlist.history.length) return;
  const song = playlist.history.pop();
  if (playlist.current) playlist.queue.unshift(playlist.current);
  playlist.current = song;
  renderQueue();
  loadSong(song);
}

async function loadLibrary(refresh) {
  try {
    const lib = await api("/api/library" + (refresh ? "?refresh=1" : ""));
    playlist.songs = lib.songs || [];
    playlist.configured = !!lib.configured;
    if (!playlist.configured) playlist.party = false;
    updateShuffleBtn();
    renderQueue();
    if (!$("library-songs").classList.contains("hidden")) renderSongList();
    return lib;
  } catch (e) {
    setLog("Library: " + e.message, true);
  }
}

$("btn-shuffle").addEventListener("click", () => {
  if (!playlist.configured) return;
  playlist.party = !playlist.party;
  if (playlist.party) partyFill();
  updateShuffleBtn();
  renderQueue();
});
$("queue-prev").addEventListener("click", prevSong);
$("queue-next").addEventListener("click", nextSong);
$("queue-clear").addEventListener("click", clearQueue);

/* ---- library modal: folder picker + song browser ---- */
let browseDir = "";

function openLibrary() {
  $("library-modal").classList.remove("hidden");
  if (playlist.configured) showSongsView(); else showBrowseView();
}
function closeLibrary() { $("library-modal").classList.add("hidden"); }

function showBrowseView(dir) {
  $("library-title").textContent = "Pick a music folder";
  $("library-browse").classList.remove("hidden");
  $("library-songs").classList.add("hidden");
  browseTo(dir || "");
}
function showSongsView() {
  $("library-title").textContent = "Library — click a song to queue it";
  $("library-browse").classList.add("hidden");
  $("library-songs").classList.remove("hidden");
  renderSongList();
}

function browseItem(iconEntity, label, onClick) {
  const el = document.createElement("div");
  el.className = "browse-item";
  const ico = document.createElement("span");
  ico.className = "bi-ico"; ico.innerHTML = iconEntity;
  el.appendChild(ico);
  el.appendChild(document.createTextNode(label));
  el.addEventListener("click", onClick);
  return el;
}

async function browseTo(dir) {
  try {
    const b = await api("/api/browse?dir=" + encodeURIComponent(dir || ""));
    browseDir = b.dir;
    $("browse-path").textContent = b.dir;
    const dr = $("browse-drives");
    dr.innerHTML = "";
    (b.drives || []).forEach((d) => {
      const chip = document.createElement("button");
      chip.className = "drive-chip"; chip.textContent = d;
      chip.addEventListener("click", () => browseTo(d));
      dr.appendChild(chip);
    });
    const list = $("browse-list");
    list.innerHTML = "";
    if (b.parent) list.appendChild(browseItem("&#8593;", " ..", () => browseTo(b.parent)));
    b.dirs.forEach((d) => list.appendChild(browseItem("&#128193;", " " + d.name, () => browseTo(d.path))));
    if (!b.dirs.length && !b.parent) {
      const e = document.createElement("div"); e.className = "hint"; e.textContent = "No sub-folders here.";
      list.appendChild(e);
    }
  } catch (e) {
    setLog("Browse: " + e.message, true);
  }
}

async function useFolder() {
  if (!browseDir) return;
  try {
    await postJSON("/api/library/roots", { path: browseDir });
    await loadLibrary();   // server already rescanned on add; fetch the new list
    showSongsView();
    setLog("Library folder added: " + browseDir);
  } catch (e) {
    setLog("Library: " + e.message, true);
  }
}

function renderSongList() {
  const list = $("song-list");
  const q = ($("song-search").value || "").toLowerCase();
  list.innerHTML = "";
  let lastArtist = null, shown = 0;
  playlist.songs.forEach((song) => {
    if (q && !(song.name.toLowerCase().includes(q) || (song.artist || "").toLowerCase().includes(q))) return;
    if (song.artist !== lastArtist) {
      lastArtist = song.artist;
      const g = document.createElement("div");
      g.className = "song-group"; g.textContent = song.artist || "—";
      list.appendChild(g);
    }
    const el = document.createElement("div");
    el.className = "song-item"; el.title = "Add to queue";
    const nm = document.createElement("span"); nm.className = "si-name"; nm.textContent = song.name;
    el.appendChild(nm);
    el.addEventListener("click", () => { enqueue(song); setLog("Queued " + song.name); });
    list.appendChild(el);
    shown++;
  });
  if (!shown) {
    const e = document.createElement("div"); e.className = "hint";
    e.textContent = playlist.songs.length ? "No matches." : "No audio files found in this folder.";
    list.appendChild(e);
  }
}

$("btn-library").addEventListener("click", openLibrary);
$("library-close").addEventListener("click", closeLibrary);
$("library-changedir").addEventListener("click", () => showBrowseView(browseDir));
$("browse-use").addEventListener("click", useFolder);
$("song-search").addEventListener("input", renderSongList);
$("library-modal").addEventListener("click", (e) => { if (e.target === $("library-modal")) closeLibrary(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("library-modal").classList.contains("hidden")) closeLibrary();
});

/* ------------------------------------------------------------------ */
/* run / stop / chaining                                               */
/* ------------------------------------------------------------------ */
function demucsParams() {
  return {
    model: $("dm-model").value,
    shifts: parseInt($("dm-shifts").value || "0", 10),
    overlap: parseFloat($("dm-overlap").value || "0.25"),
    segment: $("dm-segment").value ? parseInt($("dm-segment").value, 10) : null,
    device: getDevice(),
  };
}

function adtofParams(source) {
  return {
    source: source,
    fps: parseInt($("ad-fps").value || "100", 10),
    thresholds: currentThresholds(),
    device: getDevice(),
  };
}

let chainAdtof = null; // transcription params waiting for separation to finish

$("dm-run").addEventListener("click", async () => {
  try {
    await postJSON("/api/demucs/run", demucsParams());
    poll(true);
  } catch (e) { setLog("Separation: " + e.message, true); }
});
$("dm-stop").addEventListener("click", () => { chainAdtof = null; postJSON("/api/demucs/stop", {}).catch(() => {}); });

// Run: transcribe the raw input directly (ADTOF works best on the full mix)
$("ad-run").addEventListener("click", async () => {
  try {
    await postJSON("/api/adtof/run", adtofParams("input"));
    poll(true);
  } catch (e) { setLog("Transcription: " + e.message, true); }
});

// From stem: transcribe the Demucs drum stem — run separation first if there isn't one
$("ad-run-stem").addEventListener("click", async () => {
  const params = adtofParams("stem");
  if (!(lastState && lastState.stems)) {
    try {
      await postJSON("/api/demucs/run", demucsParams());
      chainAdtof = params;
      setLog("No drum stem yet — running separation first; transcription will follow automatically");
      poll(true);
    } catch (e) { setLog("Separation: " + e.message, true); }
    return;
  }
  try {
    await postJSON("/api/adtof/run", params);
    poll(true);
  } catch (e) { setLog("Transcription: " + e.message, true); }
});
$("ad-stop").addEventListener("click", () => { chainAdtof = null; postJSON("/api/adtof/stop", {}).catch(() => {}); });

/* ------------------------------------------------------------------ */
/* exports / reset                                                     */
/* ------------------------------------------------------------------ */
function dlURL(kind) {
  // "Match playback speed" time-stretches the export to the Speed knob setting
  const speed = $("out-speed").checked ? engine.speed : 1;
  // Per-song cache-buster: without it the URL is identical across songs, so the
  // browser serves a *previous* song's download from its HTTP cache. Include the
  // edit revision so MIDI edits also bust. (FastAPI ignores the unknown `v` param.)
  const id = (lastState && lastState.input && lastState.input.id) || "";
  const key = (lastState && lastState.stems && lastState.stems.key) || "";
  const v = encodeURIComponent([id, key, lastPickRev || ""].join("-"));
  return "/api/download/" + kind +
    "?grid=" + encodeURIComponent($("out-grid").value) +
    "&fmt=" + encodeURIComponent($("out-fmt").value) +
    "&speed=" + speed.toFixed(4) +
    "&v=" + v;
}

// a lane is downloadable once its audio exists: Input as soon as it's loaded, the
// stems + Backing only after separation has run.
function laneDownloadable(k) {
  if (!laneVisible(k)) return false;
  return k === "input" ? !!(lastState && lastState.input)
                       : !!(lastState && lastState.stems);
}
// the audio lanes currently ticked for download (only ones that actually exist)
function selectedStems() {
  return LANE_NAMES.filter((k) => dlSel[k] && laneDownloadable(k));
}
function dlStemsURL() {
  const speed = $("out-speed").checked ? engine.speed : 1;
  // key the cache-buster off the stems when present, else the input id, so an
  // Input-only download still varies per song (see [[drumlab-download-cachebust]]).
  const key = (lastState && lastState.stems && lastState.stems.key)
           || (lastState && lastState.input && lastState.input.id) || "";
  const v = encodeURIComponent([key, selectedStems().join("+")].join("-"));
  let url = "/api/download_stems?stems=" + encodeURIComponent(selectedStems().join(",")) +
    "&fmt=" + encodeURIComponent($("out-fmt").value) +
    "&speed=" + speed.toFixed(4) + "&v=" + v;
  if (selectedStems().includes("backing")) url += "&backing=" + encodeURIComponent(backingParts().join(","));
  return url;
}
$("dl-selected").addEventListener("click", () => {
  if (!selectedStems().length) return;
  window.location.href = dlStemsURL();
});
$("dl-midi").addEventListener("click", () => { window.location.href = dlURL("midi"); });
$("dl-midi-quant").addEventListener("click", () => { window.location.href = dlURL("midi_quant"); });
$("dl-musicxml").addEventListener("click", () => { window.location.href = dlURL("musicxml"); });
$("dl-view-score").addEventListener("click", () => {
  window.open("/static/score.html?grid=" + encodeURIComponent($("out-grid").value), "_blank");
});

$("out-bpm").addEventListener("change", async () => {
  const v = $("out-bpm").value;
  try {
    await postJSON("/api/tempo", { bpm: v ? parseFloat(v) : null });
    if (lastPickRev) await fetchEvents();
  } catch (e) { setLog("Tempo: " + e.message, true); }
});

// enabling auto-apply re-detects immediately — sliders may have moved while it was off
$("ad-live").addEventListener("change", () => {
  if ($("ad-live").checked && lastState && lastState.acts) debouncedPick();
});

$("btn-reset").addEventListener("click", async () => {
  try {
    await postJSON("/api/reset", {});
    window.location.reload();
  } catch (e) { setLog("Reset failed: " + e.message, true); }
});

/* ------------------------------------------------------------------ */
/* knobs — logarithmic dB tapers; double-click resets to 0 dB          */
/* ------------------------------------------------------------------ */
const knobs = {
  master: makeDbKnob("knob-master", {
    label: "Master", size: 36, maxDb: 20,
    onGain: (g) => { master.gain.value = g; },
  }),
  midi: makeDbKnob("knob-midi", {
    label: "Gain", size: 40, maxDb: 6,
    onGain: (g) => { mix.midi.gain = g; applyMix(); },
  }),
};
for (const k of LANE_NAMES) {
  knobs[k] = makeDbKnob("knob-" + k, {
    label: "Gain", size: 60, maxDb: 6,
    onGain: (g) => { mix[k].gain = g; applyMix(); },
  });
}
const KNOB_LABEL = { kick: "Kick", snare: "Snare", hihat: "Hat", tom: "Tom", cymbal: "Cymbal" };
for (const c of CLASSES) {
  knobs[c.id] = makeDbKnob("knob-" + c.id, {
    label: KNOB_LABEL[c.id], size: 28, maxDb: 6,
    color: COLORS[c.id],
    onGain: (g) => { classGains[c.id].gain.value = CLASS_TRIM[c.id] * g; },
  });
}

// speed: linear taper, pitch preserved, double-click resets to 1.00x
knobs.speed = createKnob("knob-speed", {
  label: "Speed", size: 36, min: 0.5, max: 1.5, value: 1.0, resetValue: 1.0,
  color: "#4ea1ff",
  fmt: (v) => v.toFixed(2) + "×",
  onChange: setSpeedDebounced,
});

/* ------------------------------------------------------------------ */
/* custom drum samples — drag a one-shot onto a pad to replace the synth */
/* ------------------------------------------------------------------ */
function buildSampleSlots() {
  const host = $("sample-slots");
  for (const c of CLASSES) {
    const row = document.createElement("div");
    row.className = "sample-slot";
    row.dataset.cls = c.id;
    row.innerHTML =
      '<span class="ss-name" style="color:' + COLORS[c.id] + '">' + c.label + "</span>" +
      '<span class="ss-file">synth</span>' +
      '<button class="ss-clear" title="Revert to the built-in synth" disabled>&#10005;</button>';
    host.appendChild(row);

    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".wav,.mp3,.flac,.m4a,.ogg,.aac,.aiff,.opus";
    picker.hidden = true;
    row.appendChild(picker);

    const setFile = async (file) => {
      if (!file) return;
      try {
        await ensureAudio();
        const buf = new Tone.ToneAudioBuffer();
        await buf.load(URL.createObjectURL(file));
        if (customSamples[c.id]) { try { customSamples[c.id].dispose(); } catch (e) {} }
        customSamples[c.id] = buf;
        row.classList.add("loaded");
        row.querySelector(".ss-file").textContent = file.name;
        row.querySelector(".ss-clear").disabled = false;
        engine.synths.trigger(c.id, Tone.now()); // audition
        setLog("Loaded custom " + c.label.toLowerCase() + " sample: " + file.name);
      } catch (e) { setLog("Sample load failed: " + e.message, true); }
    };

    row.querySelector(".ss-name").addEventListener("click", () => picker.click());
    row.querySelector(".ss-file").addEventListener("click", () => picker.click());
    picker.addEventListener("change", (e) => setFile(e.target.files[0]));
    row.querySelector(".ss-clear").addEventListener("click", () => {
      if (customSamples[c.id]) { try { customSamples[c.id].dispose(); } catch (e) {} }
      delete customSamples[c.id];
      row.classList.remove("loaded");
      row.querySelector(".ss-file").textContent = "synth";
      row.querySelector(".ss-clear").disabled = true;
    });
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drag"); });
    row.addEventListener("dragleave", () => row.classList.remove("drag"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag");
      setFile(e.dataTransfer.files[0]);
    });
  }
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
let lastState = null;
let pollTimer = null;

function setLog(msg, isErr) {
  const el = $("log-line");
  el.textContent = msg || "";
  el.className = isErr ? "err" : "";
}

function renderJob(prefix, job) {
  const chip = $(prefix + "-status");
  chip.textContent = STATUS_LABEL[job.status] || job.status;
  chip.className = "chip " + job.status;
  $(prefix + "-msg").textContent = job.message || "";
  const bar = $(prefix + "-bar");
  bar.style.width = job.progress != null ? (job.progress * 100).toFixed(1) + "%" : (job.status === "running" ? "100%" : "0%");
  bar.style.opacity = job.progress != null || job.status !== "running" ? "1" : "0.35";
  $(prefix + "-run").disabled = job.status === "running";
  $(prefix + "-stop").disabled = job.status !== "running";
  if (prefix === "ad") $("ad-run-stem").disabled = job.status === "running";
}

async function poll(fast) {
  clearTimeout(pollTimer);
  let running = false;
  try {
    const s = await api("/api/state");
    lastState = s;
    if (s.version) $("app-ver").textContent = "DrumLab " + s.version;
    renderJob("dm", s.jobs.demucs);
    renderJob("ad", s.jobs.adtof);
    running = s.jobs.demucs.status === "running" || s.jobs.adtof.status === "running";

    if (s.input && s.input.id !== lastInputId) {
      lastInputId = s.input.id;
      lastStemKey = null;
      lastPickRev = 0;
      roll.events = null;
      if (engine.part) { try { engine.part.dispose(); } catch (e) {} engine.part = null; }
      for (const k of STEM_LANES) disposeLane(k);
      engine._backingSig = null;
      clearLoop();
      renderInputMeta(s.input);
      updateCounts();
      $("tempo-display").textContent = "";
      $("out-tempo").textContent = "";
      $("out-bpm").value = "";
      $("zoom").value = 0;  // fit the whole new file
      seekAll(0);
      loadLane("input", "/api/audio/input?v=" + s.input.id).catch((e) => setLog("Waveform failed: " + e.message, true));
      renderStemLanes();  // reset stem lanes to placeholders for the current selection
    }
    if (s.stems && s.stems.key !== lastStemKey) {
      lastStemKey = s.stems.key;
      for (const k of STEM_LANES) disposeLane(k);   // fresh separation -> reload per selection
      engine._backingSig = null;
      renderStemLanes();
    } else if (!s.stems && lastStemKey) {
      lastStemKey = null;
      renderStemLanes();
    }
    if (s.pick && s.pick.rev !== lastPickRev) {
      lastPickRev = s.pick.rev;
      fetchEvents().catch((e) => setLog("Event fetch failed: " + e.message, true));
    }

    // reflect a server-side BPM override (e.g. after a page reload)
    const bpmEl = $("out-bpm");
    if (document.activeElement !== bpmEl) {
      const want = s.tempo_override != null ? String(s.tempo_override) : "";
      if (bpmEl.value !== want) bpmEl.value = want;
    }

    // chained run: separation finished -> start transcription
    if (chainAdtof) {
      const dm = s.jobs.demucs.status;
      if (dm === "done" && s.stems && s.jobs.adtof.status !== "running") {
        const p = chainAdtof;
        chainAdtof = null;
        postJSON("/api/adtof/run", p).then(() => poll(true)).catch((e) => setLog("Transcription: " + e.message, true));
      } else if (dm === "error" || dm === "cancelled") {
        chainAdtof = null;
      }
    }

    updateDlSelected();
    const havePick = !!s.pick;
    $("dl-midi").disabled = !havePick;
    $("dl-midi-quant").disabled = !havePick;
    $("dl-musicxml").disabled = !havePick;
    $("dl-view-score").disabled = !havePick;

    const lastLog = (s.jobs.demucs.status === "running" ? s.jobs.demucs.log : s.jobs.adtof.log) || [];
    if (running && lastLog.length) setLog(lastLog[lastLog.length - 1]);
    if (s.jobs.demucs.status === "error") setLog("Separation: " + s.jobs.demucs.message, true);
    else if (s.jobs.adtof.status === "error") setLog("Transcription: " + s.jobs.adtof.message, true);
  } catch (e) {
    setLog("Server unreachable: " + e.message, true);
  }
  pollTimer = setTimeout(poll, running || fast ? 400 : 1200);
}

/* ------------------------------------------------------------------ */
/* render loop                                                         */
/* ------------------------------------------------------------------ */
function raf() {
  const t = nowContent();
  $("time-display").textContent = fmtTime(t);
  if (Tone.Transport.state === "started") {
    updateCursors(t);
    if (!loop.active && engine.duration && t >= engine.duration) {
      Tone.Transport.pause();
      stopAudio();
      Tone.Transport.seconds = engine.duration / engine.speed;
    }
  }
  renderPlayButton();
  drawRoll();
  updateLoopOverlays();

  drawStereoMeter($("master-meter"), taps.master.get(), true);
  for (const k of LANE_NAMES) {
    if (engine.lanes[k]) drawStereoMeter($("meter-" + k), taps[k].get(), false);
  }
  drawStereoMeter($("meter-midi"), taps.midi.get(), false);
  requestAnimationFrame(raf);
}

/* init */
buildSliders();
buildSampleSlots();
engine.synths = makeSynths();
applyMix();
renderStemLanes();   // show placeholder lanes for the default selection
applyZoom();
poll(true);
loadLibrary();       // index any --library roots; enables party shuffle if configured
requestAnimationFrame(raf);
setLog("DrumLab ready — drop a file to begin");
