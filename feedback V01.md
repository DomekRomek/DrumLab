## Result
Overall very good, proceed to V2 refinements.
## General
- All volume knobs should be twisty knobs, not slide bars
- If possible and computationally cheap enough, add a two-channel live volume display with 0dBFS and all that to the waveform volume knobs (MIDI - master only)
- Radio buttons look kinda ugly, make them match the existing look and feel
## Top UI half
- Add a master volume knob
- Add a horizontal live master volume display with 0dBFS and all that
- Make play buttons green, stop red and pause yellow
- Add zoom +- buttons around the slider
- Add some more metadata at the top bar, looks barren
- If possible within a reasonable amount of effort, have the drag-to-upload region be square, rendering the embedded album art when you upload a music file if it has it.
- Drag-to-upload should be seperate to the left of (not inline with) the input params selection and  uploaded file name and (new) metadata
## Bottom UI half
- Add another waveform lane - demucs output without drums
- When zoom bar isn't fully maxed out, and the end of the audio is reached the wav waveforms are okay, but midi compresses when you keep pushing the zoom bar. Not sure how it's done right now, but consider having the bar be N% of the input audio dueration
- In ADTOF-direct mode, hide the demucs output track waveforms.
- MIDI volume should be configurable per-instrument with a master MIDI knob too, as hihat, for example, is piercingly loud in comparison to the other instruments. Overall the samples aren't volume-balanced.
- Let me select a region to loop it to check midi correctness
- MIDI track - Add an edit mode checkbox that lets me add notes where i click (snare, tom etc.)
- Scroll wheel should move the waveform left/right