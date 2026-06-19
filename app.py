# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 DomekRomek
r"""DRUMLAB -- local drum-transcription control GUI
==================================================


LAYOUT OF workdir/ (created next to this file, safe to delete to clear caches):
    uploads/   converted-to-WAV inputs (keyed by content hash)
    stems/     Demucs drum stems     (keyed by input hash + demucs params)
    acts/      ADTOF activation caches (keyed by stem hash + fps)
    out/       generated downloads (MIDI / MusicXML)
    demucs_tmp/  scratch space for running separations
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from collections import OrderedDict, deque
from fractions import Fraction
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

APP_VERSION = "4.1"
APP_DIR = Path(__file__).resolve().parent
WORK = APP_DIR / "workdir"
UPLOADS = WORK / "uploads"
STEMS = WORK / "stems"
ACTS = WORK / "acts"
OUT = WORK / "out"
DEMUCS_TMP = WORK / "demucs_tmp"
for d in (UPLOADS, STEMS, ACTS, OUT, DEMUCS_TMP):
    d.mkdir(parents=True, exist_ok=True)

PYEXE = sys.executable
WORKER = APP_DIR / "adtof_worker.py"

# Model output channel order (ADTOF LABELS_5 = [35, 38, 47, 42, 49]).
# NOTE: channel 2 is TOM and channel 3 is HI-HAT -- the package defaults
# [0.22, 0.24, 0.32, 0.22, 0.30] are in THIS order.
# Demucs full-separation sources (htdemucs / mdx all emit these four).
SOURCES = ["drums", "bass", "other", "vocals"]
CH_NAMES = ["kick", "snare", "tom", "hihat", "cymbal"]
DEFAULT_THRESHOLDS = {"kick": 0.22, "snare": 0.24, "tom": 0.32, "hihat": 0.22, "cymbal": 0.30}
# Onset-latency compensation: the model's activation peaks a few frames AFTER the
# real transient (spectrogram framing is center=True, so i/fps is otherwise exact),
# so every picked hit lands late against the audio. Shift all onsets earlier by this
# many seconds. Applied once in do_pick(), so it flows to the roll, the synth, and the
# MIDI/MusicXML exports alike. TWEAK ME by ear: raise if the synth still trails the
# track, lower if it now anticipates; a re-pick (instant) applies the new value.
ONSET_COMP_SEC = 0.08
# GM percussion pitches for exported MIDI (user-requested map).
GM_MAP = {"kick": 36, "snare": 38, "hihat": 42, "tom": 45, "cymbal": 49}
GRID_Q = {"1/8": Fraction(1, 2), "1/16": Fraction(1, 4), "1/16T": Fraction(1, 6), "1/32": Fraction(1, 8)}

CREATE_FLAGS = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW


# ---------------------------------------------------------------------------
# Peak-picking: load adtof_pytorch/post_processing.py WITHOUT importing the
# package __init__ (which would pull torch into the server process).
# ---------------------------------------------------------------------------
def _load_post_processing():
    pp_path = None
    try:
        spec = importlib.util.find_spec("adtof_pytorch")
        if spec and spec.origin:
            pp_path = Path(spec.origin).parent / "post_processing.py"
    except Exception:
        pass
    if pp_path is None or not pp_path.exists():
        pp_path = APP_DIR.parent / "ADTOF-pytorch" / "src" / "adtof_pytorch" / "post_processing.py"
    mod_spec = importlib.util.spec_from_file_location("adtof_pp_standalone", pp_path)
    mod = importlib.util.module_from_spec(mod_spec)
    mod_spec.loader.exec_module(mod)
    return mod


PP = _load_post_processing()


# ---------------------------------------------------------------------------
# Job management (one slot per stage), Windows tree-kill cancellation
# ---------------------------------------------------------------------------
def kill_tree(proc: subprocess.Popen) -> None:
    """Kill a process and all of its children (Demucs spawns GPU workers)."""
    if proc is None or proc.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )


class Job:
    def __init__(self, name: str):
        self.name = name
        self.lock = threading.Lock()
        self.status = "idle"  # idle | running | done | cancelled | error
        self.progress: Optional[float] = None
        self.message = ""
        self.log: deque = deque(maxlen=60)
        self.proc: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None
        self.cancelled = False

    def start(self, target, args=()) -> bool:
        with self.lock:
            if self.status == "running":
                return False
            self.status = "running"
            self.progress = None
            self.message = "Starting ..."
            self.log.clear()
            self.cancelled = False
            self.thread = threading.Thread(target=target, args=args, daemon=True)
            self.thread.start()
            return True

    def cancel(self) -> None:
        with self.lock:
            self.cancelled = True
            if self.proc is not None:
                kill_tree(self.proc)

    def finish(self, status: str, message: str) -> None:
        with self.lock:
            self.status = status
            self.message = message
            self.proc = None

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "log": list(self.log)[-12:],
        }


DEMUCS_JOB = Job("demucs")
ADTOF_JOB = Job("adtof")


def reset_jobs() -> None:
    for job in (DEMUCS_JOB, ADTOF_JOB):
        job.status = "idle"
        job.progress = None
        job.message = ""
        job.log.clear()
        job.cancelled = False

STATE_LOCK = threading.Lock()
# Single global workspace, NOT per-client. DrumLab is a single-user tool, so every
# connected browser (second tab, or a phone when bound with --host 0.0.0.0) shares this
# one STATE -- loading a song anywhere replaces it everywhere. Intentional; making it
# per-session would mean keying this dict + uploads + caches by a cookie. See README.
STATE = {
    "input": None,  # {"id", "name", "stem_name", "wav", "duration"}
    "stems": None,  # {"key", "dir", "sources": [present source names]}
    "acts": None,   # {"key", "dir", "fps", "tempo", "duration"}
    "pick": None,   # {"rev", "thresholds", "fps", "events", "counts"}
    "tempo_override": None,  # manual BPM; None = use the detected tempo
}
PICK_REV = [0]
ACTS_RAM: "OrderedDict[str, np.ndarray]" = OrderedDict()  # small LRU of activation arrays


def sha1_file(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def stream_subprocess(job: Job, cmd: list) -> int:
    """Run cmd, streaming combined output into job.log / job.progress.

    Returns the process return code. Honors job.cancelled via kill_tree.
    """
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env.setdefault("PYTHONUNBUFFERED", "1")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        bufsize=0, creationflags=CREATE_FLAGS, cwd=str(APP_DIR), env=env,
    )
    with job.lock:
        job.proc = proc
        if job.cancelled:  # stop raced with start
            kill_tree(proc)
    partial = ""
    # match tqdm-style " 42%|####  " only, so stray percentages in logs don't fake progress
    pct_re = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%\s*\|")
    while True:
        chunk = proc.stdout.read(4096)
        if not chunk:
            break
        partial += chunk.decode("utf-8", "replace")
        pieces = re.split(r"[\r\n]", partial)
        partial = pieces.pop()  # keep trailing partial line
        for piece in pieces:
            piece = piece.strip()
            if not piece:
                continue
            m = None
            for m in pct_re.finditer(piece):
                pass
            if m:
                try:
                    job.progress = min(100.0, float(m.group(1))) / 100.0
                except ValueError:
                    pass
            else:
                job.log.append(piece[:300])
                job.message = piece[:160]
    proc.wait()
    return proc.returncode


def classify_error(log_tail: str) -> str:
    low = log_tail.lower()
    if "out of memory" in low or "cuda oom" in low:
        return "CUDA out of memory -- switch to CPU, or lower the segment value."
    if "longer segment" in low or ("transformer model" in low and "segment" in low):
        return "Segment too long for this model (htdemucs caps at about 7 s) -- lower it or leave it empty."
    if "ffmpeg" in low or "could not load" in low or "decoding" in low or "soundfile" in low:
        return "Audio decode failed (FFmpeg) -- check the input file format."
    return "Stage failed -- see the log line below."


# ---------------------------------------------------------------------------
# Demucs stage
# ---------------------------------------------------------------------------
def demucs_thread(params: dict) -> None:
    job = DEMUCS_JOB
    try:
        inp = STATE["input"]
        if not inp:
            job.finish("error", "No input file uploaded")
            return
        model = params["model"]
        shifts = int(params["shifts"])
        overlap = float(params["overlap"])
        segment = params.get("segment")
        device = params["device"]
        seg_tag = f"_seg{segment}" if segment else ""
        key = f"{inp['id']}_{model}_sh{shifts}_ov{overlap:g}{seg_tag}"
        out_dir = STEMS / key

        def present_sources() -> list:
            return [s for s in SOURCES if (out_dir / f"{s}.wav").exists()]

        cached = present_sources()
        if cached:
            with STATE_LOCK:
                STATE["stems"] = {"key": key, "dir": str(out_dir), "sources": cached}
            job.progress = 1.0
            job.finish("done", "Reused cached stems (same input and parameters)")
            return

        tmp = DEMUCS_TMP / key
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)

        # Full separation (all four sources) so the UI can split off any of them and
        # sum the rest into a backing track on demand. Demucs computes all sources
        # internally regardless, so this is no slower than --two-stems.
        cmd = [
            PYEXE, "-m", "demucs", "-n", model,
            "--shifts", str(shifts), "--overlap", str(overlap),
            "-d", device, "-o", str(tmp),
        ]
        if segment:
            cmd += ["--segment", str(int(segment))]
        cmd.append(inp["wav"])

        job.message = f"Separating with {model} on {device} ..."
        rc = stream_subprocess(job, cmd)

        if job.cancelled:
            shutil.rmtree(tmp, ignore_errors=True)
            job.finish("cancelled", "Separation stopped -- process tree terminated")
            return
        if rc != 0:
            tail = "\n".join(list(job.log)[-8:])
            job.finish("error", classify_error(tail))
            return

        out_dir.mkdir(parents=True, exist_ok=True)
        moved = []
        for s in SOURCES:
            found = next(tmp.rglob(f"{s}.wav"), None)
            if found is not None:
                shutil.move(str(found), str(out_dir / f"{s}.wav"))
                moved.append(s)
        shutil.rmtree(tmp, ignore_errors=True)
        if "drums" not in moved:
            job.finish("error", "Separation finished but produced no drum stem")
            return
        with STATE_LOCK:
            STATE["stems"] = {"key": key, "dir": str(out_dir), "sources": moved}
        job.progress = 1.0
        job.finish("done", "Stems ready (" + ", ".join(moved) + ")")
    except Exception as e:  # noqa: BLE001
        job.finish("error", f"Separation stage crashed: {e}")


# ---------------------------------------------------------------------------
# ADTOF stage: cached activations + cheap re-pick
# ---------------------------------------------------------------------------
def load_acts(key: str) -> Optional[np.ndarray]:
    if key in ACTS_RAM:
        ACTS_RAM.move_to_end(key)
        return ACTS_RAM[key]
    path = ACTS / key / "activations.npy"
    if not path.exists():
        return None
    arr = np.load(str(path))
    ACTS_RAM[key] = arr
    while len(ACTS_RAM) > 4:
        ACTS_RAM.popitem(last=False)
    return arr


def do_pick(thresholds: dict) -> dict:
    """Peak-pick the cached activation curves. Milliseconds; no net run."""
    acts_info = STATE["acts"]
    if not acts_info:
        raise RuntimeError("No cached activations -- run Transcription first")
    arr = load_acts(acts_info["key"])
    if arr is None:
        raise RuntimeError("Activation cache missing on disk -- re-run Transcription")
    th = [float(thresholds.get(n, DEFAULT_THRESHOLDS[n])) for n in CH_NAMES]
    picker = PP.PeakPicker(thresholds=th, fps=int(acts_info["fps"]))
    picked = picker.pick(arr, labels=list(range(5)), label_offset=0)[0]
    # shift onsets earlier to cancel the model's activation latency (see ONSET_COMP_SEC)
    events = {CH_NAMES[i]: [round(max(0.0, float(t) - ONSET_COMP_SEC), 5) for t in picked[i]]
              for i in range(5)}
    with STATE_LOCK:
        PICK_REV[0] += 1
        STATE["pick"] = {
            "rev": PICK_REV[0],
            "thresholds": {n: th[i] for i, n in enumerate(CH_NAMES)},
            "fps": int(acts_info["fps"]),
            "events": events,
            "counts": {n: len(v) for n, v in events.items()},
        }
    return STATE["pick"]


def adtof_thread(params: dict) -> None:
    job = ADTOF_JOB
    try:
        source = params.get("source", "stem")
        fps = int(params.get("fps", 100))
        thresholds = params.get("thresholds", DEFAULT_THRESHOLDS)
        device = params.get("device", "cuda")

        if source == "stem":
            if not STATE["stems"]:
                job.finish("error", "No drum stem yet -- run Separation first, or set the source to 'Drum stem'")
                return
            wav = Path(STATE["stems"]["dir"]) / "drums.wav"
        else:
            if not STATE["input"]:
                job.finish("error", "No input file uploaded")
                return
            wav = Path(STATE["input"]["wav"])

        job.message = "Hashing source audio ..."
        key = f"{sha1_file(wav)}_fps{fps}"
        act_dir = ACTS / key

        if not (act_dir / "meta.json").exists():
            cmd = [PYEXE, str(WORKER), "--audio", str(wav), "--out-dir", str(act_dir),
                   "--device", device, "--fps", str(fps)]
            job.message = f"Running the ADTOF network on {device} (cached after the first run) ..."
            rc = stream_subprocess(job, cmd)
            if job.cancelled:
                shutil.rmtree(act_dir, ignore_errors=True)
                job.finish("cancelled", "Transcription stopped -- worker terminated")
                return
            if rc != 0 or not (act_dir / "meta.json").exists():
                tail = "\n".join(list(job.log)[-8:])
                shutil.rmtree(act_dir, ignore_errors=True)
                job.finish("error", classify_error(tail))
                return
        else:
            job.log.append("[cache] reusing activation curves for this audio + fps")

        meta = json.loads((act_dir / "meta.json").read_text())
        with STATE_LOCK:
            STATE["acts"] = {
                "key": key, "dir": str(act_dir), "fps": meta["fps"],
                "tempo": meta["tempo"], "duration": meta["duration"],
            }
        job.message = "Peak-picking ..."
        pick = do_pick(thresholds)
        n = sum(pick["counts"].values())
        job.progress = 1.0
        job.finish("done", f"{n} hits picked -- tempo about {meta['tempo']:.1f} BPM")
    except Exception as e:  # noqa: BLE001
        job.finish("error", f"Transcription stage crashed: {e}")


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------
def effective_tempo(acts: dict) -> float:
    return float(STATE["tempo_override"] or acts["tempo"])


def require_pick() -> tuple:
    pick, acts = STATE["pick"], STATE["acts"]
    if not pick or not acts:
        raise HTTPException(409, "No transcription yet -- run Transcription first")
    return pick, acts


def out_name(suffix: str) -> str:
    base = STATE["input"]["stem_name"] if STATE["input"] else "drumlab"
    return f"{base}{suffix}"


def build_midi(events: dict, tempo: float, path: Path) -> None:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=float(tempo))
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="ADTOF drums")
    for cls, times in events.items():
        pitch = GM_MAP[cls]
        for t in times:
            inst.notes.append(pretty_midi.Note(velocity=100, pitch=pitch, start=float(t), end=float(t) + 0.1))
    pm.instruments.append(inst)
    pm.write(str(path))


def quantize_events(events: dict, tempo: float, grid: str) -> dict:
    """Snap times to the grid; returns {cls: [(slot, t_sec), ...]} deduped."""
    frac = GRID_Q[grid]
    step_sec = float(frac) * 60.0 / float(tempo)
    out = {}
    for cls, times in events.items():
        seen = set()
        rows = []
        for t in times:
            slot = round(t / step_sec)
            if slot in seen:
                continue
            seen.add(slot)
            rows.append((slot, slot * step_sec))
        out[cls] = rows
    return out


def build_quant_midi(events: dict, tempo: float, grid: str, path: Path) -> None:
    q = quantize_events(events, tempo, grid)
    flat = {cls: [t for _slot, t in rows] for cls, rows in q.items()}
    build_midi(flat, tempo, path)


# percussion-clef display positions (Weinberg-style): kick F4, snare C5,
# tom D5, hi-hat G5 (x head), cymbal A5 (x head)
STAFF_MAP = {
    "kick": ("F", 4, "normal"),
    "snare": ("C", 5, "normal"),
    "tom": ("D", 5, "normal"),
    "hihat": ("G", 5, "x"),
    "cymbal": ("A", 5, "x"),
}


def build_musicxml(events: dict, tempo: float, grid: str, path: Path) -> None:
    from music21 import clef, duration as m21dur, meter, note, percussion, stream, tempo as m21tempo

    frac = GRID_Q[grid]
    q = quantize_events(events, tempo, grid)

    by_offset: dict = {}
    for cls, rows in q.items():
        for slot, _t in rows:
            by_offset.setdefault(slot, set()).add(cls)

    def make_unpitched(cls: str):
        step, octave, head = STAFF_MAP[cls]
        n = note.Unpitched()
        n.displayStep = step
        n.displayOctave = octave
        if head != "normal":
            n.notehead = head
        return n

    part = stream.Part()
    part.insert(0, clef.PercussionClef())
    part.insert(0, meter.TimeSignature("4/4"))
    part.insert(0, m21tempo.MetronomeMark(number=round(float(tempo), 2)))

    for slot in sorted(by_offset):
        classes = sorted(by_offset[slot])
        if len(classes) == 1:
            el = make_unpitched(classes[0])
        else:
            el = percussion.PercussionChord([make_unpitched(c) for c in classes])
        el.duration = m21dur.Duration(frac)
        part.insert(Fraction(slot) * frac, el)

    score = stream.Score([part])
    score.write("musicxml", fp=str(path))


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
app = FastAPI(title="DrumLab", version=APP_VERSION, docs_url=None, redoc_url=None)


@app.get("/")
def index():
    # inject the version so the footer is correct on first paint (the JS poll also
    # keeps it in sync, but this makes view-source / a stale poll show the real one)
    html = (APP_DIR / "static" / "index.html").read_text(encoding="utf-8")
    return Response(content=html.replace("__VER__", APP_VERSION), media_type="text/html")


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    if DEMUCS_JOB.status == "running" or ADTOF_JOB.status == "running":
        raise HTTPException(409, "A job is running -- stop it before changing the input")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "Empty upload")
    sha = hashlib.sha1(data).hexdigest()[:16]
    safe_stem = re.sub(r"[^\w\-. ]+", "_", Path(file.filename or "input").stem)[:60] or "input"
    suffix = Path(file.filename or "input.bin").suffix or ".bin"
    orig = UPLOADS / f"{sha}_orig{suffix}"
    orig.write_bytes(data)
    wav = UPLOADS / f"{sha}.wav"
    if not wav.exists():
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(orig), "-vn", "-acodec", "pcm_s16le", str(wav)],
            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=300,
        )
        if r.returncode != 0 or not wav.exists():
            tail = r.stderr.decode("utf-8", "replace")[-400:]
            raise HTTPException(400, f"FFmpeg could not decode this file. {tail}")
    import soundfile as sf

    info = sf.info(str(wav))
    duration = float(info.frames) / float(info.samplerate)

    # embedded album art (attached-pic stream), if any
    art = UPLOADS / f"{sha}_art.jpg"
    if not art.exists():
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(orig), "-an", "-map", "0:v:0", "-frames:v", "1", str(art)],
            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=60,
        )
        if r.returncode != 0 or not art.exists() or art.stat().st_size == 0:
            art.unlink(missing_ok=True)

    with STATE_LOCK:
        STATE["input"] = {
            "id": sha, "name": file.filename, "stem_name": safe_stem,
            "wav": str(wav), "duration": duration,
            "samplerate": int(info.samplerate), "channels": int(info.channels),
            "ext": suffix.lstrip(".").lower(), "size": len(data),
            "art": art.exists(),
        }
        STATE["stems"] = None
        STATE["acts"] = None
        STATE["pick"] = None
        STATE["tempo_override"] = None
    reset_jobs()
    return {"input": STATE["input"]}


@app.post("/api/demucs/run")
def demucs_run(params: dict):
    if not STATE["input"]:
        raise HTTPException(409, "Upload a file first")
    if not DEMUCS_JOB.start(demucs_thread, (params,)):
        raise HTTPException(409, "Separation is already running")
    return {"ok": True}


@app.post("/api/demucs/stop")
def demucs_stop():
    DEMUCS_JOB.cancel()
    return {"ok": True}


@app.post("/api/adtof/run")
def adtof_run(params: dict):
    if not ADTOF_JOB.start(adtof_thread, (params,)):
        raise HTTPException(409, "Transcription is already running")
    return {"ok": True}


@app.post("/api/adtof/stop")
def adtof_stop():
    ADTOF_JOB.cancel()
    return {"ok": True}


@app.post("/api/tempo")
def set_tempo(params: dict):
    """Set or clear the manual BPM override used by exports and the score."""
    bpm = params.get("bpm")
    if bpm is not None:
        try:
            bpm = float(bpm)
        except (TypeError, ValueError):
            raise HTTPException(400, "Invalid BPM value")
        if not 20 <= bpm <= 400:
            raise HTTPException(400, "BPM must be between 20 and 400")
    with STATE_LOCK:
        STATE["tempo_override"] = bpm
    return {"tempo_override": STATE["tempo_override"]}


@app.post("/api/adtof/pick")
def adtof_pick(params: dict):
    """Instant threshold re-pick on cached activations (no net run)."""
    if not STATE["acts"]:
        raise HTTPException(409, "No cached activations -- run Transcription first")
    try:
        pick = do_pick(params.get("thresholds", DEFAULT_THRESHOLDS))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"rev": pick["rev"], "counts": pick["counts"]}


@app.get("/api/state")
def get_state():
    pick = STATE["pick"]
    return {
        "version": APP_VERSION,
        "input": STATE["input"],
        "stems": {"key": STATE["stems"]["key"], "sources": STATE["stems"]["sources"]}
                 if STATE["stems"] else None,
        "acts": STATE["acts"],
        "pick": {"rev": pick["rev"], "thresholds": pick["thresholds"],
                 "fps": pick["fps"], "counts": pick["counts"]} if pick else None,
        "tempo_override": STATE["tempo_override"],
        "jobs": {"demucs": DEMUCS_JOB.as_dict(), "adtof": ADTOF_JOB.as_dict()},
        "defaults": {"thresholds": DEFAULT_THRESHOLDS},
    }


@app.get("/api/events")
def get_events():
    pick, acts = require_pick()
    return {"rev": pick["rev"], "events": pick["events"],
            "tempo": effective_tempo(acts), "detected_tempo": acts["tempo"],
            "duration": acts["duration"]}


def _parse_parts(parts: Optional[str]) -> list:
    """Validated, de-duped, sorted backing composition from a 'a,b,c' query."""
    if not parts:
        return []
    out = [p for p in dict.fromkeys(parts.split(",")) if p in SOURCES]
    return sorted(out)


def _ensure_backing(parts: list) -> tuple:
    """Sum the given source stems into one WAV (cached per composition).

    Returns (path, cache key). The summed mix never exceeds the original (the four
    stems add back to it), so straight summation with no normalisation is safe."""
    stems = STATE["stems"]
    if not stems:
        raise HTTPException(409, "No separation output yet")
    parts = [p for p in parts if p in stems["sources"]]
    if not parts:
        raise HTTPException(409, "Backing track is empty (every source is split off)")
    out_dir = Path(stems["dir"])
    sig = "-".join(parts)
    bkey = stems["key"] + "_backing_" + sig
    cached = out_dir / f"_backing_{sig}.wav"
    if cached.exists():
        return cached, bkey
    inputs = []
    for p in parts:
        inputs += ["-i", str(out_dir / f"{p}.wav")]
    if len(parts) == 1:
        shutil.copyfile(out_dir / f"{parts[0]}.wav", cached)
        return cached, bkey
    filt = f"amix=inputs={len(parts)}:normalize=0"
    r = subprocess.run(
        ["ffmpeg", "-y"] + inputs + ["-filter_complex", filt, "-c:a", "pcm_s16le", str(cached)],
        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=600)
    if r.returncode != 0 or not cached.exists():
        cached.unlink(missing_ok=True)
        raise HTTPException(500, "Backing mix failed: " + r.stderr.decode("utf-8", "replace")[-300:])
    return cached, bkey


@app.get("/api/audio/{which}")
def get_audio(which: str, parts: Optional[str] = None):
    if which == "input" and STATE["input"]:
        return FileResponse(STATE["input"]["wav"], media_type="audio/wav")
    if which == "backing":
        path, _ = _ensure_backing(_parse_parts(parts))
        return FileResponse(str(path), media_type="audio/wav", headers={"Cache-Control": "no-store"})
    if which in SOURCES and STATE["stems"] and which in STATE["stems"]["sources"]:
        return FileResponse(str(Path(STATE["stems"]["dir"]) / f"{which}.wav"), media_type="audio/wav")
    raise HTTPException(404, f"No {which} audio available")


# Chunked, pitch-preserved playback streaming. The client plays audio as a window
# of short chunks scheduled on the Web Audio clock, so RAM is bounded by the window
# (not the song length) and stays sample-aligned with the MIDI. Speed changes reuse
# the export's atempo: one continuous whole-file stretch (no per-chunk seams), cached,
# then sliced on demand. Slicing a PCM WAV with input-seek is sample-accurate.
CHUNKS = WORK / "chunks"
CHUNKS.mkdir(parents=True, exist_ok=True)
CHUNK_SEC = 8.0                       # content seconds per chunk (must match app.js)
_STRETCH_GUARD = threading.Lock()
_STRETCH_LOCKS: dict = {}             # cache path -> per-file lock (one render at a time)
# render stretches below normal priority so they never starve demucs/adtof inference
_LOW_PRIO = subprocess.CREATE_NO_WINDOW | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)


def _lane_source(lane: str, parts: Optional[str] = None):
    """(source wav path, stable cache key) for a playback lane, or 404/409."""
    if lane == "input" and STATE["input"]:
        return STATE["input"]["wav"], STATE["input"]["id"]
    if lane == "backing":
        path, bkey = _ensure_backing(_parse_parts(parts))
        return str(path), bkey
    if lane in SOURCES and STATE["stems"] and lane in STATE["stems"]["sources"]:
        return str(Path(STATE["stems"]["dir"]) / f"{lane}.wav"), STATE["stems"]["key"] + "_" + lane
    raise HTTPException(404, f"No {lane} audio available")


def _evict_stretch_cache(keep_bytes: int = 1_500_000_000):
    """LRU-cap the whole-file stretched WAVs (they are large)."""
    files = sorted(CHUNKS.glob("*x.wav"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while total > keep_bytes and len(files) > 1:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


def _ensure_stretched(src: str, key: str, speed: float) -> Path:
    """Path to a whole-file atempo-stretched WAV for (lane, speed), rendered once."""
    cached = CHUNKS / f"{key}_{speed:.4f}x.wav"
    if cached.exists():
        os.utime(cached, None)        # mark recently used for LRU
        return cached
    with _STRETCH_GUARD:
        lock = _STRETCH_LOCKS.setdefault(str(cached), threading.Lock())
    with lock:                        # collapse concurrent first-hits into one render
        if cached.exists():
            return cached
        tmp = cached.with_suffix(".tmp.wav")
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-filter:a", f"atempo={speed:.4f}",
             "-c:a", "pcm_s16le", str(tmp)],
            capture_output=True, creationflags=_LOW_PRIO, timeout=600)
        if r.returncode != 0 or not tmp.exists():
            tmp.unlink(missing_ok=True)
            raise HTTPException(500, "Stretch failed: " + r.stderr.decode("utf-8", "replace")[-300:])
        tmp.replace(cached)
        _evict_stretch_cache()
        return cached


@app.get("/api/audio_chunk")
def audio_chunk(lane: str, i: int, speed: float = 1.0, parts: Optional[str] = None):
    """One playback chunk: content window [i*CHUNK_SEC, +CHUNK_SEC] at the given speed,
    returned as a small WAV slice. speed != 1 plays a slice of the cached whole-file
    stretch; file-time = content-time / speed (the stretch slows the timeline by speed)."""
    speed = max(0.5, min(1.5, float(speed)))
    src, key = _lane_source(lane, parts)
    if abs(speed - 1.0) > 1e-3:
        src = str(_ensure_stretched(src, key, speed))
    f0 = max(0.0, (i * CHUNK_SEC) / speed)
    fdur = CHUNK_SEC / speed
    tmp = CHUNKS / f"_slice_{os.getpid()}_{threading.get_ident()}.wav"
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{f0:.6f}", "-t", f"{fdur:.6f}", "-i", src,
             "-c:a", "pcm_s16le", str(tmp)],
            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=120)
        if r.returncode != 0 or not tmp.exists():
            raise HTTPException(500, "Slice failed: " + r.stderr.decode("utf-8", "replace")[-300:])
        data = tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
    return Response(content=data, media_type="audio/wav",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/art")
def get_art():
    if STATE["input"] and STATE["input"].get("art"):
        return FileResponse(UPLOADS / f"{STATE['input']['id']}_art.jpg", media_type="image/jpeg")
    raise HTTPException(404, "No album art")


@app.post("/api/events/update")
def events_update(params: dict):
    """Replace the current hit list with manually edited events (MIDI edit mode).

    Edits live in the pick state, so downloads include them; the next
    re-pick / ADTOF run overwrites them.
    """
    if not STATE["pick"]:
        raise HTTPException(409, "No transcription to edit -- run Transcription first")
    raw = params.get("events") or {}
    events = {}
    for cls in CH_NAMES:
        times = raw.get(cls, [])
        if not isinstance(times, list):
            raise HTTPException(400, f"bad events for {cls}")
        events[cls] = sorted(round(float(t), 5) for t in times if float(t) >= 0)
    with STATE_LOCK:
        PICK_REV[0] += 1
        STATE["pick"]["rev"] = PICK_REV[0]
        STATE["pick"]["events"] = events
        STATE["pick"]["counts"] = {n: len(v) for n, v in events.items()}
    return {"rev": PICK_REV[0], "counts": STATE["pick"]["counts"]}


# stem download formats: ffmpeg args + (container extension, mimetype, name tag).
# The name tag disambiguates formats that share a container (AAC/ALAC are both .m4a).
STEM_FMTS = {
    "flac": (["-c:a", "flac"], "flac", "audio/flac", ""),
    "wav": ([], "wav", "audio/wav", ""),
    "aac": (["-c:a", "aac", "-b:a", "256k"], "m4a", "audio/mp4", "_aac"),
    "alac": (["-c:a", "alac"], "m4a", "audio/mp4", "_alac"),
    "aiff": (["-c:a", "pcm_s16be"], "aiff", "audio/aiff", ""),
    "ogg192": (["-c:a", "libvorbis", "-b:a", "192k"], "ogg", "audio/ogg", "_192"),
    "ogg320": (["-c:a", "libvorbis", "-b:a", "320k"], "ogg", "audio/ogg", "_320"),
}


# Downloads must never be served from a browser/proxy cache: the URL can repeat
# across songs, and a stale hit hands back a *previous* song's file.
_NO_STORE = {"Cache-Control": "no-store"}


def _render_stem(which: str, fmt: str, speed: float, parts: Optional[str]) -> tuple:
    """Render one stem ('input'/'drums'/'bass'/'other'/'vocals' or 'backing') to the
    chosen format and speed. Returns (path, download filename, mimetype)."""
    if fmt not in STEM_FMTS:
        raise HTTPException(400, f"Invalid audio format -- use one of {list(STEM_FMTS)}")
    if which == "input":
        if not STATE["input"]:
            raise HTTPException(409, "No input loaded")
        src = str(STATE["input"]["wav"])
        skey = STATE["input"]["id"]
    elif which == "backing":
        src, skey = _ensure_backing(_parse_parts(parts))
        src = str(src)
    elif which in SOURCES and STATE["stems"] and which in STATE["stems"]["sources"]:
        src = str(Path(STATE["stems"]["dir"]) / f"{which}.wav")
        skey = STATE["stems"]["key"] + "_" + which
    else:
        raise HTTPException(409, f"No {which} stem available")
    args, ext, mime, tag = STEM_FMTS[fmt]
    stretch = abs(speed - 1.0) > 1e-3
    stag = f"_{speed:g}x" if stretch else ""
    nice = out_name(f"_{which}{tag}{stag}.{ext}")
    if fmt == "wav" and not stretch:
        return Path(src), nice, mime
    cached = OUT / f"{skey}_{fmt}{stag}.{ext}"
    if not cached.exists():
        # atempo time-stretches with pitch preserved; matches the Speed-knob playback
        filt = ["-filter:a", f"atempo={speed:.4f}"] if stretch else []
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", src] + filt + args + [str(cached)],
            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=600,
        )
        if r.returncode != 0 or not cached.exists():
            raise HTTPException(500, "FFmpeg conversion failed: " + r.stderr.decode("utf-8", "replace")[-300:])
    return cached, nice, mime


@app.get("/api/download_stems")
def download_stems(stems: str, fmt: str = "flac", speed: float = 1.0, backing: Optional[str] = None):
    """Download the selected stems. One stem -> that file; several -> a single ZIP.

    `stems` is a comma-separated list of source names and/or 'backing'/'input';
    `backing` gives the backing composition (the sources summed into it)."""
    speed = max(0.5, min(2.0, float(speed)))
    wanted = [s for s in dict.fromkeys((stems or "").split(",")) if s in SOURCES or s in ("backing", "input")]
    if not wanted:
        raise HTTPException(400, "No stems selected")
    rendered = [_render_stem(w, fmt, speed, backing) for w in wanted]
    if len(rendered) == 1:
        path, nice, mime = rendered[0]
        return FileResponse(str(path), media_type=mime, filename=nice, headers=_NO_STORE)
    import zipfile

    stretch = abs(speed - 1.0) > 1e-3
    ztag = f"_{speed:g}x" if stretch else ""
    zpath = OUT / out_name(f"_stems{ztag}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as zf:
        for path, nice, _mime in rendered:
            zf.write(str(path), arcname=nice)
    return FileResponse(str(zpath), media_type="application/zip",
                        filename=zpath.name, headers=_NO_STORE)


@app.post("/api/reset")
def reset():
    """Full reset: session state, jobs, and all on-disk caches."""
    DEMUCS_JOB.cancel()
    ADTOF_JOB.cancel()
    if DEMUCS_JOB.thread and DEMUCS_JOB.thread.is_alive():
        DEMUCS_JOB.thread.join(timeout=5)
    if ADTOF_JOB.thread and ADTOF_JOB.thread.is_alive():
        ADTOF_JOB.thread.join(timeout=5)
    with STATE_LOCK:
        STATE["input"] = None
        STATE["stems"] = None
        STATE["acts"] = None
        STATE["pick"] = None
        STATE["tempo_override"] = None
    ACTS_RAM.clear()
    for d in (UPLOADS, STEMS, ACTS, OUT, DEMUCS_TMP):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
    reset_jobs()
    return {"ok": True}


@app.get("/api/download/{kind}")
def download(kind: str, grid: str = "1/16", fmt: str = "wav", speed: float = 1.0):
    if grid not in GRID_Q:
        raise HTTPException(400, f"Invalid grid -- use one of {list(GRID_Q)}")
    speed = max(0.5, min(2.0, float(speed)))  # atempo's single-pass range
    pick, acts = require_pick()
    tempo = effective_tempo(acts)
    # "Match playback speed": stretch event times by 1/speed and the embedded tempo by
    # speed, so the MIDI lines up with the speed-stretched audio. Quantization slots are
    # unchanged (the speed cancels), so the notation is identical, only the tempo differs.
    stretch = abs(speed - 1.0) > 1e-3
    if stretch:
        events = {cls: [t / speed for t in times] for cls, times in pick["events"].items()}
        tempo *= speed
        stag = f"_{speed:g}x"
    else:
        events = pick["events"]
        stag = ""
    if kind == "midi":
        path = OUT / out_name(f"_adtof_raw{stag}.mid")
        build_midi(events, tempo, path)
        return FileResponse(path, media_type="audio/midi", filename=path.name, headers=_NO_STORE)
    if kind == "midi_quant":
        gtag = grid.replace("/", "")
        path = OUT / out_name(f"_adtof_q{gtag}{stag}.mid")
        build_quant_midi(events, tempo, grid, path)
        return FileResponse(path, media_type="audio/midi", filename=path.name, headers=_NO_STORE)
    if kind == "musicxml":
        path = OUT / out_name(f"_adtof{stag}.musicxml")
        try:
            build_musicxml(events, tempo, grid, path)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"MusicXML export failed (music21): {e}")
        return FileResponse(path, media_type="application/vnd.recordare.musicxml+xml",
                            filename=path.name, headers=_NO_STORE)
    raise HTTPException(404, "Unknown download kind")


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")


# ---------------------------------------------------------------------------
# Launcher
# ---------------------------------------------------------------------------
def preload_models() -> int:
    """Download every Demucs model the UI offers, so the first separation doesn't stall
    on a weight download. ADTOF's weights ship inside the adtof_pytorch package, so there's
    nothing to fetch on that side."""
    models = ["htdemucs", "htdemucs_ft", "mdx_extra", "mdx_extra_q"]
    code = (
        "import sys\n"
        "from demucs.pretrained import get_model\n"
        "for m in sys.argv[1:]:\n"
        "    print('  fetching ' + m + ' ...', flush=True)\n"
        "    get_model(m)\n"
        "print('Demucs models ready.')\n"
    )
    print(f"Preloading {len(models)} Demucs models (downloads to the demucs cache) ...")
    return subprocess.run([PYEXE, "-c", code, *models]).returncode


def main() -> None:
    ap = argparse.ArgumentParser(description="DrumLab -- local drum transcription GUI")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="Address to bind (default 127.0.0.1; 0.0.0.0 exposes it on your LAN)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--preload", action="store_true",
                    help="Download all Demucs models, then exit")
    args = ap.parse_args()

    if args.preload:
        sys.exit(preload_models())

    url = f"http://{args.host}:{args.port}"
    # 0.0.0.0/:: are bind-only wildcards; open a loopback URL in the browser instead.
    browser_url = f"http://127.0.0.1:{args.port}" if args.host in ("0.0.0.0", "::") else url
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(browser_url)).start()
    print(f"DrumLab {APP_VERSION} running at {url}  (Ctrl+C to quit)")

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
