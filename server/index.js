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
  // B. send 失敗自動清掉死 socket（防殭屍累積）
  for (const ws of clients) {
    try { ws.send(data) } catch { clients.delete(ws) }
  }
}

// C. Heartbeat（每 30 秒 ping，沒回 pong 視為死連線）
const MAX_CONNECTIONS = 100  // D. 軟上限防意外
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      try { ws.terminate() } catch {}
      clients.delete(ws)
      continue
    }
    ws.isAlive = false
    try { ws.ping() } catch { clients.delete(ws) }
  }
}, 30_000)

// ─── Session persistence ──────────────────────────────────────────────────────

const SESSIONS_FILE = path.join(os.homedir(), '.claude', 'theclaudenental-sessions.json')

function persistSessions() {
  try {
    const data = {}
    for (const [id, s] of sessions) data[id] = s
    // atomic 寫入（少爺 2026-07-15）：崩潰時 writeFileSync 半寫會截斷檔案 → 下次開機全部 session 名稱/topic 遺失
    atomicWriteJson(SESSIONS_FILE, data)
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

// ─── subprocessSids 持久化（少爺 2026-07-14）───────────────────────────────────
// 純記憶體 Set 在 server 重啟後清空 → 還活著的孤兒喚醒進程的 hook 事件被誤註冊成互動 session
// （汙染 sessions 清單、也讓「活 session 警示」誤報）。持久化＋開機回濾根治。
const SUBPROC_SIDS_FILE = path.join(os.homedir(), '.claude', 'tc_subprocess_sids.json')
function persistSubprocessSids() {
  try { atomicWriteJson(SUBPROC_SIDS_FILE, [...subprocessSids]) } catch {}
}
try {
  for (const _sid of JSON.parse(fs.readFileSync(SUBPROC_SIDS_FILE, 'utf-8'))) {
    subprocessSids.add(_sid)
    // 開機回濾：先前被誤註冊進 sessions 的 TC 子進程 session 一併清掉
    if (sessions.has(_sid)) sessions.delete(_sid)
  }
} catch {}

// 不明 Session 名稱回填（少爺 2026-07-15：側欄不該只顯示「Session」字樣）——
// 舊持久化資料裡命名從未解析的，開機後從 transcript 補（aiTitle→首句）；找不到紀錄的標明讓少爺好清。
// ⚠️ 延遲執行：getSessionTopic 依賴檔案後段才宣告的 CLAUDE_DIR（TDZ），不可在模組頂層直接呼叫
setTimeout(() => {
  try {
    let _changed = 0
    for (const [_sid, _s] of [...sessions]) {
      // 全 projects 無 transcript ＝ 幽靈進程殘留（一句對話都沒寫）→ 直接移除，不留「(無紀錄)」垃圾條目
      if (!findJsonlPath(_sid)) {
        if (_s.status === 'active' || _s.status === 'waiting') continue   // 剛啟動還沒寫第一句的合法 session 不誤殺
        sessions.delete(_sid)
        broadcast({ type: 'session_remove', sessionId: _sid })
        _changed++
        continue
      }
      // 名稱收斂到「最初首句」（＝HISTORY 同款 aiTitle→首句；少爺 2026-07-15：名稱不可漂移成最新 prompt）
      const _initial = getSessionTopic(_sid)
      if (_initial && _s.displayName !== _initial.slice(0, 40)) {
        _s.topic = _initial
        _s.displayName = _initial.slice(0, 40)
        broadcast({ type: 'session', session: _s })
        _changed++
      }
    }
    if (_changed) schedulePersist()
  } catch {}
}, 3000)

// ─── WebSocket ────────────────────────────────────────────────────────────────

// A. Health endpoint — dashboard 可顯示連線數 / sessions 數 / 記憶體
app.get('/api/health', async () => {
  const mem = process.memoryUsage()
  return {
    ok: true,
    connections: clients.size,
    maxConnections: MAX_CONNECTIONS,
    sessions: sessions.size,
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
    memoryRssMB: Math.round(mem.rss / 1024 / 1024),
  }
})

app.get('/ws', { websocket: true }, (socket) => {
  // D. 軟上限保護（同時連線過多時拒絕新連線）
  if (clients.size >= MAX_CONNECTIONS) {
    try { socket.close(1013, 'too many connections') } catch {}
    return
  }
  clients.add(socket)
  socket.isAlive = true
  socket.on('pong', () => { socket.isAlive = true })  // C. heartbeat 配對
  socket.send(JSON.stringify({ type: 'state', sessions: [...sessions.values()], logs: logHistory }))

  socket.on('message', (raw) => {
    try { handleClientMessage(JSON.parse(raw.toString())) } catch {}
  })
  socket.on('close', () => clients.delete(socket))
})

function handleClientMessage(msg) {
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
  // 幽靈進程不建檔（少爺 2026-07-15「為什麼會有(無紀錄)」根治）：未知 session 的 Stop 且全 projects 無 transcript
  // ＝短命進程（如 resume 撞鎖即死），建了也只是「(無紀錄)」垃圾條目
  if (!sessions.has(e.session_id) && !findJsonlPath(e.session_id)) return { ok: true }
  const s = upsertSession(e.session_id)
  // 名稱自癒（少爺 2026-07-15）：server 重啟後第一個事件是 Stop 的 session 會掛預設名，這裡補解析
  if (s.displayName === 'Session') {
    const _topic = getSessionTopic(e.session_id)
    if (_topic) { s.topic = s.topic ?? _topic; s.displayName = _topic.slice(0, 40) }
  }
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
  // TC 出身的 sid 永久標記不刪（少爺 2026-07-14）：同 sid 可能有多顆進程（喚醒＋孤兒），
  // 一顆 SessionEnd 就除名會讓另一顆還活著的事件被誤註冊成互動 session
  if (subprocessSids.has(e.session_id)) return { ok: true }
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
  if (subprocessSids.has(e.session_id)) return { ok: true }
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
  // 名稱＝對話「最初」首句，永遠與 HISTORY 同款（少爺 2026-07-15：entry 遺失重建後不可被最新 prompt 蓋名——
  // 先從 transcript 解析最初首句/aiTitle，只有全新 session（transcript 還沒有 user 訊息）才用當前 prompt）
  if (!s.topic && clean) {
    const _initial = getSessionTopic(e.session_id) ?? clean
    s.topic = _initial
    s.displayName = _initial.slice(0, 40)
  }
  broadcast({ type: 'session', session: s })
  emitLog(e.session_id, `[Prompt] ${preview}`, 'user')

  // ─── Phase 1 PoC：環境保證自動建卡（不依賴 LLM 自律）─────────────
  // 對應 memory/project_tc_clean_tool_principle.md + auto_card_rules_schema.md
  // 規則由 ~/.claude/tc_user_config/auto_card_rules.json 控制（首次啟動 auto-copy）
  try {
    if (clean) {
      const rules = loadAutoCardRules()
      if (rules.enabled !== false) {
        const score = scoreTaskPrompt(clean, rules)
        const minScore = rules.min_score_to_create_card ?? 1
        if (score >= minScore) {
          const card = createCardFromHook(clean, e.session_id)
          if (card) emitLog(e.session_id, `[auto-card] +${card.column} 「${card.title.slice(0, 30)}」(score=${score})`, 'system')
        }
      }
    }
  } catch (err) { console.error('[auto-card]', err.message) }

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
          if (Array.isArray(c)) {
            // 依序保留 thinking + text（之前只 filter text，導致歷史載入 thinking 全失）
            for (const x of c) {
              if (x.type === 'thinking' && (x.thinking ?? '').trim()) {
                messages.push({ role: 'thinking', text: x.thinking, ts: obj.timestamp })
              } else if (x.type === 'text' && (x.text ?? '').trim()) {
                messages.push({ role: 'assistant', text: x.text.trim(), ts: obj.timestamp })
              }
            }
          }
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
  // 不截斷歷史 — 對應 memory/project_tc_design_alignment_audit.md 鐵律
  // （從前 slice(-500) 是真正讓「最早內容浮動」的元兇，已撤回）
  return { ok: true, messages, costUsd, byType, byModel }
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

// session_live 單一出口（少爺 2026-07-15 修 Chat 重複：4 處 broadcast 收斂到這）——
// TC 自己 spawn 的子進程「跑動中」時不發 session_live：它的 stdout 已走 claude_stream 直播，
// 檔案監看再發一次＝同句話雙路上畫面（重複的架構性來源）。進程結束後恢復（外部寫入照常直播）。
function emitSessionLive(sessionId, messages) {
  if (subprocessSids.has(sessionId)) {
    for (const [, e] of claudeProcs)
      if (e.sessionId === sessionId && e.status === 'running') return
  }
  broadcast({ type: 'session_live', sessionId, messages })
}

// Immediately flush new JSONL lines for a session (called by hooks for real-time updates)
function flushSessionLive(sessionId) {
  const entry = watchedSessions.get(sessionId)
  if (!entry) return
  const result = parseNewLines(entry.filePath, entry.lineCount)
  if (!result || !result.messages.length) return
  entry.lineCount = result.lineCount
  emitSessionLive(sessionId, result.messages)
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
    emitSessionLive(sessionId, result.messages)
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

// ─── Log History API ─────────────────────────────────────────────────────────

app.get('/api/logs', async (request) => {
  const { sessionId, last } = request.query
  let logs = logHistory
  if (sessionId) logs = logs.filter(l => !l.sessionId || l.sessionId === sessionId)
  if (last) logs = logs.slice(-Number(last))
  return { logs }
})

// ─── Claude Subprocess API ───────────────────────────────────────────────────

// Server side queue — 思考中送出時不 kill 上一個，自動排隊接續
// （少爺 2026-04-27 報「我做的事讓對話中斷」根因 = spawnClaude 開頭的 kill existing）
const claudeRunQueue = new Map()  // projectPath → array of { prompt, sessionId }

function processQueueIfIdle(projectPath) {
  const existing = claudeProcs.get(projectPath)
  if (existing?.status === 'running') return
  const q = claudeRunQueue.get(projectPath)
  if (!q || q.length === 0) return
  const next = q.shift()
  if (q.length === 0) claudeRunQueue.delete(projectPath)
  // 用佇列裡的 sessionId（同 session 接續）；若空則用最後一個 entry 的
  const sid = next.sessionId ?? existing?.sessionId ?? null
  broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath),
    event: { type: 'system', subtype: 'queue_dequeue', queueRemaining: q.length } })
  spawnClaude(projectPath, next.prompt, sid, next.model ?? null, next.effort ?? null, next.onInit ?? null)
}

// 少爺 2026-07-14：模型強度白名單（claude CLI --effort 支援值）
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// ─── Session 模型/強度偏好（少爺 2026-07-14：仕酒師/Chat 選的模型強度要跟著聊天室——
//     CLI 的 --model/--effort 是每次啟動參數不進 session，續聊/QA 喚醒沒明選時 server 沿用此偏好）───
const SESSION_PREFS_FILE = path.join(os.homedir(), '.claude', 'tc_session_prefs.json')
function readSessionPrefs() {
  try { return JSON.parse(fs.readFileSync(SESSION_PREFS_FILE, 'utf8')) } catch { return {} }
}
function setSessionPrefs(sessionId, model, effort) {
  if (!sessionId || (!model && !effort)) return
  const _prefs = readSessionPrefs()
  const _cur = _prefs[sessionId] ?? {}
  _prefs[sessionId] = { model: model ?? _cur.model ?? null, effort: effort ?? _cur.effort ?? null, updatedAt: Date.now() }
  atomicWriteJson(SESSION_PREFS_FILE, _prefs)
}
function getSessionPrefs(sessionId) {
  return sessionId ? (readSessionPrefs()[sessionId] ?? null) : null
}

// 少爺 2026-07-14：仕酒師/Chat 勾選「啟用 QA 流程」→ 需求 prompt 尾端附掛 Mode C 指令（流程 SSOT 在 skill 與 QA/README，不在此重抄）
const QA_FLOW_DIRECTIVE = '\n\n(TC QA 流程) 少爺勾選了「啟用 QA 流程」——本需求必須走 Mode C 協作驗證收尾：照 theclaudenental_operator skill 的「QA Run 操作 SOP（Mode C）」與專案 QA/README.md §Mode C，從 Step 0 開 QA Run（POST /api/qa/runs，必綁 boundSessionId=本 session id、wakeMode:"spawn"、boundProjectPath、project），列 QAPC 計畫（操作步驟＋預期 LOG 劇本＋LOG 埋點計畫）供少爺在 QA 分頁審查；少爺按 ▶ 之前零編譯零埋 LOG。'

function spawnClaude(projectPath, prompt, sessionId = null, model = null, effort = null, onInit = null) {
  // ⚠️ 不再 kill existing（會中斷使用者進行中的 thinking）
  // 呼叫端必須先檢查 claudeProcs.get(projectPath)?.status，running 時 push 到 queue 而非呼叫 spawnClaude

  // Pre-register before spawn so SessionStart hook can filter by cwd (race condition fix)
  const normalCwd = projectPath.replace(/\\/g, '/').toLowerCase()
  pendingSpawnCwds.add(normalCwd)

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ]
  if (effort) args.unshift('--effort', effort)
  if (model) args.unshift('--model', model)
  if (sessionId) args.unshift('--resume', sessionId)

  const proc = spawn(getClaudeExe(), args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry = { proc, sessionId, projectPath, status: 'running', model, effort }
  claudeProcs.set(projectPath, entry)

  // 少爺 2026-07-14：spawn 參數可觀察化——落 log + 推 Chat 面板顯示（effort 在 init/transcript 皆無痕跡，這裡是唯一觀察點）
  if (model || effort) {
    logEvent('claude.spawn.config', { projectPath: normalizePath(projectPath), sessionId, model: model ?? null, effort: effort ?? null })
    broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: sessionId ?? null,
      event: { type: 'system', subtype: 'spawn_config', model: model ?? null, effort: effort ?? null } })
  }

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
          persistSubprocessSids()
          pendingSpawnCwds.delete(normalCwd)
          // 新聊天室的 model/effort 選擇在拿到 session id 後記成偏好，續聊/QA 喚醒沿用
          setSessionPrefs(event.session_id, entry.model ?? null, entry.effort ?? null)
          // 呼叫端要拿新 session id 做後續綁定時用（少爺 2026-07-14：QA 未綁定 run 自動開新聊天室並綁回）
          if (onInit) try { onInit(event.session_id) } catch {}
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
    // 處理 queue 下一個（如果有）— 維持「直接送 + 不中斷」UX
    processQueueIfIdle(projectPath)
  })

  return entry
}

// base64 attachments([{name,dataUrl}]) → 存 temp 檔，回傳寫成功的路徑陣列（供 append 到 prompt 讓 Claude 讀）。
// 共用給 CHAT(/api/claude/run) 與 QA Run comment(/control) 與 Sommelier 送入聊天室。
function saveAttachmentFiles(attachments) {
  const paths = []
  if (!Array.isArray(attachments)) return paths
  for (const att of attachments) {
    if (!att?.dataUrl || !att?.name) continue
    const m = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!m) continue
    const ext = path.extname(att.name) || '.bin'
    const tmpPath = path.join(os.tmpdir(), `claud_att_${crypto.randomBytes(6).toString('hex')}${ext}`)
    try { fs.writeFileSync(tmpPath, Buffer.from(m[2], 'base64')); paths.push(tmpPath) } catch {}
  }
  return paths
}

app.post('/api/claude/run', async (request) => {
  const { projectPath: rawPath, prompt, sessionId, attachments, model, effort, qaFlow } = request.body
  if (!prompt && !(attachments?.length)) return { ok: false, error: 'missing prompt' }
  const projectPath = rawPath?.replace(/\//g, path.sep) // normalize to OS path sep
  if (!isSafeCwd(projectPath)) return { ok: false, error: 'invalid projectPath' }
  // 少爺 2026-07-14：CHAT / 仕酒師送入聊天室可指定 AI 模型（alias 或全名，交給 claude CLI 驗證）＋模型強度
  // 明選優先；續聊沒明選 → 沿用該聊天室記住的偏好；有明選則回寫偏好（聊天室從此改用）
  const _bodyModel = (typeof model === 'string' && model.trim()) ? model.trim() : null
  const _bodyEffort = EFFORT_LEVELS.includes(effort) ? effort : null
  const _prefs = sessionId ? getSessionPrefs(sessionId) : null
  const _model = _bodyModel ?? _prefs?.model ?? null
  const _effort = _bodyEffort ?? _prefs?.effort ?? null
  if (sessionId && (_bodyModel || _bodyEffort)) setSessionPrefs(sessionId, _bodyModel, _bodyEffort)

  // Save base64 attachments to temp files and append their paths to the prompt
  const tempFiles = saveAttachmentFiles(attachments)
  let fullPrompt = prompt ?? ''
  for (const tmpPath of tempFiles) fullPrompt += `\n${tmpPath}`
  // 少爺 2026-07-14：勾選啟用 QA 流程 → 需求尾端附掛 Mode C 指令
  if (qaFlow === true) fullPrompt += QA_FLOW_DIRECTIVE

  // 思考中（同 projectPath 已有 running process）→ push 到 queue，不 kill 上一個
  const existing = claudeProcs.get(projectPath)
  if (existing?.status === 'running') {
    let q = claudeRunQueue.get(projectPath)
    if (!q) { q = []; claudeRunQueue.set(projectPath, q) }
    q.push({ prompt: fullPrompt, sessionId: sessionId ?? existing.sessionId ?? null, model: _model, effort: _effort })
    broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath),
      event: { type: 'system', subtype: 'queue_enqueue', queuePos: q.length } })
    return { ok: true, queued: true, queuePos: q.length }
  }
  const entry = spawnClaude(projectPath, fullPrompt, sessionId ?? null, _model, _effort)

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
                emitSessionLive(sid, result.messages)
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
          // TC 自己 spawn 的子進程 session 不進互動 sessions 清單（少爺 2026-07-14：掃描器漏掉這道濾網＝孤兒被誤註冊的根因）
          if (subprocessSids.has(sid)) continue
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
                emitSessionLive(sid, result.messages)
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

// 過期資料清理（只清「過期」概念明確的：未用 invites + 已死 sessions）
// 卡片 / events log 不自動真刪 — 對應 memory 三層分離哲學：
// - 卡片 = 介面層（軟刪後永遠保留，要徹底刪走 /:id/purge 顯式呼叫）
// - events log = 內容層（歷史不該被自動砍）
// - knowledge / memory = 永久層
function cleanupExpiredData() {
  const now = Date.now()
  let removed = { invites: 0, sessions: 0 }
  try {
    const data = readInvites()
    const before = data.invites.length
    // 只刪「過期且未用」的 invite（已用過的留作審計）
    data.invites = data.invites.filter(i => i.usedByUserId || (i.expiresAt ?? 0) > now)
    if (before !== data.invites.length) {
      writeInvites(data)
      removed.invites = before - data.invites.length
    }
  } catch {}
  try {
    const data = readUserSessions()
    const before = data.sessions.length
    data.sessions = data.sessions.filter(s => (s.expiresAt ?? 0) > now)
    if (before !== data.sessions.length) {
      writeUserSessions(data)
      removed.sessions = before - data.sessions.length
    }
  } catch {}
  if (removed.invites || removed.sessions) {
    console.log(`[cleanup] removed: ${removed.invites} expired invites, ${removed.sessions} expired sessions`)
  }
}
// 啟動 5s 延遲 + 每 24 小時跑一次
setTimeout(() => { try { cleanupExpiredData() } catch (e) { console.error('[cleanup error]', e) } }, 5000)
setInterval(() => { try { cleanupExpiredData() } catch (e) { console.error('[cleanup error]', e) } }, 24 * 60 * 60 * 1000)

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

// ─── User Config（客製化值在本機，工具 repo 只有範例 + schema md）────────────
// 對應 memory/project_tc_clean_tool_principle.md「三層分離鐵律」

const USER_CONFIG_DIR = path.join(os.homedir(), '.claude', 'tc_user_config')
const CONFIG_EXAMPLE_DIR = path.join(import.meta.dirname, '..', 'config.example')
const AUTO_CARD_RULES_FILE = path.join(USER_CONFIG_DIR, 'auto_card_rules.json')
const PROJECT_ROOTS_FILE = path.join(USER_CONFIG_DIR, 'project_roots.json')

function ensureUserConfig() {
  try {
    if (!fs.existsSync(USER_CONFIG_DIR)) fs.mkdirSync(USER_CONFIG_DIR, { recursive: true })
    if (!fs.existsSync(CONFIG_EXAMPLE_DIR)) return
    for (const f of fs.readdirSync(CONFIG_EXAMPLE_DIR)) {
      const src = path.join(CONFIG_EXAMPLE_DIR, f)
      const dst = path.join(USER_CONFIG_DIR, f)
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
    }
  } catch (e) { console.error('[ensureUserConfig]', e.message) }
}
ensureUserConfig()

const DEFAULT_AUTO_CARD_RULES = {
  enabled: true,
  min_prompt_length: 8,
  min_score_to_create_card: 1,
  task_signals_positive: [
    { pattern: '立刻|請幫我|幫我|加上|補上|建立|實作|做一個|寫一個|新增|加入', weight: 2 },
    { pattern: '規劃|設計|查驗|驗證|找出|查清|分析|統整|整理|重構', weight: 2 },
    { pattern: 'Bug|bug|報錯|壞了|不對|失敗|crash', weight: 2 },
  ],
  task_signals_negative: [
    { pattern: '^(對|不對|是|沒錯|繼續|OK|ok|Ok|了解|收到|好)\\b', weight: -3 },
    { pattern: '^(你覺得|為什麼|怎麼看|可以嗎|是不是|對嗎)', weight: -2 },
    { pattern: '\\?$|？$', weight: -1 },
  ],
  default_column: 'idea',
  default_tag_ids: ['tag-idea'],
  title_max_chars: 60,
}

let _autoCardRulesCache = null
let _autoCardRulesMtime = 0
function loadAutoCardRules() {
  try {
    if (!fs.existsSync(AUTO_CARD_RULES_FILE)) return DEFAULT_AUTO_CARD_RULES
    const stat = fs.statSync(AUTO_CARD_RULES_FILE)
    if (_autoCardRulesCache && stat.mtimeMs === _autoCardRulesMtime) return _autoCardRulesCache
    const parsed = JSON.parse(fs.readFileSync(AUTO_CARD_RULES_FILE, 'utf8'))
    _autoCardRulesCache = parsed
    _autoCardRulesMtime = stat.mtimeMs
    return parsed
  } catch (e) {
    console.error('[loadAutoCardRules]', e.message)
    return DEFAULT_AUTO_CARD_RULES
  }
}

function scoreTaskPrompt(text, rules) {
  if (!text || text.length < (rules.min_prompt_length ?? 8)) return -Infinity
  let score = 0
  for (const s of rules.task_signals_positive ?? []) {
    try { if (new RegExp(s.pattern).test(text)) score += s.weight ?? 1 } catch {}
  }
  for (const s of rules.task_signals_negative ?? []) {
    try { if (new RegExp(s.pattern).test(text)) score += s.weight ?? -1 } catch {}
  }
  return score
}

// 防止重複建卡：每個 session 內，相同 prompt 前 60 字 + 5 分鐘窗口
const _recentAutoCards = new Map() // key=`${sessionId}|${title60}`, value=ts
function shouldSkipDuplicate(sessionId, title) {
  const key = `${sessionId ?? 'anon'}|${title}`
  const last = _recentAutoCards.get(key)
  const now = Date.now()
  if (last && now - last < 5 * 60 * 1000) return true
  _recentAutoCards.set(key, now)
  // GC：保留近 50 筆即可
  if (_recentAutoCards.size > 50) {
    const oldest = [..._recentAutoCards.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) _recentAutoCards.delete(oldest[0])
  }
  return false
}

function createCardFromHook(prompt, sessionId) {
  const rules = loadAutoCardRules()
  const titleMax = rules.title_max_chars ?? 60
  const stripped = String(prompt).replace(/[#*`>\-]/g, '').trim()
  const firstLine = stripped.split('\n').find(l => l.trim()) ?? ''
  const title = firstLine.slice(0, titleMax) || '未命名（hook 自動建卡）'
  if (shouldSkipDuplicate(sessionId, title)) return null

  const data = readTodos()
  const card = {
    id: `c${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    column: COLUMNS.includes(rules.default_column) ? rules.default_column : 'idea',
    themeId: null,
    tagIds: Array.isArray(rules.default_tag_ids) ? rules.default_tag_ids : ['tag-idea'],
    note: `## 自動建卡（hook auto）\n\nsessionId: ${sessionId ?? '(none)'}\ncreatedAt: ${new Date().toLocaleString('zh-TW', { hour12: false })}\n\n## 原始 prompt\n\n${prompt}\n`,
    parentId: null, sessionId: sessionId ?? null,
    lastDiscussedAt: sessionId ? Date.now() : null,
    lastSummary: '',
    createdAt: Date.now(), updatedAt: Date.now(), order: Date.now(),
    categoryId: 'cat-personal',
    sharedWith: [], sharedBy: 'u-owner', sharedAt: null,
    kind: 'task', topicMdPath: null,
    version: 1, deletedAt: null,
  }
  data.cards.push(card)
  writeTodos(data)
  logEvent('card.create', { id: card.id, column: card.column, title: card.title, source: 'hook-auto' })
  return card
}

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
    // P3：卡片=介面 / md=內容 設計鐵律
    kind: body.kind === 'knowledge' ? 'knowledge' : 'task',  // 預設 task；少爺手動改 knowledge
    topicMdPath: body.topicMdPath ?? null,  // 對應的話題 md 檔案路徑（相對於 RomanPrototype）
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

// P3：沉澱卡片 note 到 md 檔案（卡片=介面 / md=內容 鐵律的具體實踐）
// 卡片的 kind 決定 md 模板 + 寫入位置：
//   task → .agent/topics/[id]-[slug].md（短期 / 可被時間整理）
//   knowledge → .agent/knowledge/[slug].md（長期 / 永久保留）
// 寫入後自動更新 card.topicMdPath
app.post('/api/todos/:id/sediment', async (request, reply) => {
  const data = readTodos()
  const card = data.cards.find(c => c.id === request.params.id)
  if (!card) { reply.code(404); return { ok: false, error: 'not found' } }

  const projectRoot = request.body?.projectRoot || 'C:/Project/RomanPrototype'
  const slug = (card.title ?? 'untitled').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60)
  const isKnowledge = card.kind === 'knowledge'
  const dir = isKnowledge ? '.agent/knowledge' : '.agent/topics'
  const fileName = isKnowledge ? `${slug}.md` : `${card.id}-${slug}.md`
  const fullPath = path.join(projectRoot, dir, fileName)

  // 確保目錄存在
  try { fs.mkdirSync(path.dirname(fullPath), { recursive: true }) } catch {}

  // 已存在 → append 進度區塊；不存在 → 建新檔含模板
  let content
  if (fs.existsSync(fullPath)) {
    const existing = fs.readFileSync(fullPath, 'utf8')
    const stamp = new Date().toLocaleString('zh-TW', { hour12: false })
    content = existing + `\n\n---\n\n## 沉澱於 ${stamp}\n\n${card.note ?? ''}\n`
  } else if (isKnowledge) {
    // knowledge 模板：精煉四節結構
    content = `# ${card.title}

> 從 TODO 卡片 ${card.id} 沉澱於 ${new Date().toLocaleString('zh-TW', { hour12: false })}
> 卡片進度狀態：${card.column}

## 正確做法

（依此卡片實作經驗整理為 SOP）

## 踩過的坑

（過程中發現的陷阱、誤解、回溯點）

## 順利的工作流程

（這次哪些步驟特別 work，下次可重用）

## 前後文（context / why）

（為什麼這麼做、跟其他系統的關係、決策理由）

---

## 卡片原始內容

${card.note ?? ''}
`
  } else {
    // task 模板：簡短進度紀錄
    content = `# ${card.title}

> 從 TODO 卡片 ${card.id} 沉澱於 ${new Date().toLocaleString('zh-TW', { hour12: false })}
> 卡片狀態：${card.column} (kind: task)

## 目標

${card.title}

## 步驟 / 進度

${card.note ?? '（未填）'}

## 結果

（完成後填入；本檔可被時間整理）
`
  }

  try {
    fs.writeFileSync(fullPath, content, 'utf8')
  } catch (e) {
    reply.code(500); return { ok: false, error: `write failed: ${e.message}` }
  }

  // 更新 card 的 topicMdPath（相對路徑，跨機器友善）
  const relPath = `${dir}/${fileName}`
  card.topicMdPath = relPath
  card.version = (card.version ?? 1) + 1
  card.updatedAt = Date.now()
  // note 改成短摘要 + 連結
  const summary = (card.note ?? '').slice(0, 100).replace(/\n/g, ' ')
  card.note = `📝 已沉澱到 ${relPath}\n\n${summary}${(card.note ?? '').length > 100 ? '...' : ''}`
  writeTodos(data)
  logEvent('card.sediment', { id: card.id, kind: card.kind, path: relPath })

  return { ok: true, card, path: relPath, fullPath }
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

// ─── Open in VSCode (markdown link handler) ──────────────────────────────────
// 對應 docs/customization/project_roots_schema.md
// 對應 memory/feedback_filepath_markdown_format.md

const DEFAULT_PROJECT_ROOTS_CONFIG = {
  enabled: true,
  project_roots: [],
  vscode_cli: 'code',
  allowed_extensions: ['.md', '.txt', '.cpp', '.h', '.js', '.ts', '.json'],
  owner_only: true,
}

let _projectRootsCache = null
let _projectRootsMtime = 0
function loadProjectRootsConfig() {
  try {
    if (!fs.existsSync(PROJECT_ROOTS_FILE)) return DEFAULT_PROJECT_ROOTS_CONFIG
    const stat = fs.statSync(PROJECT_ROOTS_FILE)
    if (_projectRootsCache && stat.mtimeMs === _projectRootsMtime) return _projectRootsCache
    const parsed = JSON.parse(fs.readFileSync(PROJECT_ROOTS_FILE, 'utf8'))
    _projectRootsCache = parsed
    _projectRootsMtime = stat.mtimeMs
    return parsed
  } catch (e) {
    console.error('[loadProjectRootsConfig]', e.message)
    return DEFAULT_PROJECT_ROOTS_CONFIG
  }
}

app.post('/api/open-in-vscode', async (request, reply) => {
  const cfg = loadProjectRootsConfig()
  if (!cfg.enabled) { reply.code(503); return { ok: false, error: 'feature disabled' } }
  if (cfg.owner_only && !requireOwner(request, reply)) return { ok: false, error: 'owner only' }

  const body = request.body ?? {}
  const relativePath = String(body.relativePath ?? '').trim()
  const line = (Number.isInteger(body.line) && body.line > 0) ? body.line : null

  if (!relativePath) { reply.code(400); return { ok: false, error: 'missing relativePath' } }

  // Path traversal block
  if (relativePath.includes('..') || relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:/.test(relativePath)) {
    reply.code(400); return { ok: false, error: 'absolute or traversal path forbidden' }
  }

  // Extension whitelist
  const ext = path.extname(relativePath).toLowerCase()
  if (!cfg.allowed_extensions.includes(ext)) {
    reply.code(400); return { ok: false, error: `extension ${ext} not in whitelist` }
  }

  // Find matching project root
  let absPath = null
  for (const root of (cfg.project_roots || [])) {
    const normalizedRoot = path.resolve(root)
    const candidate = path.resolve(normalizedRoot, relativePath)
    // Security: candidate must still be inside normalizedRoot
    if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) continue
    if (fs.existsSync(candidate)) { absPath = candidate; break }
  }
  if (!absPath) { reply.code(404); return { ok: false, error: 'file not found in any project_root' } }

  // Build VSCode arg: code -g <abs>:<line>
  const target = line ? `${absPath}:${line}` : absPath
  try {
    // shell: true 為了 Windows 上 code.cmd / cursor.cmd 等 .cmd 能被 spawn 找到
    const p = spawn(cfg.vscode_cli, ['-g', target], { detached: true, stdio: 'ignore', shell: true })
    p.unref()
    return { ok: true, openedPath: absPath, line }
  } catch (e) {
    reply.code(500); return { ok: false, error: e.message }
  }
})

// ─── Sommelier(專案名詞圖鑑 — 侍酒師)─────────────────────────────────────────
// 泛用檢視器:只認 ~/.claude/tc_user_config/sommelier.json 指到的資料目錄,
// 專案知識資料本身不進 TC repo(工具乾淨化鐵律)。

const SOMMELIER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'sommelier.json')

function readSommelierConfig() {
  try { return JSON.parse(fs.readFileSync(SOMMELIER_CONFIG_FILE, 'utf8')) } catch { return { version: 1, projects: [] } }
}

app.get('/api/sommelier/projects', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const cfg = readSommelierConfig()
  // 高桌會認可制：enabled=false（除聖）的分館不出現在仕酒師/QA 下拉；資料永久保留
  return { ok: true, projects: (cfg.projects ?? []).filter(p => p.enabled !== false).map(p => ({ id: p.id, name: p.name })) }
})

// ─── 高桌會（The High Table — 分館/專案認可管理）────────────────────────────
// 專案庫 SSOT = sommelier.json；認可=出現在仕酒師/QA、除聖(enabled:false)=介面移除、資料保留

app.get('/api/projects/registry', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const cfg = readSommelierConfig()
  return { ok: true, projects: (cfg.projects ?? []).map(p => ({ id: p.id, name: p.name, dataDir: p.dataDir ?? '', enabled: p.enabled !== false })) }
})

// 開館 — 前端用瀏覽器原生 showDirectoryPicker（同 CHAT「Upload from computer」族）選資料夾；
// 瀏覽器安全限制只給「資料夾名稱」不給絕對路徑 → 此端點按名稱在 project_roots.json 的
// 目錄樹（各 root 上層起、深度 3）反查絕對路徑候選，前端一中就自動帶入、多中給選、零中手動填
app.post('/api/projects/resolve-folder', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const name = String(request.body?.name ?? '').trim()
  if (!name) { reply.code(400); return { ok: false, error: 'name required' } }
  let rootsCfg = {}
  try { rootsCfg = JSON.parse(fs.readFileSync(PROJECT_ROOTS_FILE, 'utf8')) } catch { /* 無設定 → 空清單 */ }
  const roots = new Set()
  for (const r of (rootsCfg.project_roots ?? [])) {
    const abs = path.resolve(r)
    roots.add(abs)
    roots.add(path.dirname(abs))   // 上層（如 C:/Project）也掃，涵蓋兄弟/姪層專案
  }
  const SKIP = new Set(['node_modules', 'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache', 'Content', 'Source', 'Engine', 'Plugins', 'Config', 'Build', '__ExternalActors__', '__ExternalObjects__'])
  const target = name.toLowerCase()
  const matches = new Set()
  const walk = (dir, depth) => {
    if (depth > 3 || matches.size >= 8) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.name.toLowerCase() === target) { matches.add(full); continue }
      walk(full, depth + 1)
    }
  }
  for (const r of roots) if (path.basename(r).toLowerCase() === target) matches.add(r)
  for (const r of roots) walk(r, 1)
  // 淺路徑優先（真專案通常在 root 淺層；資料夾同名的資料層/備份多在深層）
  const sorted = [...matches].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)
  return { ok: true, matches: sorted }
})

// 開館（新增分館）：帶 projectPath 時自動建立仕酒師資料層（GameMechanics/<資料夾名>/sommelier 慣例）
// + cpp 萃取指令 + 背景跑首次萃取；QA 綁 project id 即用，無需另建。手動欄位（id/name/dataDir/extractCommand）仍相容。
app.post('/api/projects/registry', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const body = request.body ?? {}
  const id = String(body.id ?? '').trim()
  if (!id) { reply.code(400); return { ok: false, error: 'id required' } }
  const cfg = readSommelierConfig()
  cfg.projects ??= []
  if (cfg.projects.some(p => p.id === id)) { reply.code(409); return { ok: false, error: `id「${id}」已存在` } }
  const proj = { id, name: String(body.name ?? '').trim() || id }
  if (typeof body.dataDir === 'string' && body.dataDir.trim()) proj.dataDir = body.dataDir.trim()
  if (typeof body.extractCommand === 'string' && body.extractCommand.trim()) proj.extractCommand = body.extractCommand.trim()
  if (typeof body.projectPath === 'string' && body.projectPath.trim()) {
    const projPath = body.projectPath.trim()
    proj.projectPath = projPath
    const folderName = path.basename(projPath)
    if (!proj.dataDir) proj.dataDir = `C:/Project/MasterBrain/GameMechanics/${folderName}/sommelier`
    try { fs.mkdirSync(path.join(proj.dataDir, 'generated'), { recursive: true }) } catch { /* 已存在 */ }
    if (!proj.extractCommand) proj.extractCommand = `node C:/Project/MasterBrain/.agent/scripts/extract_ue_cpp_symbols.mjs --project "${projPath}" --name "${proj.name}" --out "${proj.dataDir}/generated/cpp_symbols.json"`
  }
  cfg.projects.push(proj)
  atomicWriteJson(SOMMELIER_CONFIG_FILE, cfg)
  logEvent('projects.registry.add', { id, projectPath: proj.projectPath ?? null })
  // 開館即自動萃取（背景 fire-and-forget）：完成後仕酒師即可讀；失敗不擋開館（介面有刷新鈕可重跑）
  if (proj.extractCommand) {
    setImmediate(() => {
      try { const r = spawn(proj.extractCommand, { shell: true, stdio: 'ignore', detached: true }); r.unref() } catch { /* 萃取失敗交介面刷新鈕 */ }
    })
  }
  return { ok: true }
})

// 認可 / 除聖切換（enabled）＋ 改顯示名稱
app.patch('/api/projects/registry/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const cfg = readSommelierConfig()
  const proj = (cfg.projects ?? []).find(p => p.id === request.params.id)
  if (!proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const body = request.body ?? {}
  if (typeof body.enabled === 'boolean') proj.enabled = body.enabled
  if (typeof body.name === 'string' && body.name.trim()) proj.name = body.name.trim()
  atomicWriteJson(SOMMELIER_CONFIG_FILE, cfg)
  logEvent('projects.registry.update', { id: proj.id, enabled: proj.enabled !== false })
  return { ok: true }
})

app.get('/api/sommelier/data/:projectId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const cfg = readSommelierConfig()
  const proj = (cfg.projects ?? []).find(p => p.id === request.params.projectId)
  if (!proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const file = path.join(proj.dataDir, 'generated', 'cpp_symbols.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    // 架構 canvas 層（第二血肉骨架，選配）：合流 + 建 symbol→canvas 反查索引
    let arch = null
    const symbolCanvasIndex = {}
    try {
      arch = JSON.parse(fs.readFileSync(path.join(proj.dataDir, 'generated', 'arch_canvas.json'), 'utf8'))
      for (const c of arch.canvases ?? [])
        for (const n of c.nodes ?? [])
          for (const ref of n.symbolRefs ?? []) {
            (symbolCanvasIndex[ref.name] ??= []).push({
              canvas: c.file, canvasTitle: c.title,
              nodeId: n.id, nodeTitle: n.title, confidence: ref.confidence,
            })
          }
    } catch { /* arch_canvas.json 不存在 → 只回骨架層,前端優雅降級 */ }
    // 拼圖 memory 層（第三血肉，選配）：合流 + 建 symbol→memory 反查索引
    let memory = null
    const symbolMemoryIndex = {}
    try {
      memory = JSON.parse(fs.readFileSync(path.join(proj.dataDir, 'generated', 'memory_notes.json'), 'utf8'))
      for (const n of memory.notes ?? [])
        for (const ref of n.symbolRefs ?? []) {
          (symbolMemoryIndex[ref.name] ??= []).push({ name: n.name, title: n.title, type: n.type })
        }
    } catch { /* memory_notes.json 不存在 → 只回前兩層 */ }
    // 藍圖資產層（第四血肉，選配，需 Editor 側 extract_asset_graph.py 產出）：
    // 合流 + 建 C++ 類 → 繼承它的 BP 反查索引（parentName 去 U/A/I/F/E 前綴對回 cpp symbol）
    let assetGraph = null
    const symbolBpIndex = {}
    try {
      assetGraph = JSON.parse(fs.readFileSync(path.join(proj.dataDir, 'generated', 'asset_graph.json'), 'utf8'))
      const cppNames = new Set((data.symbols ?? []).map(s => s.name))
      const resolveCpp = (pn) => {
        if (!pn) return null
        if (cppNames.has(pn)) return pn
        for (const pre of ['U', 'A', 'I', 'F', 'E']) if (cppNames.has(pre + pn)) return pre + pn
        return null
      }
      for (const bp of assetGraph.blueprints ?? []) {
        if (bp.parentKind !== 'cpp') continue
        const sym = resolveCpp(bp.parentName)
        if (sym) (symbolBpIndex[sym] ??= []).push({ name: bp.name, path: bp.path, class: bp.class })
      }
    } catch { /* asset_graph.json 不存在 → 前三層照回,前端優雅降級 */ }
    return { ok: true, data, arch, symbolCanvasIndex, memory, symbolMemoryIndex, assetGraph, symbolBpIndex, extractCommand: proj.extractCommand ?? null }
  } catch (e) {
    reply.code(404)
    return { ok: false, error: `尚無萃取資料:${e.message}`, hint: proj.extractCommand ?? null }
  }
})

// 重萃取（第五階段閉環）：跑 project extractCommand（離線三萃取器 cpp/arch/memory）。
// 藍圖資產層 asset_graph 需 Editor 側 execute_python（extract_asset_graph.py），不在此端點。
app.post('/api/sommelier/refresh/:projectId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const cfg = readSommelierConfig()
  const proj = (cfg.projects ?? []).find(p => p.id === request.params.projectId)
  if (!proj?.extractCommand) { reply.code(404); return { ok: false, error: 'no extractCommand for project' } }
  try {
    const r = spawnSync(proj.extractCommand, { shell: true, encoding: 'utf8', timeout: 180000 })
    const ok = r.status === 0
    logEvent('sommelier.refresh', { projectId: proj.id, ok, code: r.status })
    return { ok, code: r.status, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-800) }
  } catch (e) { reply.code(500); return { ok: false, error: e.message } }
})

// ─── AutoQA Monitor（QA runs — 少爺可視化 QA 介面）───────────────────────────
// 對應 RomanPrototype/.agent/knowledge/UE5.8_QAToolsets_Plan.md §5.7 + Phase M
// 三層鐵律：run = 介面層（tc_qa_runs.json，永久保留不做 retention）；
//           QAP md + sessionDir = 內容層；拼圖 = 元層。

const QA_RUNS_FILE = path.join(os.homedir(), '.claude', 'tc_qa_runs.json')
const QA_EVENT_TAIL_MAX = 400   // run 只留 timeline 尾段；完整 events.jsonl 在 sessionDir（內容層）
const QA_ARTIFACT_EXTS = ['.png', '.jpg', '.jpeg', '.log', '.json', '.jsonl', '.txt', '.md']

function readQaRuns() {
  try { return JSON.parse(fs.readFileSync(QA_RUNS_FILE, 'utf8')) } catch { return { runs: [] } }
}
function writeQaRuns(data) { atomicWriteJson(QA_RUNS_FILE, data) }
function qaBroadcast(run) { broadcast({ type: 'qa_run_update', run }) }

const qaCountdownTimers = new Map()  // runId → timeout handle（倒數 server 端計，斷線不失效）

function qaClearCountdown(runId) {
  if (qaCountdownTimers.has(runId)) { clearTimeout(qaCountdownTimers.get(runId)); qaCountdownTimers.delete(runId) }
}

function qaArmCountdown(run) {
  if (run.status !== 'countdown' || !run.countdownEndsAt) return
  qaClearCountdown(run.id)
  qaCountdownTimers.set(run.id, setTimeout(() => {
    qaCountdownTimers.delete(run.id)
    const data = readQaRuns()
    const r = data.runs.find(x => x.id === run.id)
    if (!r || r.status !== 'countdown') return
    r.status = 'running'
    r.startedAt = Date.now()
    writeQaRuns(data)
    logEvent('qa.run.autostart', { id: r.id })
    qaBroadcast(r)
  }, Math.max(0, run.countdownEndsAt - Date.now())))
}

// server 重啟後恢復倒數中的 run（timer 不跨進程）
{
  const data = readQaRuns()
  let dirty = false
  for (const r of data.runs) {
    if (r.status === 'countdown' && (r.countdownEndsAt ?? 0) <= Date.now()) {
      r.status = 'running'; r.startedAt = r.startedAt || Date.now(); dirty = true
    }
  }
  if (dirty) writeQaRuns(data)
  for (const r of data.runs) if (r.status === 'countdown') qaArmCountdown(r)
}

// Claude 宣告新 run（計畫全文上介面 → 倒數攔截窗口）
// countdownSecs: >0 倒數自動開跑 / 0 立即開跑 / <0 必等少爺按「立即開跑」
app.post('/api/qa/runs', async (request) => {
  const body = request.body ?? {}
  const countdownSecs = typeof body.countdownSecs === 'number' ? body.countdownSecs : 30
  const run = {
    id: `qar${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    topic: body.topic ?? '(untitled)',
    env: body.env ?? '',
    commit: body.commit ?? '',
    // 少爺 2026-07-14「環境戳記標準化＋拼圖結合」：branch/map/buildConfig 分欄（不再塞 env 自由文字）；
    // knowledge=本輪依據拼圖清單（Claude 的理解來源外顯）、knowledgeUpdated=結案沉澱回寫（驗證後修正了哪些理解）
    branch: typeof body.branch === 'string' ? body.branch : '',
    map: typeof body.map === 'string' ? body.map : '',
    buildConfig: typeof body.buildConfig === 'string' ? body.buildConfig : '',
    knowledge: Array.isArray(body.knowledge) ? body.knowledge.map(k => String(k)) : [],
    knowledgeUpdated: [],
    boundSessionId: body.boundSessionId ?? null,  // M-6：綁定的 Claude 聊天室 session（會議室預約模式）
    boundProjectPath: body.boundProjectPath ?? null,  // M-6b：spawn 喚醒需要的 cwd
    project: typeof body.project === 'string' ? body.project : null,  // 跨專案：sommelier.json projects[].id；null=早期 run 前端視為 roman
    // M-6b 喚醒模式：spawn=server 主動 resume 該聊天室 / monitor=該 session 自掛監看（避免雙重喚醒）/ none
    wakeMode: ['spawn', 'monitor', 'none'].includes(body.wakeMode) ? body.wakeMode : (body.boundSessionId ? 'spawn' : 'none'),
    archivedAt: null,
    requirement: body.requirement ?? '',
    qapPath: body.qapPath ?? '',
    sessionDir: body.sessionDir ?? '',   // 絕對路徑；artifact 路由以此為根
    criteria: Array.isArray(body.criteria) ? body.criteria : [],
    items: (Array.isArray(body.items) ? body.items : []).map((it, i) => ({
      id: it.id ?? i + 1, text: it.text ?? '', criteriaRef: it.criteriaRef ?? null,
      scenario: it.scenario ?? '', status: 'pending', evidenceRefs: [], resultNote: '',
    })),
    status: 'announced',
    countdownSecs,
    countdownEndsAt: null,
    createdAt: Date.now(), updatedAt: Date.now(), startedAt: null, finishedAt: null,
    outcome: null,                        // finished 時：pass / fail / blocked；aborted 走 status
    anomalies: [],
    events: [], eventsTotal: 0,
    comments: [],
    controls: { pauseRequested: false, abortRequested: false },
  }
  if (countdownSecs === 0) { run.status = 'running'; run.startedAt = Date.now() }
  else if (countdownSecs > 0) { run.status = 'countdown'; run.countdownEndsAt = Date.now() + countdownSecs * 1000 }
  const data = readQaRuns()
  data.runs.push(run)
  writeQaRuns(data)
  if (run.status === 'countdown') qaArmCountdown(run)
  logEvent('qa.run.create', { id: run.id, topic: run.topic, status: run.status })
  qaBroadcast(run)
  return { ok: true, run }
})

// 歷史列表（新到舊；?limit=N 預設 50；封存的預設隱藏 ?includeArchived=1 全看）
// 封存＝介面層移除；run 資料與 sessionDir 內容層永久保留（三層鐵律）
app.get('/api/qa/runs', async (request) => {
  const limit = Number(request.query?.limit ?? 50)
  const includeArchived = request.query?.includeArchived === '1'
  const data = readQaRuns()
  const runs = [...data.runs]
    .filter(r => includeArchived || !r.archivedAt)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  return { ok: true, runs }
})

// 單一 run；?ackComments=1 = Claude 讀走未讀留言（標 seen）
app.get('/api/qa/runs/:id', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run) { reply.code(404); return { ok: false, error: 'not found' } }
  if (request.query?.ackComments === '1') {
    let dirty = false
    for (const c of run.comments) if (!c.seenByClaude) { c.seenByClaude = true; dirty = true }
    // Claude 接手訊號（少爺 2026-07-06：送出 feedback/結案要看到「正在由 Claude 處理」）
    if (run.claudeAck && run.claudeAck.state === 'pending') { run.claudeAck.state = 'working'; dirty = true }
    if (run.claudeAck) { run.claudeAck.workingAt = Date.now(); dirty = true }
    if (dirty) { writeQaRuns(data); qaBroadcast(run) }
  }
  return { ok: true, run }
})

// Claude 推進：狀態 / item 結果 / anomaly / 留言回覆 / pause-abort ack（項目邊界生效）
app.patch('/api/qa/runs/:id', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run) { reply.code(404); return { ok: false, error: 'not found' } }
  const body = request.body ?? {}
  if (typeof body.status === 'string') {
    run.status = body.status
    if (body.status === 'running' && !run.startedAt) run.startedAt = Date.now()
    if (body.status === 'finished' || body.status === 'aborted') run.finishedAt = Date.now()
  }
  if (typeof body.outcome === 'string') run.outcome = body.outcome
  if (typeof body.sessionDir === 'string') run.sessionDir = body.sessionDir
  if (typeof body.boundSessionId === 'string') run.boundSessionId = body.boundSessionId
  if (typeof body.boundProjectPath === 'string') run.boundProjectPath = body.boundProjectPath
  if (typeof body.project === 'string') run.project = body.project

  if (['spawn', 'monitor', 'none'].includes(body.wakeMode)) run.wakeMode = body.wakeMode
  if (body.item && typeof body.item.id !== 'undefined') {
    const it = run.items.find(x => x.id === body.item.id)
    if (it) Object.assign(it, body.item)
  }
  // 分支迴圈（少爺 2026-07-06）：不通過 → 同 run 追加驗證任務/準則（不另開 run）
  if (Array.isArray(body.addItems)) {
    for (const it of body.addItems) run.items.push({
      id: it.id ?? (run.items.length ? Math.max(...run.items.map(x => x.id)) + 1 : 1),
      text: it.text ?? '', criteriaRef: it.criteriaRef ?? null, scenario: it.scenario ?? '',
      status: 'pending', evidenceRefs: [], resultNote: '',
    })
  }
  if (Array.isArray(body.addCriteria)) for (const c of body.addCriteria) run.criteria.push(c)
  // 少爺 2026-07-14 環境戳記標準欄位：announce 舊路徑建的 run 可事後 PATCH 補填
  for (const _k of ['env', 'commit', 'branch', 'map', 'buildConfig'])
    if (typeof body[_k] === 'string') run[_k] = body[_k]
  // 少爺 2026-07-14 拼圖結合：knowledge=依據拼圖全量更新；knowledgeUpdated=結案沉澱逐筆追加（舊 run 無欄位先補）
  if (Array.isArray(body.knowledge)) run.knowledge = body.knowledge.map(k => String(k))
  if (Array.isArray(body.knowledgeUpdated)) {
    if (!Array.isArray(run.knowledgeUpdated)) run.knowledgeUpdated = []
    for (const u of body.knowledgeUpdated) run.knowledgeUpdated.push({ path: String(u?.path ?? ''), summary: String(u?.summary ?? ''), t: Date.now() })
  }
  // 回到待放行（分支重列任務完成 → ▶ 重新出現）時清掉處理中指示（換少爺審）
  if (body.status === 'announced') run.claudeAck = null
  if (body.anomaly) run.anomalies.push({ t: Date.now(), ...body.anomaly })
  if (body.commentReply && typeof body.commentReply.index === 'number') {
    const c = run.comments[body.commentReply.index]
    if (c) c.reply = String(body.commentReply.text ?? '')
  }
  if (body.ackPause) { run.controls.pauseRequested = false; run.status = 'paused' }
  if (body.ackAbort) { run.controls.abortRequested = false; run.status = 'aborted'; run.finishedAt = Date.now() }
  // 封存 / 還原（介面層移除；資料永久保留）
  if (body.archived === true) run.archivedAt = Date.now()
  if (body.archived === false) run.archivedAt = null
  // Claude 的任何 PATCH＝正在處理（少爺可視的接手/活動訊號）
  if (run.claudeAck) { if (run.claudeAck.state === 'pending') run.claudeAck.state = 'working'; run.claudeAck.workingAt = Date.now() }
  // 少爺引導語（2026-07-07：接手後換成告訴少爺當下該做什麼，如「請 PIE 後將 Feedback 填入留言」；空字串=清除）
  if (typeof body.guidance === 'string') run.guidance = body.guidance ? { text: body.guidance, t: Date.now() } : null
  run.updatedAt = Date.now()
  writeQaRuns(data)
  qaBroadcast(run)
  return { ok: true, run }
})

// Claude 批次事件（timeline 尾段上牆；完整 events.jsonl 在 sessionDir）
app.post('/api/qa/runs/:id/events', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run) { reply.code(404); return { ok: false, error: 'not found' } }
  const events = Array.isArray(request.body?.events) ? request.body.events : []
  run.events.push(...events)
  run.eventsTotal += events.length
  if (run.events.length > QA_EVENT_TAIL_MAX) run.events = run.events.slice(-QA_EVENT_TAIL_MAX)
  run.updatedAt = Date.now()
  writeQaRuns(data)
  qaBroadcast(run)
  return { ok: true, eventsTotal: run.eventsTotal }
})

// M-6b：少爺控制動作 → server 主動喚醒綁定的聊天室（wakeMode='spawn' 時）
// 走既有 /api/claude/run 機器：busy → 排隊；idle → spawnClaude resume 該 session
const QA_WAKE_ACTIONS = { 'start-now': '按了「▶ 立即開跑」→ 請進入階段二（埋 LOG + 雙編譯 + 重啟 Editor）', pause: '要求暫停', resume: '要求繼續', abort: '要求中止', comment: '留言', close: '按了「✔ 結案」→ 階段五（清 QAC LOG + 雙編譯 + 重啟 Editor；無頭啟動 Editor 用 Start-Process detached）＋維護侍酒師閉環：把本 run 需求「實作驗證後的收斂」沉澱回四種血肉（C++ code / 架構 canvas / 拼圖 memory；藍圖 md 暫跳過），Editor 開著時跑 extract_asset_graph.py 更新藍圖資產層，最後 POST /api/sommelier/refresh/roman 重萃取讓侍酒師吃到最新拼圖' }
function qaWakeBoundSession(run, action, text, attachPaths = [], model = null, effort = null, wakeVisible = false) {
  try {
    // monitor 模式＝該 session 自掛監看，不可 spawn（雙寫 transcript）；其餘一律喚醒
    if (run.wakeMode === 'monitor') return
    // 少爺 2026-07-14「QA 送出＝仕酒師同做法」：未綁定聊天室（或 wakeMode none）不再沉默——
    // 像「開新聊天室」spawn 新 session 接手，並在 init 拿到 session id 後自動綁回 run（自癒「沒綁定＝按鈕聾的」）
    const _unbound = !run.boundSessionId
    // 留言沒明選模型/強度 → 沿用該聊天室記住的偏好（少爺 2026-07-14）
    const _sessPrefs = getSessionPrefs(run.boundSessionId)
    const _model = model ?? _sessPrefs?.model ?? null
    const _effort = effort ?? _sessPrefs?.effort ?? null
    const detail = QA_WAKE_ACTIONS[action] ?? action
    let prompt = `(TC QA 聯動通知) 少爺在 QA Monitor 對 run「${run.topic}」(${run.id}) ${detail}${text ? `：「${text}」` : ''}。請照 Mode C 流程繼續（QA/README.md §Mode C）。`
    if (_unbound) prompt += `\n（本 run 原無綁定聊天室，你是新開接手的 session、已自動綁定為本 run 的處理聊天室。請先 GET http://127.0.0.1:3001/api/qa/runs/${run.id}?ackComments=1 讀完整 run 內容與留言再照 SOP 處理。）`
    for (const _p of (Array.isArray(attachPaths) ? attachPaths : [])) prompt += `\n${_p}`
    const projectPath = (run.boundProjectPath ?? 'C:/Project/RomanPrototype').replace(/\//g, path.sep)
    if (!isSafeCwd(projectPath)) { logEvent('qa.wake.error', { id: run.id, action, error: `unsafe cwd ${projectPath}` }); return }
    // 新開接手的 session 在 init 後綁回 run（之後的留言/結案就走正常 resume）
    const _onInit = _unbound ? (sid) => {
      const _data = readQaRuns()
      const _r = _data.runs.find(x => x.id === run.id)
      if (!_r) return
      _r.boundSessionId = sid
      _r.wakeMode = 'spawn'
      if (!_r.boundProjectPath) _r.boundProjectPath = normalizePath(projectPath)
      _r.updatedAt = Date.now()
      writeQaRuns(_data)
      qaBroadcast(_r)
      logEvent('qa.wake.autobind', { id: run.id, sessionId: sid })
    } : null
    // wakeMode 'cli'（少爺 2026-07-06）：開「可視的互動式 Claude CLI 視窗」resume 該聊天室 —
    // 同一顆 claude 執行檔，非 -p 無頭管線 → 少爺能直接看到處理過程（黑視窗問題的解）
    // 少爺 2026-07-14：留言可勾「開視窗」→ 本次喚醒改開可視互動 CLI（僅限已綁定且該專案沒有進行中的無頭進程——避免同 session 雙寫）
    const _busy = claudeProcs.get(projectPath)?.status === 'running'
    const _useCli = (run.wakeMode === 'cli' || wakeVisible === true) && run.boundSessionId && !_busy
    if (_useCli) {
      const _exe = getClaudeExe().replace(/'/g, "''")
      const _path = projectPath.replace(/'/g, "''")
      const _prompt = prompt.replace(/'/g, "''")
      const _modelArgs = _model ? `'--model','${String(_model).replace(/'/g, "''")}',` : ''
      const _effortArgs = _effort ? `'--effort','${String(_effort).replace(/'/g, "''")}',` : ''
      const _ps = `Start-Process -FilePath '${_exe}' -WorkingDirectory '${_path}' -ArgumentList ${_modelArgs}${_effortArgs}'--resume','${run.boundSessionId}','${_prompt}'`
      const p = spawn('powershell.exe', ['-NoProfile', '-Command', _ps], { detached: true, stdio: 'ignore' })
      p.unref()
      logEvent('qa.wake.cli', { id: run.id, action, sessionId: run.boundSessionId })
      return
    }
    const existing = claudeProcs.get(projectPath)
    if (existing?.status === 'running') {
      let q = claudeRunQueue.get(projectPath)
      if (!q) { q = []; claudeRunQueue.set(projectPath, q) }
      // 同 session 已有排隊中的喚醒 → 併入同一則（少爺 2026-07-15 修：喚醒堆積成 N 個回合、每回合重複回答）
      const _pending = q.find(x => x.sessionId === (run.boundSessionId ?? null))
      if (_pending) {
        _pending.prompt += `\n\n(追加喚醒) ${prompt}`
        logEvent('qa.wake.coalesced', { id: run.id, action, sessionId: run.boundSessionId ?? null })
      } else {
        q.push({ prompt, sessionId: run.boundSessionId ?? null, model: _model, effort: _effort, onInit: _onInit })
        logEvent('qa.wake.queued', { id: run.id, action, sessionId: run.boundSessionId ?? null })
      }
    } else {
      spawnClaude(projectPath, prompt, run.boundSessionId ?? null, _model, _effort, _onInit)
      logEvent('qa.wake.spawned', { id: run.id, action, sessionId: run.boundSessionId ?? null })
    }
  } catch (e) { logEvent('qa.wake.error', { id: run.id, action, error: String(e?.message ?? e) }) }
}

// 少爺控制：start-now / pause / resume / abort / comment / close
// pause / abort 對跑動中的 run 只立 flag，由 emitter 在「項目邊界」執行後 ack（狀態乾淨、不硬斷 PIE）
app.post('/api/qa/runs/:id/control', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run) { reply.code(404); return { ok: false, error: 'not found' } }
  const { action, text, itemId, attachments, model, effort, wakeVisible } = request.body ?? {}
  // 少爺 2026-07-14：QA 留言可指定喚醒子進程的 AI 模型＋強度（只在 comment 動作使用）
  const _wakeModel = (typeof model === 'string' && model.trim()) ? model.trim() : null
  const _wakeEffort = EFFORT_LEVELS.includes(effort) ? effort : null
  let _attachPaths = []   // comment 附檔存成 temp 檔的路徑，append 到喚醒 prompt 讓 Claude 讀
  if (action === 'start-now') {
    if (run.status === 'announced' || run.status === 'countdown') {
      qaClearCountdown(run.id)
      run.status = 'running'; run.startedAt = run.startedAt || Date.now(); run.countdownEndsAt = null
    }
  } else if (action === 'pause') {
    if (run.status === 'countdown' || run.status === 'announced') {
      qaClearCountdown(run.id)
      run.status = 'announced'; run.countdownEndsAt = null   // 凍結宣告態，等少爺再按開跑
    } else if (run.status === 'running') run.controls.pauseRequested = true
  } else if (action === 'resume') {
    if (run.status === 'paused') run.status = 'running'
    run.controls.pauseRequested = false
  } else if (action === 'abort') {
    if (run.status === 'announced' || run.status === 'countdown') {
      qaClearCountdown(run.id)
      run.status = 'aborted'; run.finishedAt = Date.now()
    } else run.controls.abortRequested = true
  } else if (action === 'comment') {
    _attachPaths = saveAttachmentFiles(attachments)
    const _attNames = (Array.isArray(attachments) ? attachments : []).map(a => a?.name).filter(Boolean)
    const _commentText = String(text ?? '') + (_attNames.length ? ` 📎 ${_attNames.join(', ')}` : '')
    run.comments.push({ t: Date.now(), itemId: itemId ?? null, text: _commentText, seenByClaude: false, reply: null })
  } else if (action === 'close') {
    // 少爺結案（第五階段觸發訊號）：已完成/已中止 → 結案；Claude 收到通知後清 QAC LOG + 雙編譯
    if (run.status === 'finished' || run.status === 'aborted') { run.status = 'closed'; run.closedAt = Date.now() }
    else { reply.code(400); return { ok: false, error: `cannot close run in status ${run.status}` } }
  } else { reply.code(400); return { ok: false, error: `unknown action ${action}` } }
  // 少爺動作 → 顯示「等待 Claude 接手」（Claude 第一次 API 觸碰時翻成 working — 見 PATCH/events/ackComments）
  run.claudeAck = { action, t: Date.now(), state: 'pending' }
  // 少爺推進了狀態 → 上一階段的引導語過期；留言＝Feedback 送達（2026-07-07 少爺：送出後要顯示新階段、不是還掛「請進 PIE」）
  if (action !== 'comment') run.guidance = null
  else run.guidance = { text: 'Feedback 已送出，等待 Claude 讀取分析…', t: Date.now() }
  run.updatedAt = Date.now()
  writeQaRuns(data)
  logEvent('qa.run.control', { id: run.id, action })
  qaBroadcast(run)
  qaWakeBoundSession(run, action, action === 'comment' ? String(text ?? '') : '', _attachPaths, action === 'comment' ? _wakeModel : null, action === 'comment' ? _wakeEffort : null, wakeVisible === true)
  return { ok: true, run }
})

// 白名單靜態檔（截圖 / log 切片）：只允許 run.sessionDir 內 + 副檔名白名單
app.get('/api/qa/runs/:id/artifact', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run || !run.sessionDir) { reply.code(404); return { ok: false, error: 'run or sessionDir not found' } }
  const rel = String(request.query?.path ?? '')
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) { reply.code(400); return { ok: false, error: 'bad path' } }
  const ext = path.extname(rel).toLowerCase()
  if (!QA_ARTIFACT_EXTS.includes(ext)) { reply.code(400); return { ok: false, error: `ext ${ext} not allowed` } }
  const root = path.resolve(run.sessionDir)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) { reply.code(400); return { ok: false, error: 'traversal forbidden' } }
  if (!fs.existsSync(abs)) { reply.code(404); return { ok: false, error: 'file not found' } }
  const mime = ext === '.png' ? 'image/png'
    : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
    : ext === '.json' ? 'application/json'
    : 'text/plain; charset=utf-8'
  reply.type(mime)
  return fs.readFileSync(abs)
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
