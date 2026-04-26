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

// 每次呼叫動態解析，不快取，確保 Claude Code 升版後無需重啟 server
function getClaudeExe() { return findClaudeExe() }

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
  if (subprocessSids.has(e.session_id)) return { ok: true }
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
  if (watchedSessions.has(sessionId)) return { ok: true }
  const filePath = findJsonlPath(sessionId)
  if (!filePath) return { ok: false, error: 'not found' }
  // Start from current position — only broadcast NEW lines written after this point
  const initial = parseNewLines(filePath, 0)
  const lineCount = initial?.lineCount ?? 0
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

  const proc = spawn(getClaudeExe(), args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] })
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
        broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: entry.sessionId ?? null, event })
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

// ─── Ratings & Prefs (cross-device sync) ─────────────────────────────────────

const RATINGS_FILE = path.join(os.homedir(), '.claude', 'tc_ratings.json')
const PREFS_FILE   = path.join(os.homedir(), '.claude', 'tc_prefs.json')
const HISTORY_FILE = path.join(os.homedir(), '.claude', 'tc_pref_history.json')

function readRatingsFile() {
  try { return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8')) } catch { return [] }
}
function writeRatingsFile(data) {
  fs.writeFileSync(RATINGS_FILE, JSON.stringify(data.slice(-1000)), 'utf8')
}

app.get('/api/ratings', async () => ({ ratings: readRatingsFile() }))

app.post('/api/ratings', async (request) => {
  const { rating } = request.body ?? {}
  if (!rating?.id) return { ok: false, error: 'missing id' }
  if (rating.__clearAll) { writeRatingsFile([]); return { ok: true } }
  const all = readRatingsFile()
  const idx = all.findIndex(r => r.id === rating.id)
  if (idx >= 0) all[idx] = rating; else all.push(rating)
  writeRatingsFile(all)
  return { ok: true }
})

app.get('/api/ratings/prefs', async () => {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } catch { return { text: '' } }
})

app.post('/api/ratings/prefs', async (request) => {
  const { text } = request.body ?? {}
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ text: text ?? '' }), 'utf8')
  return { ok: true }
})

app.get('/api/ratings/history', async () => {
  try { return { history: JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } }
  catch { return { history: [] } }
})

app.post('/api/ratings/history', async (request) => {
  const { snapshot } = request.body ?? {}
  if (!snapshot?.ts) return { ok: false }
  let all = []
  try { all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch {}
  all.push(snapshot)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(all.slice(-200)), 'utf8')
  return { ok: true }
})

// ─── Workflow Order (cross-device sync for 心腹 pill ordering) ───────────────

const WF_ORDER_FILE = path.join(os.homedir(), '.claude', 'tc_workflow_order.json')

app.get('/api/workflow-order', async () => {
  try { return JSON.parse(fs.readFileSync(WF_ORDER_FILE, 'utf8')) }
  catch { return { order: [] } }
})

app.post('/api/workflow-order', async (request) => {
  const { order } = request.body ?? {}
  if (!Array.isArray(order)) return { ok: false, error: 'order must be array' }
  fs.writeFileSync(WF_ORDER_FILE, JSON.stringify({ order }), 'utf8')
  return { ok: true }
})

// ─── Events Log (atomic event journal — 為 Phase 4 禮遇後台囤資料) ───────────

const METRICS_DIR = path.join(os.homedir(), '.claude', 'tc_metrics')
const EVENTS_DIR  = path.join(METRICS_DIR, 'events')

function ensureMetricsDir() {
  try {
    if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true })
    if (!fs.existsSync(EVENTS_DIR))  fs.mkdirSync(EVENTS_DIR,  { recursive: true })
  } catch {}
}
ensureMetricsDir()

function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 寫一筆原子事件（fire-and-forget, append-only, 一日一檔）
function logEvent(kind, data) {
  try {
    const file = path.join(EVENTS_DIR, `${todayStamp()}.jsonl`)
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), kind, data }) + '\n', 'utf8')
  } catch {}
}

// 讀今日 / 指定日 / 範圍 events（給 Phase 4 儀表板用）
app.get('/api/metrics/events', async (request) => {
  const { date, from, to, kind } = request.query ?? {}
  const want = []
  try {
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.jsonl'))
    for (const f of files) {
      const day = f.slice(0, -6)
      if (date && day !== date) continue
      if (from && day < from) continue
      if (to   && day > to)   continue
      const lines = fs.readFileSync(path.join(EVENTS_DIR, f), 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const ev = JSON.parse(line)
          if (kind && ev.kind !== kind) continue
          want.push(ev)
        } catch {}
      }
    }
  } catch {}
  return { events: want, count: want.length }
})

// ─── TODO Board (對話驅動 7 欄位看板，跨裝置同步) ─────────────────────────

const TODOS_FILE     = path.join(os.homedir(), '.claude', 'tc_todos.json')
const TODO_TAGS_FILE = path.join(os.homedir(), '.claude', 'tc_todo_tags.json')
const TODO_CATEGORIES_FILE = path.join(os.homedir(), '.claude', 'tc_todo_categories.json')

// 個人/工作分類（仿 Google 私人/工作雙帳號）— 獨立於 tags 的維度
// 卡片只能屬於一個 category（單選）；tags 仍可多選
// 預設兩個 builtin（不能刪），使用者可加減自訂
const SEED_CATEGORIES = [
  { id: 'cat-personal', name: '個人', icon: '🏠', color: '#a78bfa', isBuiltIn: true },
  { id: 'cat-work',     name: '工作', icon: '💼', color: '#3b82f6', isBuiltIn: true },
]

const COLUMNS = ['idea', 'discussing', 'doing', 'verifying', 'done', 'paused', 'storage']

// 預定義 tag（首次存取時 seed），使用者可改可刪可加
const SEED_TAGS = [
  { id: 'theme-web',    name: 'web',           parentId: null,       color: '#3b82f6', isBuiltIn: true, kind: 'theme' },
  { id: 'theme-ue',     name: 'UE',            parentId: null,       color: '#ef4444', isBuiltIn: true, kind: 'theme' },
  { id: 'theme-self',   name: '個人',          parentId: null,       color: '#eab308', isBuiltIn: true, kind: 'theme' },
  { id: 'ue-combat',    name: 'UE/戰鬥',       parentId: 'theme-ue', color: '#ef4444', isBuiltIn: true, kind: 'theme' },
  { id: 'ue-anim',      name: 'UE/動畫',       parentId: 'theme-ue', color: '#ef4444', isBuiltIn: true, kind: 'theme' },
  { id: 'ue-ui',        name: 'UE/UI',         parentId: 'theme-ue', color: '#ef4444', isBuiltIn: true, kind: 'theme' },
  { id: 'ue-ai',        name: 'UE/AI',         parentId: 'theme-ue', color: '#ef4444', isBuiltIn: true, kind: 'theme' },
  { id: 'tag-debug',    name: 'debug',         parentId: null,       color: '#a78bfa', isBuiltIn: true, kind: 'tag' },
  { id: 'tag-knowledge',name: 'knowledge',     parentId: null,       color: '#22d3ee', isBuiltIn: true, kind: 'tag' },
  { id: 'tag-refactor', name: 'refactor',      parentId: null,       color: '#fb923c', isBuiltIn: true, kind: 'tag' },
  { id: 'tag-bug',      name: 'bug',           parentId: null,       color: '#f43f5e', isBuiltIn: true, kind: 'tag' },
  { id: 'tag-feature',  name: 'feature',       parentId: null,       color: '#10b981', isBuiltIn: true, kind: 'tag' },
  { id: 'tag-idea',     name: 'idea',          parentId: null,       color: '#facc15', isBuiltIn: true, kind: 'tag' },
]

function readTodos() {
  try { return JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8')) } catch { return { cards: [] } }
}
function writeTodos(data) { fs.writeFileSync(TODOS_FILE, JSON.stringify(data, null, 2), 'utf8') }

function readTodoTags() {
  try { return JSON.parse(fs.readFileSync(TODO_TAGS_FILE, 'utf8')) }
  catch {
    const seeded = { tags: SEED_TAGS }
    try { fs.writeFileSync(TODO_TAGS_FILE, JSON.stringify(seeded, null, 2), 'utf8') } catch {}
    return seeded
  }
}
function writeTodoTags(data) { fs.writeFileSync(TODO_TAGS_FILE, JSON.stringify(data, null, 2), 'utf8') }

function readTodoCategories() {
  try { return JSON.parse(fs.readFileSync(TODO_CATEGORIES_FILE, 'utf8')) }
  catch {
    const seeded = { categories: SEED_CATEGORIES }
    try { fs.writeFileSync(TODO_CATEGORIES_FILE, JSON.stringify(seeded, null, 2), 'utf8') } catch {}
    return seeded
  }
}
function writeTodoCategories(data) { fs.writeFileSync(TODO_CATEGORIES_FILE, JSON.stringify(data, null, 2), 'utf8') }

// ─── Users / Sessions / Invites（P2 階段 3：分享卡片用） ────────────────────

const USERS_FILE         = path.join(os.homedir(), '.claude', 'tc_users.json')
const USER_SESSIONS_FILE = path.join(os.homedir(), '.claude', 'tc_user_sessions.json')
const INVITES_FILE       = path.join(os.homedir(), '.claude', 'tc_invites.json')

const SEED_USERS = [
  { id: 'u-owner', email: 'owner@local', name: 'Mark', role: 'owner', createdAt: 0, color: '#facc15' },
]

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) }
  catch {
    const seeded = { users: SEED_USERS }
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(seeded, null, 2), 'utf8') } catch {}
    return seeded
  }
}
function writeUsers(d) { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2), 'utf8') }

function readUserSessions() { try { return JSON.parse(fs.readFileSync(USER_SESSIONS_FILE, 'utf8')) } catch { return { sessions: [] } } }
function writeUserSessions(d) { fs.writeFileSync(USER_SESSIONS_FILE, JSON.stringify(d, null, 2), 'utf8') }

function readInvites() { try { return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8')) } catch { return { invites: [] } } }
function writeInvites(d) { fs.writeFileSync(INVITES_FILE, JSON.stringify(d, null, 2), 'utf8') }

function genToken() { return crypto.randomBytes(32).toString('hex') }

function parseCookie(raw, name) {
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

// Resolve user from request: cookie → query param token → Authorization → fallback owner
async function resolveUser(request) {
  const cookieToken = parseCookie(request.headers.cookie || '', 'tc_session')
  const queryToken  = request.query?.tc_token
  const bearerToken = (request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const token = cookieToken || queryToken || bearerToken
  if (token) {
    const sess = readUserSessions().sessions.find(s => s.token === token && s.expiresAt > Date.now())
    if (sess) {
      const u = readUsers().users.find(x => x.id === sess.userId)
      if (u) return { user: u, session: sess, viaToken: true }
    }
  }
  // 沒 token：fallback to owner（host 端體驗不變；Tailnet 內信任邊界）
  const owner = readUsers().users.find(u => u.role === 'owner')
  return owner ? { user: owner, session: null, viaToken: false } : null
}

// Hook: 為每個 request 解析 user，附在 request.tcAuth
app.addHook('onRequest', async (request) => {
  request.tcAuth = await resolveUser(request)
})

// Helper: 要求 owner 才能執行的操作
function requireOwner(request, reply) {
  const u = request.tcAuth?.user
  if (!u || u.role !== 'owner') {
    reply.code(403)
    return null
  }
  return u
}

// ─── Auth API ────────────────────────────────────────────────────────────────

app.get('/api/auth/whoami', async (request) => {
  const u = request.tcAuth?.user
  if (!u) return { ok: false, user: null }
  return { ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, color: u.color } }
})

// Owner 生成邀請連結
app.post('/api/auth/invite', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const body = request.body ?? {}
  const invite = {
    id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    token: genToken(),
    label: body.label ?? '受邀協作者',
    invitedBy: request.tcAuth.user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 86400000,  // 7 天到期
    usedByUserId: null,
    usedAt: null,
  }
  const data = readInvites()
  data.invites.push(invite)
  writeInvites(data)
  logEvent('invite.create', { id: invite.id, label: invite.label })
  return { ok: true, invite }
})

// Owner 列出已發 invites
app.get('/api/auth/invites', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  return readInvites()
})

// Owner 撤銷 invite
app.delete('/api/auth/invites/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const data = readInvites()
  const before = data.invites.length
  data.invites = data.invites.filter(i => i.id !== request.params.id)
  writeInvites(data)
  return { ok: true, removed: before - data.invites.length }
})

// 對方點 invite link → 接受邀請並建立 user + session
app.post('/api/auth/accept-invite', async (request, reply) => {
  const { token, name, email } = request.body ?? {}
  if (!token || !name) { reply.code(400); return { ok: false, error: 'token + name required' } }
  const invitesData = readInvites()
  const inv = invitesData.invites.find(i => i.token === token)
  if (!inv) { reply.code(404); return { ok: false, error: 'invalid invite token' } }
  if (inv.expiresAt < Date.now()) { reply.code(410); return { ok: false, error: 'invite expired' } }
  if (inv.usedByUserId) { reply.code(409); return { ok: false, error: 'invite already used' } }

  // 建 user
  const usersData = readUsers()
  const user = {
    id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    email: email ?? `${name.toLowerCase().replace(/\s+/g, '-')}@invited.local`,
    name,
    role: 'collaborator',
    createdAt: Date.now(),
    color: '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
    invitedBy: inv.invitedBy,
  }
  usersData.users.push(user)
  writeUsers(usersData)

  // 標記 invite 已用
  inv.usedByUserId = user.id
  inv.usedAt = Date.now()
  writeInvites(invitesData)

  // 建 session（30 天）
  const sessionToken = genToken()
  const sessData = readUserSessions()
  sessData.sessions.push({
    token: sessionToken,
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 86400000,
  })
  writeUserSessions(sessData)

  logEvent('invite.accept', { inviteId: inv.id, userId: user.id, name })

  // Set cookie（HTTP-only 不行，因為 Vite dev 是不同 origin；用普通 cookie + 也回 token 給 client localStorage）
  reply.header('Set-Cookie', `tc_session=${sessionToken}; Path=/; Max-Age=${30*86400}; SameSite=Lax`)
  return { ok: true, user, sessionToken }
})

app.post('/api/auth/logout', async (request, reply) => {
  const token = parseCookie(request.headers.cookie || '', 'tc_session') ||
                request.query?.tc_token ||
                (request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (token) {
    const data = readUserSessions()
    data.sessions = data.sessions.filter(s => s.token !== token)
    writeUserSessions(data)
  }
  reply.header('Set-Cookie', 'tc_session=; Path=/; Max-Age=0; SameSite=Lax')
  return { ok: true }
})

// Owner 列出 users
app.get('/api/auth/users', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const data = readUsers()
  return { users: data.users.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, color: u.color, createdAt: u.createdAt })) }
})

// Owner 撤銷 collaborator（同時刪該 user 的 sessions）
app.delete('/api/auth/users/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const userId = request.params.id
  if (userId === 'u-owner') { reply.code(400); return { ok: false, error: 'cannot delete owner' } }
  const usersData = readUsers()
  usersData.users = usersData.users.filter(u => u.id !== userId)
  writeUsers(usersData)
  // 刪該 user 的 sessions
  const sessData = readUserSessions()
  sessData.sessions = sessData.sessions.filter(s => s.userId !== userId)
  writeUserSessions(sessData)
  // 卡片的 sharedWith 同步移除
  const todosData = readTodos()
  for (const card of todosData.cards) {
    if (Array.isArray(card.sharedWith)) {
      const before = card.sharedWith.length
      card.sharedWith = card.sharedWith.filter(uid => uid !== userId)
      if (before !== card.sharedWith.length) card.version = (card.version ?? 1) + 1
    }
  }
  writeTodos(todosData)
  logEvent('user.revoke', { userId })
  return { ok: true }
})

// Cards — 預設過濾掉 soft-deleted；?includeDeleted=1 看全部
// Collaborator 只看到被分享給他的卡（sharedWith 含其 userId）
app.get('/api/todos', async (request) => {
  const data = readTodos()
  const includeDeleted = request.query?.includeDeleted === '1'
  let cards = includeDeleted ? data.cards : data.cards.filter(c => !c.deletedAt)
  const u = request.tcAuth?.user
  if (u && u.role === 'collaborator') {
    cards = cards.filter(c => Array.isArray(c.sharedWith) && c.sharedWith.includes(u.id))
  }
  return { cards }
})

// 垃圾桶（只看 deleted）
app.get('/api/todos/trash', async () => {
  const data = readTodos()
  return { cards: data.cards.filter(c => c.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt) }
})

app.post('/api/todos', async (request) => {
  const data = readTodos()
  const body = request.body ?? {}
  const card = {
    id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: body.title ?? '(untitled)',
    column: COLUMNS.includes(body.column) ? body.column : 'idea',
    themeId: body.themeId ?? null,
    tagIds: Array.isArray(body.tagIds) ? body.tagIds : [],
    note: body.note ?? '',
    parentId: body.parentId ?? null,
    sessionId: body.sessionId ?? null,
    lastDiscussedAt: body.sessionId ? Date.now() : null,
    lastSummary: body.lastSummary ?? '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: typeof body.order === 'number' ? body.order : Date.now(),
    categoryId: body.categoryId ?? 'cat-personal',  // 預設個人分類
    sharedWith: [],         // P2 階段 3：分享對象 user IDs
    sharedBy: request.tcAuth?.user?.id ?? null,  // 建立者
    sharedAt: null,         // 第一次被分享時的時間
    version: 1,            // ETag — 每次 PATCH +1
    deletedAt: null,       // soft delete timestamp
  }
  data.cards.push(card)
  writeTodos(data)
  logEvent('card.create', { id: card.id, column: card.column, themeId: card.themeId, title: card.title })
  return { ok: true, card }
})

app.patch('/api/todos/:id', async (request, reply) => {
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) { reply.code(404); return { ok: false, error: 'not found' } }

  // ETag 衝突偵測：If-Match header 帶 version；不符回 409
  const ifMatch = request.headers['if-match']
  if (ifMatch !== undefined && Number(ifMatch) !== card.version) {
    reply.code(409)
    return { ok: false, error: 'version conflict', currentVersion: card.version, currentCard: card }
  }

  const patch = request.body ?? {}
  delete patch.id
  delete patch.createdAt
  delete patch.version
  delete patch.deletedAt
  // noteAppend 特殊處理：append 到現有 note 而非覆寫
  if (typeof patch.noteAppend === 'string') {
    card.note = (card.note ?? '') + patch.noteAppend
    delete patch.noteAppend
  }
  const prevColumn = card.column
  Object.assign(card, patch, { updatedAt: Date.now(), version: (card.version ?? 1) + 1 })
  if (patch.column === 'discussing' || patch.sessionId) card.lastDiscussedAt = Date.now()
  writeTodos(data)
  logEvent('card.update', { id: card.id, patch, prevColumn, newColumn: card.column })
  if (patch.column && patch.column !== prevColumn)
    logEvent('card.move', { id: card.id, from: prevColumn, to: patch.column })
  return { ok: true, card }
})

// Soft delete — 進垃圾桶（30 天可還原 / 真刪）
app.delete('/api/todos/:id', async (request) => {
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) return { ok: false, error: 'not found' }
  card.deletedAt = Date.now()
  card.version = (card.version ?? 1) + 1
  writeTodos(data)
  logEvent('card.delete', { id: card.id, title: card.title, column: card.column })
  return { ok: true }
})

// 還原（從垃圾桶撈回看板）
app.post('/api/todos/:id/restore', async (request) => {
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) return { ok: false, error: 'not found' }
  card.deletedAt = null
  card.version = (card.version ?? 1) + 1
  writeTodos(data)
  logEvent('card.restore', { id: card.id })
  return { ok: true, card }
})

// 真刪（垃圾桶內手動清掉）
app.post('/api/todos/:id/purge', async (request) => {
  const data = readTodos()
  const before = data.cards.length
  data.cards = data.cards.filter(c => c.id !== request.params.id)
  writeTodos(data)
  logEvent('card.purge', { id: request.params.id })
  return { ok: true, removed: before - data.cards.length }
})

// 分享卡片給 collaborator(s)
app.post('/api/todos/:id/share', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) { reply.code(404); return { ok: false, error: 'not found' } }
  const userIds = Array.isArray(request.body?.userIds) ? request.body.userIds : []
  // 驗證 userIds 都存在且是 collaborator
  const allUsers = readUsers().users
  const valid = userIds.filter(uid => allUsers.some(u => u.id === uid && u.role === 'collaborator'))
  // 合併（不重複）
  const existing = new Set(card.sharedWith ?? [])
  for (const uid of valid) existing.add(uid)
  card.sharedWith = [...existing]
  if (!card.sharedAt) card.sharedAt = Date.now()
  card.version = (card.version ?? 1) + 1
  writeTodos(data)
  logEvent('card.share', { cardId: card.id, addedUserIds: valid })
  return { ok: true, card }
})

// 撤回分享給某 user
app.delete('/api/todos/:id/share/:userId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) { reply.code(404); return { ok: false, error: 'not found' } }
  const before = (card.sharedWith ?? []).length
  card.sharedWith = (card.sharedWith ?? []).filter(uid => uid !== request.params.userId)
  card.version = (card.version ?? 1) + 1
  writeTodos(data)
  logEvent('card.unshare', { cardId: card.id, removedUserId: request.params.userId })
  return { ok: true, card, removed: before - card.sharedWith.length }
})

// Collaborator 收件匣：被分享給此 user 的卡
app.get('/api/todos/inbox', async (request) => {
  const u = request.tcAuth?.user
  if (!u) return { cards: [] }
  const data = readTodos()
  const cards = data.cards.filter(c =>
    !c.deletedAt &&
    Array.isArray(c.sharedWith) &&
    c.sharedWith.includes(u.id)
  )
  return { cards }
})

// 批次重排
app.post('/api/todos/reorder', async (request) => {
  const data = readTodos()
  const updates = Array.isArray(request.body?.updates) ? request.body.updates : []
  const byId = new Map(data.cards.map(c => [c.id, c]))
  for (const u of updates) {
    const card = byId.get(u.id)
    if (!card) continue
    if (u.column !== undefined) card.column = u.column
    if (u.order  !== undefined) card.order  = u.order
    card.updatedAt = Date.now()
    card.version = (card.version ?? 1) + 1
  }
  writeTodos(data)
  logEvent('card.reorder', { count: updates.length })
  return { ok: true, updated: updates.length }
})

// Tag 循環防護 — 檢查若把 tagId 設成 newParentId 是否會形成循環
function wouldCreateCycle(tags, tagId, newParentId) {
  if (!newParentId) return false
  if (newParentId === tagId) return true
  const byId = new Map(tags.map(t => [t.id, t]))
  let cur = byId.get(newParentId)
  let hops = 0
  while (cur && hops++ < 16) {
    if (cur.id === tagId) return true
    if (!cur.parentId) return false
    cur = byId.get(cur.parentId)
  }
  return false  // hop limit 也視為安全（避免誤拒）
}

// Tags
app.get('/api/todo-tags', async () => readTodoTags())

app.post('/api/todo-tags', async (request, reply) => {
  const data = readTodoTags()
  const body = request.body ?? {}
  const id = body.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // 新建時也檢查 parentId 是否存在（防止懸空）
  if (body.parentId && !data.tags.find(t => t.id === body.parentId)) {
    reply.code(400)
    return { ok: false, error: 'parentId not found' }
  }
  const tag = {
    id,
    name: body.name ?? 'untitled',
    parentId: body.parentId ?? null,
    color: body.color ?? '#9ca3af',
    isBuiltIn: false,
    kind: body.kind === 'theme' ? 'theme' : 'tag',
  }
  data.tags.push(tag)
  writeTodoTags(data)
  logEvent('tag.create', { id: tag.id, name: tag.name, kind: tag.kind })
  return { ok: true, tag }
})

app.patch('/api/todo-tags/:id', async (request, reply) => {
  const data = readTodoTags()
  const tag = data.tags.find(t => t.id === request.params.id)
  if (!tag) { reply.code(404); return { ok: false, error: 'not found' } }
  const patch = request.body ?? {}
  delete patch.id
  // 循環防護：若改 parentId 要驗證
  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (!data.tags.find(t => t.id === patch.parentId)) {
      reply.code(400); return { ok: false, error: 'parentId not found' }
    }
    if (wouldCreateCycle(data.tags, tag.id, patch.parentId)) {
      reply.code(400); return { ok: false, error: 'would create tag cycle' }
    }
  }
  Object.assign(tag, patch)
  writeTodoTags(data)
  logEvent('tag.update', { id: tag.id, patch })
  return { ok: true, tag }
})

app.delete('/api/todo-tags/:id', async (request) => {
  const tagId = request.params.id
  const replaceWith = request.query.replaceWith ?? null
  const tagsData = readTodoTags()
  const tag = tagsData.tags.find(t => t.id === tagId)
  if (!tag) return { ok: false, error: 'not found' }
  if (tag.isBuiltIn) return { ok: false, error: 'built-in tag cannot be deleted (rename/recolor instead)' }

  const todosData = readTodos()
  let touched = 0
  for (const card of todosData.cards) {
    const before = card.tagIds.length
    card.tagIds = card.tagIds.filter(id => id !== tagId)
    if (replaceWith && before !== card.tagIds.length && !card.tagIds.includes(replaceWith))
      card.tagIds.push(replaceWith)
    if (card.themeId === tagId) card.themeId = replaceWith
    if (card.tagIds.length !== before || card.themeId !== tag.id) {
      touched++
      card.version = (card.version ?? 1) + 1
    }
  }
  for (const t of tagsData.tags) if (t.parentId === tagId) t.parentId = null

  tagsData.tags = tagsData.tags.filter(t => t.id !== tagId)
  writeTodoTags(tagsData)
  writeTodos(todosData)
  logEvent('tag.delete', { id: tagId, replaceWith, cardsTouched: touched })
  return { ok: true, cardsTouched: touched }
})

// Categories CRUD（個人/工作 分類維度）
app.get('/api/todo-categories', async () => readTodoCategories())

app.post('/api/todo-categories', async (request) => {
  const data = readTodoCategories()
  const body = request.body ?? {}
  const cat = {
    id: body.id ?? `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: body.name ?? 'untitled',
    icon: body.icon ?? '📁',
    color: body.color ?? '#9ca3af',
    isBuiltIn: false,
  }
  data.categories.push(cat)
  writeTodoCategories(data)
  logEvent('category.create', { id: cat.id, name: cat.name })
  return { ok: true, category: cat }
})

app.patch('/api/todo-categories/:id', async (request, reply) => {
  const data = readTodoCategories()
  const cat = data.categories.find(c => c.id === request.params.id)
  if (!cat) { reply.code(404); return { ok: false, error: 'not found' } }
  const patch = request.body ?? {}
  delete patch.id
  delete patch.isBuiltIn
  Object.assign(cat, patch)
  writeTodoCategories(data)
  logEvent('category.update', { id: cat.id, patch })
  return { ok: true, category: cat }
})

app.delete('/api/todo-categories/:id', async (request, reply) => {
  const catId = request.params.id
  const replaceWith = request.query.replaceWith ?? 'cat-personal'  // 預設搬到個人
  const data = readTodoCategories()
  const cat = data.categories.find(c => c.id === catId)
  if (!cat) { reply.code(404); return { ok: false, error: 'not found' } }
  if (cat.isBuiltIn) { reply.code(400); return { ok: false, error: 'built-in category cannot be deleted (rename/recolor instead)' } }

  // 把引用此 category 的卡片改到 replaceWith
  const todosData = readTodos()
  let touched = 0
  for (const card of todosData.cards) {
    if (card.categoryId === catId) {
      card.categoryId = replaceWith
      card.version = (card.version ?? 1) + 1
      touched++
    }
  }
  data.categories = data.categories.filter(c => c.id !== catId)
  writeTodoCategories(data)
  writeTodos(todosData)
  logEvent('category.delete', { id: catId, replaceWith, cardsTouched: touched })
  return { ok: true, cardsTouched: touched }
})

// ─── FB Content Push (bookmarklet bypass for login wall) ─────────────────────

const FB_CONTENT_FILE = path.join(os.homedir(), '.claude', 'fb_content.json')

function readFbContent() {
  try { return JSON.parse(fs.readFileSync(FB_CONTENT_FILE, 'utf8')) } catch { return [] }
}
function writeFbContent(data) {
  fs.writeFileSync(FB_CONTENT_FILE, JSON.stringify(data.slice(-50), null, 2), 'utf8')
}

// CORS pre-flight for bookmarklet posting from facebook.com
app.options('/api/fb-push', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type')
  reply.code(204).send()
})

app.post('/api/fb-push', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  const b = request.body ?? {}
  const entry = {
    id:       'fb_' + Date.now(),
    ts:       Date.now(),
    url:      b.url      || '',
    author:   b.author   || '',
    content:  b.content  || '',
    comments: Array.isArray(b.comments) ? b.comments : [],
    links:    Array.isArray(b.links)    ? b.links    : [],
    images:   Array.isArray(b.images)   ? b.images   : [],
  }
  const all = readFbContent(); all.push(entry); writeFbContent(all)
  return { ok: true, id: entry.id, length: entry.content.length }
})

app.get('/api/fb-push',        async () => ({ list: readFbContent() }))
app.get('/api/fb-push/latest', async () => {
  const all = readFbContent()
  return all[all.length - 1] || null
})

// ─── Bookmarklet install page (drag-and-drop to bookmarks bar) ───────────────

// 改用 window.open 到 /fb-receive，在我們 origin 的頁面做 POST
// 這樣 FB 的 CSP connect-src 限制不會影響到我們
const FB_BOOKMARKLET = `javascript:(function(){try{var p=document.querySelector('[role="article"]')||document.querySelector('[data-pagelet*="FeedUnit"]')||document.body;var texts=Array.from(p.querySelectorAll('*')).filter(function(e){return e.children.length===0&&e.textContent.trim()}).map(function(e){return e.textContent.trim()});var u=Array.from(new Set(texts)).filter(function(t){return t.length>8&&!/^(讚|留言|分享|回覆|追蹤|關注|·|Like|Comment|Share|Reply|All reactions)$/i.test(t)});var author=(p.querySelector('h3 a,h4 a,strong a[role="link"]')||{}).textContent||'';var links=Array.from(p.querySelectorAll('a[href]')).map(function(a){return a.href}).filter(function(h){return h&&!h.includes('facebook.com/')&&!h.includes('fb.com/')&&!h.startsWith('javascript:')&&!h.includes('/privacy')&&!h.includes('/help')});var imgs=Array.from(p.querySelectorAll('img')).map(function(i){return i.src}).filter(function(s){return s&&s.includes('scontent')}).slice(0,10);var content=u.slice(0,100).join('\\n');var comments=u.slice(100,300);var data={url:location.href,author:author.trim(),content:content,comments:comments,links:Array.from(new Set(links)),images:imgs};var host='http://100.115.110.21:3001';var encoded=encodeURIComponent(JSON.stringify(data));if(encoded.length>200000){alert('內容太長，請縮減選取範圍');return}window.open(host+'/fb-receive#'+encoded,'_blank');}catch(e){alert('✗ 錯誤：'+e.message)}})();`

// 接收頁面：bookmarklet 開新分頁到這裡，本頁的 JS 讀 hash 解碼後 POST 到 /api/fb-push
// 因為本頁和 /api/fb-push 同源，不會被 FB 的 CSP 影響
app.get('/fb-receive', async (request, reply) => {
  reply.type('text/html; charset=utf-8')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>📤 送往 Claude...</title>
<style>
  body { font-family: system-ui,-apple-system,"Microsoft JhengHei",sans-serif; background: #0a0a0a; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { text-align: center; padding: 40px; border: 1px solid #2a2a2a; border-radius: 12px; background: #141414; max-width: 480px; }
  .status { font-size: 20px; margin-bottom: 12px; }
  .meta { color: #888; font-size: 13px; line-height: 1.8; }
  .ok { color: #4ade80; }
  .err { color: #f87171; }
  .btn { display: inline-block; margin-top: 16px; padding: 8px 20px; background: #c9a227; color: #0a0a0a; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; }
</style></head><body>
<div class="box">
  <div id="status" class="status">傳送中…</div>
  <div id="meta" class="meta">正在解碼 FB 內容</div>
  <button class="btn" id="closeBtn" style="display:none" onclick="window.close()">關閉視窗</button>
</div>
<script>
(async function(){
  const s = document.getElementById('status');
  const m = document.getElementById('meta');
  const b = document.getElementById('closeBtn');
  try {
    const encoded = location.hash.slice(1);
    if (!encoded) throw new Error('沒有接收到資料（hash 為空）');
    const data = JSON.parse(decodeURIComponent(encoded));
    m.innerText = '解碼成功：' + (data.content ? data.content.length + ' 字' : '內容為空');
    const res = await fetch('/api/fb-push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const r = await res.json();
    if (r.ok) {
      s.className = 'status ok';
      s.innerText = '✓ 已送到 Claude';
      m.innerText = '內文 ' + (data.content||'').length + ' 字 · 留言 ' + (data.comments||[]).length + ' 段 · 連結 ' + (data.links||[]).length + ' 個';
      b.style.display = 'inline-block';
      setTimeout(() => window.close(), 2500);
    } else {
      throw new Error(r.error || '未知錯誤');
    }
  } catch (e) {
    s.className = 'status err';
    s.innerText = '✗ 失敗';
    m.innerText = e.message;
    b.style.display = 'inline-block';
  }
})();
</script>
</body></html>`
})

app.get('/bookmarklet', async (request, reply) => {
  reply.type('text/html; charset=utf-8')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>📤 送到 Claude — 安裝</title>
<style>
  body { font-family: system-ui, -apple-system, "Microsoft JhengHei", sans-serif; background: #0a0a0a; color: #e6e6e6; max-width: 640px; margin: 40px auto; padding: 20px; line-height: 1.7; }
  h1 { color: #c9a227; font-size: 22px; }
  h2 { color: #c9a227; font-size: 15px; margin-top: 30px; border-bottom: 1px solid #2a2a2a; padding-bottom: 6px; }
  .dragbtn { display: inline-block; padding: 14px 24px; background: linear-gradient(135deg,#c9a227,#8f6d00); color: #0a0a0a; font-weight: 700; font-size: 16px; border-radius: 8px; text-decoration: none; box-shadow: 0 4px 12px rgba(201,162,39,0.3); cursor: grab; user-select: none; }
  .dragbtn:active { cursor: grabbing; }
  .step { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px 16px; margin: 10px 0; }
  .step .num { color: #c9a227; font-weight: 700; margin-right: 8px; }
  code { background: #1a1a1a; padding: 2px 6px; border-radius: 3px; font-size: 13px; color: #e2c27d; }
  .note { color: #888; font-size: 13px; margin-top: 6px; }
  kbd { background: #2a2a2a; border: 1px solid #444; border-radius: 3px; padding: 1px 6px; font-size: 12px; }
</style></head><body>
<h1>📤 送到 Claude — 拖曳安裝</h1>
<p>把下方金色按鈕<b>拖曳到</b>瀏覽器書籤列（通常在網址列下方），即完成安裝。</p>

<p style="margin: 30px 0; text-align: center;">
  <a class="dragbtn" href='${FB_BOOKMARKLET}' onclick="event.preventDefault(); alert('請用拖曳的方式把我拉到書籤列，不要點擊 :)');">📤 送到 Claude</a>
</p>

<h2>安裝步驟</h2>
<div class="step"><span class="num">1</span>確認書籤列有顯示：<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> 切換</div>
<div class="step"><span class="num">2</span>用滑鼠按住上方金色按鈕 → <b>拖到書籤列任一位置</b> → 放開</div>
<div class="step"><span class="num">3</span>出現「📤 送到 Claude」書籤即成功 ✓</div>

<h2>使用方式</h2>
<div class="step"><span class="num">1</span>Edge 開任一 FB 貼文（登入狀態）</div>
<div class="step"><span class="num">2</span>需要看完整留言的話，先手動點開「查看更多留言」</div>
<div class="step"><span class="num">3</span>點書籤列的「📤 送到 Claude」</div>
<div class="step"><span class="num">4</span>看到 alert <code>✓ 已送到 Claude</code> 即成功</div>
<div class="step"><span class="num">5</span>回 TheClaudenental → Chat → 點 ⚡ → 點「📋 FB 暫存」</div>

<h2>疑難排解</h2>
<div class="step">
  <b>拖不動？</b><br>
  Edge 有時會擋 <code>javascript:</code> bookmark。解法：<br>
  1. 書籤列空白處右鍵 → 新增書籤<br>
  2. 名稱：<code>📤 送到 Claude</code><br>
  3. 網址：<a href="#" onclick="navigator.clipboard.writeText(${JSON.stringify(FB_BOOKMARKLET)}); this.textContent='✓ 已複製到剪貼簿，貼進書籤網址欄位'; return false;" style="color:#c9a227;">點此複製程式碼</a> → 貼進 URL 欄位
</div>
<div class="step">
  <b>點了沒反應？</b><br>
  確認 TheClaudenental server 運行中（<code>pm2 list</code> 看 <code>claudenental-server</code> 是 online）
</div>
<p class="note">書籤裡的程式碼指向 <code>http://100.115.110.21:3001</code>（Tailscale IP）。若你離開家用網路，需要修改為當時可連到的 server 位址。</p>
</body></html>`
})

// ─── Open URL in specific browser (bypass Chrome extension conflicts) ────────

app.post('/api/open-url', async (request) => {
  const { url, browser } = request.body ?? {}
  if (!url) return { ok: false, error: 'missing url' }
  try { new URL(url) } catch { return { ok: false, error: 'invalid url' } }

  // Windows: use `start` shell command with browser name
  // msedge / chrome / firefox are registered as application names
  const browserMap = {
    edge:    ['cmd', ['/c', 'start', '', 'msedge', url]],
    chrome:  ['cmd', ['/c', 'start', '', 'chrome',  url]],
    firefox: ['cmd', ['/c', 'start', '', 'firefox', url]],
    default: ['cmd', ['/c', 'start', '', url]],
  }
  const [cmd, args] = browserMap[browser] ?? browserMap.default
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false })
    p.unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

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
