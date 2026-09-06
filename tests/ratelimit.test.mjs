// Rate limit di /api/run dan /api/fork. Jalankan melawan server dengan SIMPANG_RUN_LIMIT=2:
//   SIMPANG_RUN_LIMIT=2 npx next dev -p 3102 &  lalu  BASE=http://localhost:3102 node tests/ratelimit.test.mjs
// Batas dicek SEBELUM validasi body, jadi request rusak pun dihitung dan tidak ada run berbayar yang dipicu.
const BASE = process.env.BASE ?? 'http://localhost:3102'
const a = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } else console.log('ok  ', m) }
const hit = (path) => fetch(`${BASE}${path}`, { method: 'POST', body: '{}' })

const s = []
for (let i = 0; i < 3; i++) s.push(await hit('/api/run'))
a(s[0].status === 400 && s[1].status === 400, 'run: dua request pertama lolos limiter (400 karena body kosong)')
a(s[2].status === 429, `run: request ketiga -> 429`)
const j = await s[2].json()
a(/coba lagi|kuota/.test(j.error) && Number(s[2].headers.get('retry-after')) > 0, `run: pesan + retry-after ${s[2].headers.get('retry-after')}s`)
a((await hit('/api/fork')).status === 429, 'fork: berbagi limiter yang sama -> 429')
console.log('\nOK — rate limit per IP aktif, request rusak tidak memicu run berbayar')
