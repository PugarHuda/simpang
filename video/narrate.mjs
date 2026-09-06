// Narration via edge-tts (Microsoft neural voices, free, no key). One audio file per segment
// plus word-level timings, which become the subtitle cues.
//   node video/narrate.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'out')
const AUDIO = path.join(OUT, 'audio')
const script = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8'))

fs.mkdirSync(AUDIO, { recursive: true })

const ms = (hhmmss) => {
  const [h, m, rest] = hhmmss.split(':')
  const [s, milli] = rest.replace(',', '.').split('.')
  return ((+h * 60 + +m) * 60 + +s) * 1000 + Math.round(+`0.${milli ?? 0}` * 1000)
}

/** edge-tts writes one cue per word boundary. Group them into readable lines. */
function cuesFrom(srt, maxChars = 42) {
  const words = []
  for (const block of srt.trim().split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const time = lines.find((l) => l.includes('-->'))
    if (!time) continue
    const [a, b] = time.split('-->').map((x) => x.trim())
    const text = lines.slice(lines.indexOf(time) + 1).join(' ').trim()
    if (text) words.push({ start: ms(a), end: ms(b), text })
  }
  const lines = []
  for (const w of words) {
    const last = lines.at(-1)
    if (last && (last.text.length + 1 + w.text.length) <= maxChars) {
      last.text += ' ' + w.text
      last.end = w.end
    } else {
      lines.push({ start: w.start, end: w.end, text: w.text })
    }
  }
  return lines
}

const durationOf = (file) =>
  Math.round(1000 * Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).toString().trim()))

const out = []
for (const seg of script.segments) {
  const mp3 = path.join(AUDIO, `${seg.id}.mp3`)
  const srt = path.join(AUDIO, `${seg.id}.srt`)
  const spoken = seg.speak ?? seg.text
  execFileSync('python', [
    '-m', 'edge_tts',
    '--voice', script.voice,
    // argparse reads a leading '-' as a new flag, so these must use the '=' form.
    `--rate=${script.rate ?? '+0%'}`,
    `--pitch=${script.pitch ?? '+0Hz'}`,
    '--text', spoken,
    '--write-media', mp3,
    '--write-subtitles', srt,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  const durationMs = durationOf(mp3)
  const cues = cuesFrom(fs.readFileSync(srt, 'utf8'))
  out.push({ id: seg.id, anchor: seg.anchor, file: `audio/${seg.id}.mp3`, durationMs, text: seg.text, cues })
  console.log(`  ${seg.id}  ${(durationMs / 1000).toFixed(1)}s  ${cues.length} lines  "${seg.text.slice(0, 56)}…"`)
}

const total = out.reduce((n, s) => n + s.durationMs, 0)
fs.writeFileSync(path.join(OUT, 'narration.json'), JSON.stringify({ voice: script.voice, totalMs: total, segments: out }, null, 2))
console.log(`\nnarration: ${out.length} segments, ${(total / 1000 / 60).toFixed(2)} min (before gaps)`)
