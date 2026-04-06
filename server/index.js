import Fastify from 'fastify'
import wsPlugin from '@fastify/websocket'

const PORT = 3001
const CLAUDIA_URL = 'http://localhost:48901'

const app = Fastify({ logger: false })
await app.register(wsPlugin)

// ─── State ────────────────────────────────────────────────────────────────────

const sessions           = new Map()   // sessionId → Session
const clients            = new Set()   // WebSocket clients
const pendingPermissions = new Map()   // permId → { resolve, timer, sessionId }
const logHistory         = []          // all log entries, capped at 500

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    try { ws.send(data) } catch {}
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({ type: 'state', sessions: [...sessions.values()], logs: logHistory }))

  socket.on('message', (raw) => {
    try { handleClientMessage(JSON.parse(raw.toString())) } catch {}
  })
  socket.on('close', () => clients.delete(socket))
})

function handleClientMessage(msg) {
  if (msg.type === 'gate') {
    const s = sessions.get(msg.sessionId)
    if (!s) return
    updateTaskGate(s.tasks, msg.taskId, msg.action)
    sessions.set(s.id, s)
    broadcast({ type: 'session', session: s })
  }
  if (msg.type === 'input') {
    broadcast({ type: 'log', level: 'user', text: `> ${msg.text}`, ts: Date.now(), sessionId: msg.sessionId })
  }
  if (msg.type === 'rename') {
    const s = sessions.get(msg.sessionId)
    if (!s) return
    s.displayName = msg.name
    sessions.set(s.id, s)
    broadcast({ type: 'session', session: s })
  }
  if (msg.type === 'permission_response') {
    const p = pendingPermissions.get(msg.permissionId)
    if (!p) return
    clearTimeout(p.timer)
    pendingPermissions.delete(msg.permissionId)
    const decision = msg.action === 'block' ? 'block' : 'approve'
    const label = decision === 'approve' ? '✓ APPROVED' : '✕ BLOCKED'
    const sx = sessions.get(p.sessionId)
    if (sx) { sx.pendingPermission = null }
    setStatus(p.sessionId, 'active')
    emitLog(p.sessionId, `[Permission] ${label}`, decision === 'approve' ? 'hook' : 'permission')
    p.resolve({ decision })
  }
}

function updateTaskGate(tasks, taskId, action) {
  for (const t of tasks ?? []) {
    if (t.id === taskId && t.gate) {
      const map = { approve: 'approved', force: 'force', block: 'blocked' }
      t.gate.status = map[action] ?? action
      return
    }
    updateTaskGate(t.children, taskId, action)
  }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function upsertSession(sessionId, patch = {}) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      name: sessionId,
      displayName: 'Session',
      status: 'active',
      startedAt: Date.now(),
      tasks: [],
    })
  }
  const s = sessions.get(sessionId)
  Object.assign(s, patch)
  sessions.set(sessionId, s)
  return s
}

function setStatus(sessionId, status) {
  const s = upsertSession(sessionId)
  s.status = status
  broadcast({ type: 'session', session: s })
}

function emitLog(sessionId, text, level = 'hook') {
  const entry = { type: 'log', level, text, ts: Date.now(), sessionId }
  logHistory.push(entry)
  if (logHistory.length > 500) logHistory.shift()
  broadcast(entry)
}

function projectName(cwd) {
  if (!cwd) return 'Session'
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Session'
}

// ─── Hook endpoints ───────────────────────────────────────────────────────────

// Generic passthrough (legacy / Claudia forward only)
app.post('/hook', async (request) => {
  forwardToClaudia(request.body)
  return { ok: true }
})

// SessionStart
app.post('/hook/SessionStart', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'SessionStart')
  const name = projectName(e.cwd)
  // Remove old done/inactive sessions from the same project to keep the list clean
  for (const [id, old] of sessions) {
    if (id !== e.session_id && old.displayName === name && old.status !== 'active' && old.status !== 'waiting') {
      sessions.delete(id)
      broadcast({ type: 'session_remove', sessionId: id })
    }
  }
  const s = upsertSession(e.session_id, {
    displayName: name,
    cwd: e.cwd,
    status: 'active',
    startedAt: Date.now(),
  })
  broadcast({ type: 'session', session: s })
  emitLog(e.session_id, `[SessionStart] ${s.displayName}`)
  return { ok: true }
})

// Stop
app.post('/hook/Stop', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'Stop')
  const reason = e.stop_reason ?? ''
  const status = reason === 'max_tokens' ? 'sleeping' : 'done'
  setStatus(e.session_id, status)
  const tokens = e.usage ? `in=${e.usage.input_tokens} out=${e.usage.output_tokens}` : ''
  emitLog(e.session_id, `[Stop] ${reason} ${tokens}`.trim())
  return { ok: true }
})

// SessionEnd
app.post('/hook/SessionEnd', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'SessionEnd')
  setStatus(e.session_id, 'done')
  emitLog(e.session_id, `[SessionEnd]`)
  return { ok: true }
})

// PreToolUse
app.post('/hook/PreToolUse', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'PreToolUse')
  const s = upsertSession(e.session_id)
  if (s.status === 'waiting') setStatus(e.session_id, 'active')
  const detail = toolSummary(e.tool_name, e.tool_input)
  emitLog(e.session_id, `[${e.tool_name}] ${detail}`)
  return { ok: true }
})

// PostToolUse
app.post('/hook/PostToolUse', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'PostToolUse')
  // no status change
  return { ok: true }
})

// PermissionRequest — long-poll: hold connection until user approves/blocks in dashboard
app.post('/hook/PermissionRequest', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'PermissionRequest')
  setStatus(e.session_id, 'waiting')
  const summary = toolSummary(e.tool_name, e.tool_input)
  emitLog(e.session_id, `[Permission] ${e.tool_name}: ${summary}`, 'permission')

  const permId = `perm_${Date.now()}`
  const s = upsertSession(e.session_id)
  s.pendingPermission = { permissionId: permId, toolName: e.tool_name, summary, ts: Date.now() }
  broadcast({ type: 'session', session: s })

  // Block until dashboard responds (or 60s auto-approve timeout)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(permId)
      const sx = sessions.get(e.session_id)
      if (sx) { sx.pendingPermission = null }
      setStatus(e.session_id, 'active')
      emitLog(e.session_id, '[Permission] auto-approved (60s timeout)', 'hook')
      resolve({ decision: 'approve' })
    }, 60_000)
    pendingPermissions.set(permId, { resolve, timer, sessionId: e.session_id })
  })
})

// UserPromptSubmit
app.post('/hook/UserPromptSubmit', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'UserPromptSubmit')
  const raw = e.prompt ?? ''
  // Strip leading XML system tags (e.g. <task-notification>, <system-reminder>)
  const clean = raw.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
  const preview = (clean || raw).slice(0, 80)
  // Use first real human prompt as session topic if still generic
  const s = upsertSession(e.session_id)
  if (!s.topic && clean) {
    s.topic = clean
    s.displayName = clean.slice(0, 40) || s.displayName
    broadcast({ type: 'session', session: s })
  }
  emitLog(e.session_id, `[Prompt] ${preview}`, 'user')
  return { ok: true }
})

// SubagentStop / PreCompact (forward only)
for (const path of ['/hook/SubagentStop', '/hook/PreCompact', '/hook/PostCompact']) {
  app.post(path, async (request) => {
    forwardToClaudia(request.body, path.split('/').pop())
    return { ok: true }
  })
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function forwardToClaudia(body, eventName) {
  try {
    const url = eventName ? `${CLAUDIA_URL}/hook/${eventName}` : `${CLAUDIA_URL}/hook`
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {}
}

function toolSummary(toolName, input = {}) {
  switch (toolName) {
    case 'Bash':    return (input.command ?? '').slice(0, 60)
    case 'Read':    return input.file_path ?? ''
    case 'Write':   return input.file_path ?? ''
    case 'Edit':    return input.file_path ?? ''
    case 'Glob':    return input.pattern ?? ''
    case 'Grep':    return `"${input.pattern ?? ''}" in ${input.path ?? '.'}`
    default:        return JSON.stringify(input).slice(0, 60)
  }
}

// ─── Task API (Phase B) ───────────────────────────────────────────────────────

app.get('/api/sessions', async () => ({ sessions: [...sessions.values()] }))

app.post('/api/sessions/:id/tasks', async (request) => {
  const s = upsertSession(request.params.id)
  const task = { id: `t${Date.now()}`, ...request.body, children: [] }
  s.tasks.push(task)
  broadcast({ type: 'session', session: s })
  return { ok: true, task }
})

app.patch('/api/sessions/:id/tasks/:tid', async (request) => {
  const s = sessions.get(request.params.id)
  if (!s) return { ok: false }
  patchTask(s.tasks, request.params.tid, request.body)
  broadcast({ type: 'session', session: s })
  return { ok: true }
})

function patchTask(tasks, tid, patch) {
  for (const t of tasks ?? []) {
    if (t.id === tid) { Object.assign(t, patch); return true }
    if (patchTask(t.children, tid, patch)) return true
  }
  return false
}

// Clear all non-active sessions
app.post('/api/sessions/clear-inactive', async () => {
  const removed = []
  for (const [id, s] of sessions) {
    if (s.status !== 'active' && s.status !== 'waiting') {
      sessions.delete(id)
      removed.push(id)
    }
  }
  for (const id of removed) broadcast({ type: 'session_remove', sessionId: id })
  return { ok: true, removed: removed.length }
})

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'online',
  name: 'TheClaudenental',
  sessions: sessions.size,
  clients: clients.size,
}))

// ─── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`TheClaudenental server running on http://localhost:${PORT}`)
