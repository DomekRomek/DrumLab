## Result
Incremental improvement over V01.
## UI
- Live update checkbox doesn't follow design philosphy, dropdowns and number input fields too
- Adtof note counters should reset when everything else does
- Change sliders to be slightly rounded rectangles instead of ball sliders.
- Remove the (Ardour) suffix after MIDI unquantized
- UI text should be more professional (e.g. Download buttons, Other small text, like done or 
- When in ADTOF-direct mode input waveform doesn't scale to the new height
- Rename Demucs/ADTOF modes as it's confusing (it can be mentioned in the parameter blocks like "1 . <NAME> - DEMUCS")
- If possible change favicon to look like the knobs we use right now, and change the tab name to look professional
- Explain parameters when hovering (what is shifts?? segment auto ???? )
### Knobs
- Look very good, good job. Make them logarithmic (-inf dB - +6 dB, and +20dB for the true master knob)
- Midi knobs should be in a 2wx3h grid, and the master volume bar is missing
### Album art
- Make the album art be almost as tall as the input box. Currently it's small and cramped
- Have the filename either wrap or get trimmed 
### MIDI track
- Add editor gentle snapping, as currently you can at best place notes ever so slightly off-grid
- Edit button doesn't follow design philosophy, change it to a self-explanatory icon button without text, and hover tells you what it is just in case
- Deselect button should be side-by-side with edit button
## Sounds
- Cymbals sound piercing, change it to a gentler ride sound
- MIDI knobs should start at +0dB, even out the volume under the hood
- Dums and No Drums tracks should start at -inf dB
## New Additions
- Add a clear button that resets the state back to default
- When i click RUN in adtof while in Demucs mode, i want it to run demucs automatically if it hasn't been run yet
- If reasonable, add a link that directly takes me to a page that will display me my MusicXML sheet music in one/two clicks
- When you hover your cursor over the stuff in the top section, have an informational description show up, and the "MusicXML is a.." part takes up too much space
- If reasonable, let me download the drum and no-drum stems in formats [wav, flac, ogg 195, ogg 320 (or mp3 320)

## Other
- After finishing applying feedback, always make commits when you're done by yourself. Writing commit messages is a chore.
- Add an appropriate gitignore and remove crap from commits.