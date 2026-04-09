import { useState, useEffect, useRef, useCallback } from 'react'
import { useCostEngine, BountyOverlay, BountyToast, ContractModal, fmtCost, tierKey } from './BountySystem.jsx'
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

function SessionItem({ session, isSelected, onClick, onDoubleClick, liveCost, onCostClick, autoResumeArmed, onToggleAutoResume }) {
  const base = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-all'
  const selectedCls = isSelected
    ? 'bg-[var(--surface-2)] session-active-glow'
    : 'hover:bg-[var(--surface-2)]'

  // ── Cost delta animation ─────────────────────────────────────────────────
  const rawCost = liveCost ?? session.costUsd ?? null
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
        <div className="truncate text-[var(--text-h)] text-xs leading-tight">
          {session.displayName}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
          <span>{elapsed(session.startedAt)} ago</span>

          <div className="ml-auto flex items-center gap-1 shrink-0">
            {/* Auto-resume toggle — only visible when sleeping */}
            {session.status === 'sleeping' && (
              <button
                onClick={e => { e.stopPropagation(); onToggleAutoResume?.() }}
                title={autoResumeArmed ? '自動繼續 ON — 點擊取消' : '設定整點自動繼續'}
                className={`text-[9px] px-1 leading-none rounded border transition-colors ${
                  autoResumeArmed
                    ? 'border-amber-500/80 text-amber-400 pulse-amber'
                    : 'border-gray-600/40 text-gray-600 hover:border-gray-500 hover:text-gray-400'
                }`}
              >⏰</button>
            )}

            {/* Cost badge + delta overlay */}
            {displayedCost != null && (
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
            )}
          </div>
        </div>
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

function InputBar({ onSend, className = '' }) {
  const [value, setValue] = useState('')
  const textRef = useRef(null)

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <div className={`flex items-end gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--surface)] ${className}`}>
      <textarea
        ref={textRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKey}
        placeholder="/task <標題> 新增任務　或直接輸入訊息 (Enter 送出)"
        rows={1}
        className="flex-1 resize-none bg-[var(--surface-2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text-h)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold)] min-h-[36px] max-h-[120px] overflow-y-auto"
        style={{ fieldSizing: 'content' }}
      />
      <button
        onClick={submit}
        className="shrink-0 px-3 py-2 rounded bg-[var(--gold-dim)] border border-[var(--gold-border)] text-[var(--gold)] text-xs hover:bg-[var(--gold)] hover:text-black transition-colors"
      >
        Send
      </button>
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

function ChatPanel({ streamEvents, chatInit }) {
  const [projectPath, setProjectPath] = useState('C:/Project/RomanPrototype')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const bottomRef = useRef(null)
  const prevChatInitRef = useRef(null)

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
    } else if (event.type === 'assistant') {
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
    if (!input.trim() || running) return
    const prompt = input.trim()
    setInput('')
    setRunning(true)
    setMessages(m => [...m, { role: 'user', text: prompt, ts: Date.now() }])
    await fetch('/api/claude/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, prompt, sessionId }),
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
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSend()
  }

  function clearChat() { setMessages([]); setSessionId(null) }

  return (
    <div className="flex flex-col h-full">
      {/* Project path bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest shrink-0">Project</span>
        <input
          value={projectPath}
          onChange={e => { setProjectPath(e.target.value); setSessionId(null); setMessages([]) }}
          className="flex-1 bg-transparent text-[10px] text-[var(--text)] font-mono outline-none border-b border-[var(--border)] pb-0.5"
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
        {running && (
          <div className="text-[10px] text-[var(--text-muted)] animate-pulse">Claude 思考中…</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--border)] p-2 flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="輸入訊息… (Ctrl+Enter 送出)"
          rows={3}
          disabled={running}
          className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] text-[var(--text)] resize-none outline-none placeholder:text-[var(--text-muted)] disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={handleSend}
            disabled={running || !input.trim()}
            className="px-3 py-1.5 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/50 text-[var(--gold)] text-[10px] hover:bg-[var(--gold)]/30 disabled:opacity-40"
          >
            送出
          </button>
          {running && (
            <button
              onClick={handleStop}
              className="px-3 py-1.5 rounded bg-red-900/30 border border-red-700/50 text-red-300 text-[10px] hover:bg-red-800/50"
            >
              停止
            </button>
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

function MobileSessionBar({ sessions, selectedId, setActiveTab }) {
  const sel = sessions.find(s => s.id === selectedId)
  return (
    <div className="flex md:hidden items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
      {sel
        ? <><StatusDot status={sel.status} /><span className="text-[10px] text-[var(--text-h)] truncate flex-1">{sel.displayName}</span></>
        : <span className="text-[10px] text-[var(--text-muted)] flex-1">No session selected</span>
      }
      <button
        onClick={() => setActiveTab('sessions')}
        className="text-[9px] px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)] shrink-0"
      >
        Sessions ▾
      </button>
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

function MobileSessionsPanel({ sessions, selectedId, setSelectedId, setActiveTab }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        Sessions
      </div>
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {sessions.map(s => (
          <SessionItem key={s.id} session={s} isSelected={s.id === selectedId}
            onClick={() => {
              setSelectedId(s.id)
              setActiveTab('chat')
              if (s.cwd) onContinue({ sessionId: s.id, projectPath: s.cwd })
            }}
            onDoubleClick={() => {}}
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
  const [liveCosts, setLiveCosts]               = useState({})   // { 'session:<id>' | normPath: total }
  const [historyCosts, setHistoryCosts]         = useState({})   // { [sessionId]: costUsd }

  // Track which session is currently open in Chat (for animation gating)
  const activeChatSessionRef = useRef(null)
  const activeTabRef          = useRef('chat')

  useEffect(() => { activeChatSessionRef.current = chatInit?.sessionId ?? null }, [chatInit])
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
          if (sess?.cwd && sess.status === 'sleeping') {
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
    const { key, total } = anim
    // Resolve session from key
    const sessById  = key.startsWith('session:') ? sessions.find(s => s.id === key.slice(8)) : null
    const sessByCwd = !sessById ? sessions.find(s => normPath(s.cwd) === key) : null
    const sess = sessById ?? sessByCwd

    // Always update live cost display (both keys for safe lookup)
    setLiveCosts(prev => {
      const next = { ...prev, [key]: total }
      if (sess) {
        next[normPath(sess.cwd)]    = total
        next[`session:${sess.id}`] = total
      }
      return next
    })

    // Keep historyCosts in sync — no re-fetch needed
    if (sess) {
      setHistoryCosts(prev => ({ ...prev, [sess.id]: total }))
    }

    // Fire animation only when Chat tab is active AND this is the currently open session
    const activeSid = activeChatSessionRef.current
    const isCurrentChat = sess
      ? sess.id === activeSid
      : key === normPath('') // fallback: never match
    if (activeTabRef.current === 'chat' && isCurrentChat) {
      setAnimQueue(q => [...q, { ...anim, sessionName: sess?.displayName ?? '' }])
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
  const isToast   = animTier === 'L' && (animLevel === 3 || animLevel === 4)
  const isOverlay = (animTier === 'L' && animLevel && animLevel < 3)
    ? false
    : animTier != null && !(animTier === 'L' && animLevel < 3)
  // L1/L2 = badge flash only (handled inline in SessionItem via liveCosts)

  function handleContinueInChat({ sessionId, projectPath }) {
    setChatInit({ sessionId, projectPath })
    setActiveTab('chat')
  }
  // pendingPermission is now read from selected.pendingPermission (server-side state)
  const logContainerRef = useRef(null)
  const isAtBottomRef = useRef(true)

  // Auto-scroll log to bottom unless user scrolled up
  useEffect(() => {
    const el = logContainerRef.current
    if (!el) return
    if (isAtBottomRef.current) el.scrollTop = el.scrollHeight
  }, [logs])

  function handleLogScroll() {
    const el = logContainerRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

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
      setStreamEvents(prev => [...prev.slice(-200), msg])
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

  async function handleSend(text) {
    if (!text.trim()) return
    // /task <title> → create task via API
    if (text.startsWith('/task ')) {
      const title = text.slice(6).trim()
      if (title && selectedId) {
        await fetch(`/api/sessions/${selectedId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, status: 'pending' }),
        })
      }
      return
    }
    send({ type: 'input', sessionId: selectedId, text })
    setLogs(prev => [...prev.slice(-200), {
      type: 'log', level: 'user', text: `> ${text}`, ts: Date.now(),
    }])
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg)] text-[var(--text)]">

      {/* ── Bounty overlays ── */}
      {isToast && currentAnim && (
        <BountyToast anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {isOverlay && currentAnim && (
        <BountyOverlay anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {contractModal && (
        <ContractModal
          sessionName={contractModal.sessionName}
          costData={contractModal.costData}
          onClose={() => setContractModal(null)}
        />
      )}
      {showBountySettings && (
        <BountySettings onClose={() => setShowBountySettings(false)} />
      )}

      {/* ── Top bar ── */}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
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
                    liveCost={liveCosts[`session:${s.id}`] ?? liveCosts[normPath(s.cwd)] ?? null}
                    onClick={() => {
                      setSelectedId(s.id)
                      if (s.cwd) handleContinueInChat({ sessionId: s.id, projectPath: s.cwd })
                    }}
                    onDoubleClick={() => { setRenamingId(s.id); setRenameVal(s.displayName) }}
                    onCostClick={async () => {
                      const live = costSnap[`session:${s.id}`] ?? costSnap[normPath(s.cwd)]
                      if (live) {
                        setContractModal({ sessionName: s.displayName, costData: live })
                      } else {
                        const d = await fetch(`/api/history/${s.id}`).then(r => r.json()).catch(() => ({}))
                        setContractModal({
                          sessionName: s.displayName,
                          costData: { total: d.costUsd ?? 0, byType: d.byType ?? {}, byModel: d.byModel ?? {} },
                        })
                      }
                    }}
                    autoResumeArmed={autoResumeMap[s.id]?.enabled === true}
                    onToggleAutoResume={() => toggleAutoResume(s.id)}
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
          <MobileSessionBar sessions={sessions} selectedId={selectedId} setActiveTab={setActiveTab} />

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
              <ChatPanel streamEvents={streamEvents} chatInit={chatInit} />
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
            {activeTab === 'sessions'  && <MobileSessionsPanel sessions={sessions} selectedId={selectedId} setSelectedId={setSelectedId} setActiveTab={setActiveTab} />}
            {activeTab === 'more'      && <MobileMorePanel selected={selected} send={send} logs={logs} sessions={sessions} />}
          </div>

          {/* Event log — desktop only */}
          <div className="hidden md:flex h-28 border-t border-[var(--border)] flex-col bg-[var(--surface)] shrink-0">
            <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
              Hook Events
            </div>
            <div ref={logContainerRef} onScroll={handleLogScroll}
              className="flex-1 overflow-y-auto px-3 py-1 font-mono text-[10px]">
              {logs.length === 0 && <span className="text-[var(--text-muted)]">Waiting for events…</span>}
              {logs.filter(l => !l.sessionId || l.sessionId === selectedId).map((log, i) => (
                <div key={i} className={`leading-5 ${
                  log.level === 'user'       ? 'text-[var(--gold)]' :
                  log.level === 'permission' ? 'text-amber-400' :
                  'text-[var(--text-muted)]'
                }`}>{log.text ?? JSON.stringify(log)}</div>
              ))}
            </div>
          </div>

          <InputBar onSend={handleSend} className="hidden md:flex" />
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
