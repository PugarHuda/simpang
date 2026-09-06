'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Tree, KEY_LABELS, type Act } from '@/components/tree'
import type { Divergence } from '@/lib/divergence'
import { hasWallet, paidFetch } from '@/lib/x402-client'

// The physical number row: 12 keys = 6 divergences x 2 branches.
const KEY_ROW = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal']

const EXAMPLES = [
  'refactor the auth system to use sessions',
  'analyse bitcoin over the last week',
  'add rate limiting to the login endpoint',
]

type Other = {
  runId: string; prompt: string; divergences: Divergence[]
  committed: Record<string, number>; actions: Record<string, Act>; done?: boolean
}
type Ready = { divergenceId: string; branchIdx: number; label: string; text: string }
type Result = { calibration: number | null; prefetch: Ready[]; elapsedMs: number }
type Directive = { text: string; at: number; applied: boolean }
type Pref = { constraint: string; count: number; standing: boolean }

// Client identity for attribution (run owner vs helper via [tab]). Not authentication.
const clientId = () => {
  try {
    const k = 'simpang.client'
    let v = localStorage.getItem(k)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
    return v
  } catch { return 'anon' }
}
const hdr = () => ({ 'x-simpang-client': clientId() })

const Md = ({ children }: { children: string }) => (
  <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>
)

export default function Page() {
  const [prompt, setPrompt] = useState(EXAMPLES[0])
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [divs, setDivs] = useState<Divergence[]>([])
  const [locked, setLocked] = useState({ count: 0, price: '$0.01' })
  const [eta, setEta] = useState(0)
  const [scanNote, setScanNote] = useState('')
  const [actions, setActions] = useState<Record<string, Act>>({})
  const [committed, setCommitted] = useState<Record<string, number>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [directives, setDirectives] = useState<Directive[]>([])
  const [out, setOut] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [diff, setDiff] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [prefetched, setPrefetched] = useState<string[]>([])
  const [toast, setToast] = useState('')
  const [ask, setAsk] = useState<string | null>(null)
  const [late, setLate] = useState<{ divergenceId: string; branchIdx: number } | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [openReady, setOpenReady] = useState<number | null>(null)
  const [wallet, setWallet] = useState<boolean | undefined>(undefined)
  const [t, setT] = useState(0)
  // Someone else's tree that you are helping to prune ([tab]).
  const [other, setOther] = useState<Other | null>(null)
  const otherRef = useRef<Other | null>(null)
  const startRef = useRef(0)
  const runIdRef = useRef('')
  const divsRef = useRef<Divergence[]>([])
  const askRef = useRef<string | null>(null)

  useEffect(() => { divsRef.current = divs }, [divs])
  useEffect(() => { otherRef.current = other }, [other])
  useEffect(() => { askRef.current = ask }, [ask])
  useEffect(() => { setWallet(hasWallet()) }, [])

  useEffect(() => {
    if (status !== 'running') return
    const i = setInterval(() => setT(Date.now() - startRef.current), 100)
    return () => clearInterval(i)
  }, [status])

  const flash = useCallback((msg: string, ms = 3200) => {
    setToast(msg)
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), ms)
  }, [])
  const note = useCallback((line: string) => setLog((l) => [...l.slice(-3), line]), [])

  const steer = useCallback(async (divergenceId: string, branchIdx: number, verb: 'kill' | 'pin') => {
    // While helping someone else, the prune goes into THEIR run. Same API.
    const helping = otherRef.current
    if (helping) setOther((o) => o && { ...o, actions: { ...o.actions, [divergenceId]: { verb, branchIdx } } })
    else setActions((a) => ({ ...a, [divergenceId]: { verb, branchIdx } }))
    // If the server rejects it, the optimistic paint has to come back off: a tree that
    // says "killed" for a prune that never landed is a lie.
    const revert = () => {
      const drop = (m: Record<string, Act>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== divergenceId))
      if (helping) setOther((o) => o && { ...o, actions: drop(o.actions) })
      else setActions(drop)
    }
    const r = await fetch('/api/steer', {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ runId: helping?.runId ?? runIdRef.current, divergenceId, branchIdx, verb }),
    }).then((x) => x.json()).catch(() => ({ error: 'network dropped' }))
    if (r.error && r.status !== 'late') { revert(); return flash(`✗ ${r.error}`) }
    // Late prune: the main run already committed to the other branch. Remember the
    // correction target (the branch it should have been) so [f] can fork without redoing it.
    if (r.status === 'late' && !helping) setLate({ divergenceId, branchIdx: verb === 'pin' ? branchIdx : 1 - branchIdx })
    if (r.status === 'queued' && !helping) setDirectives((d) => [...d, { text: r.injected, at: Date.now(), applied: false }])
    flash(r.status === 'late' ? `⚠ late · [f] fork the fix`
      : r.status === 'finished' ? `run already finished and agrees · recorded as a preference`
      : `${verb === 'kill' ? 'killed' : 'pinned'} · injected: "${r.injected}"`)
  }, [flash])

  // Fork: correct a late prune ([f]) OR "apply" a prefetched branch that was computed while waiting.
  const fork = useCallback(async (explicit?: { divergenceId: string; branchIdx: number }) => {
    const target = explicit ?? late
    if (!target) return
    setLate(null)
    flash('↻ forking…', 60000)
    const res = await fetch('/api/fork', {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ runId: runIdRef.current, ...target }),
    })
    if (!res.ok) return flash(`✗ fork: ${(await res.json()).error}`)
    setOut((o) => o + '\n\n')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      setOut((o) => o + dec.decode(value, { stream: true }))
    }
    setCommitted((c) => ({ ...c, [target.divergenceId]: target.branchIdx }))
    const state = await fetch(`/api/others?runId=${runIdRef.current}`).then((x) => x.json())
    if (state.diff) setDiff(state.diff)
    flash('forked · diff updated')
  }, [late, flash])

  // x402 through the official SDK: [enter] while a branch is locked. The browser wallet signs,
  // @x402/fetch retries the request with PAYMENT-SIGNATURE, the facilitator settles the USDC.
  const unlock = useCallback(async () => {
    if (!hasWallet()) return flash('needs an EVM wallet (MetaMask/Rabby) in this browser to pay via x402', 4000)
    try {
      flash('x402 · asking the wallet to sign…', 60000)
      const { fetch: pay, settleOf } = await paidFetch()
      const res = await pay(`/api/unlock?runId=${runIdRef.current}`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The facilitator's reason lives in the PAYMENT-REQUIRED header (field `error`), not the body.
        let reason = j.error ?? `HTTP ${res.status}`
        try { reason = JSON.parse(atob(res.headers.get('PAYMENT-REQUIRED') ?? '')).error ?? reason } catch {}
        if (/insufficient_balance/.test(reason)) reason = 'not enough Base Sepolia USDC in this wallet (insufficient_balance)'
        return flash(`✗ ${reason}`, 6000)
      }
      const tx = settleOf(res)?.transaction ?? ''
      setDivs((d) => [...d, j.divergence])
      setLocked((l) => ({ ...l, count: j.locked }))
      flash(`paid · "${j.divergence.axis}" unlocked${tx ? ` · tx ${tx.slice(0, 10)}…` : ''}`, 5000)
    } catch (err) {
      flash(`✗ ${(err as Error).message}`, 5000)
    }
  }, [flash])

  // [tab]: pick up someone else's running tree. Your wait time improves their result.
  const helpOther = useCallback(async () => {
    if (otherRef.current) return setOther(null)
    const r = await fetch(`/api/others?exclude=${runIdRef.current}`)
    if (!r.ok) return flash('no other run in flight', 2500)
    setOther(await r.json())
  }, [flash])

  // ponytail: 2s poll while the panel is open. SSE per tree if this ever becomes a main feature.
  const otherId = other?.runId
  useEffect(() => {
    if (!otherId) return
    const i = setInterval(async () => {
      const r = await fetch(`/api/others?runId=${otherId}`)
      const j = r.ok ? await r.json() : null
      if (!j || j.done) { setOther(null); flash('their run finished', 2500); return }
      setOther(j)
    }, 2000)
    return () => clearInterval(i)
  }, [otherId, flash])

  // Hotkeys: number row kill · shift+number pin · space ask · y/n answer · esc collapse
  //          f fork · enter pay · tab help someone else · d diff
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') return setCollapsed((c) => !c)
      if (e.key === 'Tab') { e.preventDefault(); return helpOther() }
      if (e.key === 'f') return fork()
      if (e.key === 'd') return setShowDiff((s) => !s)
      if (e.key === 'Enter') return locked.count > 0 ? unlock() : undefined
      if (e.key === ' ') {
        e.preventDefault()
        // Walk the tree: null -> d0 -> d1 -> ... -> null. It used to stop at d0 forever,
        // so the second divergence onward could never be asked about.
        const list = divsRef.current
        return setAsk(list[list.findIndex((d) => d.id === askRef.current) + 1]?.id ?? null)
      }
      if ((e.key === 'y' || e.key === 'n') && askRef.current) {
        steer(askRef.current, e.key === 'y' ? 0 : 1, 'pin')
        return setAsk(null)
      }
      // e.code, not e.key: shift+1 gives '!' in e.key.
      const n = KEY_ROW.indexOf(e.code)
      if (n < 0) return
      const d = (otherRef.current?.divergences ?? divsRef.current)[Math.floor(n / 2)]
      if (!d) return
      steer(d.id, n % 2, e.shiftKey ? 'pin' : 'kill')
    }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [steer, fork, unlock, helpOther, locked.count])

  async function go() {
    if (status === 'running' || prompt.trim().length < 3) return
    setStatus('running'); setOut(''); setDivs([]); setActions({}); setCommitted({}); setNotes({}); setDirectives([])
    setResult(null); setCollapsed(false); setAsk(null); setLate(null); setLocked({ count: 0, price: '$0.01' })
    setErrors([]); setDiff(''); setShowDiff(false); setPrefetched([]); setLog([]); setEta(0); setScanNote('')
    setOpenReady(null)
    startRef.current = Date.now()
    ;(document.activeElement as HTMLElement | null)?.blur()   // so hotkeys don't type into the input
    void fetch('/api/steer').catch(() => {})   // warm the steer route: the first key must land in < 1s

    const res = await fetch('/api/run', { method: 'POST', headers: hdr(), body: JSON.stringify({ prompt }) })
    if (!res.ok) {
      setErrors([(await res.json().catch(() => ({ error: `HTTP ${res.status}` }))).error])
      return setStatus('done')
    }
    let finished = false
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n\n')
      buf = lines.pop()!
      for (const l of lines) {
        if (!l.startsWith('data: ')) continue
        const e = JSON.parse(l.slice(6))
        if (e.type === 'run') runIdRef.current = e.runId
        if (e.type === 'scan') {
          setDivs(e.divergences); setLocked({ count: e.locked, price: e.price ?? '$0.01' }); setEta(e.etaSeconds ?? 0)
          if (e.skipped) setScanNote(`estimated wait ${e.etaSeconds}s · too short for the panel`)
          else if (!e.divergences.length) setScanNote('no real decisions in this prompt · the panel stays quiet')
        }
        if (e.type === 'text') setOut((o) => o + e.delta)
        if (e.type === 'tool') note(
          e.name === 'read' ? `reading ${e.path}`
          : e.name === 'write' ? `writing ${e.path} (${e.lines} lines)`
          : e.name === 'search' ? `searching the web: ${e.path}`
          : e.name === 'market' ? `fetching market data: ${e.path}`
          : e.name === 'paid' ? `buying via x402: ${e.path}`
          : e.name === 'bazaar' ? `searching x402 bazaar: ${e.path}`
          : `${e.name} ${e.path}`)
        if (e.type === 'paid') flash(`x402 paid · ${e.url} · tx ${(e.receipt?.transaction ?? '').slice(0, 10)}…`, 5000)
        if (e.type === 'step') note(`step ${e.n}`)
        if (e.type === 'commit') {
          setCommitted((c) => ({ ...c, [e.divergenceId]: e.branchIdx }))
          if (e.why) setNotes((n) => ({ ...n, [e.divergenceId]: e.why }))
        }
        if (e.type === 'applied') {
          setDirectives((d) => d.map((x) => (e.constraints.includes(x.text) ? { ...x, applied: true } : x)))
          flash(`applied: ${e.constraints.join(' / ')}`)
        }
        if (e.type === 'prefetch' && e.status === 'done') setPrefetched((p) => [...p, e.label])
        if (e.type === 'actions') {
          // Actions from a helper ([tab] on your tree) show up on the owner's tree with a 🤝.
          const incoming = e.actions as Record<string, Act>
          setActions((a) => {
            const next = { ...a }
            for (const [id, act] of Object.entries(incoming)) if (act.by === 'helper' || !next[id]) next[id] = act
            return next
          })
          if (Object.values(incoming).some((a) => a.by === 'helper')) flash('🤝 someone is pruning your tree')
        }
        if (e.type === 'error') setErrors((x) => [...x, e.message])
        if (e.type === 'patch') { setDiff(e.diff ?? ''); if (e.diff) note('diff ready · [d] show') }
        if (e.type === 'done') { finished = true; setResult({ calibration: e.calibration, prefetch: e.prefetch, elapsedMs: e.elapsedMs }); setStatus('done') }
      }
    }
    if (!finished) {
      // The SSE connection broke (network, function timeout): pull the last state from the
      // server instead of leaving the page stuck on "running" forever.
      const state = await fetch(`/api/others?runId=${runIdRef.current}`).then((x) => (x.ok ? x.json() : null)).catch(() => null)
      if (state) {
        if (state.output) setOut(state.output)
        if (state.diff) setDiff(state.diff)
        setCommitted(state.committed ?? {})
        setErrors((x) => [...x, state.done ? 'connection dropped, result recovered from the server' : 'connection dropped before the agent finished'])
      } else setErrors((x) => [...x, 'connection dropped'])
      setStatus('done')
    }
    void loadPrefs()
  }

  const [prefs, setPrefs] = useState<Pref[]>([])
  const loadPrefs = useCallback(async () => {
    const r = await fetch('/api/prefs').catch(() => null)
    if (r?.ok) setPrefs((await r.json()).prefs)
  }, [])
  useEffect(() => { void loadPrefs() }, [loadPrefs])
  const forget = useCallback(async (constraint: string) => {
    await fetch('/api/prefs', { method: 'DELETE', body: JSON.stringify({ constraint }) })
    void loadPrefs()
  }, [loadPrefs])

  const secs = (t / 1000).toFixed(1)
  const lastKey = KEY_LABELS[Math.max(0, divs.length * 2 - 1)]
  const diffStat = diff ? `${(diff.match(/^\+[^+]/gm) ?? []).length}+ ${(diff.match(/^-[^-]/gm) ?? []).length}- · ${(diff.match(/^diff --git/gm) ?? []).length} files` : ''
  const progress = eta > 0 ? Math.min(1, t / 1000 / eta) : 0

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 font-mono p-4 md:p-10">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="flex items-baseline gap-3 text-[13px]">
          <a href="https://github.com/PugarHuda/simpang" className="text-neutral-100 tracking-widest hover:underline">SIMPANG</a>
          <span className="text-neutral-600 hidden sm:inline">you pick the direction at every fork</span>
          <span className="ml-auto tabular-nums text-neutral-500" data-testid="clock">
            {status === 'idle' ? '--:--' : `${secs}s`}
            {eta > 0 && status === 'running' && <span className="text-neutral-700"> / ~{eta}s est</span>}
          </span>
        </header>
        {status === 'running' && eta > 0 && (
          <div className="h-px bg-neutral-900 -mt-3" aria-hidden>
            <div className="h-px bg-neutral-500 transition-all duration-300" style={{ width: `${progress * 100}%` }} />
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="task for the agent…"
            aria-label="prompt"
            data-testid="prompt"
            className="flex-1 min-w-0 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-[13px] outline-none focus:border-neutral-600"
          />
          <button
            onClick={go}
            disabled={status === 'running'}
            data-testid="run"
            className="px-4 border border-neutral-800 rounded text-[13px] hover:border-neutral-600 disabled:opacity-40"
          >
            run
          </button>
        </div>

        {status === 'idle' && (
          <div className="text-[12px] text-neutral-500 space-y-2" data-testid="intro">
            <p>
              Type a task, press Enter. While the agent works, its decision points appear as a tree.
              Kill the wrong branch before the agent spends a whole turn on it; the branches that
              survive are computed ahead of time while you wait.
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => setPrompt(ex)} data-testid="example"
                  className="px-2 py-0.5 border border-neutral-800 rounded text-neutral-400 hover:border-neutral-600 hover:text-neutral-200">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {status === 'running' && !divs.length && !scanNote && (
          <div className="text-neutral-600 text-[13px] animate-pulse" data-testid="scanning">scanning…</div>
        )}
        {scanNote && <div className="text-neutral-600 text-[12px]" data-testid="scan-note">{scanNote}</div>}

        {other && (
          <div className="border border-sky-900/60 rounded-md" data-testid="helping">
            <div className="px-3 py-2 text-[12px] text-sky-300 flex gap-2">
              <span>helping</span>
              <span className="text-neutral-400 truncate">“{other.prompt}”</span>
              <span className="ml-auto text-neutral-600">[tab] back</span>
            </div>
            <Tree
              divergences={other.divergences} actions={other.actions} committed={other.committed}
              locked={{ count: 0, price: '' }} ask={null} onAsk={() => {}} onSteer={steer}
            />
          </div>
        )}

        {divs.length > 0 && !collapsed && !other && (
          <>
            <Tree
              divergences={divs} actions={actions} committed={committed} notes={notes}
              locked={locked} ask={ask} wallet={wallet}
              onAsk={(id, idx) => { steer(id, idx, 'pin'); setAsk(null) }}
              onSteer={steer}
              onPay={unlock}
            />
            <div className="text-[11px] text-neutral-600" data-testid="legend">
              {ask
                ? '[y] take left · [n] take right · [space] next'
                : `[1-${lastKey}] kill · [⇧1-${lastKey}] pin · click a row = kill · [space] ask · [esc] ignore · [tab] help someone`}
              {late && <span className="text-amber-300"> · [f] fork the fix</span>}
              {diff && <span> · [d] diff</span>}
            </div>
          </>
        )}
        {divs.length > 0 && collapsed && (
          <div className="text-[12px] text-neutral-600" data-testid="collapsed">
            {divs.length} decisions hidden · [esc] show
          </div>
        )}

        {directives.length > 0 && (
          <div className="border border-neutral-900 rounded px-3 py-2 text-[12px] space-y-0.5" data-testid="directives">
            <div className="text-neutral-500">steering → agent</div>
            {directives.map((d, i) => (
              <div key={i} className={d.applied ? 'text-emerald-400' : 'text-amber-300'}>
                {d.applied ? '✓ applied' : '… queued'} · {d.text}
              </div>
            ))}
          </div>
        )}

        {status === 'running' && log.length > 0 && (
          <div className="text-[12px] text-neutral-500 space-y-0.5" data-testid="activity">
            {log.map((l, i) => (
              <div key={i} className={i === log.length - 1 ? 'text-neutral-400' : 'text-neutral-700'}>
                {i === log.length - 1 ? <span className="animate-pulse">●</span> : '○'} {l}
              </div>
            ))}
            {prefetched.length > 0 && <div className="text-emerald-700">✓ {prefetched.length} follow-ups ready</div>}
          </div>
        )}

        {errors.length > 0 && (
          <div className="border border-red-900/60 rounded p-3 text-[12px] text-red-300 space-y-1" data-testid="error">
            {errors.map((e, i) => <div key={i}>✗ {e}</div>)}
          </div>
        )}

        {out && (
          <div className="text-[13px] text-neutral-400 border border-neutral-900 rounded p-3" data-testid="output">
            <Md>{out}</Md>
            {status === 'running' && <span className="animate-pulse">▋</span>}
          </div>
        )}

        {diff && (
          <div className="border border-neutral-900 rounded text-[12px]" data-testid="diff">
            <button onClick={() => setShowDiff((s) => !s)} className="w-full text-left px-3 py-2 text-neutral-400 hover:text-neutral-200">
              {showDiff ? '▾' : '▸'} diff · {diffStat}
            </button>
            {showDiff && (
              <pre className="px-3 pb-3 overflow-x-auto text-neutral-500 max-h-[60vh] overflow-y-auto">
                {diff.split('\n').map((l, i) => (
                  <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-emerald-400' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400' : ''}>{l}</div>
                ))}
              </pre>
            )}
          </div>
        )}

        {result && (
          <div className="border border-emerald-900/60 rounded p-3 text-[13px] space-y-1" data-testid="result">
            <div className="text-emerald-400">
              {result.prefetch.length ? 'prefetched · ready now' : 'done'}
            </div>
            {result.prefetch.map((p, i) => (
              <div key={i}>
                <button onClick={() => setOpenReady(openReady === i ? null : i)} className="text-neutral-400 hover:text-neutral-200 text-left">
                  {openReady === i ? '▾' : '▸'} {p.label}
                </button>
                <button
                  onClick={() => fork({ divergenceId: p.divergenceId, branchIdx: p.branchIdx })}
                  data-testid={`apply-${p.divergenceId}-${p.branchIdx}`}
                  className="ml-2 px-1.5 text-[11px] border border-emerald-900 rounded text-emerald-400 hover:bg-emerald-900/30"
                  title="make this branch the main answer (forks in the same working copy)"
                >apply</button>
                {openReady === i && (
                  <div className="text-[12px] text-neutral-500 border border-neutral-900 rounded p-2 mt-1"><Md>{p.text}</Md></div>
                )}
              </div>
            ))}
            <div className="pt-1 text-neutral-600" data-testid="calibration">
              calibration {result.calibration === null ? '—' : `${Math.round(result.calibration * 100)}%`}
              {' · '}waited {(result.elapsedMs / 1000).toFixed(1)}s
            </div>
          </div>
        )}
      </div>

      {status !== 'running' && prefs.length > 0 && (
        <div className="mx-auto max-w-4xl mt-6 border border-neutral-900 rounded px-3 py-2 text-[12px] space-y-1" data-testid="prefs">
          <div className="text-neutral-500">
            learned preferences · killed ≥3× = never offered as a decision again
          </div>
          {prefs.slice(0, 8).map((p) => (
            <div key={p.constraint} className="flex items-baseline gap-2">
              <span className={p.standing ? 'text-emerald-400' : 'text-neutral-600'}>{p.count}×</span>
              <span className={p.standing ? 'text-neutral-200' : 'text-neutral-400'}>{p.constraint}</span>
              <button onClick={() => forget(p.constraint)} data-testid="forget"
                className="ml-auto text-neutral-600 hover:text-red-300">forget</button>
            </div>
          ))}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-[92vw] bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-[12px] text-neutral-300" data-testid="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  )
}
