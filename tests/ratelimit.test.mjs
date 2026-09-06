// Rate limits on /api/run and /api/fork. Run against a server started with SIMPANG_RUN_LIMIT=2:
//   SIMPANG_RUN_LIMIT=2 npx next dev -p 3102 &  then  BASE=http://localhost:3102 node tests/ratelimit.test.mjs
// The limit is checked BEFORE body validation, so even a broken request counts and no paid run is triggered.
const BASE = process.env.BASE ?? 'http://localhost:3102'
const a = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } else console.log('ok  ', m) }
const hit = (path) => fetch(`${BASE}${path}`, { method: 'POST', body: '{}' })

const s = []
for (let i = 0; i < 3; i++) s.push(await hit('/api/run'))
a(s[0].status === 400 && s[1].status === 400, 'run: the first two requests pass the limiter (400 because the body is empty)')
a(s[2].status === 429, `run: the third request -> 429`)
const j = await s[2].json()
a(/try again|quota/.test(j.error) && Number(s[2].headers.get('retry-after')) > 0, `run: message + retry-after ${s[2].headers.get('retry-after')}s`)
a((await hit('/api/fork')).status === 429, 'fork: shares the same limiter -> 429')
console.log('\nOK — the per-IP rate limit is live, and a broken request never triggers a paid run')
