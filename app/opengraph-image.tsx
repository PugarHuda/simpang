import { ImageResponse } from 'next/og'

// Generated, not a checked-in PNG: the card can never drift from the copy beside it.
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'SIMPANG — you pick the direction at every fork'

export default function OpengraphImage() {
  const mono = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, monospace'
  const Row = ({ label, pct, dim }: { label: string; pct: number; dim?: boolean }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontSize: 30, color: dim ? '#3f3f46' : '#d4d4d8',
      textDecoration: dim ? 'line-through' : 'none' }}>
      <span style={{ color: '#52525b', width: 26 }}>⑂</span>
      <span style={{ width: 430 }}>{label}</span>
      <span style={{ color: dim ? '#3f3f46' : '#fbbf24' }}>{'▓'.repeat(Math.round(pct * 6))}{'░'.repeat(6 - Math.round(pct * 6))}</span>
      <span style={{ color: '#52525b' }}>{Math.round(pct * 100)}%</span>
    </div>
  )
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center',
        background: '#0a0a0a', color: '#e5e5e5', fontFamily: mono, padding: '0 88px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 28 }}>
          <span style={{ fontSize: 60, letterSpacing: 10, color: '#fafafa' }}>SIMPANG</span>
          <span style={{ fontSize: 28, color: '#71717a' }}>you pick the direction at every fork</span>
        </div>
        <div style={{ fontSize: 34, color: '#a1a1aa', margin: '30px 0 44px', lineHeight: 1.4, display: 'flex' }}>
          While the agent thinks, you are its branch predictor.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, borderLeft: '3px solid #27272a', paddingLeft: 34 }}>
          <Row label="redis, new dependency" pct={0.62} dim />
          <Row label="postgres table" pct={0.38} />
        </div>
        <div style={{ fontSize: 26, color: '#fbbf24', marginTop: 46, display: 'flex' }}>
          kill a branch → injected at the agent&apos;s next tool call, mid-run
        </div>
      </div>
    ),
    size,
  )
}
