'use client'
import type { Divergence } from '@/lib/divergence'

export type Act = { verb: 'kill' | 'pin'; branchIdx: number }

/** Label tombol per cabang, urut baris angka fisik: 12 tombol = 6 divergensi x 2 cabang. */
export const KEY_LABELS = '1234567890-='.split('')

export function Tree({
  divergences, actions, committed, notes = {}, locked, ask, onAsk, onSteer, onPay, wallet,
}: {
  divergences: Divergence[]
  actions: Record<string, Act>
  committed: Record<string, number>
  notes?: Record<string, string>          // divergenceId -> alasan agent saat commit
  locked: { count: number; price: string }
  ask: string | null
  onAsk: (id: string, branchIdx: number) => void
  onSteer: (id: string, branchIdx: number, verb: 'kill' | 'pin') => void
  onPay?: () => void
  wallet?: boolean
}) {
  return (
    <div className="border border-neutral-800 rounded-md text-[13px] leading-6" data-testid="tree">
      {divergences.map((d, di) => {
        const act = actions[d.id]
        const done = committed[d.id]
        const asking = ask === d.id
        return (
          <div key={d.id} className="border-b border-neutral-900 last:border-0 px-3 py-2" data-testid={`div-${d.id}`}>
            <div className="flex items-baseline gap-2 text-neutral-500">
              <span className="text-neutral-600">⑂</span>
              <span className="text-neutral-300">{d.axis}</span>
              <span className="ml-auto text-[11px]" data-testid={`status-${d.id}`}>
                {done !== undefined ? 'resolved' : act ? (act.verb === 'kill' ? 'killed · waiting' : 'pinned · waiting') : '2 futures'}
              </span>
            </div>

            {asking ? (
              <div className="mt-1 pl-4" data-testid="ask">
                <div className="text-amber-300">{d.question}</div>
                <div className="mt-1 flex gap-4 text-[12px]">
                  <button onClick={() => onAsk(d.id, 0)} className="text-neutral-300 hover:text-white">
                    [y] {d.branches[0].label}
                  </button>
                  <button onClick={() => onAsk(d.id, 1)} className="text-neutral-300 hover:text-white">
                    [n] {d.branches[1].label}
                  </button>
                </div>
              </div>
            ) : (
              d.branches.map((b, bi) => {
                const key = KEY_LABELS[di * 2 + bi]
                const killed = act?.verb === 'kill' && act.branchIdx === bi
                const pinned = act?.verb === 'pin' && act.branchIdx === bi
                const lost = done !== undefined && done !== bi
                const won = done === bi
                const state = won ? 'won' : lost ? 'lost' : killed ? 'killed' : pinned ? 'pinned' : 'open'
                return (
                  <div
                    key={bi}
                    data-testid={`branch-${d.id}-${bi}`}
                    data-state={state}
                    title={b.sketch}
                    // Klik = kill, shift+klik = pin: HP dan trackpad tidak punya baris angka.
                    onClick={(e) => { if (state === 'open' || state === 'killed' || state === 'pinned') onSteer(d.id, bi, e.shiftKey ? 'pin' : 'kill') }}
                    className={[
                      'group pl-4 pr-1 flex items-baseline gap-3 transition-all duration-500 rounded cursor-pointer hover:bg-neutral-900/60',
                      killed || lost ? 'opacity-25 line-through' : '',
                      pinned ? 'text-emerald-300' : 'text-neutral-400',
                      won ? 'text-emerald-400' : '',
                    ].join(' ')}
                  >
                    <span className="text-neutral-700 w-4">{key}</span>
                    <span className="w-44 md:w-52 truncate text-neutral-200">{b.label}</span>
                    <span className="hidden sm:inline w-20 tabular-nums text-neutral-600">{b.filesTouched > 0 ? `~${b.filesTouched} files` : ''}</span>
                    <span className="hidden sm:inline w-14 tabular-nums text-neutral-600">{b.costUsd > 0 ? `$${b.costUsd.toFixed(2)}` : ''}</span>
                    <Bar v={b.confidence} />
                    <span className="hidden md:block flex-1 truncate text-neutral-600">{b.sketch}</span>
                    {state !== 'won' && state !== 'lost' && (
                      <span className="ml-auto flex gap-1 text-[11px] md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        <button
                          data-testid={`kill-${d.id}-${bi}`} aria-label={`kill ${b.label}`}
                          onClick={(e) => { e.stopPropagation(); onSteer(d.id, bi, 'kill') }}
                          className="px-1.5 border border-neutral-800 rounded text-neutral-400 hover:text-red-300 hover:border-red-900"
                        >kill</button>
                        <button
                          data-testid={`pin-${d.id}-${bi}`} aria-label={`pin ${b.label}`}
                          onClick={(e) => { e.stopPropagation(); onSteer(d.id, bi, 'pin') }}
                          className="px-1.5 border border-neutral-800 rounded text-neutral-400 hover:text-emerald-300 hover:border-emerald-900"
                        >pin</button>
                      </span>
                    )}
                  </div>
                )
              })
            )}
            {notes[d.id] && done !== undefined && (
              <div className="pl-8 text-[11px] text-neutral-600 truncate" data-testid={`why-${d.id}`} title={notes[d.id]}>
                ↳ {notes[d.id]}
              </div>
            )}
          </div>
        )
      })}

      {locked.count > 0 && (
        <button
          onClick={onPay}
          data-testid="paywall"
          className="w-full text-left px-3 py-2 border-t border-neutral-900 text-[12px] text-neutral-500 hover:bg-neutral-900/60"
        >
          {locked.count} futures lagi · {locked.price} USDC per cabang ·{' '}
          <span className="text-neutral-300">[enter] bayar via x402</span>
          {wallet === false && <span className="text-amber-400"> · butuh wallet EVM di browser</span>}
          <span className="text-neutral-700"> · [esc] lanjut dengan {divergences.length}</span>
        </button>
      )}
    </div>
  )
}

function Bar({ v }: { v: number }) {
  const n = Math.round(v * 6)
  return (
    <span className="tabular-nums text-neutral-600 shrink-0">
      <span className="text-neutral-400">{'▓'.repeat(n)}</span>
      {'░'.repeat(6 - n)} {Math.round(v * 100)}%
    </span>
  )
}
