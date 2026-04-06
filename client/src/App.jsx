import { useState, useEffect, useRef, useCallback } from 'react'

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

function SessionItem({ session, isSelected, onClick, onDoubleClick }) {
  const base = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-all'
  const selected = isSelected
    ? 'bg-[var(--surface-2)] session-active-glow'
    : 'hover:bg-[var(--surface-2)]'
  return (
    <div className={`${base} ${selected}`} onClick={onClick} onDoubleClick={onDoubleClick}>
      <StatusDot status={session.status} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[var(--text-h)] text-xs leading-tight">
          {session.displayName}
        </div>
        <div className="truncate text-[var(--text-muted)] text-[10px]">
          {elapsed(session.startedAt)} ago
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

function CharacterZone({ status }) {
  // Placeholder — Rive animation will go here
  const mood = {
    active:   { emoji: '⚔', label: 'On mission', color: 'text-green-400' },
    sleeping: { emoji: '💤', label: 'Sleeping (token limit)', color: 'text-gray-500 shimmer' },
    waiting:  { emoji: '⏳', label: 'Awaiting approval', color: 'text-amber-400 pulse-amber' },
    error:    { emoji: '🩸', label: 'Fallen', color: 'text-red-400' },
    done:     { emoji: '🏛', label: 'Mission complete', color: 'text-blue-400' },
  }[status] ?? { emoji: '?', label: 'Unknown', color: 'text-gray-500' }

  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <div className={`text-5xl leading-none ${mood.color}`}>{mood.emoji}</div>
      <div className={`text-[10px] uppercase tracking-widest ${mood.color}`}>{mood.label}</div>
      <div className="text-[10px] text-[var(--text-muted)] mt-1">The Continental</div>
    </div>
  )
}

function InputBar({ onSend }) {
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
    <div className="flex items-end gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--surface)]">
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

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [logs, setLogs] = useState([])
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
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

  const { connected, send } = useWebSocket(WS_URL, msg => {
    if (msg.type === 'state') {
      setSessions(msg.sessions)
      setSelectedId(prev => prev ?? msg.sessions[0]?.id ?? null)
      if (msg.logs) setLogs(msg.logs)
    }
    if (msg.type === 'log') setLogs(prev => [...prev.slice(-200), msg])
    if (msg.type === 'session') {
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
    <div className="flex flex-col h-screen bg-[var(--bg)] text-[var(--text)]">

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
      </header>

      {/* ── Main layout ── */}
      <div className="flex flex-1 min-h-0">

        {/* Left: Sessions list */}
        <aside className="w-52 shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--surface)] overflow-hidden">
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
                    session={s}
                    isSelected={s.id === selectedId}
                    onClick={() => setSelectedId(s.id)}
                    onDoubleClick={() => { setRenamingId(s.id); setRenameVal(s.displayName) }}
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

        {/* Center: Task tree */}
        <main className="flex-1 flex flex-col min-w-0">
          <div className="px-4 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] shrink-0 flex items-center gap-2">
            <span>Tasks</span>
            {selected && (
              <>
                <span className="text-[var(--border-2)]">/</span>
                <span className="text-[var(--text-h)] normal-case tracking-normal">
                  {selected.displayName}
                </span>
                <StatusDot status={selected.status} />
              </>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-2">
            {selected?.tasks?.length > 0
              ? selected.tasks.map(task => (
                  <TaskNode key={task.id} task={task} onGateAction={handleGateAction} />
                ))
              : (
                <div className="text-[var(--text-muted)] text-xs text-center mt-8">
                  {selected ? 'No tasks yet' : 'Select a session'}
                </div>
              )
            }
          </div>

          {/* Event log */}
          <div className="h-28 border-t border-[var(--border)] flex flex-col bg-[var(--surface)] shrink-0">
            <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
              Hook Events
            </div>
            <div
              ref={logContainerRef}
              onScroll={handleLogScroll}
              className="flex-1 overflow-y-auto px-3 py-1 font-mono text-[10px]"
            >
              {logs.length === 0 && (
                <span className="text-[var(--text-muted)]">Waiting for events…</span>
              )}
              {logs.filter(l => !l.sessionId || l.sessionId === selectedId).map((log, i) => (
                <div key={i} className={`leading-5 ${
                  log.level === 'user'       ? 'text-[var(--gold)]' :
                  log.level === 'permission' ? 'text-amber-400' :
                  'text-[var(--text-muted)]'
                }`}>
                  {log.text ?? JSON.stringify(log)}
                </div>
              ))}
            </div>
          </div>

          <InputBar onSend={handleSend} />
        </main>

        {/* Right: Character + Gate summary */}
        <aside className="w-48 shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--surface)] overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
            Agent
          </div>
          <CharacterZone status={selected?.status ?? 'sleeping'} />

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
              <div className="text-[10px] text-gray-400 shimmer">
                💤 Token 用量已達上限
              </div>
              <div className="text-[9px] text-[var(--text-muted)] mt-1">
                等待用量恢復後繼續
              </div>
            </div>
          )}

          {/* Pending gates summary */}
          <div className="px-3 py-2 border-t border-[var(--border)]">
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
    </div>
  )
}
