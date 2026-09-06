// Turns the raw capture + the narration into the finished video.
//
//   node video/compose.mjs
//
// Two ideas do all the work:
//
// 1. TIME REMAP. Each narration segment is anchored to a mark in the recording. The footage
//    between two marks is played fast enough to fit its sentence, so the minutes spent waiting
//    on the agent compress and every line lands on the thing it describes. Where the footage is
//    shorter than the sentence, the last frame is held instead of slowing to a crawl.
//
// 2. ONE ASS FILE. Cursor, click ripples, key chips, marker boxes, labels, subtitles and the
//    watermark are all subtitle events. libass draws vectors and animates them, so there is no
//    second rendering stack to install.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'out')
const GAP_MS = 450          // breath after each sentence
const MAX_RATE = 12         // never fast-forward harder than this; beyond it we simply cut
const W = 1920, H = 1080

const timeline = JSON.parse(fs.readFileSync(path.join(OUT, 'timeline.json'), 'utf8'))
const narration = JSON.parse(fs.readFileSync(path.join(OUT, 'narration.json'), 'utf8'))

// The capture runs a smaller viewport so the app's centred column fills the shot. Every
// coordinate in the timeline is in that viewport's space and has to be scaled to the frame.
// Playwright records the viewport 1:1 into the frame it is given, so the capture is a
// 1280x720 page sitting in the top-left of a 2560x1440 canvas. Crop that away, then put the
// page on a 1600x900 stage at the top of the frame. The 180px left underneath is a dedicated
// band for the subtitles, so they can never sit on top of the UI they are describing.
const VP = timeline.viewport ?? { width: W, height: H }
const PW = 1600, PH = Math.round(PW * VP.height / VP.width)
const OX = Math.round((W - PW) / 2)
const K = PW / VP.width
const sx = (n) => Math.round(OX + n * K)   // page x -> frame x
const sy = (n) => Math.round(n * K)        // page y -> frame y
const sw = (n) => Math.round(n * K)        // page size -> frame size

/* ------------------------------------------------------------- the plan ---- */

const markAt = (name) => timeline.events.find((e) => e.type === 'mark' && e.name === name)?.t
const END = timeline.durationMs
// The helper page starts recording later than the main one, so its own clock is offset.
const HELPER_T0 = timeline.helperStartMs ?? 0
// Segments that should be shown from the helper's browser rather than ours.
const FROM_HELPER = new Set(['multi'])

const segments = []
for (const seg of narration.segments) {
  const at = markAt(seg.anchor)
  if (at === undefined) { console.log(`  skip ${seg.id}: no mark "${seg.anchor}" in the capture`); continue }
  segments.push({ ...seg, at })
}
segments.sort((a, b) => a.at - b.at)

let outAt = 0
for (const [i, s] of segments.entries()) {
  const next = segments[i + 1]
  s.useHelper = FROM_HELPER.has(s.anchor) && Boolean(timeline.helper)
  s.srcEnd = next ? next.at : END
  s.outDur = s.durationMs + GAP_MS
  const span = Math.max(200, s.srcEnd - s.at)
  s.rate = Math.min(MAX_RATE, Math.max(1, span / s.outDur))
  s.consumed = Math.min(span, s.outDur * s.rate)      // source ms actually played
  s.freeze = Math.max(0, s.outDur - s.consumed / s.rate)
  s.outAt = outAt
  outAt += s.outDur
}
const TOTAL = outAt

console.log(`plan: ${segments.length} segments, ${(TOTAL / 1000 / 60).toFixed(2)} min out of ${(END / 1000 / 60).toFixed(2)} min captured`)
for (const s of segments) {
  console.log(`  ${s.id} ${(s.outAt / 1000).toFixed(1).padStart(6)}s  ${s.rate.toFixed(1)}x` +
    `${s.freeze > 200 ? ` +${(s.freeze / 1000).toFixed(1)}s hold` : ''}` +
    `${s.useHelper ? '  [helper cam]' : ''}  ${s.anchor}`)
}

/** Source time -> output time. Events inside a frozen tail clamp to where motion stopped. */
function toOut(srcMs, helper = false) {
  for (const s of segments) {
    if (s.useHelper !== helper) continue
    const rel = srcMs - s.at
    if (rel < 0 || rel > s.consumed) continue
    return s.outAt + rel / s.rate
  }
  // Otherwise clamp to the visible edge of whichever segment owns this source time, so a label
  // sitting in a frozen tail still lands. Never draw across cameras: an overlay recorded on one
  // browser must not appear over footage from the other.
  for (const s of segments) {
    if (srcMs >= s.at && srcMs < s.srcEnd) {
      return s.useHelper === helper ? s.outAt + Math.min(s.consumed, srcMs - s.at) / s.rate : null
    }
  }
  return null
}

/* ------------------------------------------------------------------ ASS ---- */

const cs = (ms) => {
  const t = Math.max(0, Math.round(ms))
  const h = Math.floor(t / 3600000)
  const m = Math.floor(t / 60000) % 60
  const s = Math.floor(t / 1000) % 60
  const c = Math.floor((t % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}
const lines = []
const dlg = (style, start, end, text, layer = 5) =>
  lines.push(`Dialogue: ${layer},${cs(start)},${cs(end)},${style},,0,0,0,,${text}`)

const AMBER = '&H24BFFB&'      // #fbbf24, ASS is BGR
const WHITE = '&HFFFFFF&'
const INK = '&H14100C&'

const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Segoe UI Semibold,46,${WHITE},${WHITE},${INK},&H80000000,0,0,0,0,100,100,0,0,1,4,2,2,200,200,34,1
Style: Label,Consolas,34,${INK},${INK},${AMBER},&H00000000,1,0,0,0,100,100,0,0,3,7,0,1,0,0,0,1
Style: Box,Consolas,34,${AMBER},${AMBER},${AMBER},&H00000000,0,0,0,0,100,100,0,0,1,4,0,7,0,0,0,1
Style: Key,Consolas,44,${INK},${INK},${AMBER},&H00000000,1,0,0,0,100,100,0,0,3,10,0,2,0,0,150,1
Style: Mark,Consolas,34,${AMBER},${AMBER},${INK},&H00000000,0,0,0,0,100,100,0,0,1,3,0,7,0,0,0,1
Style: Wm,Consolas,26,&HB0FFFFFF,&HB0FFFFFF,${INK},&H00000000,0,0,0,0,100,100,0,0,1,3,0,9,36,36,28,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

/* --- watermark: the recording has no browser chrome, so name the source ---- */
const host = timeline.base.replace(/^https?:[/][/]/, '')
dlg('Wm', 0, TOTAL, `{\\fad(600,600)}live · ${host}`, 1)

/* --- marker boxes ---------------------------------------------------------- */
const openBox = new Map()
for (const e of timeline.events) {
  if (e.type === 'box') openBox.set(e.id, e)
  if (e.type === 'boxoff') {
    const b = openBox.get(e.id)
    if (!b) continue
    openBox.delete(e.id)
    const helper = b.page === 'b'
    const a = toOut(b.t, helper), z = toOut(e.t, helper)
    if (a === null || z === null || z - a < 250) continue
    const pad = 10
    const X = Math.max(2, sx(b.rect.x) - pad), Y = Math.max(2, sy(b.rect.y) - pad)
    const BW = Math.min(W - X - 2, sw(b.rect.w) + pad * 2), BH = Math.min(PH - Y - 2, sw(b.rect.h) + pad * 2)
    // An outline-only rectangle: transparent fill, amber border.
    dlg('Box', a, z,
      `{\\an7\\pos(${X},${Y})\\1a&HFF&\\3c${AMBER}\\3a&H10&\\bord4\\shad0\\fad(180,180)\\p1}` +
      `m 0 0 l ${BW} 0 l ${BW} ${BH} l 0 ${BH}{\\p0}`, 6)
    if (b.label) {
      // Above the box when there is room, otherwise below it.
      const above = Y > 70
      dlg('Label', a, z,
        `{\\an${above ? 1 : 7}\\pos(${X},${above ? Y - 12 : Y + BH + 12})\\fad(180,180)}${b.label.replace(/\{|\}/g, '')}`, 7)
    }
  }
}
// Boxes the capture never closed (a scene bailed) still get a short life.
for (const b of openBox.values()) {
  const a = toOut(b.t, b.page === 'b')
  if (a !== null) dlg('Box', a, a + 2500, `{\\an7\\pos(${sx(b.rect.x)},${sy(b.rect.y)})\\1a&HFF&\\3c${AMBER}\\bord4\\shad0\\fad(180,180)\\p1}m 0 0 l ${sw(b.rect.w)} 0 l ${sw(b.rect.w)} ${sw(b.rect.h)} l 0 ${sw(b.rect.h)}{\\p0}`, 6)
}

/* --- cursor ---------------------------------------------------------------- */
// A classic arrow, drawn once and moved. Only on the main camera.
const ARROW = 'm 0 0 l 0 30 l 8 23 l 13 34 l 19 31 l 14 21 l 24 21'
const cursors = timeline.events.filter((e) => e.type === 'cursor')
for (let i = 0; i < cursors.length - 1; i++) {
  const from = cursors[i], to = cursors[i + 1]
  const a = toOut(from.t), z = toOut(to.t)
  if (a === null || z === null || z <= a) continue
  const moving = from.x !== to.x || from.y !== to.y
  const body = moving
    ? `{\\move(${sx(from.x)},${sy(from.y)},${sx(to.x)},${sy(to.y)},0,${Math.round(z - a)})`
    : `{\\pos(${sx(to.x)},${sy(to.y)})`
  dlg('Box', a, z,
    `${body}\\an7\\1c${WHITE}\\3c${INK}\\bord2\\shad1\\fscx90\\fscy90\\p1}${ARROW}{\\p0}`, 9)
}

/* --- click ripples --------------------------------------------------------- */
for (const e of timeline.events.filter((x) => x.type === 'click')) {
  const a = toOut(e.t)
  if (a === null) continue
  dlg('Box', a, a + 500,
    `{\\an5\\pos(${sx(e.x)},${sy(e.y)})\\1a&HFF&\\3c${AMBER}\\bord3\\shad0\\fscx40\\fscy40` +
    `\\t(0,500,\\fscx170\\fscy170\\3a&HFF&)\\p1}m 0 0 b 0 -33 -33 -33 -33 0 b -33 33 0 33 0 33 b 33 33 33 -33 0 -33{\\p0}`, 9)
}

/* --- key chips ------------------------------------------------------------- */
for (const e of timeline.events.filter((x) => x.type === 'key')) {
  const a = toOut(e.t)
  if (a === null) continue
  dlg('Key', a, a + 1600, `{\\fad(120,320)}${e.label}`, 8)
}

/* --- subtitles ------------------------------------------------------------- */
for (const s of segments) {
  for (const c of s.cues) {
    const a = s.outAt + c.start
    const z = Math.min(s.outAt + s.outDur, s.outAt + c.end + 120)
    if (z <= a) continue
    dlg('Sub', a, z, `{\\fad(90,90)}${c.text.replace(/\{|\}/g, '')}`)
  }
}

const assPath = path.join(OUT, 'overlay.ass')
fs.writeFileSync(assPath, head + lines.join('\n') + '\n')
console.log(`\noverlay: ${lines.length} drawn events -> overlay.ass`)

/* -------------------------------------------------------------- ffmpeg ---- */

// Playwright draws the viewport at 1:1 into whatever frame size it was given, so a larger
// recording size just pads with grey. The page is always the top-left viewport-sized region.

const main = path.join(OUT, timeline.main)
const helper = timeline.helper ? path.join(OUT, timeline.helper) : null
const inputs = ['-i', main]
if (helper) inputs.push('-i', helper)
const V_MAIN = 0, V_HELPER = helper ? 1 : 0
const audioBase = inputs.length / 2

const filter = []
const vparts = [], aparts = []
segments.forEach((s, i) => {
  const src = s.useHelper ? V_HELPER : V_MAIN
  const start = (s.useHelper ? s.at - HELPER_T0 : s.at) / 1000
  const end = start + s.consumed / 1000
  filter.push(
    `[${src}:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=(PTS-STARTPTS)/${s.rate.toFixed(4)},` +
    `crop=${VP.width}:${VP.height}:0:0,scale=${PW}:${PH},` +
    `pad=${W}:${H}:${OX}:0:color=0x0a0a0a,fps=30,` +
    `tpad=stop_mode=clone:stop_duration=${(s.freeze / 1000).toFixed(3)},setsar=1[v${i}]`)
  vparts.push(`[v${i}]`)

  inputs.push('-i', path.join(OUT, s.file))
  const ai = audioBase + i
  filter.push(`[${ai}:a]aresample=48000,apad=whole_dur=${(s.outDur / 1000).toFixed(3)},atrim=0:${(s.outDur / 1000).toFixed(3)},asetpts=N/SR/TB[a${i}]`)
  aparts.push(`[a${i}]`)
})
filter.push(`${vparts.join('')}concat=n=${segments.length}:v=1:a=0[vcat]`)
filter.push(`${aparts.join('')}concat=n=${segments.length}:v=0:a=1[aout]`)
// A Windows absolute path inside a filter string means escaping both the drive colon and
// the spaces for libavfilter's parser. Running ffmpeg from this directory makes the path
// relative, which needs no escaping at all.
filter.push('[vcat]ass=filename=out/overlay.ass[vout]')

const outFile = path.join(OUT, 'simpang-demo.mp4')
const args = [
  '-y', ...inputs,
  '-filter_complex', filter.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
  outFile,
]
fs.writeFileSync(path.join(OUT, 'ffmpeg-args.txt'), args.join('\n'))

console.log(`rendering ${(TOTAL / 1000 / 60).toFixed(2)} min -> ${outFile}`)
const r = spawnSync('ffmpeg', args, { cwd: HERE, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26 })
if (r.status !== 0) {
  console.error(r.stderr?.split('\n').slice(-30).join('\n'))
  process.exit(1)
}
const size = fs.statSync(outFile).size
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFile]).toString().trim()
console.log(`\ndone: ${outFile}`)
console.log(`      ${(+dur / 60).toFixed(2)} min, ${(size / 1e6).toFixed(1)} MB`)
