# The demo video

Three steps, no video editor and no paid service.

```bash
node video/capture.mjs     # ~5 min: drives production, records it, writes a timeline
node video/narrate.mjs     # ~1 min: edge-tts, one audio file + word timings per line
node video/compose.mjs     # ~2 min: ffmpeg burns the overlay and cuts to the narration
```

Output: `video/out/simpang-demo.mp4`.

## What each step does

**capture.mjs** drives `simpang.vercel.app` with Playwright and records the page. Nothing is
staged: the agent really runs, the second browser really prunes our tree, and the x402 payment
really settles on Base Sepolia (the wallet signs EIP-3009 in node and is injected as
`window.ethereum`). Alongside the `.webm` it writes `timeline.json` — every cursor move, click,
keypress, and the bounding box of whatever is being explained, all timestamped.

**narrate.mjs** turns `script.json` into one MP3 per line using edge-tts. `text` is the subtitle;
`speak` overrides it for the reader where the two differ ("x402" is read "x four oh two"). The
word-level timings that come back become the subtitle cues.

**compose.mjs** does the two things that make it watchable:

- *Time remap.* Each line is anchored to a mark in the recording. The footage between two marks is
  played fast enough to fit its sentence, so the minutes spent waiting on the agent compress and
  every claim lands on the thing it describes. Where the footage is shorter than the line, the last
  frame is held rather than slowing to a crawl.
- *One ASS file.* Cursor, click ripples, key chips, marker boxes, labels, subtitles and the
  watermark are all subtitle events. libass draws and animates vectors, so there is no second
  rendering stack to install and no licence to buy.

The page is staged on the top 1600x900 of the frame; the strip underneath belongs to the
subtitles, so they never cover the UI they are describing.

## Editing it

Change the words in `script.json` and re-run `narrate` + `compose` — no re-recording needed, the
timing re-solves itself. Add a beat by adding a `mark()` in `capture.mjs` and a segment with that
`anchor`. A segment whose anchor is missing from the capture is dropped, so a scene that fails to
record costs you that line and nothing else.
