import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

export const MODEL_PRICING = {
  'claude-sonnet-4-6':         { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-6':           { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
}
const DEFAULT_P    = MODEL_PRICING['claude-sonnet-4-6']
export const S_MILESTONES = [1, 3, 7, 15]
export const ALL_TIERS = ['L1','L2','L3','L4','H1','H2','H3','H4','S1','S2','S3','S4','C']

export const TIER_META = {
  L1: { label: 'Light I',    desc: '< $0.005',   color: '#4ade80' },
  L2: { label: 'Light II',   desc: '$0.005–0.015',color: '#4ade80' },
  L3: { label: 'Light III',  desc: '$0.015–0.04', color: '#a3e635' },
  L4: { label: 'Light IV',   desc: '$0.04–0.08',  color: '#a3e635' },
  H1: { label: 'Heavy I',    desc: '$0.08–0.15',  color: '#f59e0b' },
  H2: { label: 'Heavy II',   desc: '$0.15–0.30',  color: '#f59e0b' },
  H3: { label: 'Heavy III',  desc: '$0.30–0.60',  color: '#f97316' },
  H4: { label: 'Heavy IV',   desc: '$0.60+',      color: '#f97316' },
  S1: { label: 'Special I',  desc: 'Milestone $1', color: '#c9a227' },
  S2: { label: 'Special II', desc: 'Milestone $3', color: '#c9a227' },
  S3: { label: 'Special III',desc: 'Milestone $7', color: '#ef4444' },
  S4: { label: 'Special IV', desc: 'Milestone $15',color: '#ef4444' },
  C:  { label: 'Settlement', desc: 'Session done', color: '#a78bfa' },
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function normPath(p) {
  return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
}

export function computeDeltaCost(model, usage) {
  const p = MODEL_PRICING[model] ?? DEFAULT_P
  return (
    (usage.input_tokens                ?? 0) * p.input      +
    (usage.output_tokens               ?? 0) * p.output     +
    (usage.cache_read_input_tokens     ?? 0) * p.cacheRead  +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite
  ) / 1e6
}

export function classifyTier(delta) {
  if (delta < 0.005)  return { tier: 'L', level: 1 }
  if (delta < 0.015)  return { tier: 'L', level: 2 }
  if (delta < 0.04)   return { tier: 'L', level: 3 }
  if (delta < 0.08)   return { tier: 'L', level: 4 }
  if (delta < 0.15)   return { tier: 'H', level: 1 }
  if (delta < 0.30)   return { tier: 'H', level: 2 }
  if (delta < 0.60)   return { tier: 'H', level: 3 }
  return { tier: 'H', level: 4 }
}

export function tierKey(tier, level) {
  return level != null ? `${tier}${level}` : tier
}

export function fmtCost(usd) {
  if (usd == null || isNaN(usd)) return null
  if (usd >= 10)    return `$${usd.toFixed(2)}`
  if (usd >= 1)     return `$${usd.toFixed(3)}`
  if (usd >= 0.001) return `$${usd.toFixed(4)}`
  return usd > 0 ? '<$0.001' : '$0.0000'
}

function fmtTok(n) {
  n = n ?? 0
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

// ─── useCostEngine ────────────────────────────────────────────────────────────

export function useCostEngine(streamEvents, onAnimate) {
  const cbRef  = useRef(onAnimate)
  const data   = useRef({})   // { [normProjectPath]: CostData }
  const lastEv = useRef(null)
  const [snap, setSnap] = useState({})

  // Keep callback ref fresh
  useEffect(() => { cbRef.current = onAnimate })

  useEffect(() => {
    if (!streamEvents.length) return
    const ev = streamEvents[streamEvents.length - 1]
    if (ev === lastEv.current) return
    lastEv.current = ev

    // ── Helper: process a single assistant event object ──────────────────
    function processAssistant(event, key) {
      const model = event.message?.model
      const usage = event.message?.usage
      if (!usage) return
      if (!data.current[key]) {
        data.current[key] = {
          total: 0, byModel: {},
          byType: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          milestonesFired: new Set(),
        }
      }
      const d     = data.current[key]
      const delta = computeDeltaCost(model ?? '', usage)
      d.total            += delta
      d.byType.input     += usage.input_tokens                ?? 0
      d.byType.output    += usage.output_tokens               ?? 0
      d.byType.cacheRead += usage.cache_read_input_tokens     ?? 0
      d.byType.cacheWrite+= usage.cache_creation_input_tokens ?? 0
      const mn = model ?? 'unknown'
      if (!d.byModel[mn]) d.byModel[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      d.byModel[mn].input      += usage.input_tokens                ?? 0
      d.byModel[mn].output     += usage.output_tokens               ?? 0
      d.byModel[mn].cacheRead  += usage.cache_read_input_tokens     ?? 0
      d.byModel[mn].cacheWrite += usage.cache_creation_input_tokens ?? 0
      d.byModel[mn].cost       += delta

      let sTiered = false
      for (let i = S_MILESTONES.length - 1; i >= 0; i--) {
        const m = S_MILESTONES[i]
        if (d.total >= m && !d.milestonesFired.has(m)) {
          d.milestonesFired.add(m)
          cbRef.current({ tier: 'S', level: i + 1, delta, total: d.total, key })
          sTiered = true
          break
        }
      }
      if (!sTiered) {
        const t = classifyTier(delta)
        cbRef.current({ ...t, delta, total: d.total, key })
      }
      setSnap(prev => ({
        ...prev,
        [key]: { total: d.total, byModel: { ...d.byModel }, byType: { ...d.byType } },
      }))
    }

    // ── claude_stream (subprocess / Chat panel) ──────────────────────────
    if (ev.type === 'claude_stream') {
      const { event, projectPath } = ev
      const key = normPath(projectPath)
      if (event?.type === 'assistant') processAssistant(event, key)
      if (event?.type === 'result') {
        const d = data.current[key]
        if (d?.total > 0) cbRef.current({ tier: 'C', level: null, delta: 0, total: d.total, key })
      }
    }

    // ── session_live (VS Code live tail) ─────────────────────────────────
    if (ev.type === 'session_live') {
      const key = `session:${ev.sessionId}`   // keyed by sessionId
      for (const msg of ev.messages ?? []) {
        if (msg.type === 'assistant') processAssistant(msg, key)
      }
    }
  }, [streamEvents])

  return snap
}

// ─── AnimatedNumber ───────────────────────────────────────────────────────────

function AnimatedNumber({ to, duration = 1500, decimals = 4 }) {
  const [val, setVal] = useState(0)
  const raf = useRef(null)
  useEffect(() => {
    const t0 = performance.now()
    function tick(now) {
      const t     = Math.min(1, (now - t0) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setVal(to * eased)
      if (t < 1) raf.current = requestAnimationFrame(tick)
      else setVal(to)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [to, duration])
  return <span>${val.toFixed(decimals)}</span>
}

// ─── PieChart ─────────────────────────────────────────────────────────────────

const TOKEN_COLORS = {
  output:     '#c9a227',
  input:      '#60a5fa',
  cacheRead:  '#4ade80',
  cacheWrite: '#a78bfa',
}
export const MODEL_COLORS = ['#c9a227', '#60a5fa', '#4ade80', '#f97316', '#a78bfa', '#fb7185']

function PieChart({ slices, size = 88 }) {
  const pos   = slices.filter(s => s.value > 0)
  const total = pos.reduce((s, x) => s + x.value, 0)
  if (!total) return (
    <div style={{ width: size, height: size }}
      className="rounded-full bg-[var(--surface-2)] border border-[var(--border)] shrink-0" />
  )
  const cx = size / 2, cy = size / 2, r = size * 0.43
  // SVG arc degenerates when start === end (full circle). Handle single-slice specially.
  if (pos.length === 1) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill={pos[0].color} />
      </svg>
    )
  }
  let a = -Math.PI / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      {pos.map((sl, i) => {
        const sw = (sl.value / total) * 2 * Math.PI
        const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a)
        a += sw
        const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a)
        return (
          <path key={i}
            d={`M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${sw > Math.PI ? 1 : 0},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`}
            fill={sl.color} stroke="var(--bg)" strokeWidth="1.5" />
        )
      })}
    </svg>
  )
}

// ─── ContractModal ────────────────────────────────────────────────────────────

export function ContractModal({ sessionName, costData, onClose }) {
  if (!costData) return null
  const { total = 0, byType = {}, byModel = {} } = costData

  const typeSlices = [
    { label: 'Output',      value: byType.output     ?? 0, color: TOKEN_COLORS.output },
    { label: 'Cache Read',  value: byType.cacheRead  ?? 0, color: TOKEN_COLORS.cacheRead },
    { label: 'Input',       value: byType.input      ?? 0, color: TOKEN_COLORS.input },
    { label: 'Cache Write', value: byType.cacheWrite ?? 0, color: TOKEN_COLORS.cacheWrite },
  ]
  const modelSlices = Object.entries(byModel).map(([m, u], i) => ({
    label: m.replace('claude-', '').replace('-20251001', ''),
    value: u.cost ?? 0,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }))

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overlay-in overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.88)', paddingTop: 'max(env(safe-area-inset-top), 1rem)', paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      onClick={onClose}>
      <div className="relative w-full max-w-md mx-4 my-auto bg-[var(--surface)] border border-[var(--gold-border)] rounded-sm
        shadow-[0_0_60px_rgba(201,162,39,0.12)]"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 pt-5 pb-3 text-center border-b border-[var(--gold-border)]/40">
          <div className="text-[8px] text-[var(--gold)]/50 tracking-[0.35em] uppercase mb-1">─── The Continental ───</div>
          <div className="text-[10px] text-[var(--gold)] tracking-[0.2em] uppercase font-semibold">Contract Ledger</div>
          <div className="text-xs text-[var(--text-h)] mt-1 truncate">{sessionName}</div>
        </div>

        {/* Pie charts */}
        <div className="flex gap-3 px-5 py-4">
          {[
            { title: 'Usage Type', slices: typeSlices, fmt: v => fmtTok(v) },
            { title: 'By Model',   slices: modelSlices, fmt: v => fmtCost(v) ?? '$0.0000' },
          ].map(({ title, slices, fmt }) => (
            <div key={title} className="flex-1 min-w-0">
              <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-wider mb-2 text-center">{title}</div>
              <div className="flex flex-col items-center gap-2">
                <PieChart slices={slices} size={84} />
                <div className="w-full space-y-1">
                  {slices.filter(s => s.value > 0).map(s => (
                    <div key={s.label} className="flex items-center gap-1.5 text-[9px]">
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: s.color }} />
                      <span className="text-[var(--text-muted)] flex-1 truncate">{s.label}</span>
                      <span className="tabular-nums text-[var(--gold)]">{fmt(s.value)}</span>
                    </div>
                  ))}
                  {slices.filter(s => s.value > 0).length === 0 && (
                    <div className="text-[9px] text-[var(--text-muted)] text-center">Accumulating…</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Token breakdown */}
        <div className="px-5 pt-3 pb-3 border-t border-[var(--border)]">
          <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-wider mb-2">Token Breakdown</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {[
              ['Output',      byType.output,     TOKEN_COLORS.output],
              ['Cache Read',  byType.cacheRead,  TOKEN_COLORS.cacheRead],
              ['Input',       byType.input,      TOKEN_COLORS.input],
              ['Cache Write', byType.cacheWrite, TOKEN_COLORS.cacheWrite],
            ].map(([l, v, c]) => (
              <div key={l} className="flex items-center gap-1.5 text-[9px]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c }} />
                <span className="text-[var(--text-muted)]">{l}</span>
                <span className="ml-auto tabular-nums font-mono text-[var(--text)]">{fmtTok(v)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Exchange rates */}
        <div className="px-5 pt-3 pb-3 border-t border-[var(--border)]">
          <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-wider mb-2">Exchange Rates — per 1M tokens</div>
          <div className="space-y-1.5">
            {Object.entries(MODEL_PRICING).map(([m, p]) => (
              <div key={m} className="flex items-center gap-2 text-[9px]">
                <span className="text-[var(--text-muted)] flex-1 truncate">{m.replace('claude-', '').replace('-20251001', '')}</span>
                <span className="text-[var(--text)] tabular-nums shrink-0 font-mono">
                  in ${p.input} · out ${p.output} · cr ${p.cacheRead}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Total */}
        <div className="px-5 py-4 border-t border-[var(--gold-border)]/50 flex items-center justify-between bg-[var(--gold-dim)] rounded-b-sm">
          <span className="text-[9px] text-[var(--gold)]/60 uppercase tracking-[0.2em]">Total Bounty</span>
          <span className="text-xl font-bold text-[var(--gold)] tabular-nums">{fmtCost(total) ?? '$0.0000'}</span>
        </div>

        <button onClick={onClose}
          className="absolute top-3 right-3 text-[var(--text-muted)] hover:text-[var(--text)] text-xs p-1">✕</button>
      </div>
    </div>
  )
}

// ─── GoldParticles ────────────────────────────────────────────────────────────

function GoldParticles({ count = 30 }) {
  const ps = useRef(
    Array.from({ length: count }, () => ({
      left:     `${(Math.random() * 100).toFixed(1)}%`,
      size:     `${(3 + Math.random() * 7).toFixed(1)}px`,
      delay:    `${(Math.random() * 2).toFixed(2)}s`,
      duration: `${(2 + Math.random() * 3).toFixed(2)}s`,
      opacity:  (0.4 + Math.random() * 0.6).toFixed(2),
    }))
  ).current
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {ps.map((p, i) => (
        <div key={i} className="absolute rounded-sm"
          style={{
            left: p.left, top: '-60px', width: p.size, height: p.size,
            background: `rgba(201,162,39,${p.opacity})`,
            animation: `gold-particle-fall ${p.duration} ${p.delay} linear forwards`,
          }} />
      ))}
    </div>
  )
}

// ─── useAudio (play audio file for a tier) ────────────────────────────────────

function useAudio(tierCode, settings, phase) {
  const audioRef = useRef(null)
  useEffect(() => {
    const cfg = settings[tierCode]
    if (!cfg) return
    // Determine if audio should play
    let shouldPlay = false
    let src = null
    if (cfg.mediaType === 'video') {
      if (cfg.audioMode === 'custom') { shouldPlay = true; src = `/api/bounty/asset/${tierCode}/audio` }
      // 'video' mode: audio is handled by the <video> element
    } else {
      if (cfg.audioEnabled) { shouldPlay = true; src = `/api/bounty/asset/${tierCode}/audio` }
    }
    if (!shouldPlay || !src || phase !== 'in') return
    const a = new Audio(src)
    a.volume = 0.8
    a.play().catch(() => {})
    audioRef.current = a
    return () => { try { a.pause(); a.src = '' } catch {} }
  }, [tierCode, phase])
}

// ─── Custom Media Overlay ─────────────────────────────────────────────────────

function CustomMediaOverlay({ tierCode, cfg, onDone, children }) {
  const { mediaType, imageDuration = 3, audioMode } = cfg
  const [phase, setPhase] = useState('in')

  useAudio(tierCode, { [tierCode]: cfg }, phase)

  useEffect(() => {
    if (mediaType === 'image') {
      const dur = imageDuration * 1000
      const t1  = setTimeout(() => setPhase('out'), dur - 400)
      const t2  = setTimeout(onDone, dur)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
    // Video: onDone called by onEnded event
  }, [mediaType, imageDuration])

  const fadeClass = `transition-opacity duration-500 ${phase === 'out' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`

  if (mediaType === 'image') return (
    <div className={`fixed inset-0 z-[65] flex items-center justify-center overlay-in ${fadeClass}`}
      style={{ background: '#000' }}>
      <img
        src={`/api/bounty/asset/${tierCode}/media`}
        alt=""
        className="max-w-full max-h-full object-contain"
        style={{ imageRendering: 'pixelated' }}
      />
      {children}
    </div>
  )

  if (mediaType === 'video') return (
    <div className={`fixed inset-0 z-[65] flex items-center justify-center overlay-in ${fadeClass}`}
      style={{ background: '#000' }}>
      <video
        src={`/api/bounty/asset/${tierCode}/media`}
        autoPlay
        muted={audioMode === 'custom'}
        className="max-w-full max-h-full object-contain"
        onEnded={onDone}
      />
      {audioMode === 'custom' && (
        <audio src={`/api/bounty/asset/${tierCode}/audio`} autoPlay />
      )}
    </div>
  )

  return null
}

// ─── Default Overlays ─────────────────────────────────────────────────────────

function DefaultOverlay({ anim, settings, onDone }) {
  const { tier, level, delta, total } = anim
  const tk = tierKey(tier, level)
  const [phase,   setPhase]   = useState('in')
  const [shaking, setShaking] = useState(false)
  const [stamp,   setStamp]   = useState(false)
  const [revealN, setRevealN] = useState(0)

  useAudio(tk, settings, phase)

  useEffect(() => {
    const T = []
    const t = (fn, ms) => { const id = setTimeout(fn, ms); T.push(id) }
    if (tier === 'H') {
      const durs = { 2: 4000, 3: 5000, 4: 3500 }
      const dur  = durs[level] ?? 4000
      t(() => setPhase('out'), dur - 450)
      t(onDone, dur)
    }
    if (tier === 'S') {
      if (level === 3) t(() => setShaking(true), 350)
      if (level < 4) {
        const durs = { 1: 5500, 2: 6500, 3: 7500 }
        t(() => setPhase('out'), durs[level] - 500)
        t(onDone, durs[level])
      }
    }
    if (tier === 'C') {
      t(() => setRevealN(1), 250)
      t(() => setRevealN(2), 600)
      t(() => setRevealN(3), 1050)
      t(() => setRevealN(4), 1500)
      t(() => setStamp(true), 2300)
      const big = total >= 0.5
      if (!big) { t(() => setPhase('out'), 5000); t(onDone, 5500) }
      else       { t(() => setRevealN(5), 2800); t(() => setPhase('out'), 8500); t(onDone, 9000) }
    }
    return () => T.forEach(clearTimeout)
  }, [])

  const fade = `transition-opacity duration-500 ${phase === 'out' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`

  if (tier === 'H' && level === 2) return (
    <div className={`fixed top-0 left-0 right-0 z-[65] flex items-center justify-center gap-6 px-4 py-3
      bg-[var(--bg)] border-b border-[var(--gold-border)] banner-drop ${fade}`}>
      <span className="text-[7px] text-[var(--gold)]/50 tracking-[0.3em] uppercase shrink-0">— Bounty Increased —</span>
      <span className="text-xl font-bold text-[var(--gold)] tabular-nums">+{fmtCost(delta)}</span>
      <span className="text-[10px] text-[var(--text-muted)] shrink-0">Contract: {fmtCost(total)}</span>
    </div>
  )

  if (tier === 'H' && level === 3) return (
    <div className={`fixed bottom-0 left-0 right-0 z-[65] h-2/5 flex flex-col items-center justify-center gap-3
      border-t border-[var(--gold-border)] overlay-in ${fade}`}
      style={{ background: 'linear-gradient(to top,rgba(0,0,0,0.97),rgba(13,14,19,0.93))' }}>
      <div className="text-[7px] text-[var(--gold)]/50 tracking-[0.3em] uppercase">— Bounty Increased —</div>
      <div className="text-4xl font-bold text-[var(--gold)] tabular-nums">+{fmtCost(delta)}</div>
      <div className="text-[11px] text-[var(--text-muted)]">Contract: <span className="text-[var(--gold)]">{fmtCost(total)}</span></div>
      <div className="text-3xl text-[var(--gold)]/50 mt-1">🏛</div>
    </div>
  )

  if (tier === 'H' && level === 4) return (
    <div className={`fixed inset-0 z-[65] flex flex-col items-center justify-center gap-3 overlay-in ${fade}`}
      style={{ background: 'rgba(0,0,0,0.93)' }}>
      <div className="text-[7px] text-[var(--gold)]/50 tracking-[0.35em] uppercase mb-3">— The Continental —</div>
      <div className="text-[11px] text-[var(--gold)]/70 tracking-widest uppercase mb-1">Contract Amended</div>
      <div className="text-5xl font-bold text-[var(--gold)] tabular-nums">+{fmtCost(delta)}</div>
    </div>
  )

  if (tier === 'S' && level === 1) return (
    <div className={`fixed inset-0 z-[65] flex flex-col items-center justify-center gap-4 overlay-in ${fade}`}
      style={{ background: 'rgba(0,0,0,0.95)' }}>
      <div className="text-[7px] text-[var(--gold)]/40 tracking-[0.35em] uppercase">— The High Table —</div>
      <div className="text-[11px] text-[var(--gold)]/80 tracking-[0.2em] uppercase">Marker Registered</div>
      <div className="text-6xl font-bold text-[var(--gold)] tabular-nums"><AnimatedNumber to={total} /></div>
      <div className="text-[9px] text-[var(--text-muted)] tracking-widest uppercase">Milestone: ${S_MILESTONES[0]} reached</div>
    </div>
  )

  if (tier === 'S' && level === 2) return (
    <div className={`fixed inset-0 z-[65] flex flex-col items-center justify-center gap-4 overlay-in ${fade}`}
      style={{ background: 'rgba(0,0,0,0.95)' }}>
      <GoldParticles count={40} />
      <div className="relative z-10 flex flex-col items-center gap-4">
        <div className="text-[7px] text-[var(--gold)]/40 tracking-[0.35em] uppercase">— The High Table —</div>
        <div className="text-[12px] text-[var(--gold)] tracking-[0.2em] uppercase font-semibold">Contract Value Rising</div>
        <div className="text-6xl font-bold text-[var(--gold)] tabular-nums"><AnimatedNumber to={total} duration={2000} /></div>
        <div className="text-[9px] text-[var(--text-muted)] tracking-widest uppercase">Milestone: ${S_MILESTONES[1]} reached</div>
      </div>
    </div>
  )

  if (tier === 'S' && level === 3) return (
    <div className={`fixed inset-0 z-[65] flex flex-col items-center justify-center gap-4 overlay-in ${shaking ? 'screen-shake' : ''} ${fade}`}
      style={{ background: 'rgba(0,0,0,0.96)' }}>
      <GoldParticles count={20} />
      <div className="relative z-10 flex flex-col items-center gap-4">
        <div className="text-[7px] text-red-400/60 tracking-[0.35em] uppercase">— Marker Called —</div>
        <div className="text-[12px] text-red-400 tracking-[0.15em] uppercase font-semibold">A Marker Has Been Called</div>
        <div className="text-7xl font-bold text-[var(--gold)] tabular-nums"><AnimatedNumber to={total} duration={2000} /></div>
        <div className="text-[9px] text-[var(--text-muted)] tracking-widest uppercase">Milestone: ${S_MILESTONES[2]} reached</div>
      </div>
    </div>
  )

  if (tier === 'S' && level === 4) return (
    <div className={`fixed inset-0 z-[65] flex flex-col items-center justify-center gap-4 overlay-in ${fade}`}
      style={{ background: 'rgba(0,0,0,0.97)' }}>
      <GoldParticles count={60} />
      <div className="relative z-10 flex flex-col items-center gap-4 text-center px-4">
        <div className="text-[7px] text-red-400/60 tracking-[0.35em] uppercase mb-2">— The High Table Acknowledges —</div>
        <div className="text-xl text-[var(--gold)] font-bold tracking-[0.1em] uppercase">Blood Oath</div>
        <div className="text-[10px] text-[var(--text-muted)] max-w-xs">This contract carries the full weight of The Continental.</div>
        <div className="text-7xl font-bold text-[var(--gold)] tabular-nums my-3"><AnimatedNumber to={total} duration={2500} /></div>
        <button onClick={onDone}
          className="mt-2 px-8 py-3 border border-[var(--gold)] text-[var(--gold)] text-[10px] tracking-[0.25em] uppercase rounded-sm hover:bg-[var(--gold-dim)] transition-colors">
          Acknowledge
        </button>
      </div>
    </div>
  )

  if (tier === 'C') return (
    <div className={`fixed inset-0 z-[65] flex items-center justify-center overlay-in ${fade}`}
      style={{ background: 'rgba(0,0,0,0.95)' }}>
      <div className="flex flex-col items-center gap-3 text-center px-6 max-w-xs w-full">
        <div className="text-[7px] text-[var(--gold)]/40 tracking-[0.35em] uppercase">— The Continental —</div>
        <div className={`text-[10px] text-[var(--gold)] tracking-[0.2em] uppercase font-semibold transition-opacity duration-500 ${revealN >= 1 ? 'opacity-100' : 'opacity-0'}`}>
          Contract Fulfilled
        </div>
        <div className={`text-sm text-[var(--text-h)] max-w-[220px] truncate transition-opacity duration-500 ${revealN >= 2 ? 'opacity-100' : 'opacity-0'}`}>
          {anim.sessionName ?? ''}
        </div>
        <div className={`text-5xl font-bold text-[var(--gold)] tabular-nums transition-opacity duration-500 ${revealN >= 3 ? 'opacity-100' : 'opacity-0'}`}>
          {revealN >= 3 && <AnimatedNumber to={total} duration={1600} />}
        </div>
        {stamp && (
          <div className="mt-4 stamp-in">
            <div className="w-20 h-20 rounded-full border-2 border-[var(--gold)] flex flex-col items-center justify-center gap-0.5">
              <div className="text-[7px] text-[var(--gold)] tracking-[0.2em] uppercase">Certified</div>
              <div className="text-lg text-[var(--gold)]">🏛</div>
              <div className="text-[5px] text-[var(--gold)]/60 tracking-wider uppercase">Continental</div>
            </div>
          </div>
        )}
        {revealN >= 5 && (
          <button onClick={onDone}
            className="mt-3 text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] tracking-[0.2em] uppercase border-b border-transparent hover:border-[var(--gold)]/50 transition-colors">
            Dismiss
          </button>
        )}
      </div>
    </div>
  )

  return null
}

// ─── BountyToast (L3 / L4) ────────────────────────────────────────────────────

export function BountyToast({ anim, settings, onDone }) {
  const [exiting, setExiting] = useState(false)
  const tk  = tierKey(anim.tier, anim.level)
  const cfg = settings[tk]
  const dur = anim.level === 4 ? 4500 : 3500

  useAudio(tk, settings, exiting ? 'out' : 'in')

  useEffect(() => {
    const t1 = setTimeout(() => setExiting(true), dur - 400)
    const t2 = setTimeout(onDone, dur)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  // Custom image/gif as toast background
  const hasCustomMedia = cfg?.mediaType === 'image'
  const imgDur = cfg?.imageDuration ?? 3
  // Override duration if custom media sets it
  const effectiveDur = hasCustomMedia ? imgDur * 1000 : dur

  return (
    <div className={`fixed top-4 right-4 z-[60] flex items-center gap-3 px-4 py-3
      bg-[var(--surface)] border border-[var(--gold-border)] rounded-sm
      shadow-[0_4px_24px_rgba(201,162,39,0.25)] pointer-events-none
      transition-[transform,opacity] duration-500 overflow-hidden
      ${exiting ? 'opacity-0 translate-x-full' : 'toast-enter opacity-100'}`}
      style={{ minWidth: 170, maxWidth: 260 }}>
      {hasCustomMedia && (
        <img src={`/api/bounty/asset/${tk}/media`} alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-20" />
      )}
      {anim.level === 4 && <span className="relative text-xl text-[var(--gold)] shrink-0">🏛</span>}
      <div className="relative min-w-0">
        <div className="text-[7px] text-[var(--text-muted)] tracking-[0.25em] uppercase mb-0.5">
          {anim.level === 4 ? '— The Continental —' : 'Bounty ▲'}
        </div>
        <div className="text-base font-bold text-[var(--gold)] tabular-nums">+{fmtCost(anim.delta)}</div>
        <div className="text-[9px] text-[var(--text-muted)] tabular-nums mt-0.5">Total {fmtCost(anim.total)}</div>
      </div>
    </div>
  )
}

// ─── BountyOverlay (H2+ / S / C) ─────────────────────────────────────────────

export function BountyOverlay({ anim, settings, onDone }) {
  const { tier, level } = anim
  const tk  = tierKey(tier, level)
  const cfg = settings[tk]

  // Custom media (video / image) takes full precedence
  if (cfg?.mediaType === 'video' || (cfg?.mediaType === 'image' && tier !== 'L')) {
    return <CustomMediaOverlay tierCode={tk} cfg={cfg} onDone={onDone} />
  }

  return <DefaultOverlay anim={anim} settings={settings} onDone={onDone} />
}
