import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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

// ─── Rating System ────────────────────────────────────────────────────────────
// 被動訊號（不評分）= 可接受，低權重；主動訊號（明確評分）= 高權重。
// 兩者共同描繪「規矩」（好球帶），定期分析後寫入偏好文字。

const RATING_KEY    = 'tc_ratings_v1'   // localStorage cache key
const PREF_TEXT_KEY = 'tc_pref_text'    // localStorage cache key

// ── localStorage helpers (cache layer) ──
function loadRatingsCache() {
  try { return JSON.parse(localStorage.getItem(RATING_KEY) || '[]') } catch { return [] }
}
function writeRatingsCache(all) {
  localStorage.setItem(RATING_KEY, JSON.stringify(all.slice(-1000)))
}
function loadRatingById(id) { return loadRatingsCache().find(r => r.id === id) || null }

// ── Server helpers (source of truth) ──
async function fetchRatingsFromServer() {
  try {
    const d = await fetch('/api/ratings').then(r => r.json())
    const all = d.ratings ?? []
    writeRatingsCache(all)   // keep cache in sync
    return all
  } catch { return loadRatingsCache() }  // offline fallback
}

function saveRating(r) {
  // 1. 立即寫入 localStorage（帶 _pendingSync 標記）
  const entry = { ...r, _pendingSync: true }
  const all = loadRatingsCache()
  const idx = all.findIndex(x => x.id === r.id)
  if (idx >= 0) all[idx] = entry; else all.push(entry)
  writeRatingsCache(all)
  // 2. 送上 server，成功後清除 _pendingSync
  fetch('/api/ratings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: r }),
  }).then(res => {
    if (res.ok) {
      const fresh = loadRatingsCache()
      const i2 = fresh.findIndex(x => x.id === r.id)
      if (i2 >= 0) { fresh[i2] = { ...fresh[i2], _pendingSync: false }; writeRatingsCache(fresh) }
    }
  }).catch(() => {}) // 保留 _pendingSync:true，等下次載頁重送
}

// 頁面載入時，把上次沒送到的評分補送
function flushPendingSync() {
  const all = loadRatingsCache()
  const pending = all.filter(r => r._pendingSync)
  for (const r of pending) {
    const clean = { ...r }; delete clean._pendingSync
    fetch('/api/ratings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: clean }),
    }).then(res => {
      if (res.ok) {
        const fresh = loadRatingsCache()
        const i = fresh.findIndex(x => x.id === r.id)
        if (i >= 0) { fresh[i] = { ...fresh[i], _pendingSync: false }; writeRatingsCache(fresh) }
      }
    }).catch(() => {})
  }
}

// loadRatings used by PreferencesPanel — pulls from server for fresh cross-device data
async function loadRatings() { return fetchRatingsFromServer() }

function extractFeatures(text) {
  if (!text) return {}
  return {
    len:        text.length,
    hasCode:    /```/.test(text),
    hasList:    /^[\-\*\d]\.?\s/m.test(text),
    hasHeaders: /^#{1,3}\s/m.test(text),
    paraCount:  (text.match(/\n\n+/g) || []).length + 1,
  }
}

function analyzeRatings(ratings) {
  if (!ratings || ratings.length < 3) return null
  const explicit = ratings.filter(r => r.explicit)
  const ups      = explicit.filter(r => r.reaction === 'up')
  const downs    = explicit.filter(r => r.reaction === 'down')
  const passive  = ratings.filter(r => !r.explicit)
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null
  const avgUpLen   = avg(ups.map(r => r.features?.len).filter(Boolean))
  const avgDownLen = avg(downs.map(r => r.features?.len).filter(Boolean))
  const avgPassLen = avg(passive.map(r => r.features?.len).filter(Boolean))
  const fRate = (list, f) => list.length ? list.filter(r => r.features?.[f]).length / list.length : 0
  const feats = {}
  for (const f of ['hasCode', 'hasList', 'hasHeaders']) {
    feats[f] = { up: fRate(ups, f), down: fRate(downs, f), pass: fRate(passive, f) }
  }
  const tagMap = {}
  for (const r of explicit) {
    for (const tag of r.tags || []) {
      if (!tagMap[tag]) tagMap[tag] = { up: 0, down: 0 }
      tagMap[tag][r.reaction || 'up']++
    }
  }

  // ── 方向偵測（第二層）────────────────────────────────────────────────────
  const wrongDir        = explicit.filter(r => r.tags?.includes('方向偏了'))
  const wrongDirRatio   = explicit.length > 0 ? wrongDir.length / explicit.length : 0
  // 近10筆趨勢
  const recent10        = explicit.slice(-10)
  const recentWrongDir  = recent10.filter(r => r.tags?.includes('方向偏了'))
  const recentRatio     = recent10.length > 0 ? recentWrongDir.length / recent10.length : 0
  // 特徵相關：哪類回應容易方向偏
  const wdFeats = {}
  for (const f of ['hasCode', 'hasList', 'hasHeaders']) {
    const wdWithF  = wrongDir.filter(r => r.features?.[f]).length
    const allWithF = explicit.filter(r => r.features?.[f]).length
    wdFeats[f] = allWithF > 0 ? wdWithF / allWithF : 0
  }
  const wdLong = wrongDir.filter(r => (r.features?.len || 0) > 500).length
  const allLong = explicit.filter(r => (r.features?.len || 0) > 500).length
  wdFeats.longMsg = allLong > 0 ? wdLong / allLong : 0
  // 警示等級
  const wdLevel = recentRatio >= 0.3 ? 'high' : recentRatio >= 0.15 ? 'mid' : wrongDirRatio >= 0.15 ? 'low' : 'ok'

  return { total: ratings.length, explicit: explicit.length, ups: ups.length, downs: downs.length,
           passive: passive.length, avgUpLen, avgDownLen, avgPassLen, feats, tagMap,
           wrongDir: { count: wrongDir.length, ratio: wrongDirRatio, recentRatio, wdFeats, level: wdLevel } }
}

function generatePrefText(a) {
  if (!a) return ''
  const lines = []
  if (a.avgUpLen && a.avgDownLen) {
    if (a.avgUpLen < a.avgDownLen - 100)
      lines.push(`回應長度：偏短（約 ${a.avgUpLen} 字為佳，超過會顯冗長）`)
    else
      lines.push(`回應長度：約 ${a.avgUpLen} 字左右即可`)
  } else if (a.avgPassLen) {
    lines.push(`回應長度：目前接受約 ${a.avgPassLen} 字`)
  }
  const { hasCode, hasList, hasHeaders } = a.feats
  if (hasList?.up > 0.6)    lines.push('結構：偏好條列式，少用大段落')
  if (hasList?.down > 0.6)  lines.push('結構：偏好段落式，避免大量條列')
  if (hasCode?.up > 0.5)    lines.push('程式碼區塊：歡迎適度使用')
  if (hasHeaders?.down > 0.5) lines.push('標題層級：避免過多，保持輕量')
  const topDown = Object.entries(a.tagMap).filter(([,v]) => v.down > 0).sort((x,y) => y[1].down - x[1].down).slice(0,3).map(([k]) => k)
  if (topDown.includes('太長'))    lines.push('給出答案後不要繼續延伸，直接停')
  if (topDown.includes('太囉嗦'))  lines.push('不要重述問題或做開場白，直接進入正題')
  if (topDown.includes('太短') || topDown.includes('需要更多細節')) lines.push('回答請充分展開，不要點到為止')
  // 方向偵測注入
  const wd = a.wrongDir
  if (wd?.level === 'high')
    lines.push(`⚠️ 方向確認（高頻）：近期 ${Math.round(wd.recentRatio*100)}% 回應方向偏了，不確定時必須先提案確認再動手`)
  else if (wd?.level === 'mid')
    lines.push(`⚠️ 方向確認：近期出現方向偏離訊號（${Math.round(wd.recentRatio*100)}%），複雜任務請先確認理解方向`)
  else if (wd?.level === 'low')
    lines.push(`方向確認：偶有方向偏離（${Math.round(wd.ratio*100)}%），複雜需求可先說明理解再執行`)
  if (!lines.length) lines.push('暫無明確偏好，維持現有風格')
  return lines.join('\n')
}

const RATING_TAGS = ['太長', '太短', '方向對了', '方向偏了', '需要更多細節', '太囉嗦', '需要例子', '完美']

function MessageRating({ id, text, serverRating }) {
  const [phase, setPhase]         = useState('idle') // idle | react | tag
  const [reaction, setReaction]   = useState(null)
  const [selTags, setSelTags]     = useState([])
  const [saved, setSaved]         = useState(() => id ? loadRatingById(id) : null)
  const timerRef                  = useRef(null)

  // 當 server 資料抵達（手機等 localStorage 為空的裝置），補上 saved 狀態
  useEffect(() => {
    if (serverRating && !saved) setSaved(serverRating)
  }, [serverRating])

  useEffect(() => {
    if (!id || saved) return
    timerRef.current = setTimeout(() => {
      const r = { id, ts: Date.now(), explicit: false, reaction: null, tags: [], features: extractFeatures(text) }
      saveRating(r); setSaved(r)
    }, 12000)
    return () => clearTimeout(timerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function pickReaction(r) { clearTimeout(timerRef.current); setReaction(r); setPhase('tag') }
  function toggleTag(t) { setSelTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]) }
  function commit() {
    const r = { id, ts: Date.now(), explicit: true, reaction, tags: selTags, features: extractFeatures(text) }
    saveRating(r); setSaved(r); setPhase('idle'); setSelTags([])
    // passive timer may have been replaced by explicit — saveRating handles server write
  }

  const dot = !saved ? '◦' : saved.explicit ? (saved.reaction === 'up' ? '👍' : saved.reaction === 'down' ? '👎' : '·') : '·'

  if (phase === 'idle') {
    if (saved?.explicit) return (
      <button onClick={() => setPhase('react')} title="重新評分"
        className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--gold)]/40 text-[var(--gold)]/70 hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors ml-1 select-none">
        {saved.reaction === 'up' ? '👍' : '👎'}
        {saved.tags?.[0] && <span className="text-[8px]">{saved.tags[0]}</span>}
      </button>
    )
    return (
      <button onClick={() => setPhase('react')} title="評分這則回應"
        className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)] hover:text-[var(--gold)] transition-colors ml-1 select-none opacity-65 hover:opacity-100">
        <span>★</span><span>評分</span>
      </button>
    )
  }

  if (phase === 'react') return (
    <span className="inline-flex items-center gap-1 ml-1">
      <button onClick={() => pickReaction('up')}   className="text-[12px] hover:scale-110 transition-transform">👍</button>
      <button onClick={() => pickReaction('down')} className="text-[12px] hover:scale-110 transition-transform">👎</button>
      <button onClick={() => setPhase('idle')}     className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] ml-0.5">✕</button>
    </span>
  )

  return (
    <div className="flex flex-wrap gap-1 mt-1 justify-end items-center">
      <span className="text-[10px]">{reaction === 'up' ? '👍' : '👎'}</span>
      {RATING_TAGS.map(tag => (
        <button key={tag} onClick={() => toggleTag(tag)}
          className={`text-[8px] px-1.5 py-0.5 rounded-full border transition-colors ${
            selTags.includes(tag)
              ? 'border-[var(--gold)] text-[var(--gold)] bg-[var(--gold)]/10'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)]'
          }`}>{tag}</button>
      ))}
      <button onClick={commit}
        className="text-[8px] px-2 py-0.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20">
        完成
      </button>
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
  const [showWorkflow, setShowWorkflow]     = useState(false)
  const [serverRatingsMap, setServerRatingsMap] = useState({})
  const [wfType, setWfType]                 = useState(null)
  const [wfUrl, setWfUrl]                   = useState('')
  const [wfThought, setWfThought]           = useState('')
  const [injectOnce, setInjectOnce]         = useState(false)  // B機制：單次注入偏好
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

  // Tracks whether web-initiated stream events are active (skip session_live appends during run)
  const runningRef = useRef(false)
  // Guards against processing the same streamEvent twice (useEffect re-runs on dep change)
  const lastEvTsRef = useRef(0)

  // Apply chatInit when it changes (from History "Continue in Chat" or session click)
  useEffect(() => {
    if (!chatInit) return
    if (chatInit === prevChatInitRef.current) return
    prevChatInitRef.current = chatInit
    setProjectPath(chatInit.projectPath)
    setSessionId(chatInit.sessionId)
    setMessages([{ role: 'system', text: '載入歷史紀錄…', ts: Date.now() }])
    // Start live-tailing for VS Code session incremental updates
    fetch('/api/session/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chatInit.sessionId }),
    }).catch(() => {})
    // Load history from API (single source of truth for past messages)
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

  // On mount: flush pending ratings → merge server data into cache → build id map
  useEffect(() => {
    flushPendingSync()   // 補送上次刷新前沒送到的評分
    fetch('/api/ratings').then(r => r.json()).then(d => {
      const serverAll = d.ratings ?? []
      // Merge：server 資料更新/補充 localStorage，不刪除本地還沒同步的項目
      const local = loadRatingsCache()
      const merged = [...local]
      for (const r of serverAll) {
        const idx = merged.findIndex(x => x.id === r.id)
        if (idx >= 0) merged[idx] = { ...r, _pendingSync: false }
        else merged.push({ ...r, _pendingSync: false })
      }
      writeRatingsCache(merged)
      const map = {}
      for (const r of merged) map[r.id] = r
      setServerRatingsMap(map)
    }).catch(() => {})
  }, [])

  // On mount: mark all existing streamEvents as already-processed so a tab-switch remount
  // doesn't replay the full 200-event buffer and cause massive duplicates.
  useEffect(() => {
    const maxTs = streamEvents.reduce((m, e) => Math.max(m, e._arrivalTs ?? 0), 0)
    lastEvTsRef.current = maxTs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty — runs once on mount only

  // Process incoming stream events — loop over ALL new events to avoid React 18 batching issue
  // (processing only the last event caused content_block_stop to swallow preceding deltas,
  //  so live thinking text never appeared before the block was cleared)
  useEffect(() => {
    if (!streamEvents.length) return

    // Find all events not yet processed (arrival timestamp > last processed)
    const startIdx = streamEvents.findIndex(ev => (ev._arrivalTs ?? 0) > lastEvTsRef.current)
    if (startIdx < 0) return
    const newEvts = streamEvents.slice(startIdx)
    lastEvTsRef.current = newEvts[newEvts.length - 1]._arrivalTs ?? lastEvTsRef.current

    let liveUpdated = false

    for (const ev of newEvts) {
      // ── session_live: VS Code live tail (incremental only) ───────────────
      if (ev.type === 'session_live' && ev.sessionId === sessionId) {
        if (runningRef.current) continue  // web run active — claude_stream is source of truth
        setMessages(prev => {
          const existingToolKeys = new Set(prev.filter(m => m.toolId).map(m => `${m.role}:${m.toolId}`))
          let next = [...prev]
          for (const m of ev.messages ?? []) {
            const msg = { ...m, live: true }
            if (msg.toolId) {
              const key = `${msg.role}:${msg.toolId}`
              if (existingToolKeys.has(key)) continue
              existingToolKeys.add(key)
            }
            if (msg.role === 'tool_result') {
              const idx = next.map(x => x.toolId).lastIndexOf(msg.toolId)
              if (idx >= 0) { next = [...next.slice(0, idx + 1), msg, ...next.slice(idx + 1)]; continue }
            }
            next = [...next, msg]
          }
          return next
        })
        continue
      }

      // ── claude_stream: real-time subprocess events ─────────────────────────
      if (ev.type !== 'claude_stream') continue
      if (normPath(ev.projectPath) !== normPath(projectPath)) continue
      // Reject events from a different subprocess session (same projectPath, different session)
      if (ev.sessionId && sessionId && ev.sessionId !== sessionId) continue
      const { event } = ev

      if (event.type === 'system' && event.subtype === 'init') {
        // Only adopt new sessionId when THIS tab initiated the run (runningRef=true).
        // Other tabs' init events arrive with ev.sessionId=null (bypassing the sessionId filter)
        // and must not hijack this panel's session context.
        if (runningRef.current) setSessionId(event.session_id)
      } else if (event.type === 'content_block_start') {
        const t = event.content_block?.type
        if (t === 'thinking') { liveBlockRef.current = { type: 'thinking', text: '' }; liveUpdated = true }
        else if (t === 'text')    { liveBlockRef.current = { type: 'text', text: '' };    liveUpdated = true }
        else                      { liveBlockRef.current = null;                           liveUpdated = true }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta
        if (liveBlockRef.current && (d?.type === 'thinking_delta' || d?.type === 'text_delta')) {
          liveBlockRef.current = { ...liveBlockRef.current, text: liveBlockRef.current.text + (d.thinking ?? d.text ?? '') }
          liveUpdated = true
        }
      } else if (event.type === 'content_block_stop') {
        liveBlockRef.current = null; liveUpdated = true
      } else if (event.type === 'assistant') {
        liveBlockRef.current = null; liveUpdated = true
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
        const blocks = event.message?.content ?? []
        setMessages(prev => {
          let next = [...prev]
          for (const b of blocks) {
            if (b.type !== 'tool_result') continue
            const output = Array.isArray(b.content)
              ? b.content.filter(x => x.type === 'text').map(x => x.text).join('').slice(0, 300)
              : String(b.content ?? '').slice(0, 300)
            if (!output.trim()) continue
            const resultMsg = { role: 'tool_result', toolId: b.tool_use_id, output, ts: Date.now() }
            const idx = next.map(m => m.toolId).lastIndexOf(b.tool_use_id)
            if (idx >= 0) next = [...next.slice(0, idx + 1), resultMsg, ...next.slice(idx + 1)]
            else next = [...next, resultMsg]
          }
          return next
        })
      } else if (event.type === 'result') {
        setRunning(false)
        const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''
        setMessages(m => [...m, { role: 'result', text: `完成${cost}`, ts: Date.now() }])
        // Hold runningRef for 700ms to absorb any trailing session_live fires
        // (file watcher or Stop hook may broadcast already-shown messages from claude_stream)
        setTimeout(() => { runningRef.current = false }, 700)
      } else if (event.type === 'done') {
        setRunning(false)
        setTimeout(() => { runningRef.current = false }, 700)
      }
    }

    if (liveUpdated) scheduleLiveUpdate()
  }, [streamEvents, projectPath, sessionId])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend(overrideText) {
    const text = (overrideText ?? input).trim()
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

    const rawPrompt = text || (attachments.length ? '請查看附件' : '')
    const prefText  = localStorage.getItem(PREF_TEXT_KEY) || ''
    const prompt    = (injectOnce && prefText && !overrideText)
      ? `[使用者回應偏好（本次請遵循）：\n${prefText}]\n\n${rawPrompt}`
      : rawPrompt
    if (injectOnce && !overrideText) setInjectOnce(false)

    if (!overrideText) setInput('')
    const sentAttachments = attachments
    setAttachments([])
    runningRef.current = true
    setRunning(true)
    const displayText = prompt + (sentAttachments.length ? `\n${sentAttachments.map(a => `[${a.name}]`).join(' ')}` : '')
    setMessages(m => [...m, { role: 'user', text: displayText, attachments: sentAttachments, ts: Date.now() }])
    try {
      const res = await fetch('/api/claude/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, prompt, sessionId, attachments: sentAttachments }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setRunning(false)
        const reason = data.error ?? `HTTP ${res.status}`
        setMessages(m => [...m, { role: 'result', text: `發送失敗：${reason}`, ts: Date.now() }])
      }
    } catch (err) {
      setRunning(false)
      setMessages(m => [...m, { role: 'result', text: `發送失敗：${err.message}`, ts: Date.now() }])
    }
  }

  function handleStop() {
    fetch('/api/claude/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    })
    runningRef.current = false
    setRunning(false)
  }

  const WORKFLOWS = [
    {
      id: 'youtube', icon: '🎬', label: 'YouTube 吸收',
      urlLabel: '影片網址', thoughtLabel: '吸收後的期望或重點方向',
      build: (url, thought) =>
`我貼上一部影片讓你做深度知識吸收，請依照以下步驟：

1. 確認作者含金量（查 memory/reference_youtube_creators.md）；若未記錄，先告訴我再繼續
2. 在 AI_Utils/ 用 yt-dlp 下載 SRT 字幕，再用 Read 工具讀取全文
3. **時序因果分析**：還原影片的敘事結構——作者的鋪陳→論點→轉折→結論各在哪個時間點、前後邏輯是什麼
4. **視覺缺口標記**：字幕沒說但影片明顯在展示的內容（程式碼、圖表、演示動作），標記為「[視覺補充待確認]」
5. 萃取對羅馬專案或 UE 開發有價值的知識，整理為 .agent/knowledge/[主題].md（格式：Raw Data → Narrative Flow → Key Insights → Visual Gaps → Clues for Further Investigation）
6. 更新 MEMORY.md 索引

影片：${url}
我的想法：${thought || '（未填）'}`,
    },
    {
      id: 'report', icon: '📰', label: '報導/查驗',
      urlLabel: '報導或文章網址', thoughtLabel: '這篇對我們協作的意義是什麼',
      build: (url, thought) =>
`我貼上一篇報導讓你查驗並沉澱為協作基石：

1. 用 WebFetch 或 WebSearch 讀取完整內容
2. **事實查驗**：找出報導的核心主張，交叉比對其他來源，標記「可信／存疑／未經證實」
3. **提取對我們有用的部分**：這篇報導如何影響我們的開發方向、工具選擇、或協作方式
4. **協作反思**：根據這篇內容，評估我們目前的協作模式是否還是最理想的，列出可改進的具體點
5. 將查驗結果與洞察整理為 .agent/knowledge/ 下的參考文件

報導網址：${url}
對協作的意義：${thought || '（未填）'}`,
    },
    {
      id: 'tutorial', icon: '📖', label: '教學/文件',
      urlLabel: '教學文章或官方文件網址', thoughtLabel: '想補齊的知識方向',
      build: (url, thought) =>
`我貼上一篇教學或文件讓你補齊完整知識：

1. 用 WebFetch 讀取主文內容
2. **找前後系列**：確認這篇是否屬於某個系列（第幾篇、有無 Part 1/2/3、官方文件的相鄰章節），把完整系列清單列出來
3. **逐一吸收系列文章**：依序讀取所有相關篇章，不留知識缺口
4. 整合所有文章，整理為結構完整的 .agent/knowledge/[主題].md，包含：概念全貌、關鍵 API/步驟、常見坑、與羅馬專案的對應點
5. 更新 MEMORY.md 索引

文章網址：${url}
知識補齊方向：${thought || '（未填）'}`,
    },
    {
      id: 'aicase', icon: '👥', label: 'AI 協作案例',
      urlLabel: 'FB 貼文或社群連結（或貼上截圖說明）', thoughtLabel: '覺得哪個做法值得學習或反思',
      build: (url, thought) =>
`我分享一個別人與 AI 協作的案例，請分析並找出我們可以借鏡的地方：

1. 讀取或理解案例內容（網址 / 截圖說明）
2. **提煉協作模式**：他們用了什麼方法、工具、提示詞結構，與我們的做法有何不同
3. **差距分析**：他們做到了我們還沒做到的是什麼？我們有沒有比他們更好的地方？
4. **改進建議**：具體列出 1~3 個可以直接套用或調整到我們協作中的做法
5. 若值得長期參考：更新 memory/feedback_*.md 或 preferences.md

案例來源：${url || '（見我的補充說明）'}
我覺得值得學習的點：${thought || '（未填）'}`,
    },
    {
      id: 'github', icon: '🔗', label: 'GitHub 倉庫',
      urlLabel: 'GitHub repo 網址', thoughtLabel: '想怎麼用它（fork / 整合 / 學原理）',
      build: (url, thought) =>
`我分享一個 GitHub 倉庫，請做全面理解並給出行動建議：

1. 用 WebFetch 讀取 README、主要文件、CHANGELOG
2. **全面理解 repo**：它解決什麼問題、架構是什麼、核心技術原理是什麼
3. **社群使用經驗**：搜尋 Issues、Discussions、相關教學文章或 YouTube 影片，找出常見坑與最佳實踐
4. **與我們的關聯評估**：
   - Fork 路線：值得 fork 嗎？哪些部分要改造才符合我們需求？
   - 整合路線：可以直接當 dependency 或插件嗎？
   - 學習路線：主要是理解原理技術，不直接使用
5. 產出建議報告：推薦哪條路線 + 具體下一步行動
6. 若決定採用：整理關鍵知識到 .agent/knowledge/[repo名稱].md

Repo：${url}
初步想法：${thought || '（未填）'}`,
    },
    {
      id: 'screenshot', icon: '📸', label: '截圖解析',
      urlLabel: '截圖說明或對應系統', thoughtLabel: '要解決的問題或疑惑',
      build: (url, thought) =>
`我貼上截圖讓你解析並推導實作方案：
1. 先查 .agent/knowledge/ 有無相關既有分析
2. 識別截圖中的架構、關鍵節點與數值
3. 對照 GASP 知識庫，推導羅馬專案的對應實作（不自行發明，從截圖推導）
4. 產出可直接執行的步驟

截圖說明／系統：${url}
要解決的問題：${thought || '（未填）'}`,
    },
    {
      id: 'knowledge', icon: '📚', label: '知識庫擴充',
      urlLabel: '主題或文件網址', thoughtLabel: '具體想知道什麼',
      build: (url, thought) =>
`請針對以下主題擴充 .agent/knowledge/，再回答我：
1. 搜尋 .agent/knowledge/ 現有相關資料並評估是否足夠
2. 若不足：補充分析，寫入 knowledge/[主題].md
3. 補充完成後，用新資料回答問題

主題／資料來源：${url}
具體問題：${thought || '（未填）'}`,
    },
    {
      id: 'anim', icon: '🎞', label: '動畫自動加工',
      urlLabel: 'A：搜尋方法（或動畫路徑）', thoughtLabel: 'B：操作類型（或目標說明）',
      build: (url, thought) =>
`動畫自動加工任務，請先確認 A × B 組合再執行：

A（搜尋方法）：${url || '（請補充）'}
B（操作類型）：${thought || '（請補充）'}

參考：.agent/workflows/z_sub_anim_auto_process.md
若 A 或 B 未指定，先向我提問確認，不可擅自假設。`,
    },
    {
      id: 'dream', icon: '🧠', label: 'Dream Pass',
      urlLabel: '（選填）特別關注的領域', thoughtLabel: '（選填）本次清理的重點指示',
      build: (url, thought) =>
`做一次 dream pass。
${url ? `特別關注：${url}` : ''}
${thought ? `重點指示：${thought}` : ''}
參考流程：.agent/workflows/dream_pass.md`.trim(),
    },
    {
      id: 'debug', icon: '🔬', label: '除錯流程',
      urlLabel: '異常現象描述', thoughtLabel: '懷疑方向或已嘗試過的做法',
      build: (url, thought) =>
`除錯任務，請用「變數隔離 + 基準比較」方法，不要直接猜原因：

異常現象：${url}
懷疑方向：${thought || '（未填）'}

步驟：
1. 確認「已知正常的基準狀態」是什麼
2. 列出可能影響的變數清單
3. 設計最小可重現路徑
4. 一次只改一個變數驗證，記錄結果`,
    },
    {
      id: 'handoff', icon: '📋', label: 'Session 交接',
      urlLabel: '（選填）本次 session 主要做了什麼', thoughtLabel: '下個 session 的優先事項',
      build: (url, thought) =>
`請幫我做 Session 交接：
1. 整理本次 session 的主要成果（完成了什麼、遺留什麼）
2. 更新 .agent/last_session_state.md
3. 確認有需要同步到 memory/ 或 knowledge/ 的新知識
4. 列出下個 session 的優先待辦

本次摘要：${url || '（請自行從對話推導）'}
下個 session 優先事項：${thought || '（請自行從對話推導）'}`,
    },
    {
      id: 'plan', icon: '🏗', label: '新功能規劃',
      urlLabel: '功能描述或相關資料連結', thoughtLabel: '希望如何疊加（不改哪些部分）',
      build: (url, thought) =>
`新功能規劃，請用「疊加不破壞」原則：

功能描述：${url}
疊加方向：${thought || '（未填）'}

步驟：
1. 用 git diff / grep 確認現有穩定架構的邊界
2. 確認新功能影響哪些現有路徑
3. 設計「在舊功能旁邊加，不動舊功能主幹」的方案
4. 列出完成後的驗證清單（確認舊功能仍正常）`,
    },
  ]

  function handleWorkflowSend() {
    const wf = WORKFLOWS.find(w => w.id === wfType)
    if (!wf) return
    const prompt = wf.build(wfUrl.trim(), wfThought.trim())
    setShowWorkflow(false)
    setWfType(null); setWfUrl(''); setWfThought('')
    handleSend(prompt)
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
          <div key={i} className={`text-[11px] leading-relaxed ${m.historical ? 'opacity-75' : ''}`}>
            {/* System / divider */}
            {m.role === 'system' && (
              <div className="text-[9px] text-[var(--text-muted)] text-center py-1 border-t border-[var(--border)] mt-1">{m.text}</div>
            )}
            {/* User message */}
            {m.role === 'user' && (
              <div className="text-[var(--gold)]">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="opacity-50 mr-1">›</span>
                    <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                  </div>
                  {m.ts && (
                    <span className="shrink-0 text-[8px] text-[var(--gold)]/30 tabular-nums font-mono leading-tight pt-0.5 text-right">
                      {new Date(m.ts).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                  )}
                </div>
                {m.attachments?.filter(a => a.type?.startsWith('image/')).map((a, ai) => (
                  <img key={ai} src={a.dataUrl} alt={a.name}
                    className="mt-1 max-h-32 max-w-full rounded border border-[var(--border)] block" />
                ))}
              </div>
            )}
            {/* Assistant text */}
            {m.role === 'assistant' && (
              <div>
                <div className="md-body text-[var(--text)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || ''}</ReactMarkdown>
                </div>
                <div className="flex justify-end mt-0.5">
                  <MessageRating id={sessionId && m.ts ? `${sessionId}_${m.ts}` : null} text={m.text || ''}
                    serverRating={sessionId && m.ts ? serverRatingsMap[`${sessionId}_${m.ts}`] : undefined} />
                </div>
              </div>
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

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">

        {/* Workflow Launcher */}
        {showWorkflow && (
          <div className="border-b border-[var(--border)] bg-[var(--surface-2)] p-2">
            {/* Workflow type pills */}
            <div className="flex gap-1.5 overflow-x-auto pb-1.5 mb-2">
              {WORKFLOWS.map(wf => (
                <button key={wf.id} onClick={() => setWfType(wf.id === wfType ? null : wf.id)}
                  className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold tracking-wide border transition-colors ${
                    wfType === wf.id
                      ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}>
                  <span>{wf.icon}</span><span>{wf.label}</span>
                </button>
              ))}
            </div>
            {/* Selected workflow fields */}
            {(() => {
              const wf = WORKFLOWS.find(w => w.id === wfType)
              if (!wf) return (
                <div className="text-[9px] text-[var(--text-muted)] text-center py-1">選擇心腹成員</div>
              )
              return (
                <div className="flex flex-col gap-1.5">
                  <input value={wfUrl} onChange={e => setWfUrl(e.target.value)}
                    placeholder={wf.urlLabel}
                    className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] font-mono" />
                  <div className="flex gap-1.5">
                    <input value={wfThought} onChange={e => setWfThought(e.target.value)}
                      placeholder={wf.thoughtLabel}
                      onKeyDown={e => { if (e.key === 'Enter') handleWorkflowSend() }}
                      className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]" />
                    <button onClick={handleWorkflowSend} disabled={running || !wfType}
                      className="px-3 py-1 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/60 text-[var(--gold)] text-[10px] font-semibold hover:bg-[var(--gold)]/30 disabled:opacity-40 shrink-0">
                      ⚡ 啟動
                    </button>
                  </div>
                </div>
              )
            })()}
          </div>
        )}

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
          {/* ✦ Inject preference (B機制) */}
          <button
            onClick={() => setInjectOnce(v => !v)}
            title={injectOnce ? '偏好注入：開（送出後自動關閉）' : '偏好注入：關（點擊啟用單次注入）'}
            className={`w-7 h-7 flex items-center justify-center rounded border text-xs transition-colors shrink-0 ${
              injectOnce
                ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'
            }`}>✦</button>
          {/* ⚡ Workflow toggle */}
          <button
            onClick={() => setShowWorkflow(v => !v)}
            title="心腹"
            className={`w-7 h-7 flex items-center justify-center rounded border text-xs transition-colors shrink-0 ${
              showWorkflow
                ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'
            }`}>⚡</button>
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

// ─── Preferences Panel ────────────────────────────────────────────────────────

// ── Snapshot helpers ──────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const d = await fetch('/api/ratings/history').then(r => r.json())
    return d.history ?? []
  } catch { return [] }
}

function saveSnapshot(analysis, text, note = '') {
  if (!analysis) return
  const snapshot = {
    ts: Date.now(), text, note,
    stats: {
      total:               analysis.total,
      explicit:            analysis.explicit,
      ups:                 analysis.ups,
      downs:               analysis.downs,
      upRatio:             analysis.explicit > 0 ? analysis.ups / analysis.explicit : 0,
      wrongDirRatio:       analysis.wrongDir?.ratio ?? 0,
      recentWrongDirRatio: analysis.wrongDir?.recentRatio ?? 0,
      wdLevel:             analysis.wrongDir?.level ?? 'ok',
      avgUpLen:            analysis.avgUpLen ?? null,
    },
  }
  fetch('/api/ratings/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  }).catch(() => {})
  return snapshot
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ data, color = 'var(--gold)', width = 120, height = 28, label }) {
  if (!data || data.length < 2) return <span className="text-[8px] text-[var(--text-muted)]">資料不足</span>
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 0.001
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - 2 - ((v - min) / range) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const lastY = height - 2 - ((data[data.length - 1] - min) / range) * (height - 4)
  const lastVal = data[data.length - 1]
  const prevVal = data[data.length - 2]
  const trend = lastVal > prevVal + 0.01 ? '↑' : lastVal < prevVal - 0.01 ? '↓' : '→'
  const trendColor = color === 'var(--gold)' ? 'text-[var(--gold)]'
    : lastVal > prevVal + 0.01 ? 'text-green-400' : lastVal < prevVal - 0.01 ? 'text-red-400' : 'text-[var(--text-muted)]'
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[8px] text-[var(--text-muted)] w-14 shrink-0">{label}</span>}
      <svg width={width} height={height} className="overflow-visible shrink-0">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
        <circle cx={(data.length - 1) / (data.length - 1) * width} cy={lastY} r="2.5" fill={color} />
      </svg>
      <span className={`text-[9px] font-mono ${trendColor} shrink-0`}>
        {(lastVal * 100).toFixed(0)}% {trend}
      </span>
    </div>
  )
}

function PreferencesPanel() {
  const [ratings, setRatings]   = useState(() => loadRatingsCache())  // init from cache, then fetch
  const [prefText, setPrefText] = useState(() => localStorage.getItem(PREF_TEXT_KEY) || '')
  const [syncing, setSyncing]   = useState(false)
  const [copied, setCopied]     = useState(false)
  const [history, setHistory]   = useState([])
  const [histOpen, setHistOpen] = useState(false)
  const [snapNote, setSnapNote] = useState('')

  // On mount: pull from server (cross-device source of truth)
  useEffect(() => {
    setSyncing(true)
    loadRatings().then(all => { setRatings(all); setSyncing(false) })
    fetch('/api/ratings/prefs').then(r => r.json()).then(d => {
      if (d.text) { setPrefText(d.text); localStorage.setItem(PREF_TEXT_KEY, d.text) }
    }).catch(() => {})
    loadHistory().then(setHistory)
  }, [])

  const analysis = analyzeRatings(ratings)

  function refresh() {
    setSyncing(true)
    loadRatings().then(all => { setRatings(all); setSyncing(false) })
  }

  function runAnalysis() {
    const text = generatePrefText(analysis)
    setPrefText(text)
    localStorage.setItem(PREF_TEXT_KEY, text)
    fetch('/api/ratings/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {})
    // 儲存快照
    const snap = saveSnapshot(analysis, text, snapNote)
    if (snap) { setHistory(h => [...h, snap]); setSnapNote('') }
  }

  function updatePrefText(v) {
    setPrefText(v)
    localStorage.setItem(PREF_TEXT_KEY, v)
    fetch('/api/ratings/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: v }),
    }).catch(() => {})
  }

  function clearAll() {
    if (!window.confirm('確認清除所有評分紀錄？')) return
    localStorage.removeItem(RATING_KEY)
    fetch('/api/ratings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: { id: '__clear__', __clearAll: true } }),
    }).catch(() => {})
    setRatings([])
  }

  async function copyPref() {
    await navigator.clipboard.writeText(prefText).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  const ups   = ratings.filter(r => r.reaction === 'up').length
  const downs = ratings.filter(r => r.reaction === 'down').length
  const expl  = ratings.filter(r => r.explicit).length
  const passv = ratings.filter(r => !r.explicit).length

  // Tag frequency from explicit ratings
  const tagFreq = {}
  for (const r of ratings.filter(r => r.explicit)) {
    for (const t of r.tags || []) { tagFreq[t] = (tagFreq[t] || 0) + 1 }
  }
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 6)

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">

      {/* Left: stats + history */}
      <div className="flex flex-col md:w-1/2 min-h-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">規矩 · The Rules</span>
          {syncing && <span className="text-[8px] text-[var(--text-muted)] animate-pulse">同步中…</span>}
          <div className="flex-1" />
          <button onClick={refresh} className={`text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] ${syncing ? 'animate-spin' : ''}`}>↺</button>
          <button onClick={clearAll} className="text-[9px] text-[var(--text-muted)] hover:text-red-400 border border-[var(--border)] rounded px-1.5 py-0.5">清除</button>
        </div>
        <div className="p-3 flex flex-col gap-4">

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '總收集', value: ratings.length, sub: '訊號' },
              { label: '主動評分', value: expl, sub: `${ups}👍 ${downs}👎`, gold: true },
              { label: '被動接受', value: passv, sub: '沒評 = 可接受' },
              { label: '資料充足', value: ratings.length >= 10 ? '✓' : `${ratings.length}/10`, sub: '分析需 10 筆' },
            ].map(s => (
              <div key={s.label} className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2">
                <div className={`text-xl font-bold ${s.gold ? 'text-[var(--gold)]' : 'text-[var(--text-h)]'}`}>{s.value}</div>
                <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-wide">{s.label}</div>
                <div className="text-[8px] text-[var(--text-muted)]/70 mt-0.5">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* 方向偵測警示 */}
          {(() => {
            const wd = analysis?.wrongDir
            if (!wd || wd.level === 'ok') return null
            const cfg = {
              high: { bg: 'bg-red-900/20',    border: 'border-red-600/50',    text: 'text-red-400',    icon: '🚨', title: '方向偏離：高頻警示' },
              mid:  { bg: 'bg-amber-900/15',  border: 'border-amber-600/50',  text: 'text-amber-400',  icon: '⚠️', title: '方向偏離：偵測到訊號' },
              low:  { bg: 'bg-yellow-900/10', border: 'border-yellow-700/40', text: 'text-yellow-500', icon: '💡', title: '方向偏離：輕微訊號' },
            }[wd.level]
            const topFeat = Object.entries(wd.wdFeats)
              .filter(([,v]) => v > 0.4)
              .sort((a,b) => b[1]-a[1])
              .map(([k]) => ({ hasCode: '含程式碼', hasList: '含條列', hasHeaders: '含標題', longMsg: '長回應' }[k]))
              .filter(Boolean)
            return (
              <div className={`rounded border ${cfg.border} ${cfg.bg} p-2.5`}>
                <div className={`text-[9px] font-semibold uppercase tracking-wider ${cfg.text} mb-1`}>
                  {cfg.icon} {cfg.title}
                </div>
                <div className="text-[9px] text-[var(--text)] mb-1.5">
                  全部 <span className={cfg.text}>{Math.round(wd.ratio*100)}%</span> 的評分帶有「方向偏了」tag，
                  近 10 筆為 <span className={cfg.text}>{Math.round(wd.recentRatio*100)}%</span>
                  {wd.recentRatio > wd.ratio + 0.1 ? '（趨勢上升）' : ''}
                </div>
                {topFeat.length > 0 && (
                  <div className="text-[9px] text-[var(--text-muted)] mb-1.5">
                    常見於：{topFeat.join('、')}的回應
                  </div>
                )}
                <div className={`text-[9px] ${cfg.text} font-medium`}>
                  → 建議：這類任務先說明理解方向再執行（提案確認模式）
                </div>
                <div className="mt-1.5 text-[8px] text-[var(--text-muted)]/60">
                  此訊號在「重新分析」時會自動注入偏好文字
                </div>
              </div>
            )
          })()}

          {/* Top tags */}
          {topTags.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">常見評語</div>
              <div className="flex flex-wrap gap-1.5">
                {topTags.map(([tag, count]) => (
                  <span key={tag} className="text-[9px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)]">
                    {tag} <span className="text-[var(--gold)]">×{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Rating history */}
          {ratings.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">最近紀錄</div>
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
                {[...ratings].reverse().slice(0, 60).map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-[9px] border-b border-[var(--border)]/30 pb-0.5">
                    <span className="w-4 text-center shrink-0">
                      {r.explicit ? (r.reaction === 'up' ? '👍' : r.reaction === 'down' ? '👎' : '·') : '·'}
                    </span>
                    <span className={`shrink-0 ${r.explicit ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                      {r.explicit ? '主動' : '被動'}
                    </span>
                    <span className="text-[var(--text-muted)] truncate flex-1">{r.tags?.join(' ') || '—'}</span>
                    <span className="shrink-0 font-mono text-[var(--text-muted)]">{r.features?.len ?? 0}字</span>
                    <span className="shrink-0 font-mono text-[var(--text-muted)]/50">
                      {new Date(r.ts).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ratings.length === 0 && (
            <div className="text-[10px] text-[var(--text-muted)] text-center mt-4">
              還沒有評分紀錄。<br/>每則 Claude 回應右下角有 ◦ 可以評分，<br/>不評分 12 秒後自動記為「被動接受」。
            </div>
          )}
        </div>
      </div>

      {/* Right: preference text + history */}
      <div className="flex flex-col md:w-1/2 min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">偏好文字</span>
          <div className="flex-1" />
          <button onClick={() => setHistOpen(v => !v)}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
              histOpen ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>
            📈 歷史{history.length > 0 ? ` (${history.length})` : ''}
          </button>
          <button onClick={runAnalysis} disabled={!analysis}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)] disabled:opacity-30">
            ⚡ 分析並存檔
          </button>
          <button onClick={copyPref} disabled={!prefText}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors disabled:opacity-30 ${
              copied ? 'border-green-500 text-green-400' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>
            {copied ? '✓' : '複製'}
          </button>
        </div>

        {/* History view */}
        {histOpen ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">

            {/* Sparkline charts */}
            {history.length >= 2 && (
              <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-3 flex flex-col gap-2">
                <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">調教曲線</div>
                <Sparkline
                  label="滿意度"
                  data={history.map(s => s.stats.upRatio)}
                  color="#4ade80"
                  width={130} height={30}
                />
                <Sparkline
                  label="方向偏離"
                  data={history.map(s => s.stats.wrongDirRatio)}
                  color="#f87171"
                  width={130} height={30}
                />
                <Sparkline
                  label="評分數量"
                  data={history.map(s => s.stats.total / Math.max(...history.map(x => x.stats.total), 1))}
                  color="var(--gold)"
                  width={130} height={30}
                />
                <div className="text-[8px] text-[var(--text-muted)] mt-0.5">
                  共 {history.length} 次快照 · 最早 {new Date(history[0].ts).toLocaleDateString('zh-TW')} · 最近 {new Date(history[history.length-1].ts).toLocaleDateString('zh-TW')}
                </div>
              </div>
            )}

            {/* Snapshot timeline */}
            {history.length === 0 && (
              <div className="text-[10px] text-[var(--text-muted)] text-center mt-4">
                還沒有歷史快照。<br/>點「⚡ 分析並存檔」建立第一筆。
              </div>
            )}
            {[...history].reverse().map((snap, i) => {
              const prev = history[history.length - 1 - i - 1]
              const upDiff  = prev ? ((snap.stats.upRatio  - prev.stats.upRatio)  * 100).toFixed(0) : null
              const wdDiff  = prev ? ((snap.stats.wrongDirRatio - prev.stats.wrongDirRatio) * 100).toFixed(0) : null
              const isLatest = i === 0
              return (
                <div key={snap.ts} className={`border rounded p-2.5 flex flex-col gap-1.5 ${isLatest ? 'border-[var(--gold)]/50 bg-[var(--gold)]/5' : 'border-[var(--border)] bg-[var(--surface-2)]'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] font-mono ${isLatest ? 'text-[var(--gold)]' : 'text-[var(--text-muted)]'}`}>
                      {new Date(snap.ts).toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                    </span>
                    {isLatest && <span className="text-[7px] px-1 rounded bg-[var(--gold)]/20 text-[var(--gold)] uppercase tracking-wide">最新</span>}
                    {snap.note && <span className="text-[9px] text-[var(--text-muted)] italic">{snap.note}</span>}
                    <div className="flex-1" />
                    <button onClick={() => { updatePrefText(snap.text); setHistOpen(false) }}
                      className="text-[8px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]">
                      套用
                    </button>
                  </div>
                  <div className="flex gap-3 text-[9px]">
                    <span>
                      滿意度 <span className={`font-mono ${snap.stats.upRatio > 0.6 ? 'text-green-400' : snap.stats.upRatio < 0.4 ? 'text-red-400' : 'text-[var(--text)]'}`}>
                        {(snap.stats.upRatio * 100).toFixed(0)}%
                      </span>
                      {upDiff !== null && <span className={`ml-0.5 text-[8px] ${upDiff > 0 ? 'text-green-400' : upDiff < 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                        {upDiff > 0 ? `+${upDiff}` : upDiff}%
                      </span>}
                    </span>
                    <span>
                      方向偏 <span className={`font-mono ${snap.stats.wrongDirRatio > 0.25 ? 'text-red-400' : 'text-green-400'}`}>
                        {(snap.stats.wrongDirRatio * 100).toFixed(0)}%
                      </span>
                      {wdDiff !== null && <span className={`ml-0.5 text-[8px] ${wdDiff < 0 ? 'text-green-400' : wdDiff > 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                        {wdDiff > 0 ? `+${wdDiff}` : wdDiff}%
                      </span>}
                    </span>
                    <span className="text-[var(--text-muted)]">{snap.stats.total} 筆</span>
                  </div>
                  {snap.text && (
                    <div className="text-[8px] text-[var(--text-muted)] font-mono line-clamp-2 mt-0.5 leading-relaxed">
                      {snap.text.split('\n')[0]}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex-1 p-3 flex flex-col gap-3 overflow-y-auto">
            <div className="text-[9px] text-[var(--text-muted)] leading-relaxed">
              這段文字是從評分資料推導出你的規矩，可以手動修改。<br/>
              「⚡ 分析並存檔」會同時更新偏好文字並儲存一筆歷史快照。
            </div>
            <input value={snapNote} onChange={e => setSnapNote(e.target.value)}
              placeholder="快照備註（選填，例：調整方向偏離問題後）"
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[10px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]" />
            <textarea value={prefText} onChange={e => updatePrefText(e.target.value)}
              rows={8}
              placeholder={ratings.length < 3 ? '評分資料不足（需至少 3 筆）' : '點擊「⚡ 分析並存檔」產生偏好描述'}
              className="flex-1 min-h-[150px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] resize-y font-mono leading-relaxed" />
            <div className="text-[9px] text-[var(--text-muted)] border border-[var(--border)] rounded p-2 bg-[var(--surface-2)]">
              <span className="text-[var(--gold)] font-semibold">A 機制</span>：定期把偏好貼進 <code className="text-[9px]">.agent/preferences.md</code>，Claude 下次啟動時讀到。<br/>
              <span className="text-[var(--gold)] font-semibold">B 機制</span>：點 Chat 輸入框的 <span className="text-[var(--gold)]">✦</span>，單次注入這則訊息。
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

// ─── Prompt Studio ────────────────────────────────────────────────────────────
// 本機模板工具，不走 LLM、不耗 Token。把零散想法組成結構化 prompt，
// 複製支援純文字（Markdown）與保留格式（HTML，貼到 Word / Notion 會變排版）。

const PROMPT_PRESETS = {
  none: { label: '— 無預設 —', role: '' },
  ue:   { label: 'Unreal Engine 開發者', role: '你是一位資深 Unreal Engine 5 遊戲開發者，熟悉 C++、Blueprint、Animation Blueprint、Mover 與 GASP。' },
  code: { label: '資深軟體工程師',        role: '你是一位資深軟體工程師，重視程式碼品質、可讀性與可維護性。' },
  writer:{label: '寫作助理',              role: '你是一位中文寫作編輯，擅長把口語化內容改寫為條理清楚、語氣專業的文字。' },
  teach:{ label: '教學助教',              role: '你是一位耐心的教學助教，會用類比與範例把概念講清楚。' },
  review:{label: '程式碼審查員',          role: '你是一位嚴謹的程式碼審查員，會指出潛在 bug、效能問題與可讀性缺陷。' },
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function buildPrompt({ raw, role, context, task, constraints, output, modifiers }) {
  const md = []
  const html = []
  function section(title, body) {
    if (!body?.trim()) return
    md.push(`## ${title}\n${body.trim()}\n`)
    html.push(`<h3 style="margin:12px 0 4px;font-size:14px;color:#c9a227">${escHtml(title)}</h3><div style="white-space:pre-wrap;line-height:1.55">${escHtml(body.trim())}</div>`)
  }
  function xmlSection(tag, body) {
    if (!body?.trim()) return
    md.push(`<${tag}>\n${body.trim()}\n</${tag}>\n`)
    html.push(`<p style="margin:10px 0 2px;font-family:ui-monospace,monospace;color:#888">&lt;${escHtml(tag)}&gt;</p><div style="white-space:pre-wrap;line-height:1.55;padding-left:10px;border-left:2px solid #333">${escHtml(body.trim())}</div><p style="margin:2px 0 10px;font-family:ui-monospace,monospace;color:#888">&lt;/${escHtml(tag)}&gt;</p>`)
  }
  const S = modifiers.useXmlTags ? xmlSection : section

  if (role?.trim())        S('role', role)
  if (context?.trim())     S('context', context)
  if (task?.trim() || raw?.trim()) S('task', task?.trim() ? task : raw)
  if (constraints?.trim()) S('constraints', constraints)
  if (output?.trim())      S('output_format', output)

  const directives = []
  // 通用
  if (modifiers.clarifyFirst)  directives.push('開始前，若有資訊不足或需要確認的地方，請先提出澄清問題，不要憑空假設。')
  if (modifiers.stepByStep)    directives.push('請一步一步思考，再給出最終答案。')
  if (modifiers.concise)       directives.push('回答請簡潔直接，不要無謂客套或重述已知資訊。')
  if (modifiers.withExamples)  directives.push('若有助於理解，請附上具體範例。')
  if (modifiers.chineseReply)  directives.push('請以繁體中文回答。')
  // 羅馬工作流程
  if (modifiers.deriveFromKnowledge) directives.push('實作請優先查 .agent/knowledge/ 既有分析與截圖/memory，從中推導；不要自行發明實作或參數。')
  if (modifiers.updateNotes)         directives.push('任務結束後請更新對應的 memory / knowledge 筆記，保留關鍵發現（檔案路徑、決策、踩坑）。')
  if (modifiers.planFirst)           directives.push('動手前先列出步驟、影響範圍與需驗證的路徑，確認後再執行。')
  if (modifiers.stackNotBreak)       directives.push('改動前先用 git diff/show 確認舊穩定版本的做法；改完驗證已知正常路徑仍正常。')
  if (modifiers.isolateDebug)        directives.push('除錯時採變數隔離＋基準比較，不直接猜原因。')
  if (modifiers.noPreemptive)        directives.push('只處理明確觸發條件，不要預防性加保護代碼或額外功能。')
  if (modifiers.verifyRefs)          directives.push('引用檔案/符號前先用 grep/glob 驗證仍存在，不信任舊記憶。')
  if (modifiers.sudokuReasoning)     directives.push('從我的訊息推導完整意圖，主動預見下游問題並提出解法，不要只解字面需求。')
  if (modifiers.dualBuild)           directives.push('C++ 改動後請跑 Development + DebugGame 雙版本編譯，兩邊都過才算完成。')
  if (modifiers.codingStyle)         directives.push('遵守專案編碼風格：單行 if 不加大括號且同一行、Allman 風格、/** */ 函式註解、區域變數 _ 前綴、參數 In/Out 前綴。')
  if (modifiers.tempFiles)           directives.push('暫存或中間檔案請放 AI_Utils/，任務結束自行評估清理。')
  if (modifiers.noGitAuto)           directives.push('不要自作主張 git add/commit；需要 commit 前先列出要包含的檔案並等我確認。')
  if (directives.length) {
    S('directives', directives.map((d, i) => `${i + 1}. ${d}`).join('\n'))
  }

  const fallback = md.length === 0 && raw?.trim()
  if (fallback) {
    md.push(raw.trim())
    html.push(`<div style="white-space:pre-wrap;line-height:1.55">${escHtml(raw.trim())}</div>`)
  }

  return {
    markdown: md.join('\n').trim(),
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;color:#e6e6e6;background:#111;padding:12px;border-radius:6px">${html.join('')}</div>`,
  }
}

function PromptStudioPanel() {
  const [raw, setRaw]                 = useState('')
  const [preset, setPreset]           = useState('none')
  const [role, setRole]               = useState('')
  const [context, setContext]         = useState('')
  const [task, setTask]               = useState('')
  const [constraints, setConstraints] = useState('')
  const [output, setOutput]           = useState('')
  const [modifiers, setModifiers]     = useState({
    // 通用
    useXmlTags: true, clarifyFirst: false, stepByStep: false,
    concise: true, withExamples: false, chineseReply: true,
    // 羅馬工作流程
    deriveFromKnowledge: false, updateNotes: false, planFirst: false,
    stackNotBreak: false, isolateDebug: false, noPreemptive: false,
    verifyRefs: false, sudokuReasoning: false, dualBuild: false,
    codingStyle: false, tempFiles: false, noGitAuto: false,
  })
  const [copied, setCopied] = useState(null)

  function applyPreset(key) {
    setPreset(key)
    const p = PROMPT_PRESETS[key]
    if (p && p.role) setRole(p.role)
    else if (key === 'none') setRole('')
  }

  const { markdown, html } = buildPrompt({ raw, role, context, task, constraints, output, modifiers })

  async function copyPlain() {
    try { await navigator.clipboard.writeText(markdown); setCopied('plain'); setTimeout(() => setCopied(null), 1500) }
    catch (e) { setCopied('fail'); setTimeout(() => setCopied(null), 1500) }
  }
  async function copyRich() {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          'text/html':  new Blob([html],     { type: 'text/html' }),
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
        })
        await navigator.clipboard.write([item])
      } else {
        await navigator.clipboard.writeText(markdown)
      }
      setCopied('rich'); setTimeout(() => setCopied(null), 1500)
    } catch (e) { setCopied('fail'); setTimeout(() => setCopied(null), 1500) }
  }

  function clearAll() {
    setRaw(''); setRole(''); setContext(''); setTask(''); setConstraints(''); setOutput(''); setPreset('none')
  }

  const toggleRow = (key, label) => (
    <label className="flex items-center gap-2 text-[10px] text-[var(--text)] cursor-pointer select-none">
      <input type="checkbox" checked={!!modifiers[key]}
        onChange={e => setModifiers(m => ({ ...m, [key]: e.target.checked }))}
        className="accent-[var(--gold)]"
      />
      <span>{label}</span>
    </label>
  )

  const field = (label, value, setValue, placeholder, rows = 2) => (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">{label}</span>
      <textarea value={value} onChange={e => setValue(e.target.value)} rows={rows} placeholder={placeholder}
        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] resize-y font-mono" />
    </div>
  )

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      {/* Left: Input */}
      <div className="flex flex-col md:w-1/2 min-h-0 md:border-r border-[var(--border)] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">Prompt Studio</span>
          <span className="text-[8px] text-[var(--text-muted)]">本機模板 · 不耗 Token</span>
          <div className="flex-1" />
          <button onClick={clearAll}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 hover:border-red-500/50">
            清空
          </button>
        </div>
        <div className="px-3 py-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">角色預設</span>
            <select value={preset} onChange={e => applyPreset(e.target.value)}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]">
              {Object.entries(PROMPT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          {field('角色 (role)', role, setRole, '例：你是一位 UE5 資深開發者…', 2)}
          {field('背景 (context)', context, setContext, '例：目前在做羅馬士兵的 ABP，已經完成 Mover 遷移…', 3)}
          {field('任務 (task)', task, setTask, '例：幫我規劃 ABP 狀態機的 state 與 transition…', 4)}
          {field('限制 (constraints)', constraints, setConstraints, '例：不用 ACF、保留現有編碼風格…', 2)}
          {field('輸出格式 (output)', output, setOutput, '例：用繁中條列、每條不超過兩行…', 2)}
          {field('或直接貼入零散想法 (fallback → 會放到 task)', raw, setRaw, '沒填上面欄位的話，這段會變成 task 內容', 3)}

          <div className="border-t border-[var(--border)] pt-2 mt-1">
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">通用修飾</div>
            <div className="grid grid-cols-2 gap-1.5">
              {toggleRow('useXmlTags',   '用 XML tags 包裝（Claude 偏好）')}
              {toggleRow('clarifyFirst', '先提澄清問題再動手')}
              {toggleRow('stepByStep',   '逐步思考再回答')}
              {toggleRow('concise',      '回答簡潔直接')}
              {toggleRow('withExamples', '附範例說明')}
              {toggleRow('chineseReply', '用繁體中文回答')}
            </div>
          </div>
          <div className="border-t border-[var(--border)] pt-2 mt-1">
            <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/80 mb-2">羅馬工作流程（常用需求）</div>
            <div className="grid grid-cols-1 gap-1.5">
              {toggleRow('deriveFromKnowledge', '從 knowledge/ 與截圖推導，不自行發明實作')}
              {toggleRow('updateNotes',         '完成後更新 memory / knowledge 話題筆記')}
              {toggleRow('planFirst',           '動手前先列步驟與影響範圍再執行')}
              {toggleRow('stackNotBreak',       '疊加不破壞：改前 git diff 舊穩定版本')}
              {toggleRow('isolateDebug',        '除錯用變數隔離＋基準比較，不直接猜')}
              {toggleRow('noPreemptive',        '不做超前防護，只處理明確觸發條件')}
              {toggleRow('verifyRefs',          '引用檔案/符號前先 grep/glob 驗證仍存在')}
              {toggleRow('sudokuReasoning',     '預見下游問題，在我問之前主動提出解法')}
              {toggleRow('dualBuild',           'C++ 改動跑 Development + DebugGame 雙版本')}
              {toggleRow('codingStyle',         '遵守編碼風格（單行 if / Allman / _ 前綴…）')}
              {toggleRow('tempFiles',           '暫存檔放 AI_Utils/，任務結束評估清理')}
              {toggleRow('noGitAuto',           '不自作主張 git add/commit，先確認再動手')}
            </div>
          </div>
        </div>
      </div>

      {/* Right: Preview */}
      <div className="flex flex-col md:w-1/2 min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">預覽 / 複製</span>
          <div className="flex-1" />
          <button onClick={copyPlain} disabled={!markdown}
            className={`text-[9px] px-2 py-1 rounded border transition-colors ${
              copied === 'plain' ? 'border-green-500 text-green-400'
                : 'border-[var(--border)] text-[var(--text)] hover:border-[var(--gold-border)] hover:text-[var(--gold)]'
            } ${!markdown ? 'opacity-40 cursor-not-allowed' : ''}`}>
            {copied === 'plain' ? '✓ 已複製' : '複製 Markdown'}
          </button>
          <button onClick={copyRich} disabled={!markdown}
            className={`text-[9px] px-2 py-1 rounded border transition-colors ${
              copied === 'rich' ? 'border-green-500 text-green-400'
                : 'border-[var(--gold)] text-[var(--gold)] hover:bg-[var(--gold)]/10'
            } ${!markdown ? 'opacity-40 cursor-not-allowed' : ''}`}>
            {copied === 'rich' ? '✓ 已複製' : '複製（含格式）'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {markdown
            ? (
              <pre className="text-[11px] leading-5 whitespace-pre-wrap break-words font-mono text-[var(--text)] bg-[var(--surface-2)] border border-[var(--border)] rounded p-3">
                {markdown}
              </pre>
            )
            : (
              <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">
                填入左邊任一欄位，這裡會即時組出結構化 prompt。
              </div>
            )
          }
          {copied === 'fail' && (
            <div className="mt-2 text-[10px] text-red-400">複製失敗（瀏覽器可能阻擋 Clipboard API，請改用純文字複製）</div>
          )}
        </div>
      </div>
    </div>
  )
}

const TABS = [
  { id: 'chat',      label: 'Chat' },
  { id: 'tasks',     label: 'Tasks' },
  { id: 'history',   label: 'History' },
  { id: 'prompt',    label: 'Prompt' },
  { id: 'prefs',     label: '規矩' },
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
      {/* Open claude.ai */}
      <a
        href="https://claude.ai"
        target="_blank"
        rel="noopener noreferrer"
        title="開啟 Claude.ai"
        className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] shrink-0 px-1 no-underline"
      >↗</a>
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
  const SUB = ['agent', 'prompt', 'prefs', 'analytics', 'claude.md', 'agents', 'mcp', 'hooks']
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
        {sub === 'prompt'    && <PromptStudioPanel />}
        {sub === 'prefs'     && <PreferencesPanel />}
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
  // auto-dismiss after 5s
  useEffect(() => {
    const T = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1800),
      setTimeout(() => setPhase(3), 3000),
      setTimeout(() => onDone?.(), 5000),
    ]
    return () => T.forEach(clearTimeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Ref tracking current chat projectPath for stream watcher (avoids stale sessions lookup)
  const chatProjectPathRef = useRef('')

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
    chatProjectPathRef.current = projectPath ?? ''
    setSelectedId(sessionId)   // sync selected session so name + cost animations match chat
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
      // Match against chatProjectPathRef (reliable) OR active session cwd (fallback)
      const chatPath = chatProjectPathRef.current
      const activeSession = sessions.find(s => s.id === selectedId)
      const expectedPath = chatPath || activeSession?.cwd || ''
      if (!expectedPath || normPath(ev.projectPath) !== normPath(expectedPath)) return
      const { event } = ev
      if (event?.type === 'system' && event?.subtype === 'init') {
        // New run starting — reset stage so Stage 2 can fire again
        setChatStage(1)
      } else if (event?.type === 'assistant' && event.message?.usage) {
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
        <a
          href="https://claude.ai"
          target="_blank"
          rel="noopener noreferrer"
          title="開啟 Claude.ai"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase no-underline">
          ↗ Claude
        </a>
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
            {activeTab === 'prompt'    && <PromptStudioPanel />}
            {activeTab === 'prefs'     && <PreferencesPanel />}
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
