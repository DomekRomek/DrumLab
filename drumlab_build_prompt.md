# Build a local drum-transcription control GUI

You're building a single-user, **fully local** web app that wraps an existing Demucs → ADTOF drum-transcription pipeline in a hands-on GUI. I'm an advanced dev (comfortable with CLI, unconventional setups). I want to manually tune each stage and see + hear the results aligned in time. Build the whole thing; only stop to ask me before introducing any dependency that could disturb my torch/CUDA install (see constraints).

## Hard environment constraints — do NOT break the existing setup
- **OS:** Windows 10/11, PowerShell.
- **venv:** Python 3.10 at `C:\Users\dom\Documents\_Drumming\Stem-Music\venv`. Use it.
- **torch:** `torch==2.12.0+cu130` (CUDA 13.0 build), GPU-working. **Do not upgrade, reinstall, or `pip install` anything that could pull a different torch / torchaudio / torchcodec** — a CPU wheel silently kills GPU support. Install any new dep so pip cannot touch torch (use `--no-deps` for anything that lists torch as a dependency, and pin around it). I have been burned by this exact thing already.
- **Already installed:** `demucs==4.0.1`, `torchaudio==2.11.0`, `torchcodec==0.14.0`, and FFmpeg "full-shared" (Gyan 8.1.1) on PATH (torchcodec/torchaudio decode depends on it).
- **ADTOF:** inference via `xavriley/ADTOF-pytorch` (deps: torch, librosa, pretty_midi; weights bundled). CLI form: `adtof --audio in.wav --out out.mid --thresholds k,s,h,t,c --fps 100 --device cuda`. Programmatic: `from adtof_pytorch import transcribe_to_midi`. Installed editable. Prefer importing its internals so you can cache pre-threshold activations (see "the threshold trick").
- **New deps:** keep minimal and CPU-safe — FastAPI, uvicorn, python-multipart, music21 (MusicXML), plus the already-present librosa / pretty_midi / soundfile / numpy. Pin nothing that drags torch.

## Stack (decided — chosen for robustness, don't substitute)
- **Backend:** FastAPI + uvicorn, serving a static single-page frontend.
- **Frontend:** vanilla HTML/JS, **no build step**. WaveSurfer.js for the audio waveforms, Tone.js for MIDI playback/synth + transport sync, a custom `<canvas>` for the MIDI piano-roll. No framework, no bundler — keep it a couple of static files so it can't rot.
- **Launch:** `python app.py` starts uvicorn on `127.0.0.1:<port>` and **immediately opens the default browser** at that URL (`webbrowser.open`). No second command, no manual navigation. Support optional `--no-browser` and `--port`.

## Pipeline & the two recompute costs (drives the UX)
Two stages, each run **manually** via its own **Run** button, each with a **Stop** that genuinely cancels:
1. **Demucs** (separation): audio → drum stem WAV. **Expensive** (tens of seconds). Run as a cancellable subprocess. Cache the stem; don't re-separate unless input/params change.
2. **ADTOF** (transcription): drum stem WAV → MIDI. The network produces, per class, a continuous **activation curve** over time; the 5 thresholds are just **peak-picking** applied to those curves *after* the net runs.

**The threshold trick (implement this):** run the ADTOF network **once per audio input** and **cache the raw per-class activation curves** (+ fps). Moving any threshold slider must **not** re-run the network — only re-run cheap peak-picking on the cached curves (milliseconds). This makes the optional "live-update thresholds" toggle instant. Only a new stem or an fps change re-runs the net. If `adtof_pytorch` doesn't expose pre-threshold activations publicly, import the model + preprocessing directly and reimplement the peak-pick.

## Entry points (start at either stage)
A selector lets an uploaded file feed EITHER:
- the **Demucs** stage (full song → separate → transcribe), or
- the **ADTOF** stage directly (already-isolated drum audio → transcribe), bypassing Demucs.
Accept common FFmpeg-decodable formats (wav/mp3/flac/m4a).

## Layout
**Top half — controls:**
- Entry-point selector: `Demucs` | `ADTOF-direct`.
- File picker / drop zone.
- Device toggle: `CUDA` (default) | `CPU`.
- **Demucs panel:** model dropdown (`htdemucs` [default], `htdemucs_ft`, `mdx_extra`, `mdx_extra_q`), `shifts` (int 0–10), `overlap` (0.0–0.99), `segment` (int seconds); two-stems fixed to drums. Run + Stop + progress.
- **ADTOF panel:** 5 threshold sliders — Kick / Snare / Hi-hat / Toms / Cymbals (range 0.0–1.0; defaults 0.22 / 0.24 / 0.32 / 0.22 / 0.30), `fps` (default 100), "Live-update thresholds" checkbox (default **OFF**). Run + Stop.

**Bottom half — three time-aligned lanes** sharing ONE horizontal time axis, ONE synced playhead, synced zoom/scroll:
1. Input audio waveform (WaveSurfer).
2. Demucs drum-stem waveform (WaveSurfer).
3. ADTOF MIDI piano-roll: 5 rows (kick / snare / hat / tom / cymbal), hits drawn as marks at their times (custom canvas).

**Transport:** one global play / pause / seek. All three lanes play together, sample-accurate, off a single clock (Tone.Transport). **Each lane has its own gain fader** (input gain, stem gain, MIDI-synth gain) so I can mix / A-B alignment (e.g. original quiet, synth loud).

**MIDI sound:** Tone.js synth, no sample files. kick → MembraneSynth; snare → short bright NoiseSynth; hi-hat → filtered noise / MetalSynth (short decay); toms → tuned MembraneSynth; cymbals → MetalSynth (long decay). "Dinky but recognizably drums" is the bar — don't over-engineer.

## Outputs (per-stage downloads, available once produced)
- **Drum stem WAV** (Demucs output).
- **Ardour-ready MIDI** (baseline): **unquantized** — hits at their true absolute times, first event at real **t=0** (do NOT trim leading silence); embed the **detected tempo** (librosa beat-track the stem) so importing into Ardour at session start lands hits on the audio with no manual nudging. GM percussion map, channel 10 (`pretty_midi` `is_drum=True`).
- **Quantized MIDI**: same notes snapped to a user-selected grid (1/8, 1/16, 1/16T, 1/32; default 1/16) at the detected tempo. For clean notation.
- **MusicXML**: from the quantized MIDI via music21 → drum/percussion staff (percussion clef, unpitched notes on standard drum-line positions) that opens in MuseScore. Drum MusicXML is finicky; if perfect drum-line mapping is hard, a correct-rhythm percussion staff is acceptable — surface any limitation in the UI.

GM note map: kick=36, snare=38, hi-hat=42, tom=45, cymbal=49 (ADTOF's 5 classes → these).

## Cancellation (Windows — get this right)
Demucs spawns worker processes. **Stop must kill the whole process tree**, not just the parent, or workers keep hogging the GPU. Launch the subprocess in a new process group (`CREATE_NEW_PROCESS_GROUP` / job object) and terminate the tree (`psutil` `process.children(recursive=True)` then kill, or `taskkill /T`). Run ADTOF as a cancellable worker (subprocess / separate process) so Stop is reliable even mid-inference. Surface job state (idle / running / done / cancelled / error) to the UI.

## Robustness
- Re-running a stage with unchanged inputs+params reuses the cache (cheap), doesn't recompute.
- Clear UI errors: CUDA OOM → suggest CPU toggle or smaller `segment`; FFmpeg decode fail → say so.
- Don't block the event loop — long jobs in background tasks/threads with status polling or websocket updates.
- Fully local: no telemetry, no external calls (pin local copies of WaveSurfer.js / Tone.js if you can, else pinned CDN URLs — state which).

## Deliverable
- Runnable in the existing venv: `app.py` (launcher + FastAPI), `static/` (`index.html` + `app.js` + the JS libs), and `requirements-extra.txt` for the **new** deps only (fastapi, uvicorn, python-multipart, music21) with an explicit warning not to let pip touch torch.
- Top-of-file README block: how to install the extra deps safely and run.
- Begin by stating your assumptions and asking me before adding any dependency that could disturb the torch/CUDA install. Otherwise, build it end to end.
