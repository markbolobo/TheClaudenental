import Fastify from 'fastify'
import wsPlugin from '@fastify/websocket'
import multipart from '@fastify/multipart'
import fs from 'fs'
import path from 'path'
import { spawnSync, spawn } from 'child_process'
import os from 'os'
import crypto from 'crypto'

const PORT = 3001
const CLAUDIA_URL = 'http://localhost:48901'

const PRICING = {
  'claude-sonnet-4-6':         { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-6':           { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
}

const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 }) // 50MB — supports large image base64 payloads
await app.register(wsPlugin)
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }) // 100 MB

// ─── Claude Binary Auto-detect ───────────────────────────────────────────────

function findClaudeExe() {
  // 1. Check VS Code extension (primary on Windows)
  const extDir = path.join(os.homedir(), '.vscode', 'extensions')
  if (fs.existsSync(extDir)) {
    const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code')).sort().reverse()
    for (const d of dirs) {
      const candidate = path.join(extDir, d, 'resources', 'native-binary', 'claude.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  // 2. Fallback: PATH
  return 'claude'
}

const CLAUDE_EXE = findClaudeExe()

// ─── State ────────────────────────────────────────────────────────────────────

const sessions           = new Map()   // sessionId → Session
const clients            = new Set()   // WebSocket clients
const pendingPermissions = new Map()   // permId → { resolve, timer, sessionId }
const logHistory         = []          // all log entries, capped at 500
const claudeProcs        = new Map()   // projectPath → { proc, sessionId, status }
const subprocessSids     = new Set()   // session_ids spawned by us (filtered from sessions list)
const pendingSpawnCwds   = new Set()   // project paths currently spawning (pre-registers before init event)

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    try { ws.send(data) } catch {}
  }
}

// ─── Session persistence ──────────────────────────────────────────────────────

const SESSIONS_FILE = path.join(os.homedir(), '.claude', 'theclaudenental-sessions.json')

function persistSessions() {
  try {
    const data = {}
    for (const [id, s] of sessions) data[id] = s
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data))
  } catch {}
}

function loadPersistedSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
    for (const [id, s] of Object.entries(data)) {
      // Mark previously-active as done since we don't know if they're still running
      if (s.status === 'active' || s.status === 'waiting') s.status = 'done'
      sessions.set(id, s)
    }
  } catch {}
}

loadPersistedSessions()

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
    // If entry not found (e.g. server restarted, stale card), still clear UI
    if (!p) {
      for (const [, sx] of sessions) {
        if (sx.pendingPermission?.permissionId === msg.permissionId) {
          sx.pendingPermission = null
          broadcast({ type: 'session', session: sx })
        }
      }
      return
    }
    clearTimeout(p.timer)
    pendingPermissions.delete(msg.permissionId)
    const isAlwaysAllow = msg.action === 'allow_always'
    const allow = msg.action !== 'block'
    const label = isAlwaysAllow ? '⭐ ALWAYS ALLOWED' : allow ? '✓ APPROVED' : '✕ BLOCKED'
    const sx = sessions.get(p.sessionId)
    if (sx) { sx.pendingPermission = null }
    setStatus(p.sessionId, 'active')
    emitLog(p.sessionId, `[Permission] ${label}`, allow ? 'hook' : 'permission')
    // Resolve FIRST so Claude Code resumes immediately — settings write happens after
    p.resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: allow ? 'allow' : 'deny' } })
    // Persist to settings.json when "Allow Always" (done async to avoid race with Claude Code file watcher)
    if (isAlwaysAllow && p.toolName) {
      setImmediate(() => {
        try {
          const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
          settings.permissions = settings.permissions ?? {}
          settings.permissions.allow = settings.permissions.allow ?? []
          const entry = p.toolName === 'Bash' ? 'Bash(*)' : p.toolName
          if (!settings.permissions.allow.includes(entry)) {
            settings.permissions.allow.push(entry)
            atomicWriteJson(settingsPath, settings)
            emitLog(p.sessionId, `[Permission] ${entry} 已加入永久白名單`, 'hook')
          }
        } catch {}
      })
    }
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

let _persistTimer = null
function schedulePersist() {
  if (_persistTimer) return
  _persistTimer = setTimeout(() => { _persistTimer = null; persistSessions() }, 2000)
}

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
  schedulePersist()
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
  // Ignore sessions spawned by our own subprocess — they appear in Chat, not Sessions list
  // Check both confirmed session_ids and pending spawns (by cwd) to handle race condition
  const cwdNorm = (e.cwd ?? '').replace(/\\/g, '/').toLowerCase()
  if (subprocessSids.has(e.session_id) || pendingSpawnCwds.has(cwdNorm)) return { ok: true }
  const name = getSessionTopic(e.session_id) ?? projectName(e.cwd)
  // Remove old done/inactive sessions from the same project to keep the list clean
  for (const [id, old] of sessions) {
    if (id !== e.session_id && old.cwd === e.cwd && old.status !== 'active' && old.status !== 'waiting') {
      sessions.delete(id)
      broadcast({ type: 'session_remove', sessionId: id })
      schedulePersist()
    }
  }
  const s = upsertSession(e.session_id, {
    displayName: name,
    topic: name !== projectName(e.cwd) ? name : undefined,
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
  if (subprocessSids.has(e.session_id)) return { ok: true }
  const reason = e.stop_reason ?? ''
  const isSleeping = reason === 'max_tokens'
  const status = isSleeping ? 'sleeping' : 'done'
  const s = upsertSession(e.session_id)
  if (isSleeping) s.sleepingAt = Date.now()
  else s.sleepingAt = null
  // Accumulate token usage
  if (e.usage) {
    s.tokens = s.tokens ?? { input: 0, output: 0 }
    s.tokens.input  += e.usage.input_tokens  ?? 0
    s.tokens.output += e.usage.output_tokens ?? 0
  }
  setStatus(e.session_id, status)
  const tokens = e.usage ? `in=${e.usage.input_tokens} out=${e.usage.output_tokens}` : ''
  emitLog(e.session_id, `[Stop] ${reason} ${tokens}`.trim())
  // Immediately flush JSONL so final thinking/text appear without waiting for watcher
  flushSessionLive(e.session_id)
  return { ok: true }
})

// SessionEnd
app.post('/hook/SessionEnd', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'SessionEnd')
  if (subprocessSids.has(e.session_id)) { subprocessSids.delete(e.session_id); return { ok: true } }
  setStatus(e.session_id, 'done')
  emitLog(e.session_id, `[SessionEnd]`)
  return { ok: true }
})

// PreToolUse
app.post('/hook/PreToolUse', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'PreToolUse')
  const s = upsertSession(e.session_id)
  // Fill in displayName from cwd if still generic
  if (e.cwd && (!s.cwd || s.displayName === 'Session')) {
    s.cwd = e.cwd
    s.displayName = projectName(e.cwd)
  }
  // Try to resolve better topic from JSONL if we only have projectName
  if (!s.topic && s.displayName === projectName(e.cwd)) {
    const topic = getSessionTopic(e.session_id)
    if (topic) { s.topic = topic; s.displayName = topic }
  }
  // Always clear stale pendingPermission (e.g. after server restart + VS Code approval)
  if (s.pendingPermission) {
    const p = pendingPermissions.get(s.pendingPermission.permissionId)
    if (p) { clearTimeout(p.timer); pendingPermissions.delete(s.pendingPermission.permissionId); p.resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } }) }
    s.pendingPermission = null
  }
  if (s.status === 'waiting') setStatus(e.session_id, 'active')
  else broadcast({ type: 'session', session: s })
  const detail = toolSummary(e.tool_name, e.tool_input)
  emitLog(e.session_id, `[${e.tool_name}] ${detail}`)
  // Immediately flush JSONL so thinking/text appear before tool executes
  flushSessionLive(e.session_id)
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

  const permId = crypto.randomUUID()
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
      resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })
    }, 60_000)
    pendingPermissions.set(permId, { resolve, timer, sessionId: e.session_id, toolName: e.tool_name })
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
  // Save cwd as fallback name only — don't overwrite if topic already set
  if (e.cwd && !s.cwd) {
    s.cwd = e.cwd
    if (s.displayName === 'Session') s.displayName = projectName(e.cwd)
  }
  // First real human message becomes the display name
  if (!s.topic && clean) {
    s.topic = clean
    s.displayName = clean.slice(0, 40)
  }
  broadcast({ type: 'session', session: s })
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

// Clear all non-active sessions — must be before /:id routes to avoid param capture
app.post('/api/sessions/clear-inactive', async () => {
  const removed = []
  for (const [id, s] of sessions) {
    if (s.status !== 'active' && s.status !== 'waiting') {
      sessions.delete(id)
      removed.push(id)
      schedulePersist()
    }
  }
  for (const id of removed) broadcast({ type: 'session_remove', sessionId: id })
  return { ok: true, removed: removed.length }
})

// ── Activity Heat — time-windowed cost from JSONL files ──────────────────────
app.get('/api/usage/heat', async () => {
  const now    = Date.now()
  const WIN_5H = 5  * 60 * 60 * 1000
  const WIN_7D = 7  * 24 * 60 * 60 * 1000
  let cost5h = 0, cost7d = 0, count5h = 0, count7d = 0

  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeDir)) return { session5h: { cost: 0, count: 0 }, weekly7d: { cost: 0, count: 0 }, updatedAt: now }

  // Claude Code JSONL stores type:"assistant" entries with message.usage token counts.
  // There is no type:"result" with total_cost_usd — must compute cost from usage fields.
  const computeCost = (model, usage) => {
    const p = PRICING[model] ?? PRICING['claude-sonnet-4-6']
    return (
      (usage.input_tokens                ?? 0) * p.input      / 1_000_000 +
      (usage.output_tokens               ?? 0) * p.output     / 1_000_000 +
      (usage.cache_read_input_tokens     ?? 0) * p.cacheRead  / 1_000_000 +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite / 1_000_000
    )
  }

  try {
    for (const proj of fs.readdirSync(claudeDir)) {
      const projDir = path.join(claudeDir, proj)
      try { if (!fs.statSync(projDir).isDirectory()) continue } catch { continue }
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith('.jsonl')) continue
        const fullPath = path.join(projDir, f)
        try {
          // Quick pre-filter: skip files not touched in 7d
          if (now - fs.statSync(fullPath).mtimeMs > WIN_7D) continue
          for (const line of fs.readFileSync(fullPath, 'utf-8').split('\n')) {
            try {
              const obj = JSON.parse(line)
              if (obj.type !== 'assistant') continue
              const msg = obj.message
              if (!msg?.usage?.output_tokens) continue   // skip non-generating turns
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
              if (!ts) continue
              const age = now - ts
              if (age > WIN_7D) continue
              const cost = computeCost(msg.model ?? '', msg.usage)
              if (cost <= 0) continue
              cost7d += cost; count7d++
              if (age <= WIN_5H) { cost5h += cost; count5h++ }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  return {
    session5h: { cost: cost5h, count: count5h },
    weekly7d:  { cost: cost7d, count: count7d },
    updatedAt: now,
  }
})

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


// ─── Session History API ──────────────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude')

/** Read first user message or ai-title from a session's JSONL as display name */
function getSessionTopic(sessionId) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, proj, `${sessionId}.jsonl`)
      if (!fs.existsSync(candidate)) continue
      const lines = fs.readFileSync(candidate, 'utf-8').split('\n').filter(Boolean)
      let aiTitle = null
      for (const l of lines) {
        try {
          const obj = JSON.parse(l)
          if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle
        } catch {}
      }
      if (aiTitle) return aiTitle
      for (const l of lines) {
        try {
          const obj = JSON.parse(l)
          if (obj.type === 'user') {
            const c = obj.message?.content
            const text = typeof c === 'string' ? c : c?.[0]?.text ?? ''
            const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
            if (clean) return clean.slice(0, 50)
          }
        } catch {}
      }
    }
  } catch {}
  return null
}

// List all past sessions across all projects
app.get('/api/history', async () => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  const result = []
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const projPath = path.join(projectsDir, proj)
      if (!fs.statSync(projPath).isDirectory()) continue
      for (const file of fs.readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        const fullPath = path.join(projPath, file)
        const stat = fs.statSync(fullPath)
        // Read ai-title, cwd, and first user message
        let title = null, firstMsg = null, cwd = null, costUsd = null
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(Boolean)
          const byModelCost = {}
          for (const l of lines) {
            try {
              const obj = JSON.parse(l)
              if (!cwd && obj.cwd) cwd = obj.cwd
              if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
              if (obj.type === 'result' && typeof obj.total_cost_usd === 'number') {
                costUsd = (costUsd ?? 0) + obj.total_cost_usd
              }
              if (obj.type === 'assistant' && obj.message?.usage) {
                const u  = obj.message.usage
                const mn = obj.message.model ?? 'claude-sonnet-4-6'
                const p  = PRICING[mn] ?? PRICING['claude-sonnet-4-6']
                byModelCost[mn] = (byModelCost[mn] ?? 0) + (
                  (u.input_tokens ?? 0) * p.input +
                  (u.output_tokens ?? 0) * p.output +
                  (u.cache_read_input_tokens ?? 0) * p.cacheRead +
                  (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
                ) / 1e6
              }
            } catch {}
          }
          if (costUsd === null) {
            const est = Object.values(byModelCost).reduce((s, v) => s + v, 0)
            if (est > 0) costUsd = est
          }
          for (const l of lines) {
            try {
              const obj = JSON.parse(l)
              if (obj.type === 'user') {
                const c = obj.message?.content
                const text = typeof c === 'string' ? c : c?.[0]?.text ?? ''
                const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
                if (clean) { firstMsg = clean.slice(0, 60); break }
              }
            } catch {}
          }
        } catch {}
        result.push({ sessionId, project: proj, cwd, title: title ?? firstMsg ?? sessionId.slice(0,8), mtime: stat.mtimeMs, size: stat.size, costUsd })
      }
    }
  } catch {}
  return { sessions: result.sort((a,b) => b.mtime - a.mtime).slice(0, 100) }
})

// Get messages from a specific session JSONL
app.get('/api/history/:sessionId', async (request) => {
  const { sessionId } = request.params
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  let filePath = null
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, proj, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) { filePath = candidate; break }
    }
  } catch {}
  if (!filePath) return { ok: false, messages: [] }
  const messages = []
  let costUsd = null
  const byType   = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const byModel  = {}   // { [model]: { input, output, cacheRead, cacheWrite, cost } }
  const DEFAULT_P = PRICING['claude-sonnet-4-6']
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    for (const l of lines) {
      try {
        const obj = JSON.parse(l)
        if (obj.type === 'user') {
          const c = obj.message?.content
          const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x=>x.type==='text').map(x=>x.text).join('') : '')
          const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
          if (clean) messages.push({ role: 'user', text: clean, ts: obj.timestamp })
        }
        if (obj.type === 'assistant') {
          const c = obj.message?.content
          const text = Array.isArray(c) ? c.filter(x=>x.type==='text').map(x=>x.text).join('') : ''
          if (text.trim()) messages.push({ role: 'assistant', text: text.trim(), ts: obj.timestamp })
          if (obj.message?.usage) {
            const u   = obj.message.usage
            const mn  = obj.message.model ?? 'unknown'
            const p   = PRICING[mn] ?? DEFAULT_P
            byType.input      += u.input_tokens                ?? 0
            byType.output     += u.output_tokens               ?? 0
            byType.cacheRead  += u.cache_read_input_tokens     ?? 0
            byType.cacheWrite += u.cache_creation_input_tokens ?? 0
            if (!byModel[mn]) byModel[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
            byModel[mn].input      += u.input_tokens                ?? 0
            byModel[mn].output     += u.output_tokens               ?? 0
            byModel[mn].cacheRead  += u.cache_read_input_tokens     ?? 0
            byModel[mn].cacheWrite += u.cache_creation_input_tokens ?? 0
            byModel[mn].cost       += (
              (u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output +
              (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
            ) / 1e6
          }
        }
        if (obj.type === 'result' && typeof obj.total_cost_usd === 'number') {
          costUsd = (costUsd ?? 0) + obj.total_cost_usd
          // modelUsage from result event overrides per-message estimates for subprocess sessions
          if (obj.modelUsage) {
            for (const [mn, mu] of Object.entries(obj.modelUsage)) {
              if (!byModel[mn]) byModel[mn] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
              byModel[mn].input      = mu.inputTokens               ?? byModel[mn].input
              byModel[mn].output     = mu.outputTokens              ?? byModel[mn].output
              byModel[mn].cacheRead  = mu.cacheReadInputTokens      ?? byModel[mn].cacheRead
              byModel[mn].cacheWrite = mu.cacheCreationInputTokens  ?? byModel[mn].cacheWrite
              byModel[mn].cost       = mu.costUSD                   ?? byModel[mn].cost
            }
          }
        }
      } catch {}
    }
    if (costUsd === null && (byType.input + byType.output + byType.cacheRead) > 0) {
      costUsd = (byType.input * 3 + byType.output * 15 + byType.cacheRead * 0.3 + byType.cacheWrite * 3.75) / 1e6
    }
  } catch {}
  return { ok: true, messages: messages.slice(-500), costUsd, byType, byModel }
})

// ─── VS Code session live tail ────────────────────────────────────────────────

const watchedSessions = new Map() // sessionId → { watcher, filePath, lineCount }

function findJsonlPath(sessionId) {
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, proj, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}
  return null
}

function parseNewLines(filePath, fromLine) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    const newLines = lines.slice(fromLine)
    const messages = []
    for (const l of newLines) {
      try {
        const obj = JSON.parse(l)
        if (obj.type === 'user') {
          const c = obj.message?.content
          if (Array.isArray(c)) {
            // Tool results — emit each as tool_result
            for (const b of c) {
              if (b.type !== 'tool_result') continue
              const out = Array.isArray(b.content)
                ? b.content.filter(x => x.type === 'text').map(x => x.text).join('').slice(0, 300)
                : String(b.content ?? '').slice(0, 300)
              if (out.trim()) messages.push({ role: 'tool_result', toolId: b.tool_use_id, output: out, ts: obj.timestamp })
            }
            // Also push plain user text if any
            const text = c.filter(x => x.type === 'text').map(x => x.text).join('')
            const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
            if (clean) messages.push({ role: 'user', text: clean, ts: obj.timestamp })
          } else {
            const text = typeof c === 'string' ? c : ''
            const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
            if (clean) messages.push({ role: 'user', text: clean, ts: obj.timestamp })
          }
        } else if (obj.type === 'assistant') {
          const c = obj.message?.content ?? []
          const ts = obj.timestamp
          for (const b of (Array.isArray(c) ? c : [])) {
            if (b.type === 'thinking' && b.thinking?.trim())
              messages.push({ role: 'thinking', text: b.thinking.trim(), ts })
            else if (b.type === 'text' && b.text?.trim())
              messages.push({ role: 'assistant', text: b.text.trim(), ts })
            else if (b.type === 'tool_use')
              messages.push({ role: 'tool_use', toolName: b.name, input: b.input ?? {}, toolId: b.id, ts })
          }
          // Include usage for cost tracking (preserve on first assistant msg of this block)
          if (obj.message?.usage) {
            const last = messages[messages.length - 1]
            if (last) last._usage = { model: obj.message.model, usage: obj.message.usage }
          }
        }
      } catch {}
    }
    return { lineCount: lines.length, messages }
  } catch {}
  return null
}

// Immediately flush new JSONL lines for a session (called by hooks for real-time updates)
function flushSessionLive(sessionId) {
  const entry = watchedSessions.get(sessionId)
  if (!entry) return
  const result = parseNewLines(entry.filePath, entry.lineCount)
  if (!result || !result.messages.length) return
  entry.lineCount = result.lineCount
  broadcast({ type: 'session_live', sessionId, messages: result.messages })
}

app.post('/api/session/watch', async (request) => {
  const { sessionId } = request.body
  if (!sessionId) return { ok: false }
  // Stop watching previous session if different
  for (const [id, w] of watchedSessions) {
    if (id !== sessionId) { try { w.watcher.close() } catch {}; watchedSessions.delete(id) }
  }
  const filePath = findJsonlPath(sessionId)
  if (!filePath) return { ok: false, error: 'not found' }
  const initial = parseNewLines(filePath, 0)
  const lineCount = initial?.lineCount ?? 0
  // Broadcast full replay marked as isReplay so client always treats this as replace
  if (initial?.messages?.length) {
    broadcast({ type: 'session_live', sessionId, messages: initial.messages, isReplay: true })
  }
  if (watchedSessions.has(sessionId)) {
    watchedSessions.get(sessionId).lineCount = lineCount
    return { ok: true }
  }
  const watcher = fs.watchFile(filePath, { interval: 500 }, () => {
    const entry = watchedSessions.get(sessionId)
    if (!entry) return
    const result = parseNewLines(filePath, entry.lineCount)
    if (!result || !result.messages.length) return
    entry.lineCount = result.lineCount
    broadcast({ type: 'session_live', sessionId, messages: result.messages })
  })
  watchedSessions.set(sessionId, { watcher, filePath, lineCount })
  return { ok: true }
})

app.post('/api/session/unwatch', async (request) => {
  const { sessionId } = request.body
  const entry = watchedSessions.get(sessionId)
  if (entry) { try { fs.unwatchFile(entry.filePath) } catch {}; watchedSessions.delete(sessionId) }
  return { ok: true }
})

// ─── CLAUDE.md API ────────────────────────────────────────────────────────────

app.get('/api/claudemd', async (request) => {
  const cwd = request.query.cwd ?? process.cwd()
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  ]
  const files = []
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf-8')
      files.push({ path: p, content })
    } catch {}
  }
  return { files }
})

app.post('/api/claudemd', async (request) => {
  const { path: filePath, content } = request.body
  // Only allow writing CLAUDE.md files, block path traversal
  if (
    !filePath ||
    typeof filePath !== 'string' ||
    filePath.includes('..') ||
    !path.basename(filePath).match(/^CLAUDE\.md$/i)
  ) return { ok: false, error: 'invalid path' }
  try {
    fs.writeFileSync(filePath, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── Checkpoints API (git-based) ─────────────────────────────────────────────

// Validate hash: only hex, 7-40 chars
const SAFE_HASH = /^[0-9a-f]{7,40}$/i

// Validate cwd is an existing directory (normalize slashes for Windows)
function isSafeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return false
  const normalized = cwd.replace(/\//g, path.sep)
  try { return fs.statSync(normalized).isDirectory() } catch { return false }
}

function normalizePath(p) {
  return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
}

// Atomic JSON write — prevents race with Claudia
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

app.get('/api/checkpoints', async (request) => {
  const cwd = request.query.cwd
  if (!isSafeCwd(cwd)) return { ok: false, checkpoints: [] }
  try {
    const r = spawnSync('git', ['log', '--oneline', '-20'], { cwd, encoding: 'utf-8' })
    if (r.status !== 0) return { ok: false, checkpoints: [] }
    const checkpoints = r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, ...rest] = line.split(' ')
      return { hash, message: rest.join(' ') }
    })
    return { ok: true, checkpoints }
  } catch { return { ok: false, checkpoints: [] } }
})

app.post('/api/checkpoints', async (request) => {
  const { cwd, message } = request.body
  if (!isSafeCwd(cwd)) return { ok: false, error: 'invalid cwd' }
  const safeMsg = (typeof message === 'string' ? message : new Date().toISOString()).slice(0, 200)
  try {
    spawnSync('git', ['add', '-A'], { cwd })
    const commit = spawnSync('git', ['commit', '-m', `checkpoint: ${safeMsg}`], { cwd, encoding: 'utf-8' })
    if (commit.status !== 0) return { ok: false, error: commit.stderr?.trim() }
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf-8' })
    const hash = r.stdout.trim()
    broadcast({ type: 'checkpoint', cwd, hash, message: safeMsg })
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: e.message } }
})

app.post('/api/checkpoints/restore', async (request) => {
  const { cwd, hash } = request.body
  if (!isSafeCwd(cwd)) return { ok: false, error: 'invalid cwd' }
  if (!hash || !SAFE_HASH.test(hash)) return { ok: false, error: 'invalid hash' }
  try {
    // Create a new branch to avoid detached HEAD
    const branchName = `restore-${hash.slice(0, 7)}-${Date.now()}`
    const r = spawnSync('git', ['checkout', '-b', branchName, hash], { cwd, encoding: 'utf-8' })
    if (r.status !== 0) return { ok: false, error: r.stderr?.trim() }
    return { ok: true, branch: branchName }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── Agents API ───────────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents')

app.get('/api/agents', async () => {
  const agents = []
  try {
    if (!fs.existsSync(AGENTS_DIR)) return { agents }
    for (const file of fs.readdirSync(AGENTS_DIR)) {
      if (!file.endsWith('.md')) continue
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8')
      const name = file.replace('.md', '')
      const desc = content.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? ''
      agents.push({ name, file, desc: desc.slice(0, 80), content })
    }
  } catch {}
  return { agents }
})

app.post('/api/agents', async (request) => {
  const { name, content } = request.body
  if (!name || !content) return { ok: false }
  try {
    if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true })
    fs.writeFileSync(path.join(AGENTS_DIR, `${name}.md`), content, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

app.delete('/api/agents/:name', async (request) => {
  // Sanitize: basename only, alphanumeric + dash/underscore
  const safeName = path.basename(request.params.name).replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!safeName) return { ok: false, error: 'invalid name' }
  try {
    fs.unlinkSync(path.join(AGENTS_DIR, `${safeName}.md`))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── MCP API ─────────────────────────────────────────────────────────────────

app.get('/api/mcp', async () => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf-8'))
    return { servers: settings.mcpServers ?? {} }
  } catch { return { servers: {} } }
})

app.post('/api/mcp', async (request) => {
  const { name, config } = request.body
  if (!name || typeof name !== 'string') return { ok: false, error: 'invalid name' }
  try {
    const filePath = path.join(CLAUDE_DIR, 'settings.json')
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    settings.mcpServers = settings.mcpServers ?? {}
    settings.mcpServers[name] = config
    atomicWriteJson(filePath, settings)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

app.delete('/api/mcp/:name', async (request) => {
  try {
    const filePath = path.join(CLAUDE_DIR, 'settings.json')
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    delete (settings.mcpServers ?? {})[request.params.name]
    atomicWriteJson(filePath, settings)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── Log History API ─────────────────────────────────────────────────────────

app.get('/api/logs', async (request) => {
  const { sessionId, last } = request.query
  let logs = logHistory
  if (sessionId) logs = logs.filter(l => !l.sessionId || l.sessionId === sessionId)
  if (last) logs = logs.slice(-Number(last))
  return { logs }
})

// ─── Claude Subprocess API ───────────────────────────────────────────────────

function spawnClaude(projectPath, prompt, sessionId = null) {
  // Kill any existing process for this project
  const existing = claudeProcs.get(projectPath)
  if (existing?.proc) try { existing.proc.kill() } catch {}

  // Pre-register before spawn so SessionStart hook can filter by cwd (race condition fix)
  const normalCwd = projectPath.replace(/\\/g, '/').toLowerCase()
  pendingSpawnCwds.add(normalCwd)

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ]
  if (sessionId) args.unshift('--resume', sessionId)

  const proc = spawn(CLAUDE_EXE, args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry = { proc, sessionId, projectPath, status: 'running' }
  claudeProcs.set(projectPath, entry)

  let buf = ''
  proc.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        // Capture session_id from init + mark as subprocess session
        if (event.type === 'system' && event.subtype === 'init') {
          entry.sessionId = event.session_id
          subprocessSids.add(event.session_id)
          pendingSpawnCwds.delete(normalCwd)
        }
        // Skip hook noise
        if (event.type === 'system' && (event.subtype === 'hook_started' || event.subtype === 'hook_response')) continue
        broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), event })
      } catch {}
    }
  })

  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text) broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), event: { type: 'stderr', text } })
  })

  proc.on('close', code => {
    entry.status = 'done'
    broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), event: { type: 'done', exitCode: code } })
    setTimeout(() => { if (claudeProcs.get(projectPath) === entry) claudeProcs.delete(projectPath) }, 10_000)
  })

  return entry
}

app.post('/api/claude/run', async (request) => {
  const { projectPath: rawPath, prompt, sessionId, attachments } = request.body
  if (!prompt && !(attachments?.length)) return { ok: false, error: 'missing prompt' }
  const projectPath = rawPath?.replace(/\//g, path.sep) // normalize to OS path sep
  if (!isSafeCwd(projectPath)) return { ok: false, error: 'invalid projectPath' }

  // Save base64 attachments to temp files and append their paths to the prompt
  const tempFiles = []
  let fullPrompt = prompt ?? ''
  if (Array.isArray(attachments) && attachments.length) {
    for (const att of attachments) {
      if (!att.dataUrl || !att.name) continue
      const m = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (!m) continue
      const ext = path.extname(att.name) || '.bin'
      const tmpPath = path.join(os.tmpdir(), `claud_att_${crypto.randomBytes(6).toString('hex')}${ext}`)
      fs.writeFileSync(tmpPath, Buffer.from(m[2], 'base64'))
      tempFiles.push(tmpPath)
      fullPrompt += `\n${tmpPath}`
    }
  }

  const entry = spawnClaude(projectPath, fullPrompt, sessionId ?? null)

  // Clean up temp files after subprocess closes
  if (tempFiles.length) {
    entry.proc.on('close', () => {
      for (const f of tempFiles) try { fs.unlinkSync(f) } catch {}
    })
  }

  return { ok: true, projectPath: normalizePath(projectPath), sessionId: entry.sessionId }
})

app.post('/api/claude/stop', async (request) => {
  const { projectPath } = request.body
  const entry = claudeProcs.get(projectPath)
  if (entry?.proc) try { entry.proc.kill(); entry.status = 'stopped' } catch {}
  return { ok: true }
})

app.get('/api/claude/processes', async () => ({
  processes: [...claudeProcs.entries()].map(([p, e]) => ({
    projectPath: p, sessionId: e.sessionId, status: e.status,
  }))
}))

// ─── Bounty Assets ────────────────────────────────────────────────────────────

const BOUNTY_DIR      = path.join(os.homedir(), '.claude', 'theclaudenental-bounty')
const BOUNTY_ASSETS   = path.join(BOUNTY_DIR, 'assets')
const BOUNTY_SETTINGS = path.join(BOUNTY_DIR, 'settings.json')

if (!fs.existsSync(BOUNTY_ASSETS)) fs.mkdirSync(BOUNTY_ASSETS, { recursive: true })

const MEDIA_EXTS = { image: ['.jpg','.jpeg','.png','.webp','.gif'], video: ['.mp4','.webm'], audio: ['.mp3','.ogg','.wav','.m4a'] }
function assetFilename(tier, assetType) {
  // Find existing file with any supported extension
  const exts = MEDIA_EXTS[assetType] ?? []
  for (const ext of exts) {
    const p = path.join(BOUNTY_ASSETS, `${tier}-${assetType}${ext}`)
    if (fs.existsSync(p)) return p
  }
  return null
}

// GET settings
app.get('/api/bounty/settings', async () => {
  try { return JSON.parse(fs.readFileSync(BOUNTY_SETTINGS, 'utf-8')) } catch { return {} }
})

// POST settings
app.post('/api/bounty/settings', async (request) => {
  fs.writeFileSync(BOUNTY_SETTINGS, JSON.stringify(request.body, null, 2))
  return { ok: true }
})

// GET asset file
app.get('/api/bounty/asset/:tier/:type', async (request, reply) => {
  const { tier, type } = request.params
  const fp = assetFilename(tier, type)
  if (!fp) return reply.status(404).send({ error: 'not found' })
  const ext  = path.extname(fp).toLowerCase()
  const mime = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  }[ext] ?? 'application/octet-stream'
  reply.header('Content-Type', mime)
  reply.header('Cache-Control', 'no-cache')
  return reply.send(fs.createReadStream(fp))
})

// POST upload asset
app.post('/api/bounty/upload', async (request, reply) => {
  const data     = await request.file()
  if (!data) return reply.status(400).send({ error: 'no file' })
  const tier      = data.fields?.tier?.value
  const assetType = data.fields?.assetType?.value   // 'media' | 'audio'
  if (!tier || !assetType) return reply.status(400).send({ error: 'missing tier or assetType' })

  const ext = path.extname(data.filename).toLowerCase()
  const allowed = [...MEDIA_EXTS.image, ...MEDIA_EXTS.video, ...MEDIA_EXTS.audio]
  if (!allowed.includes(ext)) return reply.status(400).send({ error: 'unsupported file type' })

  // Remove existing asset of same tier+type (any ext)
  const existing = assetFilename(tier, assetType)
  if (existing) try { fs.unlinkSync(existing) } catch {}

  const dest = path.join(BOUNTY_ASSETS, `${tier}-${assetType}${ext}`)
  const buf  = await data.toBuffer()
  fs.writeFileSync(dest, buf)

  // Detect category: image / video / audio
  const category = MEDIA_EXTS.image.includes(ext) ? 'image'
    : MEDIA_EXTS.video.includes(ext) ? 'video' : 'audio'
  return { ok: true, filename: `${tier}-${assetType}${ext}`, category }
})

// DELETE asset
app.delete('/api/bounty/asset/:tier/:type', async (request) => {
  const { tier, type } = request.params
  const fp = assetFilename(tier, type)
  if (fp) try { fs.unlinkSync(fp) } catch {}
  return { ok: true }
})

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'online',
  name: 'TheClaudenental',
  sessions: sessions.size,
  clients: clients.size,
}))

// ─── JSONL directory scanner (fallback session discovery) ────────────────────
// Runs every 8s. Discovers sessions whose hooks may have been missed (e.g. after
// server restart, or VS Code sessions in other projects). Only touches sessions
// modified within the last 30 minutes so it stays lightweight.

const SCAN_WINDOW_MS   = 30 * 60 * 1000   // look at files touched in last 30 min
const SCAN_INTERVAL_MS = 8_000

function scanJsonlSessions() {
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  const now = Date.now()
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const pd = path.join(projectsDir, proj)
      if (!fs.statSync(pd).isDirectory()) continue
      for (const file of fs.readdirSync(pd)) {
        // Skip subagent dirs and non-jsonl files
        if (!file.endsWith('.jsonl')) continue
        const fp  = path.join(pd, file)
        const st  = fs.statSync(fp)
        // Only consider recently-modified files
        if (now - st.mtimeMs > SCAN_WINDOW_MS) continue
        const sid = file.replace('.jsonl', '')
        // Skip sessions we already know about and are still active
        const existing = sessions.get(sid)
        if (existing?.status === 'active') {
          // Still active — auto-watch if not already watching
          if (!watchedSessions.has(sid)) {
            const fp2 = findJsonlPath(sid)
            if (fp2) {
              const initial   = parseNewLines(fp2, 0)
              const lineCount = initial?.lineCount ?? 0
              const watcher   = fs.watchFile(fp2, { interval: 500 }, () => {
                const entry = watchedSessions.get(sid)
                if (!entry) return
                const result = parseNewLines(fp2, entry.lineCount)
                if (!result || !result.messages.length) return
                entry.lineCount = result.lineCount
                broadcast({ type: 'session_live', sessionId: sid, messages: result.messages })
              })
              watchedSessions.set(sid, { watcher, filePath: fp2, lineCount })
            }
          }
          continue
        }
        // Read minimal info from JSONL to build/refresh the session
        try {
          const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
          let cwd = null, aiTitle = null, firstUser = null, lastStatus = 'done'
          let hasActivity = false
          for (const l of lines) {
            try {
              const o = JSON.parse(l)
              if (!cwd && o.cwd) cwd = o.cwd
              if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle
              if (o.type === 'user' && !firstUser) {
                const c = o.message?.content
                const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x=>x.type==='text').map(x=>x.text).join('') : '')
                const clean = t.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
                if (clean) firstUser = clean.slice(0, 60)
              }
              if (o.type === 'assistant') hasActivity = true
              // Most recent result/stop tells us status
              if (o.type === 'result') lastStatus = 'done'
            } catch {}
          }
          if (!hasActivity) continue   // skip empty/init-only files
          // Determine if session looks "active" (file modified < 3 min ago and no result event at end)
          const recentlyWritten = now - st.mtimeMs < 3 * 60 * 1000
          const lastLine = lines[lines.length - 1] ?? ''
          let lastType = null
          try { lastType = JSON.parse(lastLine).type } catch {}
          const looksActive = recentlyWritten && lastType !== 'result'
          const status = looksActive ? 'active' : 'done'
          const displayName = aiTitle ?? firstUser ?? sid.slice(0, 8)
          // Upsert — only protect active→done downgrade when file is very recent
          // (race: hook fired but Claude hasn't written output yet).
          // recentlyWritten = < 3 min; if older, allow downgrade.
          const cur = sessions.get(sid)
          if (cur && cur.status === 'active' && status === 'done' && recentlyWritten) continue
          const s = upsertSession(sid, { displayName, cwd: cwd ?? cur?.cwd, status, startedAt: st.birthtimeMs ?? st.mtimeMs })
          broadcast({ type: 'session', session: s })
          schedulePersist()
          // Auto-watch newly-discovered active sessions
          if (status === 'active' && !watchedSessions.has(sid)) {
            const fp2 = findJsonlPath(sid)
            if (fp2) {
              const initial   = parseNewLines(fp2, 0)
              const lineCount = initial?.lineCount ?? 0
              const watcher   = fs.watchFile(fp2, { interval: 500 }, () => {
                const entry = watchedSessions.get(sid)
                if (!entry) return
                const result = parseNewLines(fp2, entry.lineCount)
                if (!result || !result.messages.length) return
                entry.lineCount = result.lineCount
                broadcast({ type: 'session_live', sessionId: sid, messages: result.messages })
              })
              watchedSessions.set(sid, { watcher, filePath: fp2, lineCount })
            }
          }
        } catch {}
      }
    }
  } catch {}

  // ── Expire stale active sessions ─────────────────────────────────────────
  // Sessions outside the scan window (> 30 min old file) can never be picked
  // up by the file loop above. Check them separately: if the JSONL hasn't been
  // modified in > 15 min and the session is still marked active, downgrade it.
  const STALE_MS = 15 * 60 * 1000
  for (const [sid, s] of sessions) {
    if (s.status !== 'active' && s.status !== 'sleeping') continue
    const fp = findJsonlPath(sid)
    if (!fp) continue
    try {
      const mt = fs.statSync(fp).mtimeMs
      if (now - mt > STALE_MS) {
        s.status = 'done'
        sessions.set(sid, s)
        broadcast({ type: 'session', session: s })
        schedulePersist()
      }
    } catch {}
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`TheClaudenental server running on http://localhost:${PORT}`)

// Clear any stale pendingPermission left over from before this process started
// (those long-poll HTTP connections are gone after restart)
for (const [, s] of sessions) {
  if (s.pendingPermission) s.pendingPermission = null
}

// Start JSONL scanner
scanJsonlSessions()
setInterval(scanJsonlSessions, SCAN_INTERVAL_MS)
