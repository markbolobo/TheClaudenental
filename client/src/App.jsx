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

const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000 // 5 hours

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

// ─── Tab panels ──────────────────────────────────────────────────────────────

function HistoryPanel() {
  const [list, setList] = useState([])
  const [active, setActive] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/history').then(r => r.json()).then(d => setList(d.sessions ?? []))
  }, [])

  async function open(s) {
    setActive(s); setLoading(true)
    const d = await fetch(`/api/history/${s.sessionId}`).then(r => r.json())
    setMessages(d.messages ?? []); setLoading(false)
  }

  if (active) return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <button onClick={() => setActive(null)} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs">← Back</button>
        <span className="text-xs text-[var(--text-h)] truncate">{active.title}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {loading && <div className="text-[var(--text-muted)] text-xs">Loading…</div>}
        {messages.map((m, i) => (
          <div key={i} className={`text-[11px] rounded px-2 py-1 ${m.role === 'user' ? 'bg-[var(--surface-2)] text-[var(--gold)]' : 'text-[var(--text-muted)]'}`}>
            <div className="font-semibold text-[9px] uppercase mb-0.5 opacity-60">{m.role}</div>
            <div className="whitespace-pre-wrap break-words">{m.text}</div>
          </div>
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
          <div className="text-[10px] text-[var(--text-muted)]">{s.project.replace('c--', '').replace(/-/g,'/')} · {new Date(s.mtime).toLocaleDateString()}</div>
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

function ChatPanel({ send, streamEvents }) {
  const [projectPath, setProjectPath] = useState('C:/Project/RomanPrototype')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const bottomRef = useRef(null)

  // Process incoming stream events
  useEffect(() => {
    if (!streamEvents.length) return
    const ev = streamEvents[streamEvents.length - 1]
    if (ev.projectPath !== projectPath) return
    const { event } = ev

    if (event.type === 'system' && event.subtype === 'init') {
      setSessionId(event.session_id)
    } else if (event.type === 'assistant') {
      const blocks = event.message?.content ?? []
      const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
      const toolBlocks = blocks.filter(b => b.type === 'tool_use')
      if (textBlocks) setMessages(m => [...m, { role: 'assistant', text: textBlocks, ts: Date.now() }])
      for (const t of toolBlocks)
        setMessages(m => [...m, { role: 'tool', toolName: t.name, input: t.input, ts: Date.now() }])
    } else if (event.type === 'result') {
      setRunning(false)
      const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''
      setMessages(m => [...m, { role: 'result', text: `完成${cost}`, ts: Date.now() }])
    } else if (event.type === 'done') {
      setRunning(false)
    }
  }, [streamEvents, projectPath])

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
          <div key={i} className={`text-[11px] leading-relaxed ${
            m.role === 'user'      ? 'text-[var(--gold)]' :
            m.role === 'assistant' ? 'text-[var(--text)]' :
            m.role === 'tool'      ? 'text-sky-400 font-mono text-[10px]' :
            'text-[var(--text-muted)] text-[10px]'
          }`}>
            {m.role === 'user' && <span className="opacity-50 mr-1">›</span>}
            {m.role === 'tool' && (
              <span className="bg-sky-900/30 border border-sky-700/50 rounded px-1.5 py-0.5 inline-block">
                [{m.toolName}] {JSON.stringify(m.input).slice(0, 80)}
              </span>
            )}
            {m.role !== 'tool' && <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>}
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

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [logs, setLogs] = useState([])
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const [streamEvents, setStreamEvents] = useState([])
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
      if (msg.logs) setLogs(msg.logs)  // replace on reconnect, not append
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
    if (msg.type === 'claude_stream') {
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

        {/* Center: Tab panel */}
        <main className="flex-1 flex flex-col min-w-0">

          {/* Tab bar */}
          <div className="flex items-center border-b border-[var(--border)] bg-[var(--surface)] shrink-0 overflow-x-auto">
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
              <ChatPanel send={send} streamEvents={streamEvents} />
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
            {activeTab === 'history'   && <HistoryPanel />}
            {activeTab === 'analytics' && <AnalyticsPanel sessions={sessions} />}
            {activeTab === 'claudemd'  && <ClaudeMdPanel selected={selected} />}
            {activeTab === 'agents'    && <AgentsPanel />}
            {activeTab === 'mcp'       && <McpPanel />}
          </div>

          {/* Event log */}
          <div className="h-28 border-t border-[var(--border)] flex flex-col bg-[var(--surface)] shrink-0">
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

          <InputBar onSend={handleSend} />
        </main>

        {/* Right: Character + Gate summary */}
        <aside className="w-48 shrink-0 border-l border-[var(--border)] flex flex-col bg-[var(--surface)] overflow-hidden">
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
              <div className="text-[10px] text-gray-400 shimmer">
                💤 Token 用量已達上限
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
    </div>
  )
}
