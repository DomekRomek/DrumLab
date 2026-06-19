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


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="ADTOF activation-cache worker")
    ap.add_argument("--audio", required=True, help="Input audio file (drum stem)")
    ap.add_argument("--out-dir", required=True, help="Cache directory for activations + meta")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--fps", type=int, default=100, help="Model frame rate (changes preprocessing hop)")
    args = ap.parse_args()

    audio_path = Path(args.audio)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    assert audio_path.exists(), f"audio not found: {audio_path}"

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

    log("[worker] detecting tempo (librosa beat-track) ...")
    import librosa

    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    tempo_raw, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo_raw)[0])
    duration = float(len(y)) / sr

    meta = {
        "fps": int(args.fps),
        "tempo": tempo,
        "duration": duration,
        "n_frames": int(pred.shape[0]),
        "audio": str(audio_path),
        "device": device,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    log(f"[worker] done. tempo={tempo:.2f} bpm, duration={duration:.1f}s")


if __name__ == "__main__":
    main()
