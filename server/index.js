import Fastify from 'fastify'
import wsPlugin from '@fastify/websocket'
import fs from 'fs'
import path from 'path'
import { spawnSync, spawn } from 'child_process'
import os from 'os'
import crypto from 'crypto'

const PORT = 3001
const CLAUDIA_URL = 'http://localhost:48901'

const app = Fastify({ logger: false })
await app.register(wsPlugin)

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
    // Persist to settings.json when "Allow Always"
    if (isAlwaysAllow && p.toolName) {
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
    }
    p.resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: allow ? 'allow' : 'deny' } })
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
  // Ignore sessions spawned by our own subprocess — they appear in Chat, not Sessions list
  // Check both confirmed session_ids and pending spawns (by cwd) to handle race condition
  const cwdNorm = (e.cwd ?? '').replace(/\\/g, '/').toLowerCase()
  if (subprocessSids.has(e.session_id) || pendingSpawnCwds.has(cwdNorm)) return { ok: true }
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
    }
  }
  for (const id of removed) broadcast({ type: 'session_remove', sessionId: id })
  return { ok: true, removed: removed.length }
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
        let title = null, firstMsg = null, cwd = null
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(Boolean)
          for (const l of lines) {
            const obj = JSON.parse(l)
            if (!cwd && obj.cwd) cwd = obj.cwd
            if (obj.type === 'ai-title' && obj.aiTitle) { title = obj.aiTitle }
          }
          for (const l of lines) {
            const obj = JSON.parse(l)
            if (obj.type === 'user') {
              const c = obj.message?.content
              const text = typeof c === 'string' ? c : c?.[0]?.text ?? ''
              const clean = text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
              if (clean) { firstMsg = clean.slice(0, 60); break }
            }
          }
        } catch {}
        result.push({ sessionId, project: proj, cwd, title: title ?? firstMsg ?? sessionId.slice(0,8), mtime: stat.mtimeMs, size: stat.size })
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
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    for (const l of lines) {
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
        if (text.trim()) messages.push({ role: 'assistant', text: text.trim().slice(0, 800), ts: obj.timestamp })
      }
    }
  } catch {}
  return { ok: true, messages: messages.slice(0, 200) }
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

// Validate cwd is an existing directory
function isSafeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return false
  try { return fs.statSync(cwd).isDirectory() } catch { return false }
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
        broadcast({ type: 'claude_stream', projectPath, event })
      } catch {}
    }
  })

  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim()
    if (text) broadcast({ type: 'claude_stream', projectPath, event: { type: 'stderr', text } })
  })

  proc.on('close', code => {
    entry.status = 'done'
    broadcast({ type: 'claude_stream', projectPath, event: { type: 'done', exitCode: code } })
    setTimeout(() => { if (claudeProcs.get(projectPath) === entry) claudeProcs.delete(projectPath) }, 10_000)
  })

  return entry
}

app.post('/api/claude/run', async (request) => {
  const { projectPath, prompt, sessionId } = request.body
  if (!prompt) return { ok: false, error: 'missing prompt' }
  if (!isSafeCwd(projectPath)) return { ok: false, error: 'invalid projectPath' }
  const entry = spawnClaude(projectPath, prompt, sessionId ?? null)
  return { ok: true, projectPath, sessionId: entry.sessionId }
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

// Clear any stale pendingPermission left over from before this process started
// (those long-poll HTTP connections are gone after restart)
for (const [, s] of sessions) {
  if (s.pendingPermission) s.pendingPermission = null
}
