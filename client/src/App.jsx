import { useState, useEffect, useRef, useCallback } from 'react'
import { useCostEngine, BountyOverlay, BountyToast, ContractModal, fmtCost, computeDeltaCost } from './BountySystem.jsx'
import BountySettings from './BountySettings.jsx'

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = `ws://${location.host}/ws`

const STATUS_ICON = {
  active:   '●',
  sleeping: '◌',
  waiting:  '◐',
  error:    '✕',
  done:     '✓',
}

const GATE_LABEL = {
  1: 'Gate 1 — Plan Review',
  2: 'Gate 2 — Build Check',
}

// ─── (mock data removed — sessions come from server via WebSocket) ───────────

// ─── Utility ──────────────────────────────────────────────────────────────────

function elapsed(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function fmtHour(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status }) {
  const cls = {
    active:   'text-green-400',
    sleeping: 'text-gray-600 shimmer',
    waiting:  'text-amber-400 pulse-amber',
    error:    'text-red-400',
    done:     'text-blue-400',
  }[status] ?? 'text-gray-500'
  return <span className={`text-xs ${cls}`}>{STATUS_ICON[status] ?? '?'}</span>
}

// ─── Activity Heat ────────────────────────────────────────────────────────────
// Heat thresholds (USD) — colour shifts cold→warm→hot→critical
const HEAT_MAX_5H  = 10   // $10 in 5h  = full bar
const HEAT_MAX_7D  = 50   // $50 in 7d  = full bar

function heatColor(ratio) {
  if (ratio < 0.25) return { bar: '#22d3ee', glow: 'rgba(34,211,238,0.4)' }   // cyan — cold
  if (ratio < 0.55) return { bar: '#c9a227', glow: 'rgba(201,162,39,0.45)' }   // gold — warm
  if (ratio < 0.80) return { bar: '#f97316', glow: 'rgba(249,115,22,0.50)' }   // orange — hot
  return                  { bar: '#ef4444', glow: 'rgba(239,68,68,0.60)' }       // red — critical
}

function ActivityHeat() {
  const [heat, setHeat] = useState(null)

  useEffect(() => {
    function load() {
      fetch('/api/usage/heat')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.session5h && d?.weekly7d) setHeat(d) })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  if (!heat) return null
  const { session5h, weekly7d } = heat

  function HeatBar({ label, window, cost, max }) {
    const ratio = Math.min(cost / max, 1)
    const pct   = (ratio * 100).toFixed(0)
    const c     = heatColor(ratio)
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="text-[8px] tracking-[0.18em] uppercase"
            style={{ color: c.bar }}>{label}</span>
          <span className="text-[8px] tabular-nums font-mono"
            style={{ color: c.bar }}>{fmtCost(cost) ?? '$0.00'}</span>
        </div>
        <div className="h-[3px] rounded-full bg-[var(--border)] overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, background: c.bar, boxShadow: `0 0 6px ${c.glow}` }} />
        </div>
        <div className="text-[7px] text-[var(--text-muted)] tracking-wider">{window}</div>
      </div>
    )
  }

  return (
    <div className="mx-2 mt-2 mb-1 px-2.5 py-2 rounded-sm border border-[var(--border)]
      bg-[var(--surface-2)]">
      <div className="text-[7px] text-[var(--text-muted)] tracking-[0.3em] uppercase mb-2 text-center">
        ── Activity Heat ──
      </div>
      <div className="space-y-2">
        <HeatBar label="Session"  window="5 hr window" cost={session5h.cost} max={HEAT_MAX_5H} />
        <HeatBar label="Profile"  window="7 day window" cost={weekly7d.cost}  max={HEAT_MAX_7D} />
      </div>
    </div>
  )
}

function SessionItem({ session, isSelected, onClick, onDoubleClick, onCostClick, autoResumeArmed, autoResumeFireAt, onToggleAutoResume, hitLimit, isChatSession, chatStage = 1, chatRunning = 0, chatLastDelta = null, chatBaseline = 0, onPermissionResponse }) {
  const base = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-all'
  const selectedCls = isSelected
    ? 'bg-[var(--surface-2)] session-active-glow'
    : 'hover:bg-[var(--surface-2)]'

  // ── Cost delta animation ─────────────────────────────────────────────────
  const rawCost = session.costUsd ?? null
  const [displayedCost, setDisplayedCost] = useState(rawCost)
  const [deltaAmt, setDeltaAmt]           = useState(null)   // number | null
  const [deltaPhase, setDeltaPhase]       = useState('idle') // 'idle'|'show'|'fade'
  const prevRawRef = useRef(rawCost)
  const t1Ref = useRef(null)
  const t2Ref = useRef(null)

  useEffect(() => {
    if (rawCost == null) { setDisplayedCost(null); prevRawRef.current = null; return }
    const prev = prevRawRef.current
    prevRawRef.current = rawCost

    if (prev == null || rawCost - prev <= 0.000001) {
      setDisplayedCost(rawCost)
      return
    }

    const d = rawCost - prev
    // Phase 2: keep showing OLD cost + "+delta" for 0.2 s
    setDeltaAmt(d)
    setDeltaPhase('show')

    clearTimeout(t1Ref.current)
    clearTimeout(t2Ref.current)

    t1Ref.current = setTimeout(() => {
      // Phase 3: switch to new total, delta fades out
      setDisplayedCost(rawCost)
      setDeltaPhase('fade')
      t2Ref.current = setTimeout(() => { setDeltaAmt(null); setDeltaPhase('idle') }, 550)
    }, 200)

    return () => { clearTimeout(t1Ref.current); clearTimeout(t2Ref.current) }
  }, [rawCost])

  return (
    <div className={`${base} ${selectedCls}`} onClick={onClick} onDoubleClick={onDoubleClick}>
      <StatusDot status={session.status} />
      <div className="flex-1 min-w-0">
        {/* Row 1: session name */}
        <div className="truncate text-[var(--text-h)] text-xs leading-tight mb-0.5">
          {session.displayName}
        </div>
        {/* Row 2: time */}
        <div className="text-[10px] text-[var(--text-muted)]">
          {elapsed(session.startedAt)} ago
        </div>
        {/* Row 3: cost + auto-resume toggle */}
        <div className="flex items-center gap-1 mt-0.5">
          {/* Cost display — 5-stage for active chat, simple badge otherwise */}
          {isChatSession && (chatStage === 2 || chatStage === 3) ? (
            // Stage 2: baseline(gray) | running(gold) | +delta(green)
            // Stage 3: baseline(gray) | running(gold)
            <button onClick={e => { e.stopPropagation(); onCostClick?.() }}
              className="flex items-center gap-1 tabular-nums text-[9px] font-mono">
              <span className={`transition-colors duration-700 ${chatStage === 2 ? 'text-gray-600' : 'text-gray-500'}`}>
                {fmtCost(chatBaseline)}
              </span>
              <span className="text-[var(--gold)]">{fmtCost(chatRunning)}</span>
              {chatStage === 2 && chatLastDelta != null && (
                <span className="text-green-400">+{fmtCost(chatLastDelta)}</span>
              )}
            </button>
          ) : displayedCost != null ? (
            // Stage 1 / 4 / 5 (or non-chat session): single total badge
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); onCostClick?.() }}
                className="tabular-nums text-[var(--gold)]/80 hover:text-[var(--gold)] transition-colors
                  border-b border-[var(--gold)]/20 hover:border-[var(--gold)]/60 leading-tight text-[9px]">
                {fmtCost(displayedCost)}
              </button>
              {deltaAmt != null && (
                <span
                  className={`absolute left-full pl-1 top-0 tabular-nums text-green-400 text-[9px] whitespace-nowrap pointer-events-none transition-opacity duration-500 ${
                    deltaPhase === 'fade' ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  +{fmtCost(deltaAmt)}
                </span>
              )}
            </div>
          ) : null}

          {/* Auto-resume toggle — visible when sleeping OR when usage limit hit */}
          {(session.status === 'sleeping' || hitLimit) && (
            <button
              onClick={e => { e.stopPropagation(); onToggleAutoResume?.() }}
              title={autoResumeArmed ? '自動繼續 ON — 點擊取消' : '設定整點自動繼續'}
              className={`flex items-center gap-0.5 text-[9px] px-1 leading-none rounded border transition-colors ${
                autoResumeArmed
                  ? 'border-amber-500/80 text-amber-400 pulse-amber'
                  : 'border-gray-600/40 text-gray-600 hover:border-gray-500 hover:text-gray-400'
              }`}
            >
              <span>⏰</span>
              <span>{autoResumeArmed ? `${fmtHour(autoResumeFireAt) || '?'} 自動發送訊息` : '尚未預約'}</span>
            </button>
          )}
        </div>
        {/* Row 4: pending permission (non-chat sessions) */}
        {session.pendingPermission && !isChatSession && (
          <div className="mt-1 rounded border border-amber-600/40 bg-amber-900/10 px-1.5 py-1">
            <div className="text-[8px] text-amber-400 font-semibold tracking-wide mb-0.5">⚠ 需要授權</div>
            <div className="text-[9px] text-[var(--text)] font-mono truncate mb-1">{session.pendingPermission.toolName}</div>
            <div className="flex gap-1">
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'approve') }}
                className="flex-1 py-0.5 rounded bg-green-900/40 border border-green-700 text-green-300 text-[8px]"
              >✓</button>
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'allow_always') }}
                className="flex-1 py-0.5 rounded bg-yellow-900/40 border border-yellow-600 text-yellow-300 text-[8px]"
              >⭐</button>
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'block') }}
                className="flex-1 py-0.5 rounded bg-red-900/40 border border-red-700 text-red-300 text-[8px]"
              >✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function GateBadge({ gate, onApprove, onForce, onBlock }) {
  if (!gate || gate.status === 'approved') return null

  const statusCls = {
    pending: 'gate-pending',
    force:   'gate-force',
    blocked: 'gate-blocked',
  }[gate.status] ?? 'gate-pending'

  return (
    <div className={`mt-1 ml-4 border rounded px-2 py-1 text-[10px] inline-flex flex-col gap-1 ${statusCls}`}>
      <span className="font-semibold">{GATE_LABEL[gate.id] ?? `Gate ${gate.id}`}</span>
      {gate.status === 'pending' && (
        <div className="flex gap-1 mt-0.5">
          <button
            onClick={onApprove}
            className="px-2 py-0.5 rounded bg-green-900/40 border border-green-700 text-green-300 hover:bg-green-800/60 text-[10px]"
          >
            驗收通過
          </button>
          <button
            onClick={onForce}
            className="px-2 py-0.5 rounded bg-purple-900/40 border border-purple-700 text-purple-300 hover:bg-purple-800/60 text-[10px]"
          >
            強力過件
          </button>
          <button
            onClick={onBlock}
            className="px-2 py-0.5 rounded bg-red-900/40 border border-red-700 text-red-300 hover:bg-red-800/60 text-[10px]"
          >
            擋下
          </button>
        </div>
      )}
    </div>
  )
}

function TaskNode({ task, depth = 0, onGateAction }) {
  const [collapsed, setCollapsed] = useState(false)
  const hasChildren = task.children?.length > 0
  const indent = depth * 16

  const rowCls = {
    active:  'border-l-2 border-green-500/50',
    waiting: 'border-l-2 border-amber-500/50',
    done:    'border-l-2 border-blue-500/20 opacity-60',
    error:   'border-l-2 border-red-500/50',
  }[task.status] ?? 'border-l-2 border-transparent'

  return (
    <div>
      <div
        className={`flex items-start gap-2 px-2 py-1 rounded-sm hover:bg-[var(--surface-2)] ${rowCls}`}
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-[var(--text-muted)] text-[10px] w-3 shrink-0 mt-0.5 hover:text-[var(--text)]"
          >
            {collapsed ? '▶' : '▼'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <StatusDot status={task.status} />
        <div className="flex-1 min-w-0">
          <span className={`text-xs ${task.status === 'done' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-h)]'}`}>
            {task.title}
          </span>
          {task.gate && (
            <GateBadge
              gate={task.gate}
              onApprove={() => onGateAction(task.id, 'approve')}
              onForce={() => onGateAction(task.id, 'force')}
              onBlock={() => onGateAction(task.id, 'block')}
            />
          )}
        </div>
      </div>
      {!collapsed && hasChildren && (
        <div>
          {task.children.map(child => (
            <TaskNode key={child.id} task={child} depth={depth + 1} onGateAction={onGateAction} />
          ))}
        </div>
      )}
    </div>
  )
}

const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000 // 5 hours

// 冷卻到期後，下一個整點 :00:01 (瀏覽器本地時區)
function nextWholeHourAfter(ms) {
  const d = new Date(ms)
  d.setMinutes(0, 1, 0)
  if (d.getTime() <= ms) d.setHours(d.getHours() + 1)
  return d.getTime()
}

function CooldownTimer({ sleepingAt }) {
  const [remaining, setRemaining] = useState(null)

  useEffect(() => {
    if (!sleepingAt) { setRemaining(null); return }
    function tick() {
      const elapsed = Date.now() - sleepingAt
      const left = Math.max(0, SESSION_LIMIT_MS - elapsed)
      setRemaining(left)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sleepingAt])

  if (remaining === null) return null

  const h = Math.floor(remaining / 3600000)
  const m = Math.floor((remaining % 3600000) / 60000)
  const s = Math.floor((remaining % 60000) / 1000)
  const pct = Math.round(((SESSION_LIMIT_MS - remaining) / SESSION_LIMIT_MS) * 100)

  if (remaining === 0) return (
    <div className="text-[10px] text-green-400 mt-1">✓ 冷卻完成，可繼續</div>
  )

  return (
    <div className="mt-2">
      <div className="flex justify-between text-[9px] text-[var(--text-muted)] mb-1">
        <span>冷卻中</span>
        <span className="tabular-nums">{h}h {String(m).padStart(2,'0')}m {String(s).padStart(2,'0')}s</span>
      </div>
      <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-gray-500 rounded-full transition-all duration-1000"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function CharacterZone({ status }) {
  // Placeholder — Rive animation will go here
  const mood = {
    active:   { emoji: '⚔', label: 'On mission', color: 'text-green-400' },
    sleeping: { emoji: '💤', label: 'Sleeping (token limit)', color: 'text-gray-500 shimmer' },
    waiting:  { emoji: '⏳', label: 'Awaiting approval', color: 'text-amber-400 pulse-amber' },
    error:    { emoji: '🩸', label: 'Fallen', color: 'text-red-400' },
    done:     { emoji: '🏛', label: 'Mission complete', color: 'text-blue-400' },
    idle:     { emoji: '🏛', label: 'Idle', color: 'text-gray-600' },
  }[status] ?? { emoji: '🏛', label: 'Idle', color: 'text-gray-600' }

  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <div className={`text-5xl leading-none ${mood.color}`}>{mood.emoji}</div>
      <div className={`text-[10px] uppercase tracking-widest ${mood.color}`}>{mood.label}</div>
      <div className="text-[10px] text-[var(--text-muted)] mt-1">The Continental</div>
    </div>
  )
}

// ─── WebSocket hook ───────────────────────────────────────────────────────────

function useWebSocket(url, onMessage) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let ws
    let retryTimer

    function connect() {
      ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        retryTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = e => {
        try { onMessage(JSON.parse(e.data)) } catch {}
      }
    }

    connect()
    return () => {
      clearTimeout(retryTimer)
      ws?.close()
    }
  }, [url])  // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(data => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(data))
  }, [])

  return { connected, send }
}

// ─── Tab panels ──────────────────────────────────────────────────────────────

const HISTORY_PREVIEW_LEN = 300

function HistoryMessage({ message: m }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = m.text.length > HISTORY_PREVIEW_LEN
  const displayed = expanded || !isLong ? m.text : m.text.slice(0, HISTORY_PREVIEW_LEN) + '…'
  return (
    <div className={`text-[11px] rounded px-2 py-1 ${m.role === 'user' ? 'bg-[var(--surface-2)] text-[var(--gold)]' : 'text-[var(--text-muted)]'}`}>
      <div className="font-semibold text-[9px] uppercase mb-0.5 opacity-60">{m.role}</div>
      <div className="whitespace-pre-wrap break-words">{displayed}</div>
      {isLong && (
        <button
          onClick={() => setExpanded(x => !x)}
          className="mt-1 text-[9px] text-[var(--gold)]/70 hover:text-[var(--gold)] underline"
        >
          {expanded ? '▲ 收起' : '▼ 展開全文'}
        </button>
      )}
    </div>
  )
}


function HistoryPanel({ onContinue }) {
  const [list, setList] = useState([])
  const [active, setActive] = useState(null)
  const [messages, setMessages] = useState([])
  const [activeCost, setActiveCost] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/history').then(r => r.json()).then(d => setList(d.sessions ?? []))
  }, [])

  async function open(s) {
    setActive(s); setLoading(true); setActiveCost(null)
    const d = await fetch(`/api/history/${s.sessionId}`).then(r => r.json())
    setMessages(d.messages ?? [])
    setActiveCost(d.costUsd ?? s.costUsd ?? null)
    setLoading(false)
  }

  if (active) return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <button onClick={() => setActive(null)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs">← Back</button>
        <span className="flex-1 text-xs text-[var(--text-h)] truncate">{active.title}</span>
        {activeCost != null && (
          <span className="shrink-0 text-[10px] text-[var(--gold)]/80">{fmtCost(activeCost)}</span>
        )}
        {active.cwd && (
          <button
            onClick={() => onContinue({ sessionId: active.sessionId, projectPath: active.cwd })}
            className="shrink-0 px-2 py-1 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/50 text-[var(--gold)] text-[9px] hover:bg-[var(--gold)]/30"
          >
            ▶ Continue in Chat
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {loading && <div className="text-[var(--text-muted)] text-xs">Loading…</div>}
        {messages.map((m, i) => (
          <HistoryMessage key={i} message={m} />
        ))}
      </div>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {list.length === 0 && <div className="text-[var(--text-muted)] text-xs text-center mt-8">No history</div>}
      {list.map(s => (
        <div key={s.sessionId} onClick={() => open(s)}
          className="px-3 py-2 rounded hover:bg-[var(--surface-2)] cursor-pointer mb-1">
          <div className="text-xs text-[var(--text-h)] truncate">{s.title}</div>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            <span className="truncate">{s.project.replace('c--', '').replace(/-/g,'/')} · {new Date(s.mtime).toLocaleDateString()}</span>
            {s.costUsd != null && <span className="shrink-0 text-[var(--gold)]/70">{fmtCost(s.costUsd)}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function AnalyticsPanel({ sessions }) {
  const totals = sessions.reduce((acc, s) => {
    acc.input  += s.tokens?.input  ?? 0
    acc.output += s.tokens?.output ?? 0
    return acc
  }, { input: 0, output: 0 })

  const fmt = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n)

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Total Input', val: fmt(totals.input), sub: 'tokens' },
          { label: 'Total Output', val: fmt(totals.output), sub: 'tokens' },
          { label: 'Sessions', val: sessions.length, sub: 'all time' },
          { label: 'Active', val: sessions.filter(s=>s.status==='active').length, sub: 'right now' },
        ].map(c => (
          <div key={c.label} className="bg-[var(--surface-2)] rounded p-3 border border-[var(--border)]">
            <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider">{c.label}</div>
            <div className="text-xl text-[var(--gold)] font-semibold mt-1">{c.val}</div>
            <div className="text-[9px] text-[var(--text-muted)]">{c.sub}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-2">Per Session</div>
        <div className="space-y-1">
          {sessions.filter(s => s.tokens?.input || s.tokens?.output).map(s => (
            <div key={s.id} className="flex items-center gap-2 text-[10px]">
              <span className="truncate flex-1 text-[var(--text-h)]">{s.displayName}</span>
              <span className="text-[var(--text-muted)]">↑{fmt(s.tokens?.input??0)}</span>
              <span className="text-[var(--text-muted)]">↓{fmt(s.tokens?.output??0)}</span>
            </div>
          ))}
          {sessions.every(s => !s.tokens?.input && !s.tokens?.output) && (
            <div className="text-[var(--text-muted)] text-xs">Token data appears after session ends</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ClaudeMdPanel({ selected }) {
  const [files, setFiles] = useState([])
  const [activeFile, setActiveFile] = useState(null)
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const cwd = selected?.cwd ?? ''
    fetch(`/api/claudemd?cwd=${encodeURIComponent(cwd)}`).then(r=>r.json()).then(d => {
      setFiles(d.files ?? [])
      if (d.files?.length > 0 && !activeFile) { setActiveFile(d.files[0].path); setContent(d.files[0].content) }
    })
  }, [selected?.cwd])

  async function save() {
    setSaving(true)
    await fetch('/api/claudemd', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: activeFile, content }) })
    setSaving(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] shrink-0 overflow-x-auto">
        {files.map(f => (
          <button key={f.path} onClick={() => { setActiveFile(f.path); setContent(f.content) }}
            className={`px-2 py-1 rounded text-[10px] shrink-0 ${activeFile===f.path ? 'bg-[var(--gold-dim)] text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
            {f.path.split(/[/\\]/).pop()}
          </button>
        ))}
        {files.length === 0 && <span className="text-[10px] text-[var(--text-muted)] px-2">No CLAUDE.md found</span>}
      </div>
      {activeFile && (
        <>
          <textarea value={content} onChange={e => setContent(e.target.value)}
            className="flex-1 bg-transparent font-mono text-[11px] text-[var(--text)] p-3 resize-none focus:outline-none"
            spellCheck={false} />
          <div className="px-3 py-2 border-t border-[var(--border)] flex justify-between items-center shrink-0">
            <span className="text-[9px] text-[var(--text-muted)] truncate">{activeFile}</span>
            <button onClick={save} disabled={saving}
              className="px-3 py-1 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-[10px] hover:bg-[var(--gold)] hover:text-black">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function AgentsPanel() {
  const [agents, setAgents] = useState([])
  const [editing, setEditing] = useState(null) // { name, content } or null
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')

  const reload = () => fetch('/api/agents').then(r=>r.json()).then(d => setAgents(d.agents ?? []))
  useEffect(() => { reload() }, [])

  async function save() {
    const name = editing?.name ?? newName
    const content = editing?.content ?? newContent
    if (!name.trim()) return
    await fetch('/api/agents', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, content }) })
    setEditing(null); setNewName(''); setNewContent(''); reload()
  }

  async function del(name) {
    await fetch(`/api/agents/${encodeURIComponent(name)}`, { method:'DELETE' })
    reload()
  }

  if (editing) return (
    <div className="flex flex-col h-full p-3 gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-[var(--text-h)]">{editing.name}</span>
        <div className="flex-1" />
        <button onClick={() => setEditing(null)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">Cancel</button>
        <button onClick={save} className="px-2 py-1 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-[10px]">Save</button>
      </div>
      <textarea value={editing.content} onChange={e => setEditing(p => ({...p, content: e.target.value}))}
        className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 font-mono text-[11px] text-[var(--text)] resize-none focus:outline-none" />
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {agents.map(a => (
          <div key={a.name} className="flex items-center gap-2 px-2 py-2 rounded hover:bg-[var(--surface-2)]">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-h)] truncate">{a.name}</div>
              <div className="text-[9px] text-[var(--text-muted)] truncate">{a.desc}</div>
            </div>
            <button onClick={() => setEditing({ name: a.name, content: a.content })} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">Edit</button>
            <button onClick={() => del(a.name)} className="text-[10px] text-[var(--text-muted)] hover:text-red-400">✕</button>
          </div>
        ))}
        {agents.length === 0 && <div className="text-[var(--text-muted)] text-xs text-center mt-8">No agents yet</div>}
      </div>
      <div className="border-t border-[var(--border)] p-3 space-y-2 shrink-0">
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Agent name"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-h)] focus:outline-none focus:border-[var(--gold)]" />
        <textarea value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="System prompt…" rows={3}
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] resize-none focus:outline-none focus:border-[var(--gold)]" />
        <button onClick={save} className="w-full py-1 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-[10px] hover:bg-[var(--gold)] hover:text-black">
          + Create Agent
        </button>
      </div>
    </div>
  )
}

function McpPanel() {
  const [servers, setServers] = useState({})
  const [name, setName] = useState('')
  const [cmd, setCmd] = useState('')
  const [args, setArgs] = useState('')

  const reload = () => fetch('/api/mcp').then(r=>r.json()).then(d => setServers(d.servers ?? {}))
  useEffect(() => { reload() }, [])

  async function add() {
    if (!name.trim() || !cmd.trim()) return
    const config = { command: cmd, args: args ? args.split(' ') : [] }
    await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, config }) })
    setName(''); setCmd(''); setArgs(''); reload()
  }

  async function del(n) {
    await fetch(`/api/mcp/${encodeURIComponent(n)}`, { method:'DELETE' }); reload()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {Object.entries(servers).map(([n, cfg]) => (
          <div key={n} className="flex items-center gap-2 px-2 py-2 rounded hover:bg-[var(--surface-2)]">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-h)]">{n}</div>
              <div className="text-[9px] text-[var(--text-muted)] truncate font-mono">{cfg.command} {(cfg.args??[]).join(' ')}</div>
            </div>
            <button onClick={() => del(n)} className="text-[10px] text-[var(--text-muted)] hover:text-red-400">✕</button>
          </div>
        ))}
        {Object.keys(servers).length === 0 && <div className="text-[var(--text-muted)] text-xs text-center mt-8">No MCP servers</div>}
      </div>
      <div className="border-t border-[var(--border)] p-3 space-y-2 shrink-0">
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Server name"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-h)] focus:outline-none focus:border-[var(--gold)]" />
        <input value={cmd} onChange={e=>setCmd(e.target.value)} placeholder="Command (e.g. npx)"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] focus:outline-none focus:border-[var(--gold)]" />
        <input value={args} onChange={e=>setArgs(e.target.value)} placeholder="Args (space-separated)"
          className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] focus:outline-none focus:border-[var(--gold)]" />
        <button onClick={add} className="w-full py-1 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-[10px] hover:bg-[var(--gold)] hover:text-black">
          + Add Server
        </button>
      </div>
    </div>
  )
}

function CheckpointsPanel({ selected }) {
  const [checkpoints, setCheckpoints] = useState([])
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const cwd = selected?.cwd ?? ''

  const reload = useCallback(() => {
    if (!cwd) return
    fetch(`/api/checkpoints?cwd=${encodeURIComponent(cwd)}`).then(r=>r.json()).then(d => setCheckpoints(d.checkpoints ?? []))
  }, [cwd])

  useEffect(() => { reload() }, [reload])

  async function create() {
    setLoading(true)
    await fetch('/api/checkpoints', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, message: msg }) })
    setMsg(''); reload(); setLoading(false)
  }

  async function restore(hash) {
    if (!confirm(`Restore to ${hash}?`)) return
    await fetch('/api/checkpoints/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd, hash }) })
    reload()
  }

  if (!cwd) return <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Select a session with cwd</div>

  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <div className="flex gap-1">
        <input value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Checkpoint message…"
          className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[10px] text-[var(--text-h)] focus:outline-none focus:border-[var(--gold)]" />
        <button onClick={create} disabled={loading}
          className="px-2 py-1 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-[10px] shrink-0">
          Save
        </button>
      </div>
      <div className="space-y-1">
        {checkpoints.map(c => (
          <div key={c.hash} className="flex items-center gap-2 text-[10px] hover:bg-[var(--surface-2)] px-1 py-1 rounded">
            <span className="font-mono text-[var(--gold)] shrink-0">{c.hash}</span>
            <span className="text-[var(--text-muted)] truncate flex-1">{c.message}</span>
            <button onClick={() => restore(c.hash)} className="text-[var(--text-muted)] hover:text-amber-400 shrink-0">↩</button>
          </div>
        ))}
        {checkpoints.length === 0 && <div className="text-[var(--text-muted)] text-[10px]">No checkpoints</div>}
      </div>
    </div>
  )
}

// ─── Chat Panel ───────────────────────────────────────────────────────────────

function normPath(p) { return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') }

function ChatPanel({ streamEvents, chatInit, logs, selectedId, onTaskCreated }) {
  const [projectPath, setProjectPath] = useState('C:/Project/RomanPrototype')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [attachments, setAttachments] = useState([])  // [{ name, dataUrl, type }]
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const fileInputRef = useRef(null)
  const attachMenuRef = useRef(null)
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const bottomRef = useRef(null)
  const prevChatInitRef = useRef(null)
  // Live streaming block (rAF-batched to avoid per-token re-renders)
  const liveBlockRef = useRef(null)  // { type: 'thinking'|'text', text: string } | null
  const [, setLiveTick] = useState(0)
  const rafRef = useRef(null)
  function scheduleLiveUpdate() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; setLiveTick(t => t + 1) })
  }

  // Apply chatInit when it changes (from History "Continue in Chat" or session click)
  useEffect(() => {
    if (!chatInit) return
    if (chatInit === prevChatInitRef.current) return
    prevChatInitRef.current = chatInit
    setProjectPath(chatInit.projectPath)
    setSessionId(chatInit.sessionId)
    setMessages([{ role: 'system', text: '載入歷史紀錄…', ts: Date.now() }])
    // Start live-tailing VS Code session
    fetch('/api/session/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chatInit.sessionId }),
    }).catch(() => {})
    fetch(`/api/history/${chatInit.sessionId}`)
      .then(r => r.json())
      .then(d => {
        const hist = (d.messages ?? []).map(m => ({ ...m, historical: true }))
        setMessages(prev => {
          const newStream = prev.filter(m => !m.historical && m.role !== 'system')
          return [...hist, { role: 'system', text: '─── 以上為歷史紀錄，從此繼續 ───', ts: Date.now() }, ...newStream]
        })
      })
      .catch(() => setMessages([{ role: 'system', text: '歷史紀錄載入失敗', ts: Date.now() }]))
  }, [chatInit])

  // Process incoming stream events (subprocess)
  useEffect(() => {
    if (!streamEvents.length) return
    const ev = streamEvents[streamEvents.length - 1]
    // session_live: VS Code live tail messages
    if (ev.type === 'session_live' && ev.sessionId === sessionId) {
      setMessages(prev => [...prev, ...ev.messages.map(m => ({ ...m, live: true }))])
      return
    }
    if (normPath(ev.projectPath) !== normPath(projectPath)) return
    const { event } = ev

    if (event.type === 'system' && event.subtype === 'init') {
      setSessionId(event.session_id)
    } else if (event.type === 'content_block_start') {
      const t = event.content_block?.type
      if (t === 'thinking') { liveBlockRef.current = { type: 'thinking', text: '' }; scheduleLiveUpdate() }
      else if (t === 'text') { liveBlockRef.current = { type: 'text', text: '' }; scheduleLiveUpdate() }
      else liveBlockRef.current = null
    } else if (event.type === 'content_block_delta') {
      const d = event.delta
      if (liveBlockRef.current && (d?.type === 'thinking_delta' || d?.type === 'text_delta')) {
        liveBlockRef.current = { ...liveBlockRef.current, text: liveBlockRef.current.text + (d.thinking ?? d.text ?? '') }
        scheduleLiveUpdate()
      }
    } else if (event.type === 'content_block_stop') {
      liveBlockRef.current = null
      scheduleLiveUpdate()
    } else if (event.type === 'assistant') {
      liveBlockRef.current = null
      const blocks = event.message?.content ?? []
      const newMsgs = []
      for (const b of blocks) {
        if (b.type === 'thinking')
          newMsgs.push({ role: 'thinking', text: b.thinking, ts: Date.now() })
        else if (b.type === 'text' && b.text.trim())
          newMsgs.push({ role: 'assistant', text: b.text, ts: Date.now() })
        else if (b.type === 'tool_use')
          newMsgs.push({ role: 'tool_use', toolName: b.name, input: b.input, toolId: b.id, ts: Date.now() })
      }
      if (newMsgs.length) setMessages(m => [...m, ...newMsgs])
    } else if (event.type === 'user') {
      // Tool results
      const blocks = event.message?.content ?? []
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const output = Array.isArray(b.content)
            ? b.content.filter(x => x.type === 'text').map(x => x.text).join('').slice(0, 300)
            : String(b.content ?? '').slice(0, 300)
          if (output.trim())
            setMessages(m => [...m, { role: 'tool_result', toolId: b.tool_use_id, output, ts: Date.now() }])
        }
      }
    } else if (event.type === 'result') {
      setRunning(false)
      const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''
      setMessages(m => [...m, { role: 'result', text: `完成${cost}`, ts: Date.now() }])
    } else if (event.type === 'done') {
      setRunning(false)
    }
  }, [streamEvents, projectPath, sessionId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    if (running) return

    // /task <title> — intercept, create task, show feedback in chat
    if (text.startsWith('/task ') && attachments.length === 0) {
      const title = text.slice(6).trim()
      if (title && selectedId) {
        await fetch(`/api/sessions/${selectedId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, status: 'pending' }),
        })
        setMessages(m => [...m, { role: 'system', text: `✓ Task created: ${title}`, ts: Date.now() }])
        onTaskCreated?.()
      }
      setInput('')
      return
    }

    const prompt = text || (attachments.length ? '請查看附件' : '')

    setInput('')
    const sentAttachments = attachments
    setAttachments([])
    setRunning(true)
    const displayText = prompt + (sentAttachments.length ? `\n${sentAttachments.map(a => `[${a.name}]`).join(' ')}` : '')
    setMessages(m => [...m, { role: 'user', text: displayText, attachments: sentAttachments, ts: Date.now() }])
    await fetch('/api/claude/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, prompt, sessionId, attachments: sentAttachments }),
    })
  }

  function handleStop() {
    fetch('/api/claude/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    })
    setRunning(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgItem = items.find(i => i.type.startsWith('image/'))
    if (!imgItem) return
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setAttachments(prev => [...prev, { name: file.name || 'image.png', dataUrl: ev.target.result, type: file.type }])
    reader.readAsDataURL(file)
  }

  function handleFileChange(e) {
    const files = Array.from(e.target.files ?? [])
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = ev => setAttachments(prev => [...prev, { name: file.name, dataUrl: ev.target.result, type: file.type }])
      reader.readAsDataURL(file)
    })
    e.target.value = ''
    setShowAttachMenu(false)
  }

  // Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return
    function handler(e) { if (!attachMenuRef.current?.contains(e.target)) setShowAttachMenu(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAttachMenu])

  function clearChat() { setMessages([]); setSessionId(null) }

  return (
    <div className="flex flex-col h-full">

      {/* Project path bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest shrink-0">Project</span>
        <input
          value={projectPath}
          onChange={e => { setProjectPath(e.target.value); setSessionId(null); setMessages([]) }}
          className="flex-1 bg-transparent text-base md:text-[10px] text-[var(--text)] font-mono outline-none border-b border-[var(--border)] pb-0.5"
        />
        {sessionId && (
          <span className="text-[9px] text-[var(--text-muted)] font-mono shrink-0">{sessionId.slice(0,8)}</span>
        )}
        <button onClick={clearChat} className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] shrink-0">✕ clear</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0">
        {messages.length === 0 && (
          <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">
            輸入訊息開始對話，不需要 VS Code 介面
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`text-[11px] leading-relaxed ${m.historical ? 'opacity-50' : ''}`}>
            {/* System / divider */}
            {m.role === 'system' && (
              <div className="text-[9px] text-[var(--text-muted)] text-center py-1 border-t border-[var(--border)] mt-1">{m.text}</div>
            )}
            {/* User message */}
            {m.role === 'user' && (
              <div className="text-[var(--gold)]">
                <span className="opacity-50 mr-1">›</span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                {m.attachments?.filter(a => a.type?.startsWith('image/')).map((a, ai) => (
                  <img key={ai} src={a.dataUrl} alt={a.name}
                    className="mt-1 max-h-32 max-w-full rounded border border-[var(--border)] block" />
                ))}
              </div>
            )}
            {/* Assistant text */}
            {m.role === 'assistant' && (
              <div className="text-[var(--text)]" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            )}
            {/* Thinking block */}
            {m.role === 'thinking' && (
              <details className="border border-purple-700/40 rounded bg-purple-900/10 px-2 py-1">
                <summary className="text-[9px] text-purple-400 cursor-pointer select-none uppercase tracking-widest">💭 Thinking</summary>
                <div className="mt-1 text-[10px] text-purple-300/70 font-mono" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              </details>
            )}
            {/* Tool use */}
            {m.role === 'tool_use' && (
              <details className="border border-sky-700/40 rounded bg-sky-900/10 px-2 py-1">
                <summary className="text-[9px] text-sky-400 cursor-pointer select-none">
                  <span className="uppercase tracking-widest">⚙ {m.toolName}</span>
                  <span className="ml-2 text-sky-500/60 font-mono">{Object.values(m.input)[0]?.toString().slice(0, 60) ?? ''}</span>
                </summary>
                <pre className="mt-1 text-[10px] text-sky-300/70 overflow-x-auto">{JSON.stringify(m.input, null, 2)}</pre>
              </details>
            )}
            {/* Tool result */}
            {m.role === 'tool_result' && (
              <details className="border border-emerald-700/40 rounded bg-emerald-900/10 px-2 py-1">
                <summary className="text-[9px] text-emerald-400 cursor-pointer select-none uppercase tracking-widest">↩ Result</summary>
                <pre className="mt-1 text-[10px] text-emerald-300/70 overflow-x-auto">{m.output}</pre>
              </details>
            )}
            {/* Completion */}
            {m.role === 'result' && (
              <div className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] pt-1 mt-1">{m.text}</div>
            )}
          </div>
        ))}
        {/* Live streaming block */}
        {liveBlockRef.current && (
          <div className={`text-[11px] leading-relaxed ${liveBlockRef.current.type === 'thinking' ? '' : ''}`}>
            {liveBlockRef.current.type === 'thinking' ? (
              <details open className="border border-purple-700/40 rounded bg-purple-900/10 px-2 py-1">
                <summary className="text-[9px] text-purple-400 cursor-pointer select-none uppercase tracking-widest">💭 Thinking…</summary>
                <div className="mt-1 text-[10px] text-purple-300/70 font-mono" style={{ whiteSpace: 'pre-wrap' }}>
                  {liveBlockRef.current.text}<span className="animate-pulse">▍</span>
                </div>
              </details>
            ) : (
              <div className="text-[var(--text)]" style={{ whiteSpace: 'pre-wrap' }}>
                {liveBlockRef.current.text}<span className="animate-pulse">▍</span>
              </div>
            )}
          </div>
        )}
        {running && !liveBlockRef.current && (
          <div className="text-[10px] text-[var(--text-muted)] animate-pulse">Claude 思考中…</div>
        )}

        {/* Hook event log — inline at bottom of chat */}
        {(logs ?? []).filter(l => !l.sessionId || l.sessionId === selectedId).map((log, i) => (
          <div key={`log-${i}`} className={`text-[10px] font-mono leading-5 ${
            log.level === 'user'       ? 'text-[var(--gold)]/70' :
            log.level === 'permission' ? 'text-amber-400/80' :
            'text-[var(--text-muted)]/60'
          }`}>{log.text ?? JSON.stringify(log)}</div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative group">
                {a.type.startsWith('image/') ? (
                  <img src={a.dataUrl} alt={a.name}
                    className="h-12 w-12 object-cover rounded border border-[var(--border)]" />
                ) : (
                  <div className="h-12 px-2 flex items-center rounded border border-[var(--border)] bg-[var(--surface-2)] text-[9px] text-[var(--text-muted)] max-w-[80px] truncate">
                    {a.name}
                  </div>
                )}
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 flex w-4 h-4 rounded-full bg-red-700/90 text-white text-[8px] items-center justify-center">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="p-2 flex gap-2 items-end">
          {/* + button */}
          <div className="relative" ref={attachMenuRef}>
            <button
              onClick={() => setShowAttachMenu(v => !v)}
              disabled={running}
              className="w-7 h-7 flex items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)] transition-colors text-sm disabled:opacity-40"
              title="附加檔案 / 新增任務">+</button>
            {showAttachMenu && (
              <div className="absolute bottom-full left-0 mb-1 w-44 bg-[var(--surface-2)] border border-[var(--border)] rounded shadow-lg z-20 overflow-hidden">
                <button onClick={() => { fileInputRef.current?.click() }}
                  className="w-full text-left px-3 py-2 text-[10px] text-[var(--text)] hover:bg-[var(--surface)] flex items-center gap-2">
                  <span>⬆</span> Upload from computer
                </button>
                <button onClick={() => {
                  const title = window.prompt('Task title:')
                  if (title?.trim() && selectedId) {
                    fetch(`/api/sessions/${selectedId}/tasks`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: title.trim(), status: 'pending' }),
                    }).then(() => {
                      setMessages(m => [...m, { role: 'system', text: `✓ Task created: ${title.trim()}`, ts: Date.now() }])
                      onTaskCreated?.()
                    })
                  }
                  setShowAttachMenu(false)
                }}
                  className="w-full text-left px-3 py-2 text-[10px] text-[var(--text)] hover:bg-[var(--surface)] flex items-center gap-2 border-t border-[var(--border)]">
                  <span>✓</span> Add task
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv"
              className="hidden" onChange={handleFileChange} />
          </div>

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="輸入訊息…"
            rows={2}
            disabled={running}
            className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-base md:text-[11px] text-[var(--text)] resize-none outline-none placeholder:text-[var(--text-muted)] disabled:opacity-50"
          />
          <div className="flex flex-col gap-1 shrink-0">
            <button
              onClick={handleSend}
              disabled={running || (!input.trim() && attachments.length === 0)}
              className="px-3 py-1.5 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/50 text-[var(--gold)] text-[10px] hover:bg-[var(--gold)]/30 disabled:opacity-40"
            >送出</button>
            {running && (
              <button onClick={handleStop}
                className="px-3 py-1.5 rounded bg-red-900/30 border border-red-700/50 text-red-300 text-[10px] hover:bg-red-800/50">
                停止
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const TABS = [
  { id: 'chat',      label: 'Chat' },
  { id: 'tasks',     label: 'Tasks' },
  { id: 'history',   label: 'History' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'claudemd',  label: 'CLAUDE.md' },
  { id: 'agents',    label: 'Agents' },
  { id: 'mcp',       label: 'MCP' },
]

const MOBILE_TABS = [
  { id: 'chat',     label: 'CHAT',     icon: '◻' },
  { id: 'tasks',    label: 'TASKS',    icon: '✓' },
  { id: 'history',  label: 'HISTORY',  icon: '◷' },
  { id: 'sessions', label: 'SESSIONS', icon: '◈' },
  { id: 'more',     label: 'MORE',     icon: '⋯' },
]

// ─── Mobile components ────────────────────────────────────────────────────────

function MobileSessionBar({ sessions, selectedId, setActiveTab, connected, onBountySettings }) {
  const sel = sessions.find(s => s.id === selectedId)
  return (
    <div className="flex md:hidden items-center gap-2 px-3 h-10 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
      {/* App title + connection dot */}
      <span className="text-[var(--gold)] font-semibold tracking-widest text-[9px] uppercase shrink-0">
        THE CLAUDENENTAL
      </span>
      <span className={`text-[8px] shrink-0 ${connected ? 'text-green-400' : 'text-red-400 pulse-amber'}`}>●</span>
      {/* Active session name */}
      {sel ? (
        <span className="flex items-center gap-1 flex-1 min-w-0">
          <StatusDot status={sel.status} />
          <span className="text-[10px] text-[var(--text-h)] truncate">{sel.displayName}</span>
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {/* Sessions switcher */}
      <button
        onClick={() => setActiveTab('sessions')}
        className="text-[9px] px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)] shrink-0"
      >◈</button>
      {/* Bounty settings */}
      <button
        onClick={onBountySettings}
        className="text-[var(--text-muted)] hover:text-[var(--gold)] text-xs shrink-0 px-1"
        title="Bounty Settings"
      >⚙</button>
    </div>
  )
}

function MobileTabBar({ activeTab, setActiveTab }) {
  return (
    <nav className="md:hidden shrink-0 flex items-center px-3 pt-2 bg-[var(--surface)] border-t border-[var(--border)]" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
      <div className="flex flex-1 h-[52px] bg-[var(--surface-2)] rounded-full border border-[var(--border)] p-1">
        {MOBILE_TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-full text-center transition-colors ${
              activeTab === t.id
                ? 'bg-[var(--gold)] text-[var(--bg)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <span className="text-[11px] leading-none">{t.icon}</span>
            <span className="text-[7px] font-semibold tracking-wide leading-none">{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function MobileSessionsPanel({ sessions, selectedId, setSelectedId, setActiveTab, onContinue, autoResumeMap, onToggleAutoResume, hitLimitSessions, historyCosts, onCostClick, onPermissionResponse, chatStage, chatRunning, chatLastDelta, chatBaseline }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        Sessions
      </div>
      <ActivityHeat />
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {sessions.map(s => (
          <SessionItem
            key={s.id}
            session={{ ...s, costUsd: historyCosts?.[s.id] ?? s.costUsd ?? null }}
            isSelected={s.id === selectedId}
            onClick={() => {
              setSelectedId(s.id)
              setActiveTab('chat')
              if (s.cwd) onContinue?.({ sessionId: s.id, projectPath: s.cwd })
            }}
            onDoubleClick={() => {}}
            onCostClick={() => onCostClick?.(s)}
            autoResumeArmed={autoResumeMap?.[s.id]?.enabled === true}
            autoResumeFireAt={autoResumeMap?.[s.id]?.fireAt ?? null}
            onToggleAutoResume={() => onToggleAutoResume?.(s.id)}
            hitLimit={hitLimitSessions?.has(s.id) ?? false}
            isChatSession={s.id === selectedId}
            chatStage={s.id === selectedId ? chatStage : 1}
            chatRunning={s.id === selectedId ? chatRunning : 0}
            chatLastDelta={s.id === selectedId ? chatLastDelta : null}
            chatBaseline={s.id === selectedId ? chatBaseline : 0}
            onPermissionResponse={onPermissionResponse}
          />
        ))}
        {sessions.length === 0 && <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">No sessions yet</div>}
      </div>
    </div>
  )
}

function MobileMorePanel({ selected, send, logs, sessions }) {
  const [sub, setSub] = useState('agent')
  const SUB = ['agent', 'analytics', 'claude.md', 'agents', 'mcp', 'hooks']
  return (
    <div className="flex flex-col h-full">
      <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        {SUB.map(t => (
          <button key={t} onClick={() => setSub(t)}
            className={`px-3 py-2 text-[9px] uppercase tracking-wider shrink-0 border-b-2 transition-colors ${
              sub === t ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-transparent text-[var(--text-muted)]'
            }`}>{t}</button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {sub === 'agent' && (
          <div className="flex flex-col h-full overflow-y-auto">
            <CharacterZone status={selected?.status ?? 'idle'} />
            {selected?.pendingPermission && (
              <div className="mx-3 mb-3 border border-amber-500/50 rounded p-2 bg-amber-900/10">
                <div className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider mb-1 pulse-amber">⏳ Permission</div>
                <div className="text-[10px] text-[var(--text)] mb-1 font-mono truncate">{selected.pendingPermission.toolName}</div>
                <div className="text-[9px] text-[var(--text-muted)] mb-2 break-all line-clamp-2">{selected.pendingPermission.summary}</div>
                <div className="flex gap-1">
                  <button onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'approve' })} className="flex-1 py-1 rounded bg-green-900/40 border border-green-700 text-green-300 text-[10px]">✓ Allow</button>
                  <button onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'allow_always' })} className="flex-1 py-1 rounded bg-yellow-900/40 border border-yellow-600 text-yellow-300 text-[10px]">⭐ Always</button>
                  <button onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'block' })} className="flex-1 py-1 rounded bg-red-900/40 border border-red-700 text-red-300 text-[10px]">✕ Block</button>
                </div>
              </div>
            )}
            <div className="px-3 py-2 border-t border-[var(--border)] flex-1 overflow-y-auto">
              <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Checkpoints</div>
              <CheckpointsPanel selected={selected} />
            </div>
          </div>
        )}
        {sub === 'analytics' && <AnalyticsPanel sessions={sessions} />}
        {sub === 'claude.md'  && <ClaudeMdPanel selected={selected} />}
        {sub === 'agents'     && <AgentsPanel />}
        {sub === 'mcp'        && <McpPanel />}
        {sub === 'hooks'      && (
          <div className="flex-1 overflow-y-auto px-3 py-1 font-mono text-[10px]">
            {logs.length === 0 && <span className="text-[var(--text-muted)]">Waiting for events…</span>}
            {logs.map((l, i) => (
              <div key={i} className={`leading-5 ${l.level === 'user' ? 'text-[var(--gold)]' : l.level === 'permission' ? 'text-amber-400' : 'text-[var(--text-muted)]'}`}>{l.text ?? JSON.stringify(l)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Stage 4 full-screen summary overlay ─────────────────────────────────────

function Stage4Anim({ baseline, chatRunning, onDone }) {
  const newTotal = baseline + chatRunning
  const [phase, setPhase] = useState(0)
  // phase 0→1: chat total 金→綠 (0.8s)
  // phase 1→2: baseline 灰→金 (1.8s)
  // phase 2→3: show merged total (3.0s)
  useEffect(() => {
    const T = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1800),
      setTimeout(() => setPhase(3), 3000),
    ]
    return () => T.forEach(clearTimeout)
  }, [])
  return (
    <div className="flex flex-col items-center gap-3 text-center px-6">
      <div className="flex items-baseline gap-3">
        <span className={`text-4xl font-bold tabular-nums transition-colors duration-700 ${
          phase >= 1 ? 'text-green-400' : 'text-[var(--gold)]'
        }`}>+{fmtCost(chatRunning)}</span>
        <span className="text-[var(--text-muted)] text-xl">+</span>
        <span className={`text-2xl tabular-nums transition-colors duration-700 ${
          phase >= 2 ? 'text-[var(--gold)]' : 'text-gray-600'
        }`}>{fmtCost(baseline)}</span>
      </div>
      {phase >= 3 && (
        <>
          <div className="text-[8px] text-[var(--gold)]/50 tracking-[0.3em] uppercase mt-2">New Session Total</div>
          <div className="text-5xl font-bold text-[var(--gold)] tabular-nums">{fmtCost(newTotal)}</div>
        </>
      )}
      <button onClick={onDone}
        className="mt-4 text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] tracking-[0.2em] uppercase
          border-b border-transparent hover:border-[var(--gold)]/50 transition-colors">
        Dismiss
      </button>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [logs, setLogs] = useState([])
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const [streamEvents, setStreamEvents] = useState([])
  const [chatInit, setChatInit] = useState(null)

  // ── Bounty system ────────────────────────────────────────────────────────
  const [bountySettings, setBountySettings]     = useState({})
  const [animQueue, setAnimQueue]               = useState([])
  const [currentAnim, setCurrentAnim]           = useState(null)
  const [showBountySettings, setShowBountySettings] = useState(false)
  const [contractModal, setContractModal]       = useState(null)
  const [historyCosts, setHistoryCosts]         = useState({})   // { [sessionId]: costUsd }
  const [chatBaseline, setChatBaseline]         = useState(0)    // historyCosts snapshot when chatInit last fired
  // ── 5-Stage chat cost display (lives in SessionItem Row 3) ──────────────
  const [chatStage, setChatStage]       = useState(1)   // 1=idle 2=flash 3=running 4=done
  const [chatRunning, setChatRunning]   = useState(0)   // cost accumulated this chat
  const [chatLastDelta, setChatLastDelta] = useState(null)


  // Track which session is currently open in Chat (for animation gating)
  const activeChatSessionRef  = useRef(null)
  const activeTabRef           = useRef('chat')
  // Timestamp of last session switch — used to skip session_live replay batches
  const sessionLiveStartRef    = useRef(0)

  useEffect(() => { activeChatSessionRef.current = selectedId }, [selectedId])
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  // Load bounty settings + seed historyCosts from history API once
  useEffect(() => {
    fetch('/api/bounty/settings').then(r => r.json()).then(setBountySettings).catch(() => {})
    fetch('/api/history').then(r => r.json()).then(d => {
      const map = {}
      for (const s of d.sessions ?? []) {
        if (s.costUsd != null) map[s.sessionId] = s.costUsd
      }
      setHistoryCosts(map)
    }).catch(() => {})
  }, [])

  // ── Auto-resume per-session state ────────────────────────────────────────
  // { [sessionId]: { enabled, message, fireAt } }
  const [autoResumeMap, setAutoResumeMap] = useState({})
  // Sessions where usage limit was hit (shows ⏰ even if status != sleeping)
  const [hitLimitSessions, setHitLimitSessions] = useState(new Set())

  // Global timer: fire any armed resumes when cooldown expires
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      setAutoResumeMap(prev => {
        let changed = false
        const next = { ...prev }
        for (const [sid, ar] of Object.entries(prev)) {
          if (!ar.enabled || !ar.fireAt) continue
          if (now < ar.fireAt) continue
          // Time to fire — find session cwd
          const sess = sessions.find(s => s.id === sid)
          if (sess?.cwd && (sess.status === 'sleeping' || hitLimitSessions.has(sid))) {
            fetch('/api/claude/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectPath: sess.cwd, prompt: ar.message || '請繼續', sessionId: sid }),
            }).catch(() => {})
          }
          next[sid] = { ...ar, enabled: false, fired: true }
          changed = true
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  function toggleAutoResume(sessionId) {
    setAutoResumeMap(prev => {
      const cur = prev[sessionId]
      if (cur?.enabled) {
        // Disarm
        const next = { ...prev }
        delete next[sessionId]
        return next
      }
      // Arm: compute 整點 fire time
      const sess = sessions.find(s => s.id === sessionId)
      const cooldownExpiry = (sess?.sleepingAt ?? Date.now()) + SESSION_LIMIT_MS
      const fireAt = nextWholeHourAfter(cooldownExpiry)
      return { ...prev, [sessionId]: { enabled: true, message: '請繼續', fireAt } }
    })
  }

  // Cost engine — receives stream events and fires animation triggers
  const costSnap = useCostEngine(streamEvents, (anim) => {
    const { key, delta } = anim
    // Resolve session from key
    const sessById  = key.startsWith('session:') ? sessions.find(s => s.id === key.slice(8)) : null
    const sessByCwd = !sessById ? sessions.find(s => normPath(s.cwd) === key) : null
    const sess = sessById ?? sessByCwd

    // ADD delta to historyCosts baseline for live subprocess runs only.
    // session_live events are historical replays already captured in the API baseline — skip them.
    const trueTotal = (historyCosts[sess?.id] ?? 0) + delta
    if (sess && !key.startsWith('session:')) {
      setHistoryCosts(prev => ({ ...prev, [sess.id]: (prev[sess.id] ?? 0) + delta }))
    }

    // Fire animation only when Chat tab is active AND this is the currently open session
    const activeSid = activeChatSessionRef.current
    const isCurrentChat = sess
      ? sess.id === activeSid
      : key === normPath('') // fallback: never match
    if (activeTabRef.current === 'chat' && isCurrentChat) {
      setAnimQueue(q => [...q, { ...anim, total: trueTotal, sessionName: sess?.displayName ?? '' }])
    }
  })

  // Drain animation queue one at a time
  useEffect(() => {
    if (currentAnim || animQueue.length === 0) return
    const [next, ...rest] = animQueue
    setAnimQueue(rest)
    setCurrentAnim(next)
  }, [animQueue, currentAnim])

  function handleAnimDone() { setCurrentAnim(null) }

  function normPath(p) { return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') }

  // Determine anim component type
  const animTier  = currentAnim?.tier
  const animLevel = currentAnim?.level
  const isPreview = !!currentAnim?._uid
  // L3/L4 = toast; L1/L2 = badge-only (preview exception: show as toast)
  const isToast   = animTier === 'L' && ((animLevel === 3 || animLevel === 4) || (animLevel <= 2 && isPreview))
  // H/S/C always overlay; L tiers never overlay
  const isOverlay = animTier != null && animTier !== 'L'

  function handleContinueInChat({ sessionId, projectPath }) {
    setChatBaseline(historyCosts[sessionId] ?? 0)
    setChatRunning(0)
    setChatLastDelta(null)
    setChatStage(1)
    setChatInit({ sessionId, projectPath })
    setActiveTab('chat')
  }

  // Reset stage state whenever the selected session changes
  useEffect(() => {
    if (!selectedId) return
    setChatBaseline(historyCosts[selectedId] ?? 0)
    setChatRunning(0)
    setChatLastDelta(null)
    setChatStage(1)
    // Give replays 3s to flush before we start processing session_live cost events
    sessionLiveStartRef.current = Date.now() + 3000
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Keep chatBaseline in sync when historyCosts loads (covers async API + auto-selected sessions)
  const selectedCost = selectedId ? (historyCosts[selectedId] ?? 0) : 0
  useEffect(() => {
    if (selectedId && chatStage === 1) setChatBaseline(selectedCost)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCost])

  // Stage 2 → 3 auto-transition (2.5s after first token)
  useEffect(() => {
    if (chatStage !== 2) return
    const t = setTimeout(() => setChatStage(3), 2500)
    return () => clearTimeout(t)
  }, [chatStage])

  // Watch streamEvents to drive chat cost stages (both dashboard chat and external VS Code)
  useEffect(() => {
    if (!streamEvents.length || !selectedId) return
    const ev = streamEvents[streamEvents.length - 1]

    // ── claude_stream: subprocess events from dashboard ChatPanel ─────────
    if (ev.type === 'claude_stream') {
      const activeSession = sessions.find(s => s.id === selectedId)
      if (!activeSession?.cwd || normPath(ev.projectPath) !== normPath(activeSession.cwd)) return
      const { event } = ev
      if (event?.type === 'assistant' && event.message?.usage) {
        const d = computeDeltaCost(event.message?.model ?? '', event.message.usage)
        setChatRunning(r => r + d)
        setChatLastDelta(d)
        setChatStage(s => s === 1 ? 2 : s)
      } else if (event?.type === 'result') {
        if (!hitLimitSessions.has(selectedId)) {
          setChatStage(s => (s === 2 || s === 3) ? 4 : s)
        }
      }
      return
    }

    // ── session_live: VS Code external session live tail ─────────────────
    if (ev.type === 'session_live' && ev.sessionId === selectedId) {
      // Skip replay batches arriving within 3s of session switch
      if ((ev._arrivalTs ?? 0) < sessionLiveStartRef.current) return
      for (const msg of ev.messages ?? []) {
        if (msg.type === 'assistant' && msg.message?.usage) {
          const d = computeDeltaCost(msg.message?.model ?? '', msg.message.usage)
          setChatRunning(r => r + d)
          setChatLastDelta(d)
          setChatStage(s => s === 1 ? 2 : s)
        }
        if (msg.type === 'result') {
          if (!hitLimitSessions.has(selectedId)) {
            setChatStage(s => (s === 2 || s === 3) ? 4 : s)
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEvents])
  // Auto-watch active sessions so session_live events flow into cost engine
  const watchedRef = useRef(new Set())
  function autoWatch(sessionId) {
    if (!sessionId || watchedRef.current.has(sessionId)) return
    watchedRef.current.add(sessionId)
    fetch('/api/session/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }

  const { connected, send } = useWebSocket(WS_URL, msg => {
    if (msg.type === 'state') {
      setSessions(msg.sessions)
      setSelectedId(prev => prev ?? msg.sessions[0]?.id ?? null)
      if (msg.logs) setLogs(msg.logs)  // replace on reconnect, not append
      // Auto-watch all active sessions on reconnect
      for (const s of msg.sessions ?? []) {
        if (s.status === 'active') autoWatch(s.id)
      }
    }
    if (msg.type === 'log') setLogs(prev => [...prev.slice(-200), msg])
    if (msg.type === 'session') {
      // Auto-watch when a session becomes active
      if (msg.session?.status === 'active') autoWatch(msg.session.id)
      // Cancel armed auto-resume if session woke up on its own (credits added / account switched)
      if (msg.session?.status !== 'sleeping') {
        setAutoResumeMap(prev => {
          if (!prev[msg.session.id]?.enabled) return prev
          const next = { ...prev }
          delete next[msg.session.id]
          return next
        })
        // Clear hit-limit flag once session becomes active again
        if (msg.session?.status === 'active') {
          setHitLimitSessions(prev => { const s = new Set(prev); s.delete(msg.session.id); return s })
        }
      }
      // When session finishes, pull final cost from server (covers externally-ended sessions)
      if (msg.session?.status === 'done') {
        fetch(`/api/history/${msg.session.id}`).then(r => r.json()).then(d => {
          if (d.costUsd != null)
            setHistoryCosts(prev => ({ ...prev, [msg.session.id]: d.costUsd }))
        }).catch(() => {})
      }
      setSessions(prev => {
        const exists = prev.some(s => s.id === msg.session.id)
        const next = exists
          ? prev.map(s => s.id === msg.session.id ? msg.session : s)
          : [...prev, msg.session]
        return next
      })
      setSelectedId(prev => prev ?? msg.session.id)
    }
    if (msg.type === 'session_remove') {
      setSessions(prev => prev.filter(s => s.id !== msg.sessionId))
      setSelectedId(prev => prev === msg.sessionId ? null : prev)
    }
    if (msg.type === 'claude_stream' || msg.type === 'session_live') {
      setStreamEvents(prev => [...prev.slice(-200), { ...msg, _arrivalTs: Date.now() }])

      // Detect usage limit hit — auto-arm ⏰ button
      const isLimit = (() => {
        if (msg.type === 'session_live') {
          return (msg.messages ?? []).some(m =>
            typeof m.text === 'string' && m.text.includes("hit your limit")
          )
        }
        if (msg.type === 'claude_stream') {
          const ev = msg.event ?? msg
          return typeof ev.text === 'string' && ev.text.includes("hit your limit")
        }
        return false
      })()

      if (isLimit) {
        const sid = msg.sessionId
        if (sid) {
          setHitLimitSessions(prev => { const s = new Set(prev); s.add(sid); return s })
          // Auto-arm auto-resume at next whole hour
          setAutoResumeMap(prev => {
            if (prev[sid]?.enabled) return prev  // already armed
            const fireAt = nextWholeHourAfter(Date.now())
            return { ...prev, [sid]: { enabled: true, message: '請繼續', fireAt, autoArmed: true } }
          })
        }
      }
    }
  })

  const selected = sessions.find(s => s.id === selectedId)

  function handleGateAction(taskId, action) {
    send({ type: 'gate', sessionId: selectedId, taskId, action })
    // Optimistic update
    setSessions(prev => prev.map(s => {
      if (s.id !== selectedId) return s
      function updateTask(tasks) {
        return tasks.map(t => {
          if (t.id === taskId && t.gate) {
            const statusMap = { approve: 'approved', force: 'force', block: 'blocked' }
            return { ...t, gate: { ...t.gate, status: statusMap[action] ?? action } }
          }
          return { ...t, children: updateTask(t.children ?? []) }
        })
      }
      return { ...s, tasks: updateTask(s.tasks) }
    }))
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg)] text-[var(--text)]">

      {/* ── Bounty overlays ── */}
      {isToast && currentAnim && (
        <BountyToast key={currentAnim._uid ?? 'toast'} anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {isOverlay && currentAnim && (
        <BountyOverlay key={currentAnim._uid ?? 'overlay'} anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {/* Stage 4 — full-screen chat session summary */}
      {chatStage === 4 && (
        <div className="fixed inset-0 z-[75] flex flex-col items-center justify-center gap-4 overlay-in"
          style={{ background: 'rgba(0,0,0,0.96)' }}>
          <div className="text-[7px] text-[var(--gold)]/40 tracking-[0.35em] uppercase">─── The Continental ───</div>
          <div className="text-[10px] text-[var(--gold)]/70 tracking-widest uppercase mb-2">Chat Session Settled</div>
          <Stage4Anim baseline={chatBaseline} chatRunning={chatRunning}
            onDone={() => setChatStage(1)} />
        </div>
      )}
      {contractModal && (
        <ContractModal
          sessionName={contractModal.sessionName}
          costData={contractModal.costData}
          onClose={() => setContractModal(null)}
        />
      )}
      {showBountySettings && (
        <BountySettings
          onClose={() => setShowBountySettings(false)}
          onPreview={tierStr => {
            setShowBountySettings(false)
            const t = tierStr === 'C' ? 'C' : tierStr[0]
            const l = tierStr === 'C' ? null : parseInt(tierStr[1])
            // _uid forces BountyOverlay/BountyToast to remount even if same tier
            setCurrentAnim({ tier: t, level: l, delta: 0.18, total: 2.34, sessionName: 'Preview', _uid: Date.now() })
          }}
        />
      )}

      {/* ── Top bar — desktop only ── */}
      <header className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        <span className="text-[var(--gold)] font-semibold tracking-widest text-xs uppercase">
          The Claudenental
        </span>
        <span className="text-[var(--border-2)]">|</span>
        <span className={`text-[10px] flex items-center gap-1 ${connected ? 'text-green-400' : 'text-red-400'}`}>
          <span className={connected ? '' : 'pulse-amber'}>{connected ? '●' : '◌'}</span>
          {connected ? 'Connected' : 'Reconnecting…'}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--text-muted)]">
          {sessions.filter(s => s.status === 'active').length} active · {sessions.length} sessions
        </span>
        <button
          onClick={() => setShowBountySettings(true)}
          title="Bounty Announcement Settings"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase">
          ⚙ Bounty
        </button>
      </header>

      {/* ── Main layout ── */}
      <div className="flex flex-1 min-h-0">

        {/* Left: Sessions list — desktop only */}
        <aside className="hidden md:flex w-52 shrink-0 border-r border-[var(--border)] flex-col bg-[var(--surface)] overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] flex items-center">
            <span className="flex-1">Sessions</span>
            <button
              onClick={() => fetch('/api/sessions/clear-inactive', { method: 'POST' })}
              title="清除已完成的 sessions"
              className="text-[var(--text-muted)] hover:text-red-400 transition-colors text-[11px] leading-none"
            >
              ✕
            </button>
          </div>
          <ActivityHeat />
          <div className="flex-1 overflow-y-auto py-1 px-1">
            {sessions.map(s => (
              renamingId === s.id
                ? (
                  <div key={s.id} className="px-2 py-1">
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={e => setRenameVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          send({ type: 'rename', sessionId: s.id, name: renameVal.trim() || s.displayName })
                          setRenamingId(null)
                        }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={() => setRenamingId(null)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--gold-border)] rounded px-2 py-1 text-[11px] text-[var(--text-h)] focus:outline-none"
                    />
                  </div>
                )
                : (
                  <SessionItem
                    key={s.id}
                    session={{ ...s, costUsd: historyCosts[s.id] ?? s.costUsd ?? null }}
                    isSelected={s.id === selectedId}
                    onClick={() => {
                      setSelectedId(s.id)
                      if (s.cwd) handleContinueInChat({ sessionId: s.id, projectPath: s.cwd })
                    }}
                    onDoubleClick={() => { setRenamingId(s.id); setRenameVal(s.displayName) }}
                    onCostClick={async () => {
                      const live = costSnap[`session:${s.id}`] ?? costSnap[normPath(s.cwd)]
                      const d = await fetch(`/api/history/${s.id}`).then(r => r.json()).catch(() => ({}))
                      const total = historyCosts[s.id] ?? live?.total ?? d.costUsd ?? 0
                      setContractModal({
                        sessionName: s.displayName,
                        costData: { total, byType: live?.byType ?? d.byType ?? {}, byModel: live?.byModel ?? d.byModel ?? {} },
                      })
                    }}
                    autoResumeArmed={autoResumeMap[s.id]?.enabled === true}
                    autoResumeFireAt={autoResumeMap[s.id]?.fireAt ?? null}
                    onToggleAutoResume={() => toggleAutoResume(s.id)}
                    hitLimit={hitLimitSessions.has(s.id)}
                    isChatSession={s.id === selectedId}
                    chatStage={s.id === selectedId ? chatStage : 1}
                    chatRunning={s.id === selectedId ? chatRunning : 0}
                    chatLastDelta={s.id === selectedId ? chatLastDelta : null}
                    chatBaseline={s.id === selectedId ? chatBaseline : 0}
                    onPermissionResponse={(permId, action) => send({ type: 'permission_response', permissionId: permId, action })}
                  />
                )
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-4 text-[10px] text-[var(--text-muted)] text-center">
                No sessions yet
              </div>
            )}
          </div>
        </aside>

        {/* Center: Tab panel */}
        <main className="flex-1 flex flex-col min-w-0">

          {/* Mobile: session indicator */}
          <MobileSessionBar sessions={sessions} selectedId={selectedId} setActiveTab={setActiveTab} connected={connected} onBountySettings={() => setShowBountySettings(true)} />

          {/* Tab bar — desktop only */}
          <div className="hidden md:flex items-center border-b border-[var(--border)] bg-[var(--surface)] shrink-0 overflow-x-auto">
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-[10px] uppercase tracking-widest shrink-0 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-[var(--gold)] text-[var(--gold)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}>
                {tab.label}
                {tab.id === 'tasks' && selected && (
                  <span className="ml-1 text-[var(--border-2)]">/ {selected.displayName}</span>
                )}
              </button>
            ))}
            {selected && <StatusDot status={selected.status} />}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {activeTab === 'chat' && (
              <ChatPanel streamEvents={streamEvents} chatInit={chatInit} logs={logs} selectedId={selectedId}
                onTaskCreated={() => setActiveTab('tasks')} />
            )}
            {activeTab === 'tasks' && (
              <div className="py-2 px-2 h-full">
                {selected?.tasks?.length > 0
                  ? selected.tasks.map(task => (
                      <TaskNode key={task.id} task={task} onGateAction={handleGateAction} />
                    ))
                  : <div className="text-[var(--text-muted)] text-xs text-center mt-8">{selected ? 'No tasks yet' : 'Select a session'}</div>
                }
              </div>
            )}
            {activeTab === 'history'   && <HistoryPanel onContinue={handleContinueInChat} />}
            {activeTab === 'analytics' && <AnalyticsPanel sessions={sessions} />}
            {activeTab === 'claudemd'  && <ClaudeMdPanel selected={selected} />}
            {activeTab === 'agents'    && <AgentsPanel />}
            {activeTab === 'mcp'       && <McpPanel />}
            {/* Mobile-only tabs */}
            {activeTab === 'sessions'  && <MobileSessionsPanel sessions={sessions} selectedId={selectedId} setSelectedId={setSelectedId} setActiveTab={setActiveTab} onContinue={handleContinueInChat} autoResumeMap={autoResumeMap} onToggleAutoResume={toggleAutoResume} hitLimitSessions={hitLimitSessions} historyCosts={historyCosts}
              onCostClick={async s => {
                const live = costSnap[`session:${s.id}`] ?? costSnap[normPath(s.cwd)]
                const d = await fetch(`/api/history/${s.id}`).then(r => r.json()).catch(() => ({}))
                const total = historyCosts[s.id] ?? live?.total ?? d.costUsd ?? 0
                setContractModal({ sessionName: s.displayName, costData: { total, byType: live?.byType ?? d.byType ?? {}, byModel: live?.byModel ?? d.byModel ?? {} } })
              }}
              onPermissionResponse={(permId, action) => send({ type: 'permission_response', permissionId: permId, action })}
              chatStage={chatStage} chatRunning={chatRunning} chatLastDelta={chatLastDelta} chatBaseline={chatBaseline}
            />}
            {activeTab === 'more'      && <MobileMorePanel selected={selected} send={send} logs={logs} sessions={sessions} />}
          </div>

        </main>

        {/* Right: Character + Gate summary — desktop only */}
        <aside className="hidden md:flex w-48 shrink-0 border-l border-[var(--border)] flex-col bg-[var(--surface)] overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
            Agent
          </div>
          <CharacterZone status={selected?.status ?? 'idle'} />

          {/* Permission request card */}
          {selected?.pendingPermission && (
            <div className="mx-2 mb-2 border border-amber-500/50 rounded p-2 bg-amber-900/10">
              <div className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider mb-1 pulse-amber">
                ⏳ Permission Request
              </div>
              <div className="text-[10px] text-[var(--text)] mb-1 font-mono truncate">
                {selected.pendingPermission.toolName}
              </div>
              <div className="text-[9px] text-[var(--text-muted)] mb-2 break-all line-clamp-2">
                {selected.pendingPermission.summary}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'approve' })}
                  className="flex-1 py-1 rounded bg-green-900/40 border border-green-700 text-green-300 hover:bg-green-800/60 text-[10px]"
                >
                  ✓ Allow
                </button>
                <button
                  onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'allow_always' })}
                  className="flex-1 py-1 rounded bg-yellow-900/40 border border-yellow-600 text-yellow-300 hover:bg-yellow-800/60 text-[10px]"
                >
                  ⭐ Always
                </button>
                <button
                  onClick={() => send({ type: 'permission_response', permissionId: selected.pendingPermission.permissionId, action: 'block' })}
                  className="flex-1 py-1 rounded bg-red-900/40 border border-red-700 text-red-300 hover:bg-red-800/60 text-[10px]"
                >
                  ✕ Block
                </button>
              </div>
            </div>
          )}

          {/* Sleeping notification */}
          {selected?.status === 'sleeping' && (
            <div className="mx-2 mb-2 border border-gray-600 rounded p-2 bg-gray-900/20">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-gray-400 shimmer">💤 Token 用量已達上限</div>
                {autoResumeMap[selected.id]?.enabled && (
                  <div className="text-[9px] text-amber-400 pulse-amber shrink-0 ml-2">⏰ 整點自動繼續</div>
                )}
              </div>
              <CooldownTimer sleepingAt={selected.sleepingAt ?? null} />
            </div>
          )}

          {/* Checkpoints */}
          <div className="px-3 py-2 border-t border-[var(--border)] flex-1 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">Checkpoints</div>
            <CheckpointsPanel selected={selected} />
          </div>

          {/* Pending gates summary */}
          <div className="px-3 py-2 border-t border-[var(--border)] shrink-0">
            <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
              Pending Gates
            </div>
            {(() => {
              const pending = []
              function collect(tasks) {
                for (const t of tasks ?? []) {
                  if (t.gate?.status === 'pending') pending.push(t)
                  collect(t.children)
                }
              }
              collect(selected?.tasks)
              return pending.length === 0
                ? <div className="text-[10px] text-[var(--text-muted)]">None</div>
                : pending.map(t => (
                  <div key={t.id} className="text-[10px] text-amber-400 pulse-amber truncate mb-1">
                    ◐ {GATE_LABEL[t.gate.id] ?? `Gate ${t.gate.id}`}
                  </div>
                ))
            })()}
          </div>
        </aside>

      </div>

      {/* Mobile bottom tab bar */}
      <MobileTabBar activeTab={activeTab} setActiveTab={setActiveTab} />
    </div>
  )
}
