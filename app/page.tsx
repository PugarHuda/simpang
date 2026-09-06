'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tree, KEY_LABELS, type Act } from '@/components/tree'
import type { Divergence } from '@/lib/divergence'
import { hasWallet, paidFetch } from '@/lib/x402-client'

// Baris angka fisik: 12 tombol = 6 divergensi x 2 cabang.
const KEY_ROW = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal']

type Other = {
  runId: string; prompt: string; divergences: Divergence[]
  committed: Record<string, number>; actions: Record<string, Act>; done?: boolean
}
type Ready = { divergenceId: string; branchIdx: number; label: string; text: string }
type Result = { calibration: number | null; prefetch: Ready[]; elapsedMs: number }

export default function Page() {
  const [prompt, setPrompt] = useState('refactor the auth system to use sessions')
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [divs, setDivs] = useState<Divergence[]>([])
  const [locked, setLocked] = useState({ count: 0, price: '$0.01' })
  const [eta, setEta] = useState(0)
  const [scanNote, setScanNote] = useState('')
  const [actions, setActions] = useState<Record<string, Act>>({})
  const [committed, setCommitted] = useState<Record<string, number>>({})
  const [out, setOut] = useState('')
  const [activity, setActivity] = useState('')
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
  // Pohon orang lain yang sedang kamu bantu pangkas ([tab]).
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

  const steer = useCallback(async (divergenceId: string, branchIdx: number, verb: 'kill' | 'pin') => {
    // Saat membantu orang lain, pangkasan masuk ke run MEREKA. API-nya sama.
    const helping = otherRef.current
    if (helping) setOther((o) => o && { ...o, actions: { ...o.actions, [divergenceId]: { verb, branchIdx } } })
    else setActions((a) => ({ ...a, [divergenceId]: { verb, branchIdx } }))
    const r = await fetch('/api/steer', {
      method: 'POST',
      body: JSON.stringify({ runId: helping?.runId ?? runIdRef.current, divergenceId, branchIdx, verb }),
    }).then((x) => x.json())
    if (r.error && r.status !== 'late') return flash(`✗ ${r.error}`)
    // Pangkasan terlambat: main run sudah commit ke cabang lawan. Simpan target
    // koreksinya (cabang yang seharusnya) supaya [f] bisa fork tanpa mengulang.
    if (r.status === 'late' && !helping) setLate({ divergenceId, branchIdx: verb === 'pin' ? branchIdx : 1 - branchIdx })
    flash(r.status === 'late' ? `⚠ late · [f] fork koreksi`
      : r.status === 'finished' ? `run sudah selesai dan sejalan · dicatat sebagai preferensi`
      : `${verb === 'kill' ? 'killed' : 'pinned'} · injected: "${r.injected}"`)
  }, [flash])

  const fork = useCallback(async () => {
    if (!late) return
    const target = late
    setLate(null)
    flash('↻ forking…', 60000)
    const res = await fetch('/api/fork', {
      method: 'POST',
      body: JSON.stringify({ runId: runIdRef.current, ...target }),
    })
    if (!res.ok) return flash(`✗ fork: ${(await res.json()).error}`)
    setOut((o) => o + '\n')
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
    flash('forked · diff diperbarui')
  }, [late, flash])

  // x402 lewat SDK resmi: [enter] saat ada cabang terkunci. Wallet browser menandatangani,
  // @x402/fetch mengulang request dengan PAYMENT-SIGNATURE, facilitator men-settle USDC.
  const unlock = useCallback(async () => {
    if (!hasWallet()) return flash('butuh wallet EVM (MetaMask/Rabby) di browser untuk bayar via x402', 4000)
    try {
      flash('x402 · minta tanda tangan wallet…', 60000)
      const { fetch: pay, settleOf } = await paidFetch()
      const res = await pay(`/api/unlock?runId=${runIdRef.current}`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Alasan penolakan facilitator ada di header PAYMENT-REQUIRED (field error), bukan body.
        let reason = j.error ?? `HTTP ${res.status}`
        try { reason = JSON.parse(atob(res.headers.get('PAYMENT-REQUIRED') ?? '')).error ?? reason } catch {}
        if (/insufficient_balance/.test(reason)) reason = 'saldo USDC Base Sepolia tidak cukup di wallet ini (insufficient_balance)'
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

  // [tab]: ambil run orang lain yang sedang berjalan. Waktu tunggumu memperbaiki hasil mereka.
  const helpOther = useCallback(async () => {
    if (otherRef.current) return setOther(null)
    const r = await fetch(`/api/others?exclude=${runIdRef.current}`)
    if (!r.ok) return flash('tidak ada run lain yang sedang berjalan', 2500)
    setOther(await r.json())
  }, [flash])

  // ponytail: poll 2 detik selama panel terbuka. SSE per pohon kalau ini jadi fitur utama.
  const otherId = other?.runId
  useEffect(() => {
    if (!otherId) return
    const i = setInterval(async () => {
      const r = await fetch(`/api/others?runId=${otherId}`)
      const j = r.ok ? await r.json() : null
      if (!j || j.done) { setOther(null); flash('run mereka selesai', 2500); return }
      setOther(j)
    }, 2000)
    return () => clearInterval(i)
  }, [otherId, flash])

  // Hotkey: baris angka kill · shift+angka pin · space ask · y/n jawab · esc collapse
  //         f fork · enter bayar · tab bantu orang lain · d diff
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Escape') return setCollapsed((c) => !c)
      if (e.key === 'Tab') { e.preventDefault(); return helpOther() }
      if (e.key === 'f') return fork()
      if (e.key === 'd') return setShowDiff((s) => !s)
      if (e.key === 'Enter') return locked.count > 0 ? unlock() : undefined
      if (e.key === ' ') {
        e.preventDefault()
        const next = divsRef.current.find((d) => d.id !== askRef.current)
        return setAsk((a) => (a ? null : next?.id ?? null))
      }
      if ((e.key === 'y' || e.key === 'n') && askRef.current) {
        steer(askRef.current, e.key === 'y' ? 0 : 1, 'pin')
        return setAsk(null)
      }
      // e.code, bukan e.key: shift+1 menghasilkan '!' di e.key.
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
    setStatus('running'); setOut(''); setDivs([]); setActions({}); setCommitted({})
    setResult(null); setCollapsed(false); setAsk(null); setLate(null); setLocked({ count: 0, price: '$0.01' })
    setErrors([]); setDiff(''); setShowDiff(false); setPrefetched([]); setActivity(''); setEta(0); setScanNote('')
    setOpenReady(null)
    startRef.current = Date.now()
    ;(document.activeElement as HTMLElement | null)?.blur()   // supaya hotkey tidak mengetik ke input

    const res = await fetch('/api/run', { method: 'POST', body: JSON.stringify({ prompt }) })
    if (!res.ok) {
      setErrors([(await res.json().catch(() => ({ error: `HTTP ${res.status}` }))).error])
      return setStatus('done')
    }
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
          if (e.skipped) setScanNote(`wait diperkirakan ${e.etaSeconds}s · terlalu pendek untuk panel`)
          else if (!e.divergences.length) setScanNote('tidak ada keputusan nyata di prompt ini · panel diam')
        }
        if (e.type === 'text') setOut((o) => o + e.delta)
        if (e.type === 'tool') setActivity(
          e.name === 'read' ? `reading ${e.path}`
          : e.name === 'write' ? `writing ${e.path} (${e.lines} lines)`
          : e.name === 'search' ? `searching the web: ${e.path}`
          : e.name === 'market' ? `fetching market data: ${e.path}`
          : e.name === 'paid' ? `buying via x402: ${e.path}`
          : `${e.name} ${e.path}`)
        if (e.type === 'paid') flash(`x402 paid · ${e.url} · tx ${(e.receipt?.transaction ?? '').slice(0, 10)}…`, 5000)
        if (e.type === 'step') setActivity((a) => a || `step ${e.n}`)
        if (e.type === 'commit') setCommitted((c) => ({ ...c, [e.divergenceId]: e.branchIdx }))
        if (e.type === 'applied') flash(`applied: ${e.constraints.join(' / ')}`)
        if (e.type === 'prefetch' && e.status === 'done') setPrefetched((p) => [...p, e.label])
        if (e.type === 'error') setErrors((x) => [...x, e.message])
        if (e.type === 'patch') { setDiff(e.diff ?? ''); setActivity(e.diff ? 'diff ready · [d] show' : '') }
        if (e.type === 'done') { setResult({ calibration: e.calibration, prefetch: e.prefetch, elapsedMs: e.elapsedMs }); setStatus('done') }
      }
    }
  }

  const secs = (t / 1000).toFixed(1)
  const lastKey = KEY_LABELS[Math.max(0, divs.length * 2 - 1)]
  const diffStat = diff ? `${(diff.match(/^\+[^+]/gm) ?? []).length}+ ${(diff.match(/^-[^-]/gm) ?? []).length}- · ${(diff.match(/^diff --git/gm) ?? []).length} files` : ''

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 font-mono p-6 md:p-10">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="flex items-baseline gap-3 text-[13px]">
          <span className="text-neutral-100 tracking-widest">SIMPANG</span>
          <span className="text-neutral-600">kamu yang memilih arah di tiap simpang</span>
          <span className="ml-auto tabular-nums text-neutral-500" data-testid="clock">
            {status === 'idle' ? '--:--' : `${secs}s`}
            {eta > 0 && status === 'running' && <span className="text-neutral-700"> / ~{eta}s est</span>}
          </span>
        </header>

        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && status !== 'running' && go()}
            data-testid="prompt"
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-[13px] outline-none focus:border-neutral-600"
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
              locked={{ count: 0, price: '' }} ask={null} onAsk={() => {}}
            />
          </div>
        )}

        {divs.length > 0 && !collapsed && !other && (
          <>
            <Tree
              divergences={divs} actions={actions} committed={committed}
              locked={locked} ask={ask} wallet={wallet}
              onAsk={(id, idx) => { steer(id, idx, 'pin'); setAsk(null) }}
            />
            <div className="text-[11px] text-neutral-600" data-testid="legend">
              {ask
                ? '[y] pilih kiri · [n] pilih kanan · [space] tutup'
                : `[1-${lastKey}] kill · [⇧1-${lastKey}] pin · [space] ask · [esc] ignore · [tab] help someone`}
              {late && <span className="text-amber-300"> · [f] fork koreksi</span>}
              {diff && <span> · [d] diff</span>}
            </div>
          </>
        )}
        {divs.length > 0 && collapsed && (
          <div className="text-[12px] text-neutral-600" data-testid="collapsed">
            {divs.length} decisions hidden · [esc] show
          </div>
        )}

        {status === 'running' && activity && (
          <div className="text-[12px] text-neutral-500" data-testid="activity">
            <span className="animate-pulse">●</span> {activity}
            {prefetched.length > 0 && <span className="text-emerald-700"> · {prefetched.length} follow-up siap</span>}
          </div>
        )}

        {errors.length > 0 && (
          <div className="border border-red-900/60 rounded p-3 text-[12px] text-red-300 space-y-1" data-testid="error">
            {errors.map((e, i) => <div key={i}>✗ {e}</div>)}
          </div>
        )}

        {out && (
          <pre className="whitespace-pre-wrap text-[13px] text-neutral-400 border border-neutral-900 rounded p-3" data-testid="output">
            {out}
            {status === 'running' && <span className="animate-pulse">▋</span>}
          </pre>
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
              {result.prefetch.length ? 'prefetched · siap sekarang' : 'selesai'}
            </div>
            {result.prefetch.map((p, i) => (
              <div key={i}>
                <button onClick={() => setOpenReady(openReady === i ? null : i)} className="text-neutral-400 hover:text-neutral-200 text-left">
                  {openReady === i ? '▾' : '▸'} {p.label}
                </button>
                {openReady === i && (
                  <pre className="whitespace-pre-wrap text-[12px] text-neutral-500 border border-neutral-900 rounded p-2 mt-1">{p.text}</pre>
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-[12px] text-neutral-300" data-testid="toast">
          {toast}
        </div>
      )}
    </main>
  )
}
