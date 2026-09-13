# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 DomekRomek
"""ADTOF inference worker.

Run as a separate, killable subprocess by app.py. Loads the ADTOF Frame_RNN
model once, runs it over the input audio, and caches the raw pre-threshold
activation curves (.npy) plus metadata (tempo, duration, fps) to --out-dir.

Peak-picking is deliberately NOT done here -- the server re-picks the cached
curves in milliseconds whenever a threshold slider moves.

Writes meta.json LAST; the server treats its presence as "cache complete".
"""

import argparse
import json
from pathlib import Path

import numpy as np


TEMPO_VERSION = 2  # bump when the detector changes; app.py refreshes caches with an older tempo_v


def log(msg: str) -> None:
    print(msg, flush=True)


def detect_tempo(audio_path: Path) -> tuple[float, float]:
    """Return (tempo_bpm, duration_sec) for the audio.

    beat_track's global BPM is quantized to the tempogram lag grid (hop 512 @
    22050 Hz), which lands 1-3 BPM off the true tempo -- audible as a metronome
    drifting in and out of phase against the hits. The tracked beat POSITIONS
    follow the audio, though, so re-derive the BPM from the beat spacing:
    averaging near-median inter-beat intervals over the whole song cancels the
    per-beat frame rounding (sub-0.1-BPM in practice)."""
    import librosa

    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    tempo_raw, beats = librosa.beat.beat_track(y=y, sr=sr, units="time", trim=False)
    tempo = float(np.atleast_1d(tempo_raw)[0])
    if len(beats) >= 9:
        intervals = np.diff(beats)
        median = float(np.median(intervals))
        good = intervals[np.abs(intervals - median) < 0.15 * median]
        if len(good) >= 8:
            tempo = 60.0 / float(np.mean(good))
    return tempo, float(len(y)) / sr


def main() -> None:
    ap = argparse.ArgumentParser(description="ADTOF activation-cache worker")
    ap.add_argument("--audio", required=True, help="Input audio file (drum stem)")
    ap.add_argument("--out-dir", required=True, help="Cache directory for activations + meta")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--fps", type=int, default=100, help="Model frame rate (changes preprocessing hop)")
    ap.add_argument("--tempo-only", action="store_true",
                    help="Re-detect tempo into an existing cache's meta.json (no torch, no inference)")
    args = ap.parse_args()

    audio_path = Path(args.audio)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    assert audio_path.exists(), f"audio not found: {audio_path}"

    if args.tempo_only:
        meta_path = out_dir / "meta.json"
        meta = json.loads(meta_path.read_text())
        log("[worker] refreshing tempo (librosa beat-track, refined) ...")
        tempo, duration = detect_tempo(audio_path)
        meta.update({"tempo": tempo, "duration": duration, "tempo_v": TEMPO_VERSION})
        meta_path.write_text(json.dumps(meta, indent=2))
        log(f"[worker] done. tempo={tempo:.2f} bpm")
        return

    log("[worker] importing torch / adtof_pytorch ...")
    import torch
    from adtof_pytorch import (
        calculate_n_bins,
        create_frame_rnn_model,
        get_default_weights_path,
        load_audio_for_model,
        load_pytorch_weights,
    )

    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        log("[worker] WARNING: CUDA requested but not available, falling back to CPU")
        device = "cpu"

    log(f"[worker] building model (device={device})")
    model = create_frame_rnn_model(calculate_n_bins())
    model.eval()
    weights = get_default_weights_path()
    if weights and Path(weights).exists():
        model = load_pytorch_weights(model, str(weights), strict=False)
    else:
        log("[worker] WARNING: packaged weights not found, using random init")
    model.to(device)

    log(f"[worker] preprocessing audio (fps={args.fps}) ...")
    x = load_audio_for_model(str(audio_path), fps=args.fps)
    x = x.to(device)

    log(f"[worker] running inference on input shape {tuple(x.shape)} ...")
    with torch.no_grad():
        pred = model(x).cpu().numpy()[0]  # [T, 5] in channel order kick/snare/tom/hihat/cymbal
    np.save(str(out_dir / "activations.npy"), pred.astype(np.float32))
    log(f"[worker] activations cached: {pred.shape[0]} frames x {pred.shape[1]} classes")

    log("[worker] detecting tempo (librosa beat-track, refined) ...")
    tempo, duration = detect_tempo(audio_path)

    meta = {
        "fps": int(args.fps),
        "tempo": tempo,
        "tempo_v": TEMPO_VERSION,
        "duration": duration,
        "n_frames": int(pred.shape[0]),
        "audio": str(audio_path),
        "device": device,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    log(f"[worker] done. tempo={tempo:.2f} bpm, duration={duration:.1f}s")


if __name__ == "__main__":
    main()
