import Fastify from 'fastify'
import wsPlugin from '@fastify/websocket'
import multipart from '@fastify/multipart'
import * as OpenCC from 'opencc-js'
import fs from 'fs'
import path from 'path'
import { spawnSync, spawn } from 'child_process'
import net from 'net'
import os from 'os'
import crypto from 'crypto'
import { buildCatalog, getCatalog, priceFor, catalogFingerprint } from './modelCatalog.js'
import { claudeVersionFromPath, compareClaudeVersion } from './modelPushSource.js'
import { createLaneRegistry, createRefCountSet } from './claudeLanes.js'
import { commentIntendsClose, transitionCancelsArm, canArmInStatus } from './qaCloseArm.js'

const PORT = 3001
const CLAUDIA_URL = 'http://localhost:48901'

// 模型定價改由 modelCatalog 供應（少爺 2026-08-15「與時俱進」＋「要能自動更新」）——
// 原本三個硬編條目已停在 4.6 世代，Opus 5 / Sonnet 5 的花費全部用錯價回算。
// 目錄＝內建表 ∪ 官方模型表（Claude Code 內建 claude-api skill）∪ 掃 claude.exe 得到的 alias ∪ 手動覆寫。
// 開機與每日重建一次；另外每小時比一次指紋（claude.exe 檔案戳記＋skill 版本），
// 有換版就立刻重建——少爺升級 Claude Code 後最慢一小時內，新模型就會出現在下拉裡（2026-09-24）。
const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000
const MODEL_FINGERPRINT_MS = 60 * 60 * 1000
function priceOf(InModelId) { return priceFor(InModelId, getClaudeExe()) }

const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 }) // 50MB — supports large image base64 payloads
await app.register(wsPlugin)
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }) // 100 MB

// ─── Claude Binary Auto-detect ───────────────────────────────────────────────

function findClaudeExe() {
  // 1. Check VS Code extension (primary on Windows)
  const extDir = path.join(os.homedir(), '.vscode', 'extensions')
  if (fs.existsSync(extDir)) {
    // 版號要按數字比，不能按字串排——字串排會讓 2.1.99 贏過 2.1.300，升版後反而抓到舊二進位
    const dirs = fs.readdirSync(extDir).filter(d => d.startsWith('anthropic.claude-code'))
      .sort((a, b) => compareClaudeVersion(claudeVersionFromPath(a) ?? '0', claudeVersionFromPath(b) ?? '0') ?? a.localeCompare(b))
      .reverse()
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
const claudeLanes        = createLaneRegistry()   // 無頭聊天室執行道：一個聊天室一條道，跨聊天室並行（claudeLanes.js）
const subprocessSids     = new Set()   // session_ids spawned by us (filtered from sessions list)
const pendingSpawnCwds   = createRefCountSet()   // project paths currently spawning (pre-registers before init event)；同 cwd 可並行多個，計數歸零才移除
const monitorHeartbeats  = new Map()   // sessionId → last Watch-QAComments heartbeat ms（監看存活的 VERIFIED 證據）

// 監看存活 = 最後心跳在 MONITOR_ALIVE_MS 內（Watch-QAComments 輪詢 5s，20s 容 3 拍遺失不誤判死）
const MONITOR_ALIVE_MS = 20 * 1000
function isMonitorAlive(sessionId) {
  if (!sessionId) return false
  const _beat = monitorHeartbeats.get(sessionId)
  if (!_beat) return false
  const _ts = typeof _beat === 'object' ? _beat.ts : _beat
  if (Date.now() - (_ts ?? 0) >= MONITOR_ALIVE_MS) return false
  // ⭐ 心跳新鮮不等於監看還接得到聊天室（少爺 2026-08-21）：Claude session 收掉後 Watch-QAComments 會變孤兒、
  //    心跳照送 → 這裡誤判「原地聯動會處理」→ 結案喚醒整個沒送出去。監看端已補自我了結，
  //    server 這邊再驗一次回報的 PID 還在不在（雙保險：舊版監看還在跑時也擋得住）
  const _pid = typeof _beat === 'object' ? _beat.pid : null
  if (_pid) {
    try { process.kill(_pid, 0) } catch { monitorHeartbeats.delete(sessionId); return false }
  }
  return true
}

// ─── 本機 session 註冊表（Claude Code 官方維護，2.1.263+）───────────────────────
// ~/.claude/sessions/<pid>.json：{ sessionId, pid, cwd, kind:'interactive',
// entrypoint:'claude-vscode', messagingSocketPath, name, version }。
// 這是「這個 session 是不是少爺開著的活分頁」的 SSOT——比 sessions Map（靠 hook 註冊、
// 退場後條目仍在）準：PID 死了就是死了。用途：① 建 QA run 時自動判 wakeMode
// ② 決定要不要注入「補掛監看」指令 ③ messagingSocketPath 是後續直投管線的入口。
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
const LIVE_SESSIONS_TTL_MS = 2000
let _liveSessionsCache = { ts: 0, map: new Map() }
function readLiveSessions(InFresh = false) {
  if (!InFresh && Date.now() - _liveSessionsCache.ts < LIVE_SESSIONS_TTL_MS) return _liveSessionsCache.map
  const _map = new Map()
  try {
    for (const _f of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!_f.endsWith('.json')) continue
      try {
        const _o = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, _f), 'utf-8'))
        if (!_o?.sessionId || !_o?.pid) continue
        try { process.kill(_o.pid, 0) } catch { continue }   // 進程已死＝分頁關了
        _map.set(_o.sessionId, _o)
      } catch {}
    }
  } catch {}
  _liveSessionsCache = { ts: Date.now(), map: _map }
  return _map
}

/** 該 session 是不是「少爺開著的活互動分頁」——TC 自己 spawn 的無頭子進程不算 */
function isLiveInteractiveSession(sessionId) {
  if (!sessionId || subprocessSids.has(sessionId)) return false
  const _s = readLiveSessions().get(sessionId)
  return !!_s && _s.kind === 'interactive'
}

/** 原地聯動監看的掛載指令（給 Claude 端直接丟進 Monitor 工具，persistent=true） */
function monitorMountCommand(sessionId) {
  return `"${getPythonExe()}" -u C:/Project/MasterBrain/.agent/scripts/Watch-QAComments.py --session ${sessionId}`
}

// wakeMode 由 server 決定（少爺 2026-09-08）：活的 VS Code 分頁只有 monitor 能原地聯動，
// Claude 端填什麼都不算數——歷史退化的成因就是「指令範本硬寫 spawn」把聯動整條蓋掉
// （2026-07 之後 40 個 run 全是 spawn，少爺按鈕一律走無頭、分頁不動）。'none' 是唯一放行的明示值。
function decideWakeMode(sessionId, requested) {
  if (requested === 'none') return 'none'
  if (!sessionId) return 'none'
  if (isLiveInteractiveSession(sessionId)) {
    if (requested === 'spawn') logEvent('qa.wakemode.autocorrect', { sessionId, requested, applied: 'monitor' })
    return 'monitor'
  }
  return 'spawn'
}

// ─── Session Inbox：原地聯動的統一投遞口（少爺 2026-09-08「全部都要聯動」）──────
// 原本只有 QA run 一條線有原地聯動（監看輪詢 /api/qa/runs）；聊天室送訊息／侍酒師走
// /api/claude/run → spawnClaude 無頭，開著的 VS Code 分頁永遠不動。改成：監看活著時一律
// 投進 inbox，由該分頁的監看印出 → 分頁原地處理 → 回應寫進同一份 transcript，
// /api/session/watch 的 tail 照樣把畫面帶回 TC 聊天室面板。
const sessionInbox = new Map()   // sessionId → [{ id, ts, kind, text }]
const INBOX_MAX = 50
const INBOX_TTL_MS = 30 * 60 * 1000
const _autoMountInjectedAt = new Map()   // sessionId → 上次注入「補掛監看」的時間（節流）
const _ccmsgInjectedAt = new Map()       // sessionId → 上次注入「直投登記」的時間（節流）
const AUTO_MOUNT_THROTTLE_MS = 10 * 60 * 1000
function pushSessionInbox(sessionId, kind, text) {
  if (!sessionId) return null
  const _item = { id: `inb${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), kind, text: String(text ?? '') }
  const _cut = Date.now() - INBOX_TTL_MS
  const _list = (sessionInbox.get(sessionId) ?? []).filter(x => x.ts >= _cut)
  _list.push(_item)
  sessionInbox.set(sessionId, _list.slice(-INBOX_MAX))
  logEvent('tc.inbox.push', { sessionId, kind, len: _item.text.length })
  return _item
}

// ─── 做法 B：直投活分頁（Claude Code 官方跨工作階段收件管道）──────────────────────
// 少爺 2026-10-04「實測TC做法B」。官方文件 cross-session-messaging §The session's inbox socket：收件位址
// （Windows＝具名管道）＋第一行 auth（Windows 必帶）＋user 訊框。實測（2.1.286、VS Code、bypass 模式）：
// 分頁忙碌＝下一次工具結果後注入、閒置＝當場開新回合；錯權杖／沒授權行＝立即斷線、零送達。
// 權杖用分頁匯出的 CLAUDE_CODE_MESSAGING_TOKEN（官方「自己的子程序」驗證路徑，bypass 分頁不會被扣住）——
// 由 hook 以標頭帶來登記；只放記憶體與本機檔，絕不進事件紀錄、廣播或 API 回應。
// 規格與實測：memory project_spec_tc_companion.md、.agent/knowledge/bettercallgpt_解析.md §六。
const CCMSG_REGISTRY_FILE = path.join(os.homedir(), '.claude', 'tc_ccmsg_registry.json')
const CCMSG_CONNECT_TIMEOUT_MS = 5000
const CCMSG_RECEIPT_WAIT_MS = 3200
const ccmsgRegistry = new Map()   // sessionId → { socket, token, pid, ts }
try {
  for (const [_sid, _e] of Object.entries(JSON.parse(fs.readFileSync(CCMSG_REGISTRY_FILE, 'utf-8')))) {
    if (_e?.socket && _e?.token) ccmsgRegistry.set(_sid, _e)
  }
} catch {}
function persistCcmsgRegistry() {
  try { atomicWriteJson(CCMSG_REGISTRY_FILE, Object.fromEntries(ccmsgRegistry)) } catch {}
}

/** 登記直投：只收「本機註冊表上活著的互動分頁、且收件位址與註冊表一致」者 */
function ccmsgRegister(InSessionId, InSocket, InToken, InSource) {
  if (!InSessionId || !InSocket || !InToken) return false
  const _live = readLiveSessions(true).get(InSessionId)
  if (!_live || _live.kind !== 'interactive' || _live.messagingSocketPath !== InSocket) return false
  const _prev = ccmsgRegistry.get(InSessionId)
  if (_prev?.socket === InSocket && _prev?.token === InToken) { _prev.ts = Date.now(); return true }
  ccmsgRegistry.set(InSessionId, { socket: InSocket, token: InToken, pid: _live.pid, ts: Date.now() })
  persistCcmsgRegistry()
  logEvent('tc.ccmsg.register', { sessionId: InSessionId, source: InSource, pid: _live.pid })
  return true
}

/** hook 標頭帶來的登記（SessionStart／UserPromptSubmit／Stop 共用） */
function ccmsgRegisterFromHook(InSessionId, InRequest) {
  const _socket = InRequest?.headers?.['x-cc-msg-socket']
  const _token = InRequest?.headers?.['x-cc-msg-token']
  if (_socket && _token) ccmsgRegister(InSessionId, String(_socket), String(_token), 'hook')
}

/** 能不能直投：已登記＋分頁活著＋收件位址沒換（/clear、resume 換對話、PID 回收都會換位址） */
function ccmsgTarget(InSessionId) {
  const _e = InSessionId ? ccmsgRegistry.get(InSessionId) : null
  if (!_e) return null
  const _live = readLiveSessions().get(InSessionId)
  if (!_live || _live.messagingSocketPath !== _e.socket) return null
  return _e
}
function isDirectPipeEnabled() { return getTcSetting('delivery.directPipe', true) !== false }
function ccmsgAvailable(InSessionId) { return isDirectPipeEnabled() && !!ccmsgTarget(InSessionId) }

/** 投一則訊息，回報走到哪一步。寫出第一個位元組後永不重送（對方可能已照做——一句話跟按鍵一樣收不回） */
function ccmsgPost(InSessionId, InText, { priority = '', kind = 'tc' } = {}) {
  return new Promise((resolve) => {
    const _target = ccmsgTarget(InSessionId)
    const _tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const _report = { ok: false, sessionId: InSessionId, tag: _tag, state: 'not_sent', drained: false, error: '' }
    if (!_target) { _report.error = 'not_registered_or_stale'; resolve(_report); return }
    const _frame = { type: 'user', message: { role: 'user', content: `${InText}\n⟨tc#${_tag}⟩` }, session_id: InSessionId, from: 'TheClaudenental' }
    if (priority) _frame.priority = priority
    const _payload = `${JSON.stringify({ type: 'auth', token: _target.token })}\n${JSON.stringify(_frame)}\n`
    let _settled = false
    const _sock = net.connect({ path: _target.socket })
    const _finish = () => {
      if (_settled) return
      _settled = true
      clearTimeout(_timer)
      resolve(_report)
    }
    const _timer = setTimeout(() => {
      if (!_report.error) _report.error = 'timeout'
      try { _sock.destroy() } catch {}
      _finish()
    }, CCMSG_CONNECT_TIMEOUT_MS)
    _sock.on('connect', () => {
      _report.state = 'posting'
      _sock.write(_payload, (InErr) => {
        if (InErr) { _report.state = 'post_unknown'; _report.error = String(InErr.code ?? InErr.message); return }
        _report.state = 'posted'
        _report.ok = true
        _sock.end()
      })
    })
    _sock.on('data', () => {})
    _sock.on('error', (InErr) => {
      _report.error = String(InErr.code ?? InErr.message)
      if (_report.state === 'posting') _report.state = 'post_unknown'
    })
    _sock.on('close', () => {
      if (_report.state === 'posted') _report.drained = true
      _finish()
    })
  }).then((InReport) => {
    logEvent('tc.ccmsg.post', { sessionId: InSessionId, kind, tag: InReport.tag, state: InReport.state, drained: InReport.drained, error: InReport.error || null, len: String(InText ?? '').length })
    return InReport
  })
}

/** 收據階梯（實測 2.1.286）：enqueue＝收到；queued_command 附件或 user 字串＝已進模型（回合中注入／開新回合）；
 *  其後的 assistant＝處理中；end_turn＝回合結束。讀不到＝unknown，永不當成閒置 */
function ccmsgReceipt(InSessionId, InTag) {
  const _fp = InSessionId ? findJsonlPath(InSessionId) : null
  if (!_fp || !InTag) return { stage: 'unknown', at: null }
  let _text = ''
  try {
    const _size = fs.statSync(_fp).size
    const _len = Math.min(_size, 512 * 1024)
    const _fd = fs.openSync(_fp, 'r')
    const _buf = Buffer.alloc(_len)
    fs.readSync(_fd, _buf, 0, _len, _size - _len)
    fs.closeSync(_fd)
    _text = _buf.toString('utf8')
  } catch { return { stage: 'unknown', at: null } }
  const _needle = `⟨tc#${InTag}⟩`
  let _stage = 'none', _at = null, _consumed = false
  for (const _line of _text.split('\n')) {
    if (!_line) continue
    if (_line.includes(_needle)) {
      let _o
      try { _o = JSON.parse(_line) } catch { continue }
      if (_o.type === 'queue-operation' && _o.operation === 'enqueue' && _stage === 'none') { _stage = 'received'; _at = _o.timestamp }
      else if ((_o.type === 'attachment' && _o.attachment?.type === 'queued_command') || (_o.type === 'user' && typeof _o.message?.content === 'string')) {
        _stage = 'consumed'; _at = _o.timestamp; _consumed = true
      }
      continue
    }
    if (!_consumed || !_line.includes('"type":"assistant"')) continue
    if (_stage === 'consumed') _stage = 'processing'
    if (_line.includes('"stop_reason":"end_turn"')) _stage = 'done'
  }
  return { stage: _stage, at: _at }
}

/** 投遞＋等收據（最多約 3 秒）；沒收據也不重送，只回報讓呼叫端上牆 */
async function ccmsgPostVerified(InSessionId, InText, InOpts = {}) {
  const _report = await ccmsgPost(InSessionId, InText, InOpts)
  if (!_report.ok) return _report
  const _deadline = Date.now() + CCMSG_RECEIPT_WAIT_MS
  while (Date.now() < _deadline) {
    await new Promise(res => setTimeout(res, 400))
    const _rc = ccmsgReceipt(InSessionId, _report.tag)
    if (_rc.stage !== 'none' && _rc.stage !== 'unknown') { _report.receipt = _rc.stage; return _report }
  }
  _report.receipt = 'none'
  logEvent('tc.ccmsg.no_receipt', { sessionId: InSessionId, kind: InOpts.kind ?? 'tc', tag: _report.tag })
  return _report
}

// 登記表清掃：分頁關掉或位址換掉的條目移除（權杖不留在已失效的條目裡）
setInterval(() => {
  let _dirty = false
  const _live = readLiveSessions(true)
  for (const [_sid, _e] of ccmsgRegistry) {
    if (_live.get(_sid)?.messagingSocketPath === _e.socket) continue
    ccmsgRegistry.delete(_sid)
    _dirty = true
  }
  if (_dirty) persistCcmsgRegistry()
}, 10 * 60 * 1000)

// 解析真 python.exe 絕對路徑（少爺 2026-07-17：Monitor 非互動 shell 下裸 `python`＝WindowsApps store shim → exit 127；
// 注入指令與監看掛載都需絕對路徑）。boot 解析一次快取；py launcher 問不到才退回裸 python。
let _pythonExe = null
function getPythonExe() {
  if (_pythonExe) return _pythonExe
  try {
    const _r = spawnSync('py', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf-8' })
    const _p = String(_r.stdout ?? '').trim()
    _pythonExe = (_p && fs.existsSync(_p)) ? _p : 'python'
  } catch { _pythonExe = 'python' }
  return _pythonExe
}

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
    // 開機回濾：先前被「誤註冊」的 TC 子進程條目清掉；spawn 生命週期正式建的（origin:'tc'）保留
    if (sessions.has(_sid) && sessions.get(_sid)?.origin !== 'tc') sessions.delete(_sid)
  }
} catch {}

// 不明 Session 名稱回填（少爺 2026-07-15：側欄不該只顯示「Session」字樣）——
// 舊持久化資料裡命名從未解析的，開機後從 transcript 補（aiTitle→首句）；找不到紀錄的標明讓少爺好清。
// ⚠️ 延遲執行：getSessionTopic 依賴檔案後段才宣告的 CLAUDE_DIR（TDZ），不可在模組頂層直接呼叫
// 側欄退場門檻：超過此時間沒有真實活動的非活躍聊天室離開側欄（掃描器復活門檻同值，避免振盪）
const SESSION_RETIRE_MS = 20 * 60 * 1000

// 幽靈 session 清掃（少爺 2026-07-15：開機一次不夠——子代理/短命進程運行中隨時長出來 → 週期執行）
function sweepGhostSessions(deep = false) {
  try {
    let _changed = 0
    const _now = Date.now()
    for (const [_sid, _s] of [...sessions]) {
      // 全 projects 無 transcript ＝ 幽靈進程殘留（一句對話都沒寫）→ 直接移除，不留垃圾條目
      if (!findJsonlPath(_sid)) {
        // 剛啟動還沒寫第一句的合法 session 不誤殺：active/waiting 給 15 分鐘寬限
        const _age = _now - (_s.startedAt ?? 0)
        if ((_s.status === 'active' || _s.status === 'waiting') && _age < 15 * 60 * 1000) continue
        sessions.delete(_sid)
        broadcast({ type: 'session_remove', sessionId: _sid })
        _changed++
        continue
      }
      // 側欄自動退場（少爺 2026-07-15「用完的聊天室不該一直掛著」）：非 active/waiting/sleeping
      // 且超過 20 分鐘沒有任何 hook 活動 → 離開側欄（History 永遠查得到；回來用會自動重新出現）
      if (!['active', 'waiting', 'sleeping'].includes(_s.status)
          && _now - (_s.lastSeenAt ?? _s.startedAt ?? 0) > SESSION_RETIRE_MS) {
        sessions.delete(_sid)
        broadcast({ type: 'session_remove', sessionId: _sid })
        _changed++
        continue
      }
      // 名稱收斂到「最初首句」（＝HISTORY 同款 aiTitle→首句；名稱不可漂移成最新 prompt）。
      // deep=開機全量收斂；週期 sweep 只補 generic 名（大 transcript 全解析不便宜，不每 10 分鐘做）
      if (!deep && _s.displayName !== 'Session') continue
      const _initial = getSessionTopic(_sid)
      if (_initial && _s.displayName !== _initial.slice(0, 40)) {
        _s.topic = _initial
        _s.displayName = _initial.slice(0, 40)
        broadcast({ type: 'session', session: _s })
        _changed++
      }
    }
    // TC 出身聊天室回填（deep）：spawn 生命週期建檔機制上線前就存在的、或 cli 視窗喚醒（不經 claudeLanes）的，
    // 只要最近有真實對話就補進側欄（origin:'tc'、最初首句名）——少爺 2026-07-15「TC 出身一樣要顯示」
    if (deep) {
      for (const _sid of subprocessSids) {
        if (sessions.has(_sid)) continue
        const _fp = findJsonlPath(_sid)
        if (!_fp || _fp.includes('tc-companion')) continue   // 陪聊的常駐進程不是聊天室
        let _lastTs = 0
        try {
          const _lines = fs.readFileSync(_fp, 'utf-8').split('\n').filter(Boolean)
          for (let i = _lines.length - 1; i >= 0 && i >= _lines.length - 80; i--) {
            try {
              const _o = JSON.parse(_lines[i])
              if ((_o.type === 'user' || _o.type === 'assistant') && _o.timestamp) { _lastTs = Date.parse(_o.timestamp); break }
            } catch {}
          }
        } catch {}
        if (!_lastTs || _now - _lastTs > SESSION_RETIRE_MS) continue
        const _topic = getSessionTopic(_sid) ?? _sid.slice(0, 8)
        upsertSession(_sid, {
          origin: 'tc', status: _now - _lastTs < 3 * 60 * 1000 ? 'active' : 'done',
          topic: _topic, displayName: _topic.slice(0, 40), lastSeenAt: _lastTs,
        }, false)
        broadcast({ type: 'session', session: sessions.get(_sid) })
        _changed++
      }
    }
    if (_changed) schedulePersist()
  } catch {}
}
setTimeout(() => sweepGhostSessions(true), 3000)
setInterval(() => sweepGhostSessions(false), 3 * 60 * 1000)

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

function upsertSession(sessionId, patch = {}, touch = true) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      name: sessionId,
      displayName: 'Session',
      status: 'active',
      startedAt: Date.now(),
    })
    // 臨時診斷（少爺 2026-07-15 不明聊天室溯源）：記錄「誰建的檔」——抓到來源後移除
    try { logEvent('debug.session.created', { sid: sessionId, via: new Error().stack.split('\n').slice(2, 4).map(x => x.trim()).join(' <- ') }) } catch {}
  }
  const s = sessions.get(sessionId)
  Object.assign(s, patch)
  // 活動時間只由「真實 hook 活動」刷新（側欄自動退場用）；掃描器輪詢 upsert 傳 touch=false 不算活動
  if (touch) s.lastSeenAt = Date.now()
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
  logEvent('debug.sessionstart', e)  // 臨時診斷（少爺 2026-07-15 子代理辨識）：抓 payload 欄位，確認後移除
  forwardToClaudia(e, 'SessionStart')
  ccmsgRegisterFromHook(e?.session_id, request)
  // Ignore sessions spawned by our own subprocess — they appear in Chat, not Sessions list
  // Check both confirmed session_ids and pending spawns (by cwd) to handle race condition
  const cwdNorm = (e.cwd ?? '').replace(/\\/g, '/').toLowerCase()
  // TC 出身 sid：hook 只可更新既有條目、不可建檔（少爺 2026-07-15 拍板進側欄後的防污染守則）
  if ((subprocessSids.has(e.session_id) && !sessions.has(e.session_id)) || pendingSpawnCwds.has(cwdNorm)) return { ok: true }
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
  ccmsgRegisterFromHook(e?.session_id, request)
  if (subprocessSids.has(e.session_id) && !sessions.has(e.session_id)) return { ok: true }
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
  // 一顆 SessionEnd 就除名會讓另一顆還活著的事件被誤註冊成互動 session；有正式條目者放行更新
  if (subprocessSids.has(e.session_id) && !sessions.has(e.session_id)) return { ok: true }
  // 未知 session 的 SessionEnd 不建檔（少爺 2026-07-15：VS Code 重載時舊視窗齊發 SessionEnd，
  // setStatus 憑空建出一排無名條目）——沒追蹤過的 session 結束了也沒東西好更新
  if (!sessions.has(e.session_id)) return { ok: true }
  setStatus(e.session_id, 'done')
  emitLog(e.session_id, `[SessionEnd]`)
  return { ok: true }
})

// PreToolUse
app.post('/hook/PreToolUse', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'PreToolUse')
  if (subprocessSids.has(e.session_id) && !sessions.has(e.session_id)) return { ok: true }
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
  // TC 子進程（含 👁 cli 視窗喚醒）的權限詢問不走 TC 卡片（少爺 2026-07-15：此入口原本無過濾，
  // cli 視窗的 PermissionRequest 把 136dd7dd 憑空註冊成無名條目）——回 ok 讓它退回自己視窗內詢問
  if (subprocessSids.has(e.session_id)) return { ok: true }
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
// 同步 hook（少爺 2026-07-15「不要中斷心流」）：少爺在互動介面對「綁定 QA run 的聊天室」打字時，
// 若原地聯動的監看已斷，注入一次性指令讓該分頁自己重掛 Monitor＋轉 monitor 模式——VS Code 原地聯動全自動化。
// ⚠️ 2026-08-27 修：原本卡 `subprocessSids.has(_sid)` = 只認 TC spawn 出身的 session，
//    導致「少爺自己開的互動 VS Code session 綁 run」在 process 重啟、監看死掉後永遠不自動重掛（需手動）。
//    拿掉該 gate：改由下游守衛把關（無頭進程在跑 / 監看還活 / 無綁定 run 一律不注入），兩類 session 皆涵蓋。
// 這個端點只做注入判斷（session 註冊仍走既有非同步 /hook/UserPromptSubmit，不重複處理）
app.post('/hook/UserPromptSubmitSync', async (request, reply) => {
  const e = request.body ?? {}
  const _sid = e.session_id
  if (!_sid) return ''
  ccmsgRegisterFromHook(_sid, request)
  const _prompt = String(e.prompt ?? '')
  if (_prompt.startsWith('(TC')) return ''   // TC 自己的喚醒/通知 prompt 不注入
  // TC 自家無頭進程正在跑這個 session ＝ 這句不是少爺在互動介面打的
  if (claudeLanes.runningEntry(_sid)) return ''
  // 做法 B 直投登記（少爺 2026-10-04）：hook 標頭自動登記只在新開的分頁生效（hook 指令啟動時載入）；
  // 更早開著的分頁沒有標頭 → 注入一次「用 Bash 自行登記」（權杖只經環境變數傳給本機 TC，不回顯；節流 10 分鐘）
  const _ccmsgNote = () => {
    if (!isDirectPipeEnabled() || ccmsgTarget(_sid) || !isLiveInteractiveSession(_sid)) return ''
    if (Date.now() - (_ccmsgInjectedAt.get(_sid) ?? 0) < AUTO_MOUNT_THROTTLE_MS) return ''
    _ccmsgInjectedAt.set(_sid, Date.now())
    logEvent('tc.ccmsg.register_injected', { sid: _sid })
    return `(TC 直投登記) 這個分頁還沒登記 TC 直投（做法 B：TC 的訊息直接送進本分頁，不必靠監看）。` +
      `請在處理少爺訊息前用 Bash 工具執行一次（不要印出或回顯權杖值）：` +
      `curl -s -X POST -H "X-CC-Msg-Socket: $CLAUDE_CODE_MESSAGING_SOCKET" -H "X-CC-Msg-Token: $CLAUDE_CODE_MESSAGING_TOKEN" "http://127.0.0.1:3001/api/ccmsg/register?session=${_sid}"` +
      `，回應 "ok":true 即完成，接著照常處理少爺的訊息。`
  }
  const _asContext = (InText) => InText ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: InText } } : ''
  // 監看心跳還在＝已原地聯動、不重掛（避免每句注入）；心跳斷才注入（涵蓋兩種：spawn run 首掛 + monitor 死掉重掛）
  if (isMonitorAlive(_sid)) return _asContext(_ccmsgNote())
  // 少爺 2026-09-08「全部都要聯動」：原本要求「綁著未結案 QA run」才注入 → 沒開 run 的分頁永遠不會
  // 掛監看，TC 聊天室／侍酒師送進來的訊息就只能走無頭、分頁不動。改成活的互動分頁一律補掛（節流 10 分鐘）。
  if (!isLiveInteractiveSession(_sid)) return ''
  if (Date.now() - (_autoMountInjectedAt.get(_sid) ?? 0) < AUTO_MOUNT_THROTTLE_MS) return _asContext(_ccmsgNote())
  const _run = readQaRuns().runs.find(r =>
    r.boundSessionId === _sid && !r.archivedAt && !['closed', 'aborted'].includes(r.status))
  _autoMountInjectedAt.set(_sid, Date.now())
  logEvent('qa.monitor.autoconvert.injected', { sid: _sid, runId: _run?.id ?? null, wakeMode: _run?.wakeMode ?? null })
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `(TC 自動聯動設定) 本聊天室是少爺開著的 VS Code 分頁，但 TC 原地聯動的監看沒掛上（或已中斷）。` +
        `在掛上之前，少爺從 TC 聊天室／侍酒師送進來的訊息${_run ? `、以及 QA run「${_run.topic}」(${_run.id}) 的留言／▶／✔ 結案` : ''}都只會走無頭進程，這個分頁不會動。` +
        `請在處理少爺訊息前先用 Monitor 工具掛上（persistent=true）：command='${monitorMountCommand(_sid)}'` +
        (_run && _run.wakeMode !== 'monitor' ? `，掛好後 PATCH http://127.0.0.1:3001/api/qa/runs/${_run.id} body {"wakeMode":"monitor"}` : '') +
        `。完成後照常處理少爺的訊息，並簡短告知已完成聯動設定。` +
        (() => { const _n = _ccmsgNote(); return _n ? `\n${_n}` : '' })(),
    },
  }
})

// Watch-QAComments 監看心跳（少爺 2026-07-17：monitor 是否活著改成 VERIFIED 事實而非猜測）——
// 每輪 POST 一次；UserPromptSubmitSync 靠這判斷要不要重掛、qaWake 靠這決定監看死了就秒退無頭
app.post('/hook/monitor-heartbeat', async (request) => {
  const _sid = request.body?.session
  const _pid = Number(request.body?.pid) || null
  if (_sid) monitorHeartbeats.set(_sid, { ts: Date.now(), pid: _pid })
  return { ok: true }
})

// 監看存活狀態（少爺 2026-07-17：讓「原地聯動有沒有掛上」變成可觀察）——驗證用 + QA 面板顯示
app.get('/api/qa/monitor-status', async (request) => {
  const _sid = request.query?.session
  const _raw = _sid ? (monitorHeartbeats.get(_sid) ?? null) : null
  const _beat = _raw ? (typeof _raw === 'object' ? _raw.ts : _raw) : null
  const _pid = _raw && typeof _raw === 'object' ? _raw.pid : null
  return { session: _sid ?? null, alive: isMonitorAlive(_sid), lastBeatMs: _beat, pid: _pid, ageMs: _beat ? (Date.now() - _beat) : null }
})

// 原地聯動投遞口：監看每輪拉一次（?since=<ts> 只取新的）——聊天室訊息等非 QA 事件走這條
app.get('/api/session-inbox', async (request) => {
  const _sid = request.query?.session
  const _since = Number(request.query?.since ?? 0) || 0
  const _items = (_sid ? (sessionInbox.get(_sid) ?? []) : []).filter(x => x.ts > _since)
  return { ok: true, session: _sid ?? null, items: _items, now: Date.now() }
})

// 做法 B 直投 API（少爺 2026-10-04）。權杖只從標頭進來、永不出現在任何回應。
// 登記：分頁自己在 Bash 執行（子程序才有匯出的權杖）：
//   curl -s -X POST -H "X-CC-Msg-Socket: $CLAUDE_CODE_MESSAGING_SOCKET" -H "X-CC-Msg-Token: $CLAUDE_CODE_MESSAGING_TOKEN" "http://127.0.0.1:3001/api/ccmsg/register?session=<sid>"
app.post('/api/ccmsg/register', async (request) => {
  const _sid = request.query?.session ?? request.body?.session ?? null
  const _ok = ccmsgRegister(_sid, request.headers['x-cc-msg-socket'], request.headers['x-cc-msg-token'], 'manual')
  return { ok: _ok, session: _sid, ...(_ok ? {} : { error: '分頁不在本機註冊表、不是互動分頁，或收件位址不符' }) }
})
app.get('/api/ccmsg/status', async (request) => {
  const _sid = request.query?.session ?? null
  const _e = _sid ? ccmsgRegistry.get(_sid) : null
  return { ok: true, session: _sid, enabled: isDirectPipeEnabled(), registered: !!_e, live: !!ccmsgTarget(_sid), registeredAt: _e?.ts ?? null }
})
// 送一則（delayMs>0＝排程送，用來驗「分頁閒置時開新回合」）；priority 只收 now/next/later（官方未記載，預設不帶）
app.post('/api/ccmsg/send', async (request) => {
  const { session, text, priority, delayMs } = request.body ?? {}
  if (!session || !text) return { ok: false, error: 'missing session/text' }
  const _priority = ['now', 'next', 'later'].includes(priority) ? priority : ''
  const _delay = Math.min(Math.max(Number(delayMs) || 0, 0), 10 * 60 * 1000)
  if (_delay > 0) {
    setTimeout(() => { ccmsgPostVerified(session, String(text), { priority: _priority, kind: 'send-delayed' }).catch(() => {}) }, _delay)
    return { ok: true, scheduled: true, delayMs: _delay }
  }
  return await ccmsgPostVerified(session, String(text), { priority: _priority, kind: 'send' })
})
app.get('/api/ccmsg/receipt', async (request) => ({ ok: true, ...ccmsgReceipt(request.query?.session, request.query?.tag) }))

app.post('/hook/UserPromptSubmit', async (request) => {
  const e = request.body
  forwardToClaudia(e, 'UserPromptSubmit')
  ccmsgRegisterFromHook(e?.session_id, request)
  if (subprocessSids.has(e.session_id) && !sessions.has(e.session_id)) return { ok: true }
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
    // TC 自己投進分頁的訊息（做法 B 直投帶 ⟨tc#…⟩ 標記、喚醒通知以「(TC」開頭）不是少爺的需求，不自動建卡
    if (clean && !clean.startsWith('(TC') && !/⟨tc#[0-9a-z]+⟩/.test(raw)) {
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

// ─── 🔁 重新登入聯動（少爺 2026-09-16「讓以後 TC 觸發的聊天室都具備，提供我可以重新登入聯動聊天室的功能」）──
// TC 自己 spawn 的聊天室是無頭出身，永遠做不到原地聯動。這裡把它「重新登入」成活的互動 session：
// 在終端開一個可視視窗跑 claude --resume <sid>，起手 prompt 叫它立刻掛起監看。
// 實測 2026-09-16：終端啟動的 resume 會登進 ~/.claude/sessions/<pid>.json（kind:'interactive', entrypoint:'cli'）
// → isLiveInteractiveSession 成立 → wakeMode 判 monitor、/api/claude/run 投 inbox、UserPromptSubmitSync 會補掛。
// ⚠️ 子進程環境必須清掉 CLAUDE* 變數（巢狀守衛會讓 claude 立刻退出，實測零進程零註冊）。
// ⚠️ 參數逐項傳給 cmd start，不可自組含引號的字串（Node 會把內層引號轉義成 \"，start 解析不了，實測視窗根本沒開）。
function reloginTitleOf(sessionId) {
  return `TC 聯動 ${String(sessions.get(sessionId)?.displayName ?? sessionId.slice(0, 8)).replace(/["\r\n]/g, '')}`
}
app.post('/api/session/relogin', async (request, reply) => {
  const { sessionId, projectPath } = request.body ?? {}
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId ?? ''))) { reply.code(400); return { ok: false, error: 'sessionId 格式不對' } }
  if (isLiveInteractiveSession(sessionId)) {
    const _s = readLiveSessions().get(sessionId)
    return { ok: false, alreadyLive: true, error: `這個聊天室已經是活的互動分頁（${_s?.entrypoint === 'cli' ? '終端' : 'VS Code'}，pid ${_s?.pid}）——直接在那裡輸入即可；監看沒掛的話它會自動補掛` }
  }
  if (claudeLanes.isSessionBusy(sessionId)) return { ok: false, error: '這個聊天室正有 TC 的無頭進程在跑，等它結束再重新登入（否則雙寫 transcript）' }
  const _cwd = path.normalize(String(projectPath || sessions.get(sessionId)?.cwd || 'C:\\Project\\RomanPrototype'))
  if (!fs.existsSync(_cwd)) { reply.code(400); return { ok: false, error: `專案路徑不存在：${_cwd}` } }
  const _exe = getClaudeExe()
  // python 路徑一律正斜線：Monitor 走 Git Bash，反斜線會被吃掉 → exit 127（2026-09-16 首測實錄，該 session 自己改正斜線才掛成）
  const _mount = `${getPythonExe().replace(/\\/g, '/')} -u C:/Project/MasterBrain/.agent/scripts/Watch-QAComments.py --session ${sessionId}`
  // 起手 prompt 只用 ASCII（避開 cmd start 的引號與編碼問題）；內容＝立刻掛監看、驗 alive、回一行後等指令
  const _prompt = `(TC relogin link) This chat was re-opened from TheClaudenental to restore in-place linkage. Step 1: call the Monitor tool with persistent=true and this exact command: ${_mount}. Step 2: GET http://127.0.0.1:3001/api/qa/monitor-status?session=${sessionId} and confirm alive is true. Reply with one short line in Traditional Chinese, then wait for further instructions.`
  const _env = { ...process.env }
  for (const k of Object.keys(_env)) if (/^CLAUDE/i.test(k)) delete _env[k]
  try {
    const _p = spawn('cmd.exe', ['/c', 'start', reloginTitleOf(sessionId), '/D', _cwd, _exe, '--resume', sessionId, _prompt],
      { detached: true, stdio: 'ignore', windowsHide: true, env: _env })
    _p.unref()
  } catch (e) { reply.code(500); return { ok: false, error: String(e) } }
  logEvent('session.relogin', { sessionId, cwd: _cwd })
  broadcast({ type: 'session_relogin', sessionId, cwd: _cwd })
  return { ok: true, sessionId, cwd: _cwd, hint: '已開啟終端視窗續接該聊天室；它會自動掛起監看，約 10 秒後 🔗 聯動會變成 ·通' }
})

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
    const p = priceOf(model)
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

// ── 聊天室重點 hashtag（少爺 2026-07-16）──────────────────────────────────────
// History 總覽每列右側的簡介 tag。依據=少爺留言（user messages）、同室去重。
// 混合法：(1) CJK n-gram＋英數 token 頻次抽主題詞——跨留言重複的詞優先浮上來
// （如「野蠻人」「噴飛」「陣型」）；(2) 主題詞不足 3 個時用留言首行摘要補位。
const TAG_MAX = 5
const TAG_DIGEST_LEN = 16
// n-gram 頭尾若是虛詞即丟棄（避免「陣型的」「要野蠻人」這類殘缺詞）
const TAG_STOP_EDGE = '我你他它這那的了嗎呢吧啊也都很就還要能會用有沒是不在把讓被跟與和或到去做再先請幫個們著過只但因為所以如果然後'
// 高頻但無資訊量的完整詞
const TAG_STOPWORDS = new Set(['可以', '需要', '這個', '那個', '我們', '你們', '目前', '現在', '然後', '因為', '所以', '如果', '但是', '還是', '就是', '已經', '應該', '什麼', '怎麼', '沒有', '一下', '一個', '時候', '地方', '不要', '不是', '有沒有', '為什麼', '使用', '確認', '檢查', '繼續', '實際', '幫我', '開始', '這樣', '這些', '那些', '其他', '部分', '內容', '一樣', '專案', '知道'])
const TAG_STOPWORDS_EN = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'have', 'from', 'not', 'are', 'was', 'can', 'use', 'using', 'all', 'you', 'your', 'project', 'game', 'http', 'https', 'www', 'com', 'code', 'claude', 'run', 'say', 'reply', 'exactly', 'new', 'please', 'will', 'what', 'when', 'how', 'why', 'there', 'here', 'task', 'message', 'messages', 'system', 'user', 'instructions', 'unchanged', 'already', 'loaded', 'session'])
// 系統注入文的識別標記（出現即整則跳過——不是少爺親手打的內容）
const TAG_SYSTEM_MARKERS = ['<system-reminder', 'task-notification', 'tool_use_error', 'UserPromptSubmit hook', '每輪鐵律', 'This session is being continued', '[Request interrupted']

// ── 拼圖詞彙表（少爺 2026-07-16「HashTag 與拼圖聯動」）──────────────────────
// SSOT = task_kickoff_check SKILL 的「關鍵字→拼圖對映表」（表格第一欄，/ 分隔）。
// 命中詞彙表的候選詞大幅加權且允許單次出現——tag 因此天然對齊拼圖語彙，
// 未來可反向從 tag 對回 §A/§B 表的必讀拼圖文件。
const TAG_LEXICON_SOURCES = [
  'C:/Project/RomanPrototype/.agent/skills/task_kickoff_check/SKILL.md',
]
let tagLexiconCache = null   // { key, terms:Set(原樣), lower:Set(小寫), docsMap:Map(小寫詞→拼圖文件[]) }
function getTagLexicon() {
  let _key = ''
  for (const p of TAG_LEXICON_SOURCES) { try { _key += fs.statSync(p).mtimeMs + '|' } catch { _key += 'x|' } }
  if (tagLexiconCache && tagLexiconCache.key === _key) return tagLexiconCache
  const _terms = new Set(), _lower = new Set(), _docsMap = new Map()
  for (const p of TAG_LEXICON_SOURCES) {
    try {
      for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
        if (!line.startsWith('|')) continue
        const _cells = line.split('|')
        const _firstCell = _cells[1] ?? ''
        // 第二欄=該關鍵字群的必讀拼圖文件（.md/.canvas）→ tag 反查拼圖的橋
        const _docs = [...(_cells[2] ?? '').matchAll(/[\w./\\-]+\.(?:md|canvas)/g)].map(m => m[0]).slice(0, 6)
        for (const raw of _firstCell.split('/')) {
          const _t = raw.replace(/\*\*/g, '').trim()
          if (_t.length < 2 || _t.length > 20 || _t.startsWith('---')) continue
          _terms.add(_t); _lower.add(_t.toLowerCase())
          if (_docs.length && !_docsMap.has(_t.toLowerCase())) _docsMap.set(_t.toLowerCase(), _docs)
        }
      }
    } catch {}
  }
  tagLexiconCache = { key: _key, terms: _terms, lower: _lower, docsMap: _docsMap }
  return tagLexiconCache
}

/** LLM tag 的 knowledge 詞 → 對映拼圖文件（詞彙表 §A/§B 第二欄） */
function resolveKnowledgeDocs(terms) {
  const _lex = getTagLexicon()
  return (terms ?? []).map(t => ({ term: t, docs: _lex.docsMap.get(String(t).toLowerCase()) ?? [] }))
}

/** 濾出「少爺親手打的留言」：系統注入文 / 喚醒探針 / skill 展開文全排除 */
function filterUserTexts(userTexts) {
  return userTexts
    .map(t => (t ?? '').trim())
    .filter(t => t && !t.startsWith('(') && !t.startsWith('Base directory for this skill') && !t.startsWith('Caveat:')
      && !TAG_SYSTEM_MARKERS.some(mk => t.includes(mk)))
}

function extractSessionTags(userTexts) {
  const _texts = filterUserTexts(userTexts)
    .slice(0, 100)
    .map(t => t.slice(0, 300))
  if (!_texts.length) return []

  // 候選詞頻統計：term → { count 總次數, msgs 出現於幾則留言 }
  const _freq = new Map()
  const _bump = (term, mi) => {
    let _e = _freq.get(term)
    if (!_e) { _e = { count: 0, msgs: new Set() }; _freq.set(term, _e) }
    _e.count++; _e.msgs.add(mi)
  }
  _texts.forEach((t, mi) => {
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_+-]*/g)) {
      const _w = m[0]
      if (_w.length < 3 || _w.length > 24) continue   // 整詞比對，不做中途截斷
      if (!TAG_STOPWORDS_EN.has(_w.toLowerCase())) _bump(_w, mi)
    }
    for (const run of t.matchAll(/[一-鿿]{2,}/g)) {
      const _s = run[0]
      for (let n = 2; n <= Math.min(6, _s.length); n++)
        for (let i = 0; i + n <= _s.length; i++) _bump(_s.slice(i, i + n), mi)
    }
  })

  // 過濾＋計分：頻次>=2（拼圖詞彙允許單次）；分數=次數×(長度+2)＋跨留言則數加權；
  // 命中拼圖詞彙表 ×3＋40 — 拼圖語彙優先浮上來（少爺 2026-07-16）
  const _lex = getTagLexicon()
  const _cands = []
  for (const [term, e] of _freq) {
    const _inLexicon = _lex.terms.has(term) || _lex.lower.has(term.toLowerCase())
    if (e.count < 2 && !_inLexicon) continue
    if (TAG_STOPWORDS.has(term)) continue
    if (/^[一-鿿]/.test(term) && (TAG_STOP_EDGE.includes(term[0]) || TAG_STOP_EDGE.includes(term[term.length - 1]))) continue
    let _score = e.count * (term.length + 2) + e.msgs.size * 3
    if (_inLexicon) _score = _score * 3 + 40
    _cands.push({ term, score: _score })
  }
  _cands.sort((a, b) => b.score - a.score)

  // 兩個 CJK 詞共享 3 字以上滑窗即視為重疊（「目前的互動方」vs「前的互動方式」）
  const _cjkOverlap = (a, b) => {
    if (!/^[一-鿿]/.test(a) || !/^[一-鿿]/.test(b) || a.length < 3 || b.length < 3) return false
    for (let i = 0; i + 3 <= a.length; i++) if (b.includes(a.slice(i, i + 3))) return true
    return false
  }
  // 貪婪挑選：互為子字串（比對不分大小寫）或 CJK 滑窗重疊的候選只留分數最高者
  const _tags = []
  const _dup = (t, term) => {
    const _a = t.toLowerCase(), _b = term.toLowerCase()
    return _a.includes(_b) || _b.includes(_a) || _cjkOverlap(term, t)
  }
  for (const c of _cands) {
    if (_tags.length >= TAG_MAX) break
    if (_tags.some(t => _dup(t, c.term))) continue
    _tags.push(c.term)
  }

  // 補位：主題詞太少時用留言首行摘要（與既有 tag 半重疊的不收，重複留言只出現一次）
  if (_tags.length < 3) {
    const _seen = new Set()
    for (const t of _texts) {
      if (_tags.length >= TAG_MAX) break
      // 首行在第一個標點斷句（「更新話題筆記，從上次…」→「更新話題筆記」）
      const _d = t.split('\n')[0].replace(/^[>›\s]+/, '').split(/[，。？！；、,.:;?!]/)[0].slice(0, TAG_DIGEST_LEN)
      const _k = _d.replace(/\s+/g, '')
      if (!_k || _seen.has(_k)) continue
      if (_tags.some(x => _dup(x, _d))) { _seen.add(_k); continue }
      _seen.add(_k); _tags.push(_d)
    }
  }
  return _tags
}

// ── LLM 語意 tag 管線（少爺 2026-07-16 Phase 2：LLM 產 tag＋寫回 jsonl 快取）────
// 產物不只 hashtag：tags＋summary＋knowledge（拼圖詞彙命中→對映拼圖文件）。
// 快取寫回該 session 的 transcript jsonl（type:'ai-tags' 行，比照 ai-title 前例）——
// 任何工具（含未來 session 的 Claude 讀 transcript）都拿得到這份語意快取＝跨工具同步。
const TAG_LLM_MODEL = 'claude-haiku-4-5-20251001'   // 標籤任務用便宜快的模型
// 少爺 2026-07-16：「我是使用繁體中文的，務必注意」——雙保險：prompt 強制繁體 + OpenCC 簡轉繁（台灣用語）
// ver 不符的舊快取自動重標（v2 = 繁體強制版）
const TAG_PIPELINE_VER = 2
const s2tw = OpenCC.Converter({ from: 'cn', to: 'twp' })
function twNormalizeTags(p) {
  if (!p) return p
  try {
    return {
      ...p,
      tags: (p.tags ?? []).map(t => s2tw(String(t))),
      summary: p.summary ? s2tw(String(p.summary)) : p.summary,
      knowledge: (p.knowledge ?? []).map(t => s2tw(String(t))),
    }
  } catch { return p }
}
// 少爺 2026-07-16 定案：標籤器改「每晚 23:30 定時批次增量」——不再追活 session、不在開 History 即時觸發。
// 只處理「有新對話」的室（cleanCount > 上次標記時 userCount）、增量室只看新留言、併批 spawn 攤提系統開銷。
const TAGGER_CWD = path.join(os.tmpdir(), 'tc-tagger')
// 每日行程預設時刻（TC 總設定 marker.defaultDailyTime；未設＝23:30，與話題筆記、知識訂閱對齊）
const MARKER_DEFAULT_DAILY_TIME = '23:30'
function parseHHMM(InText) {
  const _m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(InText ?? '').trim())
  return _m ? [Number(_m[1]), Number(_m[2])] : null
}
function formatHHMM(InH, InM) { return `${String(InH).padStart(2, '0')}:${String(InM).padStart(2, '0')}` }
// 每日行程顯示字：晚上時段（18:00–04:59）＝「每晚」，其餘＝「每天」；一律 24 小時制
function dailyLabel(InH, InM) { return `${(InH >= 18 || InH < 5) ? '每晚' : '每天'} ${formatHHMM(InH, InM)}` }
function getMarkerDefaultDailyTime() { return parseHHMM(getTcSetting('marker.defaultDailyTime', MARKER_DEFAULT_DAILY_TIME)) ? getTcSetting('marker.defaultDailyTime', MARKER_DEFAULT_DAILY_TIME) : MARKER_DEFAULT_DAILY_TIME }
// 夜間標籤時刻：個別覆寫 marker.time.nightly-tagging → 每日行程預設時刻
function getNightlyHM() { return parseHHMM(getTcSetting('marker.time.nightly-tagging', null)) ?? parseHHMM(getMarkerDefaultDailyTime()) }
const TAG_BATCH_SIZE = 5                            // 每批 spawn 處理的室數（攤提 ~15-20k 系統 prompt 開銷）
const TAG_NIGHTLY_STATE_FILE = path.join(os.homedir(), '.claude', 'tc_tag_nightly.json')
const llmTagCache = new Map()   // sessionId → { tags, summary, knowledge, userCount, ts }
const tagQueue = []             // array of batch：{ items: [{ sessionId, mode, prevTags, prevSummary, texts, cleanCount }] }
const tagQueuedSids = new Set()
let tagWorkerBusy = false

/** 單室排隊（手動即時重標用）——包成單室 batch 走同一條 worker */
function enqueueLlmTagging(sessionId, cleanTexts, cleanCount = null) {
  enqueueTagBatch([{ sessionId, mode: 'full', texts: cleanTexts, cleanCount: cleanCount ?? (cleanTexts?.length ?? 0) }])
}

/** 批次排隊：過濾掉已在排隊中的室，其餘併成一個 batch job */
function enqueueTagBatch(items) {
  const _fresh = (items ?? []).filter(it => it.sessionId && !tagQueuedSids.has(it.sessionId) && it.texts?.length)
  if (!_fresh.length) return
  for (const it of _fresh) tagQueuedSids.add(it.sessionId)
  tagQueue.push({ items: _fresh })
  setImmediate(runTagWorker)
}

// ── 少爺 tag 校正（2026-07-16「編輯/新增/移除，校正你的 LLM 認知」）────────────
// 校正落成兩處：(1) ai-tags 行帶 manual/pinned/banned——重標時 pinned 必留、banned 必濾，
// LLM 永遠蓋不掉少爺的話；(2) 校正流水帳 tc_tag_corrections.jsonl——少爺新增過的詞
// 會注入之後所有標籤 prompt 的「少爺自訂詞」段（全域學習），dream pass 時同步回拼圖詞彙表。
const TAG_CORRECTIONS_FILE = path.join(os.homedir(), '.claude', 'tc_tag_corrections.jsonl')

function logTagCorrection(sessionId, op, value) {
  try { fs.appendFileSync(TAG_CORRECTIONS_FILE, JSON.stringify({ ts: Date.now(), sessionId, op, value }) + '\n', 'utf8') } catch {}
}

/** 少爺歷來新增過的自訂詞（跨聊天室全域，注入 prompt 詞彙表） */
function getCustomTagTerms() {
  try {
    const _terms = new Set()
    for (const l of fs.readFileSync(TAG_CORRECTIONS_FILE, 'utf8').split('\n')) {
      try { const o = JSON.parse(l); if (o.op === 'add' && o.value) _terms.add(String(o.value)) } catch {}
    }
    return [..._terms].slice(-40)
  } catch { return [] }
}

/** 批次標籤 prompt：一次帶多室；增量室（mode='incremental'）附既有標籤、只列新留言 */
function buildBatchTagPrompt(items) {
  const _custom = getCustomTagTerms()
  const _customLine = _custom.length ? `\n少爺自訂詞（曾手動加過的標籤，符合主題時優先採用）：${_custom.join('、')}` : ''
  const _terms = [...getTagLexicon().terms].slice(0, 260).join('、') + _customLine
  const _blocks = items.map((it, i) => {
    const _prev = (it.mode === 'incremental' && it.prevTags?.length)
      ? `既有標籤：${it.prevTags.join('、')}｜既有摘要：${it.prevSummary ?? ''}\n（下方只列本室的「新增留言」。請輸出「更新後的完整標籤集」：保留既有標籤中仍能代表本室的、再加上新留言帶出的新主題，合計取最具代表性的 3~6 個〔別丟掉既有的重要主題〕；summary 也更新成涵蓋新舊主題的一句話。）`
      : ''
    const _msgs = (it.texts ?? []).slice(0, 40).map((t, j) => `${j + 1}. ${t.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    return `── 聊天室 ${i + 1} ──\n${_prev}\n留言：\n${_msgs}`
  }).join('\n\n')
  return `你是聊天室主題標籤器。下面有 ${items.length} 個遊戲開發聊天室，各附使用者留言（時間序）。為「每一室」產生標籤。不要使用任何工具，只輸出純 JSON 陣列（第 i 個元素對應「聊天室 i」、順序絕不可變、室數必須與下方一致）、不要其他文字：
[{"tags":["3~6個主題標籤"],"summary":"這室在做什麼（繁體中文一句話，50字內）","knowledge":["tags 相關且出現在詞彙表中的詞"]}, ...]
規則：**全部輸出一律使用繁體中文（台灣用語），嚴禁出現任何簡體字**；tags 用繁體中文或原文技術詞；優先採用詞彙表的詞；聊天室特有的具體主題（例如「野蠻人噴飛BUG」「陣型衝撞」）要保留具體性；不要放「專案」「功能」這種空泛詞。
詞彙表：${_terms}

${_blocks}`
}

/** 從 LLM 回應抽出批次結果陣列（缺項回 null；單室可退回單物件） */
function parseTagBatchResult(text, n) {
  try {
    const _m = text.match(/\[[\s\S]*\]/)
    if (_m) {
      const _arr = JSON.parse(_m[0])
      if (Array.isArray(_arr)) return _arr
    }
    if (n === 1) {
      const _o = text.match(/\{[\s\S]*\}/)
      if (_o) return [JSON.parse(_o[0])]
    }
  } catch {}
  return []
}

/** 單室標籤結果寫回：增量融合舊 tag（保底）+ 套 pinned/banned 校正 + ai-tags 行 + in-memory 快取 */
function writeTagResult(sessionId, raw, cleanCount, prevTagsForMerge = null) {
  if (!raw) return
  let _tags = (Array.isArray(raw.tags) ? raw.tags : []).map(t => String(t).slice(0, 24)).filter(Boolean).slice(0, 6)
  // 增量融合保底：LLM 應已在 prompt 指示下保留舊主題，這裡再兜底一次防它只回新 tag（上限放寬到 8）
  if (prevTagsForMerge?.length) _tags = [...new Set([..._tags, ...prevTagsForMerge.map(t => String(t).slice(0, 24))])].slice(0, 8)
  const payload = twNormalizeTags({
    tags: _tags,
    summary: String(raw.summary ?? '').slice(0, 80),
    knowledge: (Array.isArray(raw.knowledge) ? raw.knowledge : []).map(t => String(t).slice(0, 24)).slice(0, 8),
    userCount: cleanCount ?? 0,
    ver: TAG_PIPELINE_VER,
    ts: Date.now(),
  })
  // 少爺校正必勝：pinned 必留、banned 必濾（LLM 重標永遠蓋不掉人工校正）
  const _prev = llmTagCache.get(sessionId)
  if (_prev?.pinned?.length || _prev?.banned?.length) {
    const _ban = new Set(_prev.banned ?? [])
    payload.tags = [...new Set([...(_prev.pinned ?? []), ...payload.tags.filter(t => !_ban.has(t))])].slice(0, 12)
    payload.pinned = _prev.pinned ?? []
    payload.banned = _prev.banned ?? []
  }
  if (payload.tags.length) {
    appendAiTagsLine(sessionId, payload)
    llmTagCache.set(sessionId, payload)
    logEvent('tags.llm.done', { sessionId, tags: payload.tags })
  }
}

/** 快取行寫回 transcript jsonl（append-only；讀取端取最後一行為準）——ai-tags / ai-present 共用 */
function appendTranscriptLine(sessionId, obj) {
  const _fp = findJsonlPath(sessionId)
  if (!_fp) return false
  let _prefix = ''
  try {
    const _fd = fs.openSync(_fp, 'r')
    const _st = fs.fstatSync(_fd)
    if (_st.size > 0) {
      const _b = Buffer.alloc(1)
      fs.readSync(_fd, _b, 0, 1, _st.size - 1)
      if (_b.toString() !== '\n') _prefix = '\n'
    }
    fs.closeSync(_fd)
  } catch {}
  try { fs.appendFileSync(_fp, _prefix + JSON.stringify(obj) + '\n', 'utf8'); return true } catch { return false }
}

/** ai-tags 快取行（既有呼叫端介面不變，內部走 appendTranscriptLine） */
function appendAiTagsLine(sessionId, payload) {
  return appendTranscriptLine(sessionId, { type: 'ai-tags', ...payload })
}

function runTagWorker() {
  if (tagWorkerBusy || tagQueue.length === 0) return
  tagWorkerBusy = true
  const job = tagQueue.shift()
  const _release = () => {
    for (const it of job.items) tagQueuedSids.delete(it.sessionId)
    tagWorkerBusy = false
    setImmediate(runTagWorker)
  }
  const _cwdNorm = TAGGER_CWD.replace(/\\/g, '/').toLowerCase()
  try { fs.mkdirSync(TAGGER_CWD, { recursive: true }) } catch {}
  pendingSpawnCwds.add(_cwdNorm)   // tagger 子進程不進 Sessions 側欄（沿用 spawn 前例）
  const args = ['--model', TAG_LLM_MODEL, '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--max-turns', '1', '-p', buildBatchTagPrompt(job.items)]
  let proc
  // 勿擾跟著誓約「夜間語意標籤」的設定（手動即時重標也走這條 worker，一併適用）
  try { proc = spawn(getClaudeExe(), args, { cwd: TAGGER_CWD, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: isQuietSetting(markerQuietKey('tc:nightly-tagging')) }) }
  catch { pendingSpawnCwds.delete(_cwdNorm); _release(); return }
  let _sid = null, _text = '', _buf = ''
  const _timeout = setTimeout(() => { try { proc.kill() } catch {} }, 180_000)   // 批次放寬到 180s
  // setEncoding 必加：中文每字 3 bytes，被切在 chunk 邊界時逐塊 toString() 會各自解出替換字元且原位元組已丟失
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', c => {
    _buf += c
    const _lines = _buf.split('\n'); _buf = _lines.pop()
    for (const l of _lines) {
      try {
        const ev = JSON.parse(l)
        if (ev.type === 'system' && ev.subtype === 'init') { _sid = ev.session_id; subprocessSids.add(_sid) }
        if (ev.type === 'result' && typeof ev.result === 'string') _text = ev.result
      } catch {}
    }
  })
  proc.on('close', () => {
    clearTimeout(_timeout)
    pendingSpawnCwds.delete(_cwdNorm)
    // tagger 自己的 transcript 不留（否則 History 會長出標籤器聊天室）
    if (_sid) { try { const _fp = findJsonlPath(_sid); if (_fp) fs.unlinkSync(_fp) } catch {} }
    try {
      const _arr = parseTagBatchResult(_text, job.items.length)
      // 順序對應：第 i 個結果 → job.items[i]（不依賴 LLM 正確回傳 sid，最 robust）
      // 增量室傳 prevTags 做融合保底（舊主題不丟失）
      job.items.forEach((it, i) => writeTagResult(it.sessionId, _arr[i], it.cleanCount, it.mode === 'incremental' ? it.prevTags : null))
    } catch {}
    _release()
  })
}

// LLM tag 快取查詢（HistoryPanel 輪詢用——不重掃 transcript，便宜）
app.get('/api/history/tags', async () => {
  const out = {}
  for (const [sid, p] of llmTagCache) {
    out[sid] = { tags: p.tags, summary: p.summary, knowledge: resolveKnowledgeDocs(p.knowledge), ts: p.ts }
  }
  return { tags: out, queue: tagQueue.length, busy: tagWorkerBusy }
})

// 少爺 tag 校正：新增/移除標籤、改 summary——寫回 ai-tags 行（manual）＋校正流水帳
app.patch('/api/history/:sessionId/tags', async (request) => {
  const { sessionId } = request.params
  const { addTag, removeTag, summary } = request.body ?? {}
  const _cur = llmTagCache.get(sessionId) ?? { tags: [], summary: '', knowledge: [], userCount: 0 }
  const _pinned = new Set(_cur.pinned ?? [])
  const _banned = new Set(_cur.banned ?? [])
  let _tags = [...(_cur.tags ?? [])]
  let _knowledge = [...(_cur.knowledge ?? [])]
  if (addTag) {
    const _t = s2tw(String(addTag).trim()).slice(0, 24)
    if (_t) {
      if (!_tags.includes(_t)) _tags.push(_t)
      _pinned.add(_t); _banned.delete(_t)
      // 加的是拼圖詞彙 → 一併進 knowledge（拼圖 chips 立即出現）
      const _lex = getTagLexicon()
      if ((_lex.terms.has(_t) || _lex.lower.has(_t.toLowerCase())) && !_knowledge.includes(_t)) _knowledge.push(_t)
      logTagCorrection(sessionId, 'add', _t)
    }
  }
  if (removeTag) {
    _tags = _tags.filter(t => t !== removeTag)
    _knowledge = _knowledge.filter(t => t !== removeTag)
    _banned.add(removeTag); _pinned.delete(removeTag)
    logTagCorrection(sessionId, 'remove', removeTag)
  }
  if (summary != null) logTagCorrection(sessionId, 'summary', String(summary).slice(0, 80))
  const payload = twNormalizeTags({
    tags: _tags.slice(0, 12),
    summary: summary != null ? String(summary).slice(0, 80) : (_cur.summary ?? ''),
    knowledge: _knowledge.slice(0, 10),
    pinned: [..._pinned], banned: [..._banned],
    manual: true, userCount: _cur.userCount ?? 0, ver: TAG_PIPELINE_VER, ts: Date.now(),
  })
  appendAiTagsLine(sessionId, payload)
  llmTagCache.set(sessionId, payload)
  return { ok: true, tags: payload.tags, summary: payload.summary, knowledge: resolveKnowledgeDocs(payload.knowledge) }
})

// ── History 增量索引（少爺 2026-07-16：「全掃是單次動作，之後只更新有新對話的聊天室」）──
// 聊天室 transcript 是 append-only（只累加不改舊內容）：索引對每室記「已掃到的 byte 游標」
// （少爺說的不顯示的時間戳記），開 History 時逐檔 statSync 比大小——沒長大＝零 IO 直接用索引；
// 長大＝只讀新增的尾巴增量累加。全掃只發生在索引不存在的第一次；檔案變短（異常重寫）才單室重建。
const HISTORY_INDEX_FILE = path.join(os.homedir(), '.claude', 'tc_history_index.json')
const HIST_HEAD_KEEP = 20, HIST_TAIL_KEEP = 20   // 每室存頭尾各 20 則乾淨留言（標籤 prompt 用，控索引體積）
let historyIndex = null
function loadHistoryIndex() {
  if (!historyIndex) {
    try { historyIndex = JSON.parse(fs.readFileSync(HISTORY_INDEX_FILE, 'utf8')) } catch { historyIndex = null }
    if (!historyIndex?.sessions) historyIndex = { sessions: {} }
  }
  return historyIndex
}

/** 把一行 transcript JSON 累加進索引 entry（首掃與增量共用同一套規則） */
function foldHistoryLine(entry, obj) {
  if (!entry.cwd && obj.cwd) entry.cwd = obj.cwd
  if (obj.type === 'ai-title' && obj.aiTitle) entry.title = obj.aiTitle
  if (obj.type === 'ai-tags' && Array.isArray(obj.tags)) entry.aiTags = twNormalizeTags(obj)
  if (obj.type === 'user') {
    const _c = obj.message?.content
    const _text = typeof _c === 'string' ? _c : _c?.[0]?.text ?? ''
    const _clean = _text.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
    if (_clean) {
      if (!entry.firstMsg) entry.firstMsg = _clean.slice(0, 60)
      if (filterUserTexts([_clean]).length) {
        const _t = _clean.slice(0, 300)
        entry.cleanCount = (entry.cleanCount ?? 0) + 1
        entry.cleanHead = entry.cleanHead ?? []
        entry.cleanTail = entry.cleanTail ?? []
        if (entry.cleanHead.length < HIST_HEAD_KEEP) entry.cleanHead.push(_t)
        else { entry.cleanTail.push(_t); if (entry.cleanTail.length > HIST_TAIL_KEEP) entry.cleanTail.shift() }
      }
    }
  }
  if (obj.type === 'result' && typeof obj.total_cost_usd === 'number')
    entry.resultUsd = (entry.resultUsd ?? 0) + obj.total_cost_usd
  if (obj.type === 'assistant' && obj.message?.usage) {
    const u  = obj.message.usage
    const mn = obj.message.model ?? null
    const p  = priceOf(mn)
    entry.estUsd = (entry.estUsd ?? 0) + (
      (u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite
    ) / 1e6
  }
}

/** 增量掃描：從上次游標只讀新增 bytes；游標永遠停在完整行邊界（寫入中的殘行下次再收） */
function scanHistoryFile(fullPath, stat, entry) {
  const _start = entry.scannedSize ?? 0
  const _len = stat.size - _start
  if (_len <= 0) return entry
  try {
    const _fd = fs.openSync(fullPath, 'r')
    const _buf = Buffer.alloc(_len)
    fs.readSync(_fd, _buf, 0, _len, _start)
    fs.closeSync(_fd)
    const _nl = _buf.lastIndexOf(0x0A)
    if (_nl === -1) return entry
    for (const l of _buf.slice(0, _nl + 1).toString('utf8').split('\n')) {
      if (!l.trim()) continue
      try { foldHistoryLine(entry, JSON.parse(l)) } catch {}
    }
    entry.scannedSize = _start + _nl + 1
  } catch {}
  return entry
}

/** 增量掃描全部 transcript、更新索引並寫回；回傳更新後的 idx。route 與 nightly 標籤共用。 */
function refreshHistoryIndex() {
  const projectsDir = path.join(CLAUDE_DIR, 'projects')
  const idx = loadHistoryIndex()
  const _seen = new Set()
  let _dirty = false
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const projPath = path.join(projectsDir, proj)
      if (!fs.statSync(projPath).isDirectory()) continue
      if (proj.includes('tc-tagger') || proj.includes('tc-companion')) continue   // 標籤器／陪聊的工作目錄不算聊天室
      for (const file of fs.readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        const fullPath = path.join(projPath, file)
        const stat = fs.statSync(fullPath)
        _seen.add(sessionId)
        let entry = idx.sessions[sessionId]
        if (entry && stat.size < (entry.scannedSize ?? 0)) entry = null   // 檔案變短＝被重寫 → 單室重建
        if (!entry) entry = { scannedSize: 0 }
        if (stat.size > (entry.scannedSize ?? 0)) { entry = scanHistoryFile(fullPath, stat, entry); _dirty = true }
        entry.project = proj
        entry.mtime = stat.mtimeMs
        entry.size = stat.size
        idx.sessions[sessionId] = entry
        // in-memory tag 快取同步（jsonl 已有 ai-tags 就載入）——校正權威也走這條回填
        if (entry.aiTags && (entry.aiTags.tags?.length || entry.aiTags.manual)) llmTagCache.set(sessionId, entry.aiTags)
      }
    }
    for (const sid of Object.keys(idx.sessions)) if (!_seen.has(sid)) { delete idx.sessions[sid]; _dirty = true }
    if (_dirty) atomicWriteJson(HISTORY_INDEX_FILE, idx)
  } catch {}
  return idx
}

// List all past sessions across all projects（純顯示——不再即時觸發 LLM 標籤，改由每晚 23:30 定時批次）
app.get('/api/history', async () => {
  const idx = refreshHistoryIndex()
  const result = []
  for (const [sessionId, entry] of Object.entries(idx.sessions)) {
    const aiTags = entry.aiTags ?? null
    const cleanTexts = [...(entry.cleanHead ?? []), ...(entry.cleanTail ?? [])]
    let tags = null, summary = null, knowledge = []
    // manual（少爺校正過）即使清空也是權威；有 LLM tag 用 LLM；都沒有才詞頻墊檔
    if (aiTags && (aiTags.tags?.length || aiTags.manual)) {
      tags = aiTags.tags ?? []; summary = aiTags.summary ?? null; knowledge = aiTags.knowledge ?? []
    }
    if (!tags) tags = extractSessionTags(cleanTexts)
    const costUsd = entry.resultUsd ?? ((entry.estUsd ?? 0) > 0 ? entry.estUsd : null)
    result.push({ sessionId, project: entry.project, cwd: entry.cwd ?? null,
      title: entry.title ?? entry.firstMsg ?? sessionId.slice(0, 8),
      mtime: entry.mtime, size: entry.size, costUsd,
      tags, summary, llm: !!(aiTags?.tags?.length || aiTags?.manual), knowledge: resolveKnowledgeDocs(knowledge) })
  }
  return { sessions: result.sort((a,b) => b.mtime - a.mtime).slice(0, 100) }
})

// ── 每晚 23:30 定時批次標籤（少爺 2026-07-16）───────────────────────────────────
// 只處理「有新對話」的室（cleanCount > 上次 userCount）；增量室只餵新留言；併批 spawn。
function runNightlyTagging(reason = 'scheduled') {
  const idx = refreshHistoryIndex()
  const _cands = []
  for (const [sessionId, entry] of Object.entries(idx.sessions)) {
    const cleanCount = entry.cleanCount ?? 0
    if (!cleanCount) continue
    const aiTags = entry.aiTags ?? null
    const _sample = [...(entry.cleanHead ?? []), ...(entry.cleanTail ?? [])]
    if (!aiTags || aiTags.ver !== TAG_PIPELINE_VER) {
      // 從沒標過 / 版本過舊 → 首標（讀樣本）
      _cands.push({ sessionId, mode: 'full', texts: _sample, cleanCount })
    } else if (cleanCount > (aiTags.userCount ?? 0)) {
      // 有新對話 → 增量（只看上次之後的新留言）
      const _newCount = cleanCount - (aiTags.userCount ?? 0)
      const _newTexts = (entry.cleanTail ?? []).slice(-Math.min(_newCount, 20))
      if (_newTexts.length) _cands.push({ sessionId, mode: 'incremental', prevTags: aiTags.tags, prevSummary: aiTags.summary, texts: _newTexts, cleanCount })
    }
    // 沒新對話 → 跳過（零成本）
  }
  for (let i = 0; i < _cands.length; i += TAG_BATCH_SIZE) enqueueTagBatch(_cands.slice(i, i + TAG_BATCH_SIZE))
  logEvent('tags.nightly.run', { reason, candidates: _cands.length, batches: Math.ceil(_cands.length / TAG_BATCH_SIZE) })
  try { atomicWriteJson(TAG_NIGHTLY_STATE_FILE, { lastRun: Date.now(), reason, candidates: _cands.length }) } catch {}
  return _cands.length
}

let nightlyTimer = null
function scheduleNextNightly() {
  if (nightlyTimer) clearTimeout(nightlyTimer)
  const _now = new Date()
  const _next = new Date(_now)
  const [_h, _m] = getNightlyHM()
  _next.setHours(_h, _m, 0, 0)
  if (_next <= _now) _next.setDate(_next.getDate() + 1)
  const _delay = _next.getTime() - _now.getTime()
  logEvent('tags.nightly.scheduled', { at: _next.toISOString(), inMinutes: Math.round(_delay / 60000) })
  nightlyTimer = setTimeout(() => {
    try { runNightlyTagging('scheduled') } catch (e) { console.error('[nightly tag]', e) }
    scheduleNextNightly()
  }, _delay)
}

// tagger 子進程 transcript 保險清掃（單次清在 worker close 做；這裡清歷史殘留——如 server 曾在
// tagger 跑到一半重啟、close handler 沒觸發）。開機時＋每晚跑完各清一次。
function cleanTaggerTranscripts() {
  try {
    const _projectsDir = path.join(CLAUDE_DIR, 'projects')
    for (const proj of fs.readdirSync(_projectsDir)) {
      if (!proj.includes('tc-tagger')) continue
      const _dir = path.join(_projectsDir, proj)
      for (const f of fs.readdirSync(_dir)) try { fs.unlinkSync(path.join(_dir, f)) } catch {}
    }
  } catch {}
}
// cleanTaggerTranscripts() 與 scheduleNextNightly() 的啟動呼叫已下移到 metrics 初始化區之後
// （2026-08-06 修：原在此處呼叫時 EVENTS_DIR const 尚在 TDZ → scheduleNextNightly 內的 logEvent
//  撞 ReferenceError 被 catch 靜默吞掉 → tags.nightly.scheduled 事件記不到；setTimeout 仍會排、
//  功能正常，但重啟後無法從 events 確認今晚排程 = 可觀測性破損）

// 手動觸發夜間標籤（測試／少爺想立即跑一輪）
app.post('/api/history/tags/run-nightly', async () => {
  const _n = runNightlyTagging('manual')
  return { ok: true, candidates: _n, queue: tagQueue.length }
})

// ─── 勿擾（少爺 2026-10-06）：執行時不跳出主控台／終端視窗，酒窖與誓約逐項獨立設定 ─────────
// 跳窗根因：TC server 在 pm2 底下沒有主控台，spawn 主控台程式（claude／cmd／python…）時 Windows 會替它
// 開新終端（本機預設＝Windows Terminal）。勿擾開＝只拿掉主控台視窗，工具自己的介面／對話框照常出現：
// - TC 直接起的 Claude 進程（酒窖 claude 型、夜間語意標籤）→ windowsHide
// - 酒窖 execute 型、Windows 排程 → 經 RunHidden.exe 轉交（只加 CREATE_NO_WINDOW、命令列逐字轉交、結束碼原樣回傳）
//   ⚠️ 不用 wscript 隱藏啟動：它靠 SW_HIDE，會連「沒加 -WindowStyle Hidden 的 PowerShell 對話框」一起藏掉；
//      conhost --headless 在本機連指令都不會真的執行（2026-10-06 實測）
// 偏好存 TC 總設定：cellar.quiet.<工具 id>／marker.quiet.<誓約 id>；未設＝關＝維持原行為。
// Windows 排程的 SSOT 是偏好：排程被別的腳本重新註冊（動作被蓋回原樣）時由對帳自動補包回去。
const RUN_HIDDEN_DIR = 'C:\\Project\\MasterBrain\\.agent\\scripts\\RunHidden'
const RUN_HIDDEN_EXE = path.join(RUN_HIDDEN_DIR, 'RunHidden.exe')
const MARKER_QUIET_RECONCILE_MS = 30 * 60 * 1000
// QA 分頁版控「⚡ 依規則 Commit」喚起的 Claude 進程（少爺 2026-10-08）；git 狀態查詢與 Commit 腳本輸出都由 TC 接走，一律不配視窗、不設開關
const QA_AUTO_COMMIT_QUIET_KEY = 'qa.quiet.git-auto-commit'

function markerQuietKey(InMarkerId) { return `marker.quiet.${InMarkerId}` }
function isQuietSetting(InKey) { return getTcSetting(InKey, false) === true }

// 排程動作是否已經由 RunHidden 轉交
function isRunHiddenWrapped(InExecute) {
  return path.basename(String(InExecute ?? '').replace(/"/g, '').trim()).toLowerCase() === 'runhidden.exe'
}

// 啟動器不在就現場建置（換機器／被清掉時自癒）；回傳是否可用
async function ensureRunHiddenExe() {
  if (fs.existsSync(RUN_HIDDEN_EXE)) return true
  const _r = await runPowerShell(`& '${path.join(RUN_HIDDEN_DIR, 'Build-RunHidden.ps1')}'`)
  logEvent('quiet.runhidden.build', { ok: fs.existsSync(RUN_HIDDEN_EXE), out: _r.out.slice(0, 300) })
  return fs.existsSync(RUN_HIDDEN_EXE)
}

// 把 Windows 排程的每個執行動作包進／拆出 RunHidden（拆回＝逐字還原原本的程式與參數）
async function applyWindowsTaskQuiet(InTaskName, InQuiet) {
  if (InQuiet && !(await ensureRunHiddenExe())) return { ok: false, error: `啟動器建置失敗：${RUN_HIDDEN_EXE}` }
  const _r = await runPowerShell(
    '$t = Get-ScheduledTask -TaskName $env:MARKER_TASK_NAME -ErrorAction Stop; $changed = $false; '
    + 'foreach ($a in $t.Actions) { if (-not $a.Execute) { continue }; '
    + '$wrapped = [IO.Path]::GetFileName($a.Execute.Trim(\'"\')) -ieq \'RunHidden.exe\'; '
    + 'if ($env:MARKER_QUIET -eq \'1\' -and -not $wrapped) { '
    + '$a.Arguments = \'"\' + $a.Execute.Trim(\'"\') + \'"\' + $(if ($a.Arguments) { \' \' + $a.Arguments } else { \'\' }); $a.Execute = $env:RUN_HIDDEN_EXE; $changed = $true } '
    + 'elseif ($env:MARKER_QUIET -ne \'1\' -and $wrapped) { '
    + 'if ($a.Arguments -match \'^\\s*"([^"]+)"\\s?(.*)$\' -or $a.Arguments -match \'^\\s*(\\S+)\\s?(.*)$\') { $a.Execute = $Matches[1]; $a.Arguments = $Matches[2]; $changed = $true } } }; '
    + 'if ($changed) { Set-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Action $t.Actions | Out-Null }',
    { MARKER_TASK_NAME: InTaskName, MARKER_QUIET: InQuiet ? '1' : '0', RUN_HIDDEN_EXE })
  return _r.code === 0 ? { ok: true } : { ok: false, error: _r.out.slice(0, 300) || `exit ${_r.code}` }
}

// 對帳：偏好有明確設定、排程實際狀態不同 → 照偏好補套（排程被重新註冊、手動改過時自癒）
let markerQuietReconciling = false
async function reconcileMarkerQuiet(InListed = null, InReason = 'periodic') {
  if (markerQuietReconciling) return
  markerQuietReconciling = true
  try {
    for (const _w of InListed ?? await listWindowsMarkers()) {
      const _want = getTcSetting(markerQuietKey(_w.id), null)
      if (typeof _want !== 'boolean' || !_w.quietSupported || _want === _w.quiet) continue
      const _r = await applyWindowsTaskQuiet(_w.name, _want)
      logEvent('marker.quiet.reconcile', { id: _w.id, quiet: _want, reason: InReason, ok: _r.ok, error: _r.error ?? null })
    }
  } finally { markerQuietReconciling = false }
}

// ─── Marker（誓約）：定期會執行的委託任務清單（少爺 2026-08-06）───────────────────
// 兩源合流：(1) TC server 內建定時＝下方 registry（只登記「語義上是委託任務」的；心跳／幽靈
//   清掃／持久化那些基礎設施 setInterval 不列）(2) Windows 排程＝Get-ScheduledTask 過濾少爺／
//   Claude 相關（名稱 match pattern）。未來自動涵蓋：新內建定時 registerMarker 一筆即現身；
//   新 Windows 排程名 match pattern 即入列（pattern 可經 tc_user_config/markers.json 擴充）。
const MARKER_REGISTRY = []
function registerMarker(_m) { MARKER_REGISTRY.push(_m) }

// 內建定時：夜間語意標籤（與話題筆記同 23:30，但話題筆記是 Windows 排程、走另一源）
registerMarker({
  id: 'nightly-tagging',
  name: '夜間語意標籤',
  desc: 'LLM 增量標 History／侍酒師的 tags＋summary',
  source: 'TC 內建',
  supportsQuiet: true,
  getTime: () => formatHHMM(...getNightlyHM()),
  setTime: (InTime) => {
    writeTcSettings({ 'marker.time.nightly-tagging': InTime })
    scheduleNextNightly()
  },
  getLast: () => { try { return JSON.parse(fs.readFileSync(TAG_NIGHTLY_STATE_FILE, 'utf8')).lastRun ?? null } catch { return null } },
  getNext: () => {
    const _n = new Date(); _n.setHours(...getNightlyHM(), 0, 0)
    if (_n <= new Date()) _n.setDate(_n.getDate() + 1)
    return _n.getTime()
  },
})

// Windows 排程識別 pattern（markers.json 可覆蓋）。預設只用精準關鍵字 Claude／Roman——
// 現有兩個排程 ClaudeLaunchUEEditor＋RomanPrototype_話題筆記 各自命中，且不會像 'UE'／'TC'
// 兩字母 substring 那樣誤撞系統排程（continUE／queUE／PaTChDb）。USER_CONFIG_DIR 用時求值避 TDZ。
function readMarkerPatterns() {
  try {
    const _c = JSON.parse(fs.readFileSync(path.join(USER_CONFIG_DIR, 'markers.json'), 'utf8'))
    if (Array.isArray(_c.windowsPatterns) && _c.windowsPatterns.length) return _c.windowsPatterns
  } catch {}
  return ['Claude', 'Roman']
}

// Windows 排程觸發類型 → 顯示字
const MARKER_TRIGGER_LABEL = {
  MSFT_TaskDailyTrigger: '每天', MSFT_TaskWeeklyTrigger: '每週', MSFT_TaskTimeTrigger: '單次',
  MSFT_TaskLogonTrigger: '登入時', MSFT_TaskBootTrigger: '開機時',
}
// 排程系統狀態碼：尚未執行（0x41303）／執行中（0x41301）不是失敗
const SCHED_S_TASK_HAS_NOT_RUN = 267011
const SCHED_S_TASK_RUNNING = 267009

// 撈少爺／Claude 相關的 Windows 排程（名稱 like 任一 pattern）→ 統一 marker 格式
function listWindowsMarkers() {
  return new Promise((resolve) => {
    const _pats = readMarkerPatterns().map(p => '"' + String(p).replace(/"/g, '') + '"').join(',')
    const _script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $pats=@(' + _pats +
      '); Get-ScheduledTask | Where-Object { $t=$_.TaskName; ($pats | Where-Object { $t -like "*$_*" }).Count -gt 0 } | ' +
      'ForEach-Object { $i=$_ | Get-ScheduledTaskInfo; $tr=$_.Triggers | Select-Object -First 1; [PSCustomObject]@{ name=$_.TaskName; state="$($_.State)"; ' +
      'desc=$_.Description; ' +
      'exec=($_.Actions | Where-Object { $_.Execute } | Select-Object -First 1).Execute; ' +
      'trigger=$tr.StartBoundary; ttype=$(if($tr){$tr.CimClass.CimClassName}else{$null}); ' +
      'lastRun=$(if($i.LastRunTime){$i.LastRunTime.ToString("o")}else{$null}); ' +
      'lastResult=$i.LastTaskResult; ' +
      'nextRun=$(if($i.NextRunTime){$i.NextRunTime.ToString("o")}else{$null}) } } | ConvertTo-Json -Depth 3 -Compress'
    let _out = ''
    try {
      // windowsHide 必加：否則 pm2 背景 node spawn console 程式會閃 powershell 視窗（少爺 2026-08-06 回報「按 Marker 跳視窗」根因）
      const _ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', _script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      _ps.stdout.setEncoding('utf-8')   // 逐塊 toString 會切壞跨 chunk 的中文字（3 bytes/字）
      _ps.stdout.on('data', d => { _out += d })
      _ps.on('close', () => {
        try {
          const _j = JSON.parse(_out.trim() || 'null')
          const _arr = Array.isArray(_j) ? _j : _j ? [_j] : []
          resolve(_arr.map(w => {
            const _notRun = w.lastResult === SCHED_S_TASK_HAS_NOT_RUN
            const _label = MARKER_TRIGGER_LABEL[w.ttype] ?? '每次'
            const _dt = w.trigger ? new Date(w.trigger) : null
            const _time = _dt ? formatHHMM(_dt.getHours(), _dt.getMinutes()) : null
            const _eventTrigger = w.ttype === 'MSFT_TaskLogonTrigger' || w.ttype === 'MSFT_TaskBootTrigger'
            const _d = w.trigger ? new Date(w.trigger) : null
            return {
              id: `win:${w.name}`, name: w.name, desc: w.desc ?? '', source: 'Windows 排程', state: w.state ?? '—',
              time: _d ? formatHHMM(_d.getHours(), _d.getMinutes()) : null,
              editable: w.ttype === 'MSFT_TaskDailyTrigger' || w.ttype === 'MSFT_TaskWeeklyTrigger',
              schedule: _eventTrigger ? _label : (!_time ? '—' : w.ttype === 'MSFT_TaskDailyTrigger' ? dailyLabel(_dt.getHours(), _dt.getMinutes()) : `${_label} ${_time}`),
              lastRun: (!_notRun && w.lastRun) ? Date.parse(w.lastRun) : null,
              lastResult: (_notRun || w.lastResult === SCHED_S_TASK_RUNNING) ? null : (w.lastResult ?? null),
              nextRun: w.nextRun ? Date.parse(w.nextRun) : null,
              // 勿擾＝排程動作實際已由 RunHidden 轉交（不是偏好值；偏好與實況不同時由對帳補套）
              quiet: isRunHiddenWrapped(w.exec), quietSupported: !!w.exec,
            }
          }))
        } catch { resolve([]) }
      })
      _ps.on('error', () => resolve([]))
    } catch { resolve([]) }
  })
}

// 誓約清單：TC 內建 registry ＋ Windows 排程合流（少爺 2026-08-06 Marker 系統）
app.get('/api/markers', async () => {
  const _win = await listWindowsMarkers()
  // 勿擾：顯示偏好值；排程實況與偏好不同＝標「套用中」並背景補套
  for (const _w of _win) {
    const _want = getTcSetting(markerQuietKey(_w.id), null)
    _w.quietPending = typeof _want === 'boolean' && _w.quietSupported && _want !== _w.quiet
    if (_w.quietPending) _w.quiet = _want
  }
  if (_win.some(w => w.quietPending)) reconcileMarkerQuiet(null, 'list')
  const _tc = MARKER_REGISTRY.map(_m => ({
    id: `tc:${_m.id}`, name: _m.name, desc: _m.desc ?? '', source: _m.source, state: 'Ready',
    schedule: _m.getTime ? dailyLabel(...parseHHMM(_m.getTime())) : _m.schedule, time: _m.getTime?.() ?? null, editable: !!_m.setTime,
    lastRun: _m.getLast?.() ?? null, lastResult: 0, nextRun: _m.getNext?.() ?? null,
    quiet: isQuietSetting(markerQuietKey(`tc:${_m.id}`)), quietSupported: !!_m.supportsQuiet,
  }))
  return { ok: true, markers: [..._tc, ..._win], defaultDailyTime: getMarkerDefaultDailyTime() }
})

// 設定單一誓約的勿擾：TC 內建只存偏好（下次起進程生效）；Windows 排程存偏好＋改排程動作並回讀驗證
async function setMarkerQuiet(InId, InQuiet) {
  const _key = markerQuietKey(InId)
  if (InId.startsWith('tc:')) {
    const _m = MARKER_REGISTRY.find(x => `tc:${x.id}` === InId)
    if (!_m?.supportsQuiet) return { ok: false, code: 404, error: '此誓約不支援勿擾' }
    writeTcSettings({ [_key]: InQuiet })
    logEvent('marker.quiet.set', { id: InId, quiet: InQuiet, ok: true })
    return { ok: true, quiet: InQuiet }
  }
  if (!InId.startsWith('win:')) return { ok: false, code: 400, error: '未知誓約' }
  const _name = InId.slice(4)
  const _listed = (await listWindowsMarkers()).find(w => w.name === _name)
  if (!_listed) return { ok: false, code: 404, error: `找不到排程 ${_name}` }
  if (!_listed.quietSupported) return { ok: false, code: 400, error: '此排程沒有可轉交的執行動作' }
  const _prev = getTcSetting(_key, null)
  writeTcSettings({ [_key]: InQuiet })
  const _r = await applyWindowsTaskQuiet(_name, InQuiet)
  const _after = (await listWindowsMarkers()).find(w => w.name === _name)
  const _ok = _r.ok && _after?.quiet === InQuiet
  logEvent('marker.quiet.set', { id: InId, quiet: InQuiet, ok: _ok, error: _r.error ?? null })
  if (_ok) return { ok: true, quiet: InQuiet }
  // 套用失敗就退回原偏好，免得對帳每半小時重試同一個失敗
  writeTcSettings({ [_key]: _prev })
  return { ok: false, code: 500, error: `套用失敗：${_r.error ?? '排程動作未改變'}` }
}

app.post('/api/markers/quiet', async (request, reply) => {
  const { id, quiet } = request.body ?? {}
  if (typeof id !== 'string' || typeof quiet !== 'boolean') { reply.code(400); return { ok: false, error: '需要 id 與 quiet（true／false）' } }
  const _r = await setMarkerQuiet(id, quiet)
  if (!_r.ok) reply.code(_r.code ?? 500)
  return { ok: _r.ok, quiet: _r.quiet, error: _r.error }
})

// 知識訂閱來源登錄（排程時刻 SSOT）與註冊腳本
const KNOWLEDGE_SUB_SOURCES = 'C:\\Project\\MasterBrain\\.agent\\data\\knowledge_subscriptions\\sources.json'
const KNOWLEDGE_SUB_REGISTER = 'C:\\Project\\MasterBrain\\.agent\\scripts\\Register-KnowledgeSubscriptionTask.ps1'

// 跑一段 PowerShell（UTF-8、不閃窗）→ { code, out }
function runPowerShell(InScript, InEnv = {}) {
  return new Promise((resolve) => {
    let _out = ''
    const _ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + InScript],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...InEnv } })
    _ps.stdout.setEncoding('utf-8'); _ps.stderr.setEncoding('utf-8')
    _ps.stdout.on('data', d => { _out += d }); _ps.stderr.on('data', d => { _out += d })
    _ps.on('close', (c) => resolve({ code: c, out: _out.trim() }))
    _ps.on('error', (e) => resolve({ code: -1, out: String(e) }))
  })
}

// 設定誓約時刻：TC 內建走 setTime；知識訂閱先改 sources.json 再重註冊；其他 Windows 排程直接改觸發時刻（保留每天／每週）
app.post('/api/markers/time', async (request, reply) => {
  const { id, time } = request.body ?? {}
  const _hm = parseHHMM(time)
  if (!_hm || typeof id !== 'string') { reply.code(400); return { ok: false, error: '時間格式需為 HH:MM' } }
  const _time = formatHHMM(..._hm)
  if (id.startsWith('tc:')) {
    const _m = MARKER_REGISTRY.find(x => `tc:${x.id}` === id)
    if (!_m?.setTime) { reply.code(404); return { ok: false, error: '此誓約不可設定時刻' } }
    _m.setTime(_time)
    logEvent('marker.time.set', { id, time: _time })
    return { ok: true, time: _time }
  }
  if (!id.startsWith('win:')) { reply.code(400); return { ok: false, error: '未知誓約' } }
  const _name = id.slice(4)
  const _listed = (await listWindowsMarkers()).find(w => w.name === _name)
  if (!_listed) { reply.code(404); return { ok: false, error: `找不到排程 ${_name}` } }
  if (!_listed.editable) { reply.code(400); return { ok: false, error: '只有每天／每週的排程可設定時刻' } }
  let _sources = null
  try { _sources = JSON.parse(fs.readFileSync(KNOWLEDGE_SUB_SOURCES, 'utf-8')) } catch {}
  const _sub = _sources?.sources?.find(s => s.schedule?.taskName === _name)
  let _r
  if (_sub) {
    _sub.schedule.time = _time
    atomicWriteJson(KNOWLEDGE_SUB_SOURCES, _sources)
    _r = await runPowerShell(`& '${KNOWLEDGE_SUB_REGISTER}' -Source '${_sub.id}'`)
  } else {
    _r = await runPowerShell('$t = Get-ScheduledTask -TaskName $env:MARKER_TASK_NAME; $tr = $t.Triggers[0]; '
      + '$d = [datetime]$tr.StartBoundary; $tr.StartBoundary = $d.Date.AddHours($env:MARKER_H).AddMinutes($env:MARKER_M).ToString("yyyy-MM-ddTHH:mm:ss"); '
      + 'Set-ScheduledTask -TaskName $env:MARKER_TASK_NAME -Trigger $t.Triggers | Out-Null',
      { MARKER_TASK_NAME: _name, MARKER_H: String(_hm[0]), MARKER_M: String(_hm[1]) })
  }
  const _after = (await listWindowsMarkers()).find(w => w.name === _name)
  const _ok = _r.code === 0 && _after?.time === _time
  logEvent('marker.time.set', { id, time: _time, knowledgeSource: _sub?.id ?? null, ok: _ok })
  // 重新註冊會把排程動作蓋回原樣 → 照勿擾偏好補包
  if (_sub) await reconcileMarkerQuiet(_after ? [_after] : null, 'reregister')
  if (!_ok) { reply.code(500); return { ok: false, error: `設定失敗：${_r.out.slice(0, 300) || '排程時刻未改變'}` } }
  return { ok: true, time: _time, knowledgeSource: _sub?.id ?? null }
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
            const p   = priceOf(mn)
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
          // 回合結束標記（少爺 2026-08-15「總結算沒播」根治）——不靠 Stop hook。
          // 實查本機 transcript：中途呼叫工具的 assistant 訊息 stop_reason='tool_use'（436 筆），
          // 真正講完那一則才是 'end_turn'（15 筆）。這是 transcript 內建、不會漏的收工訊號。
          if (obj.message?.stop_reason === 'end_turn') {
            const last = messages[messages.length - 1]
            if (last) last._turnEnd = true
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
    if (claudeLanes.runningEntry(sessionId)) return
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
  // 監看多室並存（少爺 2026-08-15：花費演出要對在各自聊天室）——原本「切換聊天室就關掉其他
  // 所有 tail」，同時運作的多間聊天室只有一間發得出 session_live，其餘無從演出。改成只回收
  // 「已不活躍」的監看：清理照舊做，active/waiting 的聊天室各自保留 tail。
  // ⚠️ 停監看要用 fs.unwatchFile（StatWatcher 沒有 close()，原本那行是被 catch 吞掉的空動作＝
  // 只從 map 移除、poller 實際仍掛著）
  for (const [id, w] of watchedSessions) {
    if (id === sessionId) continue
    const _s = sessions.get(id)
    if (_s && (_s.status === 'active' || _s.status === 'waiting')) continue
    try { fs.unwatchFile(w.filePath) } catch {}
    watchedSessions.delete(id)
  }
  // ── Continue in Chat 側欄聯動（少爺 2026-07-20）──────────────────────────────
  // 側欄自動退場（SESSION_RETIRE_MS, 8b92c09）後歷史聊天室不在 sessions 清單，而 App 的
  // handleContinueInChat 只做 setSelectedId「選側欄既有列」→ 選不到＝聯動看似消失。
  // 看聊天室（watch）就補回側欄一列（最初首句名、status done）；之後 20 分鐘沒真實活動
  // 仍照既有退場規則離開，不破壞退場機制本意。
  if (!sessions.has(sessionId)) {
    const _fp = findJsonlPath(sessionId)
    if (_fp) {
      let _cwd = null
      try {
        const _lines = fs.readFileSync(_fp, 'utf-8').split('\n').filter(Boolean)
        for (const _l of _lines.slice(0, 20)) {
          try { const _o = JSON.parse(_l); if (_o.cwd) { _cwd = _o.cwd; break } } catch {}
        }
      } catch {}
      const _topic = getSessionTopic(sessionId)
      const _s = upsertSession(sessionId, {
        status: 'done',
        ...(_cwd ? { cwd: _cwd } : {}),
        ...(_topic ? { topic: _topic, displayName: _topic.slice(0, 40) } : {}),
      })
      broadcast({ type: 'session', session: _s })
    }
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

// ─── TC 總設定（使用者偏好池；少爺 2026-08-07 立）─────────────────────────────
// 跨功能 key-value 偏好：對應少爺當下工作習慣、隨時可調；未來功能的使用者偏好一律掛這裡（namespaced key 如 'qa.newRunCountdownSecs'），不各自開 settings 檔。
// 值為 null 的 PATCH = 清除該鍵（回「未設定」讓功能端 fallback）。
const TC_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'tc_settings.json')

function readTcSettings() {
  try { return JSON.parse(fs.readFileSync(TC_SETTINGS_FILE, 'utf-8')) } catch { return {} }
}

// 讀單一偏好；未設定回 fallback（功能端唯一取用入口）
function getTcSetting(key, fallback) {
  const v = readTcSettings()[key]
  return v === undefined ? fallback : v
}

// 寫入偏好（merge；值 null＝清除鍵）並廣播
function writeTcSettings(InPatch) {
  const next = { ...readTcSettings(), ...(InPatch ?? {}) }
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k]
  atomicWriteJson(TC_SETTINGS_FILE, next)
  broadcast({ type: 'tc_settings_update', settings: next })
  return next
}

app.get('/api/settings', async () => readTcSettings())

app.patch('/api/settings', async (request) => {
  const next = writeTcSettings(request.body)
  if ('marker.defaultDailyTime' in (request.body ?? {}) || 'marker.time.nightly-tagging' in (request.body ?? {})) scheduleNextNightly()
  logEvent('tc.settings.update', { keys: Object.keys(request.body ?? {}) })
  return { ok: true, settings: next }
})

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
// 少爺 2026-10-05：隊伍以聊天室為單位——只有「同一個聊天室已有進程在跑」才排隊，不同聊天室一律並行；
// 新聊天室（沒有 session id）永不排隊。記帳在 claudeLanes.js。

/** 排進該聊天室自己的隊伍並通知前端；回傳 { pos, coalesced } */
function enqueueSessionRun(InSessionId, InItem, InOpts = {}) {
  const _r = claudeLanes.enqueue(InSessionId, InItem, InOpts)
  broadcast({ type: 'claude_stream', projectPath: normalizePath(InItem.projectPath), sessionId: InSessionId,
    event: { type: 'system', subtype: 'queue_enqueue', queuePos: _r.pos, coalesced: _r.coalesced } })
  return _r
}

/** 該聊天室閒置時送出隊伍的下一則 */
function processQueueIfIdle(InSessionId) {
  const next = claudeLanes.dequeue(InSessionId)
  if (!next) return
  broadcast({ type: 'claude_stream', projectPath: normalizePath(next.projectPath), sessionId: InSessionId,
    event: { type: 'system', subtype: 'queue_dequeue', queueRemaining: claudeLanes.queueLength(InSessionId) } })
  spawnClaude(next.projectPath, next.prompt, InSessionId, next.model ?? null, next.effort ?? null, next.onInit ?? null)
}

/** 送一則給指定聊天室：該室忙碌就排進它自己的隊伍，閒置就直接起進程（跨聊天室並行）。
 *  回傳 { queued:true, pos, coalesced } 或 { queued:false, entry } */
function runOrQueueForSession(InProjectPath, InPrompt, InSessionId, InModel = null, InEffort = null, InOnInit = null, InOpts = {}) {
  if (InSessionId && claudeLanes.isSessionBusy(InSessionId)) {
    return { queued: true, ...enqueueSessionRun(InSessionId, { projectPath: InProjectPath, prompt: InPrompt, model: InModel, effort: InEffort, onInit: InOnInit }, InOpts) }
  }
  const _parallel = claudeLanes.runningInProject(InProjectPath)
  if (_parallel.length) logEvent('claude.lane.parallel', { projectPath: normalizePath(InProjectPath), sessionId: InSessionId ?? null, alongside: _parallel.map(e => e.sessionId ?? e.laneKey) })
  return { queued: false, entry: spawnClaude(InProjectPath, InPrompt, InSessionId, InModel, InEffort, InOnInit) }
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
const QA_FLOW_DIRECTIVE = '\n\n(TC QA 流程) 少爺勾選了「啟用 QA 流程」——本需求必須走 Mode C 協作驗證收尾：照 theclaudenental_operator skill 的「QA Run 操作 SOP（Mode C）」與專案 QA/README.md §Mode C，從 Step 0 開 QA Run（POST /api/qa/runs，必綁 boundSessionId=本 session id、boundProjectPath、project；⚠️ wakeMode 不要自己填——server 會依本 session 是不是少爺開著的 VS Code 分頁自動決定），列 QAPC 計畫（操作步驟＋預期 LOG 劇本＋LOG 埋點計畫）供少爺在 QA 分頁審查；少爺按 ▶ 之前零編譯零埋 LOG。\n⭐ POST 回應若帶 mountCommand（＝wakeMode 判為 monitor），**必須在同一個 response 內**用 Monitor 工具把它掛起（persistent=true），再 GET http://127.0.0.1:3001/api/qa/monitor-status?session=<本 session id> 驗 alive:true 才算數——這是 VS Code 原地聯動唯一成立的方式，缺這步少爺按 ▶／留言／✔ 結案都只會走無頭，分頁不動。'

// quiet＝勿擾：不配終端視窗（見「勿擾」段）；目前只有酒窖開新聊天室時會傳
function spawnClaude(projectPath, prompt, sessionId = null, model = null, effort = null, onInit = null, retryCount = 0, quiet = false) {
  // ⚠️ 不再 kill existing（會中斷使用者進行中的 thinking）
  // 續聊既有聊天室一律經 runOrQueueForSession（同室忙碌要排隊）；直接呼叫本函式＝開新聊天室或確定該室閒置

  // Pre-register before spawn so SessionStart hook can filter by cwd (race condition fix)
  // 計數式：同 cwd 並行多個時，各自在 init 或結束時釋放一次（沒拿到 init 就結束也要釋放，否則該 cwd 的分頁永遠被當成子進程）
  const normalCwd = projectPath.replace(/\\/g, '/').toLowerCase()
  pendingSpawnCwds.add(normalCwd)
  let _cwdReleased = false
  const _releaseCwd = () => { if (_cwdReleased) return; _cwdReleased = true; pendingSpawnCwds.delete(normalCwd) }

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ]
  if (effort) args.unshift('--effort', effort)
  if (model) args.unshift('--model', model)
  if (sessionId) args.unshift('--resume', sessionId)

  const proc = spawn(getClaudeExe(), args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: quiet })
  // sawAssistant = 送達證明（唯一可信定義：出現 assistant 回應）。resume 撞上同 session 交接縫隙時，
  // CLI 會把 prompt enqueue 進 transcript 後無人消費地退出（2026-07-17 close 喚醒石沉實錄）——
  // 那種進程 exit 0 但零 assistant 產出，靠這旗標識別。
  const entry = { proc, sessionId, projectPath, status: 'running', model, effort, sawAssistant: false }
  claudeLanes.register(entry)
  // 石沉重試的空窗由本進程接手（重試前視同忙碌的保留到此為止）
  if (sessionId) claudeLanes.unhold(sessionId)

  // 少爺 2026-07-14：spawn 參數可觀察化——落 log + 推 Chat 面板顯示（effort 在 init/transcript 皆無痕跡，這裡是唯一觀察點）
  if (model || effort) {
    logEvent('claude.spawn.config', { projectPath: normalizePath(projectPath), sessionId, model: model ?? null, effort: effort ?? null })
    broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: sessionId ?? null,
      event: { type: 'system', subtype: 'spawn_config', model: model ?? null, effort: effort ?? null } })
  }

  let buf = ''
  // ⚠️ setEncoding 必加（少爺 2026-09-08 回報「TC 的 Commit 出現的字是亂碼，而 Fork 是正確的繁體中文」根因）：
  //    繁中每字 3 bytes，Claude 串流的 chunk 邊界可能切在字元中間；逐塊 chunk.toString() 會把半截位元組
  //    各自解成替換字元、原位元組隨即丟失無法還原 → 英文正常、中文壞掉。setEncoding 讓 Node 走 StringDecoder，
  //    跨 chunk 保留未完成的多位元組序列。（既有的 buf/lines.pop() 只處理「行」邊界，處理不到「字元」邊界）
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        // Capture session_id from init + mark as subprocess session
        if (event.type === 'system' && event.subtype === 'init') {
          claudeLanes.adopt(entry, event.session_id)
          subprocessSids.add(event.session_id)
          persistSubprocessSids()
          _releaseCwd()
          // 新聊天室的 model/effort 選擇在拿到 session id 後記成偏好，續聊/QA 喚醒沿用
          setSessionPrefs(event.session_id, entry.model ?? null, entry.effort ?? null)
          // TC 出身聊天室進 Sessions 側欄（少爺 2026-07-15 拍板）：建檔由 spawn 生命週期做（hook 對
          // subprocess 只可更新不可建）——名稱照「最初首句」規則，origin:'tc' 給前端掛 🍷 出身標記
          {
            const _cur = sessions.get(event.session_id)
            const _raw = _cur?.topic ?? getSessionTopic(event.session_id) ?? prompt
            // 喚醒/測試前綴「(TC ...)」不進名稱（最初首句規則的 TC 變體）
            const _topic = (_raw.replace(/^\((TC|probe)[^)]*\)\s*/, '').trim() || _raw).slice(0, 60)
            upsertSession(event.session_id, {
              origin: 'tc', status: 'active', cwd: projectPath,
              topic: _topic, displayName: _topic.slice(0, 40),
            })
            broadcast({ type: 'session', session: sessions.get(event.session_id) })
          }
          // 呼叫端要拿新 session id 做後續綁定時用（少爺 2026-07-14：QA 未綁定 run 自動開新聊天室並綁回）
          if (onInit) try { onInit(event.session_id) } catch {}
        }
        // Skip hook noise
        if (event.type === 'system' && (event.subtype === 'hook_started' || event.subtype === 'hook_response')) continue
        if (event.type === 'assistant') entry.sawAssistant = true
        broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: entry.sessionId ?? null, event })
      } catch {}
    }
    // TC 聊天室的側欄活動時間隨輸出刷新（in-memory；持久化靠既有 schedulePersist 節奏）
    const _sess = entry.sessionId ? sessions.get(entry.sessionId) : null
    if (_sess) _sess.lastSeenAt = Date.now()
  })

  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', chunk => {
    const text = String(chunk).trim()
    // 帶 sessionId：同專案多室並行時，前端才分得出是哪一室的輸出
    if (text) broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: entry.sessionId ?? null, event: { type: 'stderr', text } })
  })

  proc.on('close', code => {
    entry.status = 'done'
    _releaseCwd()
    // 帶 sessionId：沒帶的 done 會讓同專案每個聊天室面板都以為自己跑完了
    broadcast({ type: 'claude_stream', projectPath: normalizePath(projectPath), sessionId: entry.sessionId ?? null, event: { type: 'done', exitCode: code } })
    // 側欄的 TC 聊天室轉 done（閒置 20 分鐘後自動退場）
    if (entry.sessionId && sessions.has(entry.sessionId)) setStatus(entry.sessionId, 'done')
    setTimeout(() => claudeLanes.release(entry), 10_000)
    // 喚醒石沉偵測（少爺 2026-07-17「按結案沒反應」根治）：resume 進程零 assistant 產出＝prompt 被
    // enqueue 進 transcript 但無人消費（同 session 交接縫隙競態）→ 隔 8 秒重試一次（競態窗已過，
    // 重試幾乎必達）；重試仍石沉 → 綁定 run 標 undelivered 上牆，請少爺在聊天室說「請繼續」。
    // 重試前的 8 秒該室視同忙碌（hold）：期間進來的請求排進該室隊伍，不搶進同一個縫隙。
    if (sessionId && !entry.sawAssistant) {
      logEvent('claude.headless.swallowed', { projectPath: normalizePath(projectPath), sessionId, exitCode: code, retryCount })
      if (retryCount < 1) {
        claudeLanes.hold(sessionId)
        setTimeout(() => {
          // 正常不會有別的進程在同室跑（hold 期間都排隊）；萬一有，重試改排隊、不丟
          if (claudeLanes.runningEntry(sessionId)) {
            claudeLanes.unhold(sessionId)
            enqueueSessionRun(sessionId, { projectPath, prompt, model, effort, onInit })
            return
          }
          spawnClaude(projectPath, prompt, sessionId, model, effort, onInit, retryCount + 1, quiet)
        }, 8000)
      } else { markWakeUndelivered(sessionId); processQueueIfIdle(sessionId) }
      return   // 首次石沉不觸發 queue 消化（重試在途，避免 queue 下一則撞同一縫隙）
    }
    // 處理該聊天室隊伍的下一則（如果有）— 維持「直接送 + 不中斷」UX
    processQueueIfIdle(entry.sessionId)
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
  const { projectPath: rawPath, prompt, sessionId, attachments, model, effort, qaFlow, newSession } = request.body
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

  // ⭐ 做法 B 直投優先（少爺 2026-10-04「實測TC做法B」）：分頁已登記直投 → 直接投進它的官方收件管道
  //    （忙碌＝回合中注入、閒置＝當場開新回合），不必靠監看輪詢；投不出去（未登記／位址已換）才走下面既有的監看 inbox／無頭。
  //    寫出位元組後一律不重送（post_unknown 也算已送）。總設定 delivery.directPipe=false 可關。
  if (newSession !== true && sessionId && ccmsgAvailable(sessionId)) {
    const _direct = await ccmsgPostVerified(sessionId, fullPrompt, { kind: 'chat' })
    if (_direct.state === 'posted' || _direct.state === 'post_unknown') {
      emitLog(sessionId, `[TC] 訊息已直投到 VS Code 分頁（做法 B，收據：${_direct.receipt ?? '不明'}）`, 'hook')
      logEvent('tc.chat.delivered_direct', { sessionId, projectPath: normalizePath(projectPath), tag: _direct.tag, receipt: _direct.receipt ?? null })
      if (tempFiles.length) setTimeout(() => { for (const f of tempFiles) try { fs.unlinkSync(f) } catch {} }, INBOX_TTL_MS)
      return { ok: true, projectPath: normalizePath(projectPath), sessionId, delivered: 'direct', receipt: _direct.receipt ?? null }
    }
  }

  // ⭐ 原地聯動優先（少爺 2026-09-08「全部都要聯動」）：目標聊天室掛著活監看 → 投進 inbox 讓那個
  // VS Code 分頁原地處理，不 spawn 無頭（無頭恆不會讓已開的分頁動，且與分頁進程雙寫 transcript）。
  // 分頁的回應照樣寫進同一份 transcript，/api/session/watch 的 tail 會把畫面帶回 TC 聊天室面板。
  if (newSession !== true && sessionId && isMonitorAlive(sessionId)) {
    pushSessionInbox(sessionId, 'chat', fullPrompt)
    emitLog(sessionId, '[TC] 訊息已投遞到 VS Code 分頁原地處理（監看聯動）', 'hook')
    logEvent('tc.chat.delivered_inplace', { sessionId, projectPath: normalizePath(projectPath) })
    // 附件路徑已寫進 prompt，交給分頁自行讀取；沒有 proc close 可掛，改用延遲清理
    if (tempFiles.length) setTimeout(() => { for (const f of tempFiles) try { fs.unlinkSync(f) } catch {} }, INBOX_TTL_MS)
    return { ok: true, projectPath: normalizePath(projectPath), sessionId, delivered: 'monitor' }
  }

  // 該聊天室思考中 → 排進它自己的隊伍，不 kill 上一個；其他聊天室（含同專案）照樣並行（少爺 2026-10-05）。
  // 沒帶 sessionId＝新聊天室，永不排隊、直接起獨立進程（少爺 2026-08-06／09-11 開新聊天室的規則一般化）；
  // ChatPanel 新聊天室在 init 前的第二則由前端先留著、拿到 session id 才送（ChatPanel.jsx handleSend）。
  const _newSession = newSession === true
  const _r = runOrQueueForSession(projectPath, fullPrompt, _newSession ? null : (sessionId ?? null), _model, _effort)
  if (_r.queued) return { ok: true, queued: true, queuePos: _r.pos }
  const entry = _r.entry

  // Clean up temp files after subprocess closes
  if (tempFiles.length) {
    entry.proc.on('close', () => {
      for (const f of tempFiles) try { fs.unlinkSync(f) } catch {}
    })
  }

  return { ok: true, projectPath: normalizePath(projectPath), sessionId: entry.sessionId }
})

// 停止＝停該聊天室的進程（同專案別室並行中的不受影響）；沒帶 sessionId＝停同專案還沒拿到 session id 的新聊天室
app.post('/api/claude/stop', async (request) => {
  const { projectPath, sessionId } = request.body ?? {}
  const _targets = sessionId
    ? [claudeLanes.runningEntry(sessionId)].filter(Boolean)
    : claudeLanes.pendingInitInProject(projectPath)
  for (const entry of _targets) if (entry?.proc) try { entry.proc.kill(); entry.status = 'stopped' } catch {}
  return { ok: true, stopped: _targets.length }
})

// 每室一列（並行時同專案會有多列）；Restart-TCServer.ps1 靠本 API 判斷有沒有無頭聊天室在跑
app.get('/api/claude/processes', async () => ({
  processes: claudeLanes.entries().map(e => ({
    projectPath: e.projectPath, sessionId: e.sessionId ?? null, status: e.status,
    queued: e.sessionId ? claudeLanes.queueLength(e.sessionId) : 0,
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
  // 診斷用（少爺 2026-08-15「演出看不到」）：列內花費演出的活水源頭是 session_live，
  // 而 session_live 只有掛著 tail 的聊天室才會發 —— 沒掛上就是靜默無演出，從外面看不出差別
  watched: [...watchedSessions.keys()],
  activeSessions: [...sessions.values()].filter(s => s.status === 'active').map(s => s.id),
}))

// ─── client 診斷回報（少爺 2026-08-15「總結算又沒看到」）──────────────────────
// 瀏覽器 console 我看不到，讓 client 把關鍵判斷路徑打回 server log，用實據定位而非推論。
// ⚠️ 暫時性診斷，問題收斂後移除。
app.post('/api/debug/client', async (request) => {
  const { tag, detail } = request.body ?? {}
  console.log(`[client] ${tag} ${JSON.stringify(detail ?? {})}`)
  emitLog(null, `[client] ${tag} ${JSON.stringify(detail ?? {})}`, 'debug')
  return { ok: true }
})

// ─── 模型目錄 ─────────────────────────────────────────────────────────────────
// client 的模型下拉與成本演出都吃這支，不再各自硬編一份（少爺 2026-08-15）

/**
 * 重建模型目錄並推播給所有前端。開機／每日／換版／手動四條路都走這支，
 * 日誌與推播只有一份，不會有哪條路漏報。
 */
function refreshModelCatalog(InReason) {
  const _cat = buildCatalog(getClaudeExe())
  broadcast({ type: 'model_catalog', catalog: _cat })
  console.log(`[models] ${_cat.models.length} 筆（官方表 ${_cat.officialSource}／掃描 ${_cat.source}／${InReason}）`
    + (_cat.newlyDiscovered.length ? ` · 新模型 ${_cat.newlyDiscovered.join(', ')}` : '')
    + (_cat.excludedRetired.length ? ` · 已退役擋下 ${_cat.excludedRetired.join(', ')}` : '')
    + (_cat.excludedUnlisted.length ? ` · 官方未收錄擋下 ${_cat.excludedUnlisted.join(', ')}` : ''))
  logEvent('models.refresh', {
    reason: InReason, source: _cat.source, official: _cat.officialSource, count: _cat.models.length,
    newlyDiscovered: _cat.newlyDiscovered, estimated: _cat.estimated,
    excludedRetired: _cat.excludedRetired, excludedUnlisted: _cat.excludedUnlisted,
  })
  if (_cat.newlyDiscovered.length) {
    console.log(`[models] 新模型 ${_cat.newlyDiscovered.join(', ')} 官方表還沒收錄 —— 價暫沿用同 tier 並標 ⚠，`
      + `要先校正就改 ${'~/.claude/tc_model_catalog.json'} 的 overrides`)
    logEvent('models.discovered', { ids: _cat.newlyDiscovered })
  }
  return _cat
}

app.get('/api/models', async () => getCatalog(getClaudeExe()))

app.post('/api/models/refresh', async () => refreshModelCatalog('manual'))

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
          let lastMsgTs = 0   // 最後一句「真實對話」（user/assistant）的時間——metadata 行（last-prompt 等）不算
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
              if ((o.type === 'user' || o.type === 'assistant') && o.timestamp) {
                const _t = Date.parse(o.timestamp)
                if (_t > lastMsgTs) lastMsgTs = _t
              }
              // Most recent result/stop tells us status
              if (o.type === 'result') lastStatus = 'done'
            } catch {}
          }
          if (!hasActivity) continue   // skip empty/init-only files
          // TC 出身 sid：掃描器只可更新既有條目、不可建檔（2026-07-15 對齊 hook 同款政策——
          // 全跳過會讓 tc 條目狀態凍結、孤兒守護者工作時 session_live 不掛監看、TC Chat 看不到直播）
          if (subprocessSids.has(sid) && !sessions.has(sid)) continue
          // 復活判定看「最後真實對話」不看檔案 mtime（少爺 2026-07-15：VS Code 重載會對所有舊 session 檔
          // 補 last-prompt 中繼行 → mtime 全新 → 清掉的舊 session 被掃描器復活）——沒新對話的不重新註冊。
          // 門檻與自動退場（20 分鐘）一致，避免「掃描器加回、退場再移除」振盪
          if (!sessions.has(sid) && (!lastMsgTs || now - lastMsgTs > SESSION_RETIRE_MS)) continue
          // Determine if session looks "active" (file modified < 3 min ago and no result event at end)
          const recentlyWritten = now - st.mtimeMs < 3 * 60 * 1000
          const lastLine = lines[lines.length - 1] ?? ''
          let lastType = null
          try { lastType = JSON.parse(lastLine).type } catch {}
          // active 判定也看真實對話時間（metadata 觸碰不該讓舊 session 亮綠燈）
          const looksActive = recentlyWritten && lastType !== 'result' && (now - lastMsgTs < 3 * 60 * 1000)
          const status = looksActive ? 'active' : 'done'
          const displayName = aiTitle ?? firstUser ?? sid.slice(0, 8)
          // Upsert — only protect active→done downgrade when file is very recent
          // (race: hook fired but Claude hasn't written output yet).
          // recentlyWritten = < 3 min; if older, allow downgrade.
          const cur = sessions.get(sid)
          if (cur && cur.status === 'active' && status === 'done' && recentlyWritten) continue
          const s = upsertSession(sid, { displayName, cwd: cwd ?? cur?.cwd, status, startedAt: st.birthtimeMs ?? st.mtimeMs, ...(lastMsgTs ? { lastSeenAt: Math.max(cur?.lastSeenAt ?? 0, lastMsgTs) } : {}) }, false)
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

// 夜間標籤排程 + tagger transcript 清掃的啟動呼叫（2026-08-06 從模組前段移來）：
// 必須在 EVENTS_DIR / ensureMetricsDir / logEvent 定義之後才呼叫，否則 scheduleNextNightly 內的
// logEvent 會撞 EVENTS_DIR 的 TDZ → tags.nightly.scheduled 靜默失敗（見前段移除處註解）
cleanTaggerTranscripts()
scheduleNextNightly()

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

// ─── 打包控制（少爺 2026-08-04：QA 分頁直接打包 Dev / Shipping、看進度、開產物資料夾）──
// SOP: .agent/workflows/Roman_Packaging_SOP.md ／ 腳本: .agent/scripts/Invoke-RomanPackage.ps1
// 命名 SSOT 與腳本一致：Windows_<Dev|Shipping>_<yyyyMMdd><suffix>

const PACKAGE_SCRIPT = 'C:\\Project\\RomanPrototype\\.agent\\scripts\\Invoke-RomanPackage.ps1'
const PACKAGE_BUILD_ROOT = 'C:\\Project\\RomanPrototype\\Build'
const PACKAGE_TAIL_MAX = 60

// 打包＝跑很久的外部工作，生命週期不可綁在本 server 上（少爺 2026-08-05）：
//   ① 子進程 detached＋stdout 直寫 log 檔（自己持有 handle）→ server 重啟不影響打包、log 不斷
//   ② server 只「tail 那個 log 檔」取進度 → 重啟後重讀即可復原進度，不必重接管道
//   ③ job 狀態 atomicWriteJson 落檔 → 重啟後介面不空白（沿用 TC 既有 sessions/subprocSids 慣例）
const PACKAGE_JOB_FILE = path.join(os.homedir(), '.claude', 'tc_package_job.json')

let packageJob = null      // { id, config, suffix, status, phase, cook, tail[], results[], pid, logPath }
let packageProc = null     // 本 server 生命週期內才有；重啟後為 null 但 job 仍可靠 pid + log 續管
let packageBcastAt = 0
let packageTailTimer = null
let packageTailOffset = 0
let packageTailBuf = ''

function packageDateStamp() {
  const _d = new Date()
  return `${_d.getFullYear()}${String(_d.getMonth() + 1).padStart(2, '0')}${String(_d.getDate()).padStart(2, '0')}`
}

function persistPackageJob() {
  try {
    if (packageJob) atomicWriteJson(PACKAGE_JOB_FILE, packageJob)
    else if (fs.existsSync(PACKAGE_JOB_FILE)) fs.unlinkSync(PACKAGE_JOB_FILE)
  } catch { /* 落檔失敗不影響打包本身 */ }
}

// 進程存活判定（重啟後 packageProc 為 null，只能靠 pid）
function isPackagePidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }   // EPERM = 存在但無權限 → 仍算活著
}

function broadcastPackage(force = false) {
  if (!packageJob) return
  const _now = Date.now()
  // 節流：UAT 每秒數十行，逐行推會淹掉 ws（完成/失敗一律 force）
  if (!force && _now - packageBcastAt < 800) return
  packageBcastAt = _now
  persistPackageJob()
  broadcast({ type: 'package_update', job: packageJob })
}

// 從 log 檔續讀（offset 制）：這是重啟後唯一的進度來源
function readPackageLog() {
  if (!packageJob?.logPath) return
  try {
    const _size = fs.statSync(packageJob.logPath).size
    if (_size <= packageTailOffset) return
    const _fd = fs.openSync(packageJob.logPath, 'r')
    const _len = _size - packageTailOffset
    const _buf = Buffer.alloc(_len)
    fs.readSync(_fd, _buf, 0, _len, packageTailOffset)
    fs.closeSync(_fd)
    packageTailOffset = _size
    packageTailBuf += _buf.toString('utf-8')
    const _lines = packageTailBuf.split(/\r?\n/)
    packageTailBuf = _lines.pop() ?? ''
    for (const _l of _lines) parsePackageLine(_l)
  } catch { /* log 還沒建立 / 讀取瞬間被鎖 → 下一輪再試 */ }
}

function stopPackageTail() {
  if (packageTailTimer) clearInterval(packageTailTimer)
  packageTailTimer = null
}

function startPackageTail() {
  stopPackageTail()
  packageTailTimer = setInterval(() => {
    readPackageLog()
    if (packageJob?.status !== 'running') return
    if (packageJob.pid) {
      // 進程沒了但狀態還停在 running → 由 log 內容定案（涵蓋「server 重啟期間打包結束」）
      if (!isPackagePidAlive(packageJob.pid)) finalizePackageJob(null)
    }
    // PID 還沒從 log 讀到：給 60 秒寬限（powershell 起步＋Start-Transcript），超時＝啟動層失敗
    else if (Date.now() - packageJob.startedAt > 60000) finalizePackageJob(-1)
  }, 700)
}

// 解析腳本與 UAT 輸出 → 進度（少爺要看得到「跑到哪」而不是只有轉圈）
function parsePackageLine(line) {
  if (!packageJob) return
  const _t = line.trim()
  if (!_t) return

  packageJob.tail.push(_t)
  if (packageJob.tail.length > PACKAGE_TAIL_MAX) packageJob.tail.shift()

  let _force = false

  // 腳本自報 PID（cmd /c start 啟動法下，這是唯一能拿到真進程的管道）
  const _pid = _t.match(/^\[Package\] PID=(\d+)/)
  if (_pid) { packageJob.pid = Number(_pid[1]); _force = true }

  // 腳本自身的階段標記
  const _sect = _t.match(/^\[Package\] ===== (\w+) \((\w+)\)/)
  if (_sect) { packageJob.currentTarget = _sect[1]; packageJob.phase = 'starting'; packageJob.cook = null; _force = true }
  else if (/^\[Package\] RunUAT start/.test(_t)) { packageJob.phase = 'cooking'; _force = true }
  else if (/^\[Package\] Archiving/.test(_t)) { packageJob.phase = 'archiving'; packageJob.cook = null; _force = true }

  // UAT 階段 banner（腳本 2026-08-07 改逐行串流後才 tail 得到；比 RunUAT start 的粗階段更細）
  // 'cooking'（RunUAT start）保留當 fallback：banner 沒出現時仍有粗階段可顯示
  const _uat = _t.match(/^\*{5,} (BUILD|COOK|STAGE|PACKAGE|ARCHIVE) COMMAND STARTED/)
  if (_uat) {
    packageJob.phase = `uat_${_uat[1].toLowerCase()}`
    if (_uat[1] !== 'COOK') packageJob.cook = null
    _force = true
  }

  const _done = _t.match(/^\[Package\] (\w+) DONE in (\d+) min/)
  if (_done) {
    packageJob.results.push({ target: _done[1], status: 'ok', minutes: Number(_done[2]) })
    packageJob.phase = 'idle'; packageJob.cook = null; _force = true
  }
  const _fail = _t.match(/^\[Package\] (\w+) FAILED \(([^)]*)\)/)
  if (_fail) {
    packageJob.results.push({ target: _fail[1], status: 'failed', reason: _fail[2] })
    packageJob.phase = 'idle'; packageJob.cook = null; _force = true
  }

  // UAT cook 進度（真正的長時間段落）
  const _cook = _t.match(/Cooked packages (\d+) Packages Remain (\d+)/)
  if (_cook) {
    const _c = Number(_cook[1]), _r = Number(_cook[2])
    packageJob.cook = { done: _c, remain: _r, percent: (_c + _r) > 0 ? Math.round((_c / (_c + _r)) * 100) : null }
  }

  broadcastPackage(_force)
}

// 收尾單一出口：子進程 exit（server 活著）與 tail 偵測到 pid 消失（server 重啟後）共用
// @param InExitCode 有拿到才傳；重啟後無從得知 → 傳 null，改由 log 是否有 Summary 判定
function finalizePackageJob(InExitCode) {
  if (!packageJob || packageJob.status !== 'running') return

  readPackageLog()   // 收尾前再讀一次，避免漏掉最後幾行（含 Summary / FAILED）
  stopPackageTail()

  packageJob.exitCode = InExitCode
  packageJob.finishedAt = Date.now()
  packageJob.phase = 'idle'
  packageJob.cook = null

  // 腳本跑完必印 Summary。沒有 Summary 時要分清兩種：
  //   有 exitCode（本 server 全程看著它結束）＝腳本異常結束 → failed（別誤標成中斷）
  //   無 exitCode（重啟後才發現進程不見）＝中途被斬 → interrupted
  const _hasSummary = packageJob.tail.some(l => /^\[Package\] ===== Summary/.test(l)) || packageJob.results.length > 0
  const _anyFail = packageJob.results.some(r => r.status === 'failed')
  if (!_hasSummary) {
    packageJob.status = (InExitCode === null) ? 'interrupted' : 'failed'
    if (packageJob.tail.length === 0) packageJob.tail.push(`（腳本無任何輸出，exit=${InExitCode}；log=${packageJob.logPath}）`)
  }
  else packageJob.status = ((InExitCode ?? 0) === 0 && !_anyFail) ? 'done' : 'failed'

  packageProc = null

  // 少爺 2026-08-04：打包失敗 → 自動喚 Claude 分析根因並建立「修復到能順利打包」的 QA Run
  //（取消/中斷不算失敗、不喚醒；沿用既有 spawnClaude，不自造第二套喚醒）
  // F4（少爺 2026-08-05）：區分「前置守衛類假失敗」與「真失敗」。
  //「output already exists」是 -Force 守衛的正確攔阻（產物早已完整、不是打壞），
  // 喚 Claude 分析純屬浪費（實測噴 13.26M token/Opus）；只有真失敗
  //（UAT 非 0／cook 炸／staged 缺失／腳本層崩、results 空）才喚醒。
  if (packageJob.status === 'failed') {
    const _fails = packageJob.results.filter(r => r.status === 'failed')
    const _isGuardBlock = (r) => /already exists|exists, need/i.test(r.reason ?? '')
    const _realFails = _fails.filter(r => !_isGuardBlock(r))
    const _guardOnly = _fails.length > 0 && _realFails.length === 0   // 有 failed 且全是 exists 類 = 純守衛攔阻
    // 腳本連 log 都沒寫出來（啟動層就死）＝沒有可分析的素材，喚 Claude 只會空轉燒 token
    if (!_hasSummary && packageJob.results.length === 0) {
      packageJob.analysis = { state: 'skipped', reason: '腳本無任何輸出（啟動層失敗）＝無可分析素材，不喚 Claude', at: Date.now() }
      logEvent('package.failure.no_output', { id: packageJob.id, exitCode: InExitCode })
    }
    else if (_guardOnly) {
      packageJob.analysis = { state: 'skipped', reason: '前置守衛攔阻（產物已存在，需 -Force）＝非真失敗，不喚 Claude', at: Date.now() }
      logEvent('package.failure.guard_skipped', { id: packageJob.id, config: packageJob.config, reasons: _fails.map(r => r.reason) })
    }
    else triggerPackageFailureAnalysis(packageJob)
  }

  broadcastPackage(true)
}

// 打包失敗 → 喚 Claude 分析根因＋建立修復 QA Run（少爺 2026-08-04）
function triggerPackageFailureAnalysis(job) {
  try {
    const _cwd = 'C:\\Project\\RomanPrototype'
    if (!isSafeCwd(_cwd)) return
    // 分析是開新聊天室、只讀 log 建 QA Run——與同專案其他聊天室並行，不因專案忙碌而跳過（少爺 2026-10-05）

    const _failed = job.results.filter(r => r.status === 'failed').map(r => `${r.target}(${r.reason})`).join('、')
      || `exit ${job.exitCode}`
    const _tail = job.tail.slice(-25).join('\n')

    const _prompt = [
      `(TC 打包失敗自動通知) 羅馬打包失敗，請分析並建立修復 QA Run。`,
      ``,
      `失敗組態：${_failed}`,
      `打包設定：config=${job.config}、suffix=${job.suffix}、日期=${job.dateStamp}`,
      `完整 log：${job.logPath}`,
      ``,
      `尾段輸出：`,
      '```',
      _tail,
      '```',
      ``,
      `請照以下順序處理：`,
      `1. 讀 .agent/workflows/Roman_Packaging_SOP.md §四陷阱索引，比對本次失敗是否命中既知陷阱`,
      `   （PoseSearch cook 卡死＝查 log 裡 "PreCancelled because of X" 的 X 才是元兇／Mover mode ClassWithin cook-only 炸／BP 類子系統打包版不存在）`,
      `2. 讀完整 log 找真因（tail 只有 25 行，根因通常在更前面；用 grep 找 Error/Fatal/PreCancelled/Missing）`,
      `3. 列 2-3 個可能根因再收斂（feedback_diagnosis_hold_hypotheses_before_commit），不要太快 commit 單一結論`,
      `4. POST http://127.0.0.1:3001/api/qa/runs 建立 QA Run：topic 標明「打包修復」、requirement 寫失敗現象與你的根因判斷、`,
      `   criteria 至少含「C1 該組態能完整打包成功並產出可執行檔」、items 涵蓋修復驗證與回歸（其他組態不被修壞）`,
      `5. 修復動工前照 QA Mode C 把計畫寫成 QAPC 交少爺審（QA/README.md §Mode C），不要直接改`,
    ].join('\n')

    // F4（少爺 2026-08-05）：喚醒降 sonnet/low —— 讀 log 找根因＋建 QA Run 不需 Opus 全力，省 token
    spawnClaude(_cwd, _prompt, null, 'sonnet', 'low')
    job.analysis = { state: 'spawned', model: 'sonnet', effort: 'low', at: Date.now() }
    logEvent('package.failure.analysis_spawned', { id: job.id, config: job.config, failed: _failed, model: 'sonnet', effort: 'low' })
  } catch (e) {
    job.analysis = { state: 'error', reason: e.message, at: Date.now() }
  }
}

app.post('/api/package/start', async (request) => {
  const { config = 'Both', suffix = '_WithExtraWorks', overwrite = false } = request.body ?? {}
  if (!['Dev', 'Shipping', 'Both'].includes(config)) return { ok: false, error: 'invalid config' }
  // 後綴會直接進資料夾名 → 只放行檔名安全字元（擋路徑穿越與參數注入）
  if (!/^[\w-]*$/.test(suffix)) return { ok: false, error: '後綴只能用英數 / 底線 / 連字號' }
  if (packageJob?.status === 'running') return { ok: false, error: '已有打包進行中', job: packageJob }

  const _stamp = packageDateStamp()

  // 同日重打會覆寫既有產物（動輒 2GB+）→ 未明確確認前不動手（腳本端也有 -Force 把關，雙保險）
  if (!overwrite) {
    const _targets = config === 'Both' ? ['Dev', 'Shipping'] : [config]
    const _existing = _targets
      .map(t => `Windows_${t}_${_stamp}${suffix}`)
      .filter(name => { try { return fs.existsSync(path.join(PACKAGE_BUILD_ROOT, name)) } catch { return false } })
    if (_existing.length) return { ok: false, needsConfirm: true, existing: _existing }
  }
  const _jobId = `pkg${Date.now()}`
  // 完整輸出落檔：tail 只留 60 行，cook 失敗的真因（PreCancelled because of X）往往在幾千行前
  const _logDir = path.join(PACKAGE_BUILD_ROOT, '__package_logs')
  try { fs.mkdirSync(_logDir, { recursive: true }) } catch {}
  const _logPath = path.join(_logDir, `${_jobId}.log`)

  packageJob = {
    id: _jobId,
    config, suffix, dateStamp: _stamp,
    targets: config === 'Both' ? ['Dev', 'Shipping'] : [config],
    folders: (config === 'Both' ? ['Dev', 'Shipping'] : [config]).map(t => `Windows_${t}_${_stamp}${suffix}`),
    status: 'running', phase: 'starting', currentTarget: null, cook: null,
    startedAt: Date.now(), finishedAt: null,
    tail: [], results: [], exitCode: null,
    logPath: _logPath, analysis: null,
  }
  // 用 `cmd /c start` 啟動（沿用 TC 既有 open-url 的做法）：start 會配新 console，powershell 才活得下來，
  // 且 cmd 立刻退出 → powershell 完全脫離本 server，重啟/掛掉都不中斷打包。
  // ⚠️ 走過的兩條死路（2026-08-05 實測）：
  //    ① node `detached:true` = DETACHED_PROCESS 不配 console → powershell 秒退、log 0 bytes
  //    ② `Start-Process` 在 pm2 服務脈絡下無聲失敗（TC 既有註解 line ~4328 已記錄）
  // ⚠️ log 由腳本自己寫（-LogPath → Start-Transcript）；PID 也由腳本自報（cmd 的 pid 沒用）
  try {
    const _psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PACKAGE_SCRIPT,
      '-Config', config, '-Suffix', suffix, '-LogPath', _logPath]
    if (overwrite) _psArgs.push('-Force')
    packageProc = spawn('cmd.exe', ['/c', 'start', 'Roman Package', '/min', 'powershell.exe', ..._psArgs], {
      cwd: 'C:\\Project\\RomanPrototype', detached: true, stdio: 'ignore', windowsHide: true,
    })
    packageProc.unref()
    packageProc = null           // cmd 立刻結束，留著它沒有意義；真 pid 由 log 的 [Package] PID= 補上
    packageJob.pid = null
  } catch (e) {
    packageJob.status = 'failed'; packageJob.finishedAt = Date.now(); packageJob.tail.push(`spawn failed: ${e.message}`)
    broadcastPackage(true)
    return { ok: false, error: e.message }
  }

  // 收尾一律交給 tail 的 pid 存活檢查：cmd /c start 啟動法下我們拿不到真進程物件
  //（cmd 立刻退出、它的 exit 事件毫無意義），所以這裡不掛任何 exit 監聽
  packageTailOffset = 0
  packageTailBuf = ''
  startPackageTail()

  broadcastPackage(true)
  return { ok: true, job: packageJob }
})

app.get('/api/package/status', async () => ({ ok: true, job: packageJob }))

app.post('/api/package/cancel', async () => {
  // 用 job.pid 而非 packageProc：server 重啟後 packageProc 為 null，但打包還在跑、仍須可中止
  if (packageJob?.status !== 'running' || !packageJob.pid) return { ok: false, error: '沒有進行中的打包' }
  try { spawnSync('taskkill', ['/pid', String(packageJob.pid), '/T', '/F']) } catch { /* 已結束 */ }
  stopPackageTail()
  readPackageLog()
  packageJob.status = 'cancelled'
  packageJob.finishedAt = Date.now()
  packageJob.phase = 'idle'
  packageJob.cook = null
  packageProc = null
  broadcastPackage(true)
  return { ok: true }
})

// 開機復原（少爺 2026-08-05）：server 重啟後把上次的 job 撿回來
//   還在跑 → 從 log 頭重讀重建進度＋續 tail；已結束 → 直接由 log 定案（含補觸發失敗分析）
try {
  const _savedJob = JSON.parse(fs.readFileSync(PACKAGE_JOB_FILE, 'utf-8'))
  if (_savedJob?.id) {
    packageJob = _savedJob
    if (packageJob.status === 'running') {
      packageTailOffset = 0
      packageTailBuf = ''
      packageJob.tail = []
      packageJob.results = []
      packageJob.cook = null
      readPackageLog()   // 重播整份 log → results / phase / cook 全部重建
      if (isPackagePidAlive(packageJob.pid)) {
        logEvent('package.restore.resumed', { id: packageJob.id, pid: packageJob.pid })
        startPackageTail()
      }
      else {
        logEvent('package.restore.finalize', { id: packageJob.id })
        finalizePackageJob(null)   // server 重啟期間就跑完/被斬了 → 現在定案
      }
    }
  }
} catch { /* 沒有前次 job 或檔壞掉 → 當作全新開始 */ }

// 開啟產物資料夾（挑該組態「最新一份」；日期為 yyyyMMdd → 字典序即時間序）
app.post('/api/package/open', async (request) => {
  const { target = 'Dev', suffix = '' } = request.body ?? {}
  if (!['Dev', 'Shipping'].includes(target)) return { ok: false, error: 'invalid target' }

  let _dir = PACKAGE_BUILD_ROOT
  try {
    const _prefix = `Windows_${target}_`
    const _all = fs.readdirSync(PACKAGE_BUILD_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(_prefix)).map(e => e.name).sort()
    const _matched = suffix ? _all.filter(n => n.endsWith(suffix)) : _all
    const _pick = (_matched.length ? _matched : _all).pop()
    if (_pick) _dir = path.join(PACKAGE_BUILD_ROOT, _pick)
  } catch { /* 讀不到就退回 Build 根目錄 */ }

  try {
    const _p = spawn('explorer.exe', [_dir], { detached: true, stdio: 'ignore', shell: false })
    _p.unref()
    return { ok: true, path: _dir }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── 開啟專案（少爺 2026-08-06）：一鍵開 uproject／workspace／根目錄 Explorer ──────
// 隨 activeProjectId 切路徑（前端傳 projectId）；projectRoot 讀 sommelier.json（每專案補）。
// uproject／workspace 掃根目錄找副檔名——檔名未必＝資料夾名（RomanPrototype/romanprototype.uproject）。
app.post('/api/project/open', async (request) => {
  const { projectId, target } = request.body ?? {}
  const _cfg = readSommelierConfig()
  const _proj = (_cfg.projects ?? []).find(p => p.id === projectId)
  const _root = _proj?.projectRoot || _proj?.projectPath
  if (!_root) return { ok: false, error: `專案「${projectId}」未設 projectRoot（請在 sommelier.json 補）` }
  if (!fs.existsSync(_root)) return { ok: false, error: `專案根目錄不存在：${_root}` }
  try {
    if (target === 'explorer') {
      spawn('explorer.exe', [path.normalize(_root)], { detached: true, stdio: 'ignore', shell: false }).unref()
      return { ok: true, opened: _root }
    }
    if (target === 'uproject' || target === 'workspace') {
      const _ext = target === 'uproject' ? '.uproject' : '.code-workspace'
      const _file = fs.readdirSync(_root).find(f => f.toLowerCase().endsWith(_ext))
      if (!_file) return { ok: false, error: `根目錄找不到 *${_ext}：${_root}` }
      const _full = path.join(_root, _file)
      // .code-workspace 沒有檔案關聯 → cmd start 開不起來，必用 VS Code CLI；.uproject 有 UE 關聯 → start 開
      // ⚠️ 必用 'code.cmd' 不可用裸 'code'：PATH 裡 VS Code 根目錄（含 Code.exe）排在 \bin 前、PATHEXT 又 .EXE 優先 .CMD
      // → 裸 code 會解析到 GUI 的 Code.exe；本進程繼承 ELECTRON_RUN_AS_NODE=1 使 Code.exe 以 node 模式把 workspace 當腳本跑而閃退。
      // code.cmd 是官方 CLI wrapper，內部走 cli.js 正確處理 node 模式並開 workspace。（少爺 2026-08-06 修）
      if (target === 'workspace') spawn('code.cmd', [_full], { detached: true, stdio: 'ignore', shell: true }).unref()
      else spawn('cmd', ['/c', 'start', '', _full], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, opened: _full }
    }
    // FMOD Studio 專案（少爺 2026-10-01）：開起來後 PIE 中 File › Connect to Game → 127.0.0.1:9264 看事件／聲部／參數
    if (target === 'fmod') {
      const _fspro = findFmodProject(_proj, _root)
      if (!_fspro) return { ok: false, error: `找不到 FMOD Studio 專案（*.fspro）：請在 sommelier.json 的 projects[].fmodProject 指定，或放在專案根目錄下三層內` }
      spawn('cmd', ['/c', 'start', '', _fspro], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, opened: _fspro, hint: 'PIE 中 File › Connect to Game → 127.0.0.1:9264' }
    }
    return { ok: false, error: `未知 target：${target}` }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// FMOD Studio 專案路徑：sommelier.json 的 fmodProject 優先；否則從根目錄往下找三層 *.fspro（略過建置產物與資產目錄）
const FMOD_SEARCH_SKIP = new Set(['node_modules', '.git', 'Intermediate', 'Saved', 'Binaries', 'DerivedDataCache', 'Content', 'Plugins', 'Build'])
function findFmodProject(InProject, InRoot) {
  if (InProject?.fmodProject && fs.existsSync(InProject.fmodProject)) return InProject.fmodProject
  let _level = [InRoot]
  for (let _depth = 0; _depth <= 3 && _level.length; _depth++) {
    const _next = []
    for (const _dir of _level) {
      let _entries = []
      try { _entries = fs.readdirSync(_dir, { withFileTypes: true }) } catch { continue }
      const _hit = _entries.find(e => e.isFile() && e.name.toLowerCase().endsWith('.fspro'))
      if (_hit) return path.join(_dir, _hit.name)
      for (const _e of _entries) if (_e.isDirectory() && !FMOD_SEARCH_SKIP.has(_e.name) && !_e.name.startsWith('.')) _next.push(path.join(_dir, _e.name))
    }
    _level = _next
  }
  return null
}

// ─── 專案路徑健康檢查（少爺 2026-08-06）：高桌會切專案時驗 projectRoot／打包腳本／uproject／
// workspace 是否存在（失聯偵測）→ 前端據此禁用失效按鈕、避免對不存在的路徑動作而系統出錯。
app.get('/api/project/health/:projectId', async (request) => {
  const _cfg = readSommelierConfig()
  const _proj = (_cfg.projects ?? []).find(p => p.id === request.params.projectId)
  if (!_proj) return { ok: false, error: `未知專案：${request.params.projectId}` }
  const _root = _proj.projectRoot || _proj.projectPath || null
  const _rootExists = !!_root && fs.existsSync(_root)
  let _uproject = null, _workspace = null
  if (_rootExists) {
    try {
      const _files = fs.readdirSync(_root)
      _uproject = _files.find(f => f.toLowerCase().endsWith('.uproject')) ?? null
      _workspace = _files.find(f => f.toLowerCase().endsWith('.code-workspace')) ?? null
    } catch { /* 讀不到目錄＝視同失聯 */ }
  }
  return {
    ok: true,
    health: {
      projectRoot: { path: _root, exists: _rootExists },
      packageScript: { path: _proj.packageScript ?? null, exists: !!_proj.packageScript && fs.existsSync(_proj.packageScript) },
      uproject: { name: _uproject, exists: !!_uproject },
      workspace: { name: _workspace, exists: !!_workspace },
      fmodProject: (() => { const _f = _rootExists ? findFmodProject(_proj, _root) : null; return { path: _f, exists: !!_f } })(),
    },
  }
})

// ─── 版控 Commit（少爺 2026-08-14）：手動 commit 面板，固定流程參數化 ────────────
// 規則 SSOT＝sommelier.json 的 projects[].git（staging / lang / coAuthor）；執行 SSOT＝Invoke-ProjectCommit.ps1。
// TC 面板與 Claude CLI 共用同一支腳本＝規則只有一份，Claude 不必每次重讀 commit 紀律再手跑 git（少爺的省 token 目的）。
// 分工：Claude POST /api/git/draft 把訊息草稿推上面板 → 少爺看過／改過 → 面板 POST /api/git/commit 才真的提交。
const PROJECT_COMMIT_SCRIPT = 'C:\\Project\\MasterBrain\\.agent\\scripts\\Invoke-ProjectCommit.ps1'
const GIT_DRAFTS_FILE = path.join(USER_CONFIG_DIR, 'git_drafts.json')

function readGitDrafts() {
  try { return JSON.parse(fs.readFileSync(GIT_DRAFTS_FILE, 'utf8')) } catch { return {} }
}

function writeGitDrafts(drafts) {
  atomicWriteJson(GIT_DRAFTS_FILE, drafts)
  broadcast({ type: 'git_draft_update', drafts })
}

// 依規則 Commit 紀錄（少爺 2026-08-20）：auto-commit 子進程提交完把雙語內容回寫，面板「展開檢視」用
const GIT_AUTOCOMMIT_RESULTS_FILE = path.join(USER_CONFIG_DIR, 'git_autocommit_results.json')

function readGitAutoResults() {
  try { return JSON.parse(fs.readFileSync(GIT_AUTOCOMMIT_RESULTS_FILE, 'utf8')) } catch { return {} }
}

function writeGitAutoResults(results) {
  atomicWriteJson(GIT_AUTOCOMMIT_RESULTS_FILE, results)
}

function gitRepoRoot(proj) {
  return proj?.git?.repoRoot || proj?.projectRoot || proj?.projectPath || null
}

// 只認有 git 規則的專案；不看 enabled——TC 自身這種「要 commit 但不是侍酒師分館」的 repo 也要能列
function findGitProject(projectId) {
  const _cfg = readSommelierConfig()
  return (_cfg.projects ?? []).find(p => p.id === projectId && p.git) ?? null
}

function gitProjectPolicy(proj) {
  return {
    staging: proj.git.staging ?? 'none',
    lang: proj.git.lang ?? 'en',
    coAuthor: proj.git.coAuthor !== false,
    allowStageOverride: proj.git.allowStageOverride === true,
  }
}

app.get('/api/git/projects', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const _cfg = readSommelierConfig()
  const _projects = (_cfg.projects ?? []).filter(p => p.git).map(p => {
    const _root = gitRepoRoot(p)
    return {
      id: p.id, name: p.name ?? p.id, repoRoot: _root,
      exists: !!_root && fs.existsSync(path.join(_root, '.git')),
      ...gitProjectPolicy(p),
    }
  })
  return { ok: true, projects: _projects, drafts: readGitDrafts(), autoResults: readGitAutoResults(), autoCommitQuiet: isQuietSetting(QA_AUTO_COMMIT_QUIET_KEY) }
})

// 面板現況：分支＋三類檔案清單（staged／已改未 staged／未追蹤）＋最後一筆 commit
app.get('/api/git/status', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const _proj = findGitProject(request.query.projectId)
  if (!_proj) return { ok: false, error: `專案「${request.query.projectId}」未設 git 規則` }
  const _root = gitRepoRoot(_proj)
  if (!_root || !fs.existsSync(path.join(_root, '.git'))) return { ok: false, error: `不是 git repo：${_root}` }
  // windowsHide 必加：QA 分頁每次顯示／切專案都會跑這 5～6 次 git，沒加＝每次彈出 4 個空白終端視窗（少爺 2026-10-08 勿擾）
  const _gitRaw = (args) => {
    const r = spawnSync('git', ['-C', _root, ...args], { encoding: 'utf-8', windowsHide: true })
    return r.status === 0 ? (r.stdout ?? '') : ''
  }
  const _git = (args) => _gitRaw(args).trim()
  // porcelain v1：XY <path>，X=index 狀態、Y=工作區狀態、?? =未追蹤
  // ⚠️ 這裡不能對整段輸出 trim：未 staged 的行開頭就是空白（" M path"），trim 掉第一行的空白會讓整行位移一格
  const _staged = [], _unstaged = [], _untracked = []
  for (const _line of _gitRaw(['status', '--porcelain']).split(/\r?\n/)) {
    if (!_line.trim()) continue
    const _x = _line[0], _y = _line[1], _file = _line.slice(3).trim()
    if (_x === '?') { _untracked.push(_file); continue }
    if (_x !== ' ') _staged.push({ file: _file, code: _x })
    if (_y !== ' ') _unstaged.push({ file: _file, code: _y })
  }
  // 領先／落後上游幾筆（少爺 2026-08-29）：逐筆推送要先知道會推幾筆；沒設上游時 rev-list 會失敗＝回空字串
  const _ahead = Number(_git(['rev-list', '--count', '@{u}..HEAD'])) || 0
  const _behind = Number(_git(['rev-list', '--count', 'HEAD..@{u}'])) || 0
  return {
    ok: true,
    projectId: _proj.id, repoRoot: _root, ...gitProjectPolicy(_proj),
    // --show-current 在 unborn branch 也答得出來；空字串時退回 rev-parse（detached HEAD 之類）
    branch: _git(['branch', '--show-current']) || _git(['rev-parse', '--abbrev-ref', 'HEAD']),
    lastCommit: _git(['log', '-1', '--format=%h %s']),
    ahead: _ahead, behind: _behind,
    staged: _staged, unstaged: _unstaged, untracked: _untracked,
  }
})

// 草稿（Claude → 面板）：message 照專案規則的語言寫，messageZh 是給少爺看的繁中對照（不寫進 commit）
app.post('/api/git/draft', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, message, messageZh, stage, paths, note } = request.body ?? {}
  if (!findGitProject(projectId)) return { ok: false, error: `專案「${projectId}」未設 git 規則` }
  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'message 不可空白' }
  const _drafts = readGitDrafts()
  _drafts[projectId] = {
    message: message.trim(),
    messageZh: typeof messageZh === 'string' ? messageZh.trim() : '',
    stage: ['none', 'all', 'paths'].includes(stage) ? stage : null,
    paths: Array.isArray(paths) ? paths : [],
    note: typeof note === 'string' ? note : '',
    at: Date.now(),
  }
  writeGitDrafts(_drafts)
  logEvent('git.draft', { projectId, stage: _drafts[projectId].stage })
  return { ok: true, draft: _drafts[projectId] }
})

app.delete('/api/git/draft/:projectId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const _drafts = readGitDrafts()
  delete _drafts[request.params.projectId]
  writeGitDrafts(_drafts)
  return { ok: true }
})

// 依規則 Commit 完成回寫（子進程照 buildAutoCommitPrompt 第 5 步 POST）：每專案存最近 10 筆＋推播面板
app.post('/api/git/auto-commit/result', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, hash, message, messageZh, files, branch } = request.body ?? {}
  if (!findGitProject(projectId)) return { ok: false, error: `專案「${projectId}」未設 git 規則` }
  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'message 不可空白' }
  const _results = readGitAutoResults()
  const _entry = {
    hash: typeof hash === 'string' ? hash.trim() : '',
    message: message.trim(),
    messageZh: typeof messageZh === 'string' ? messageZh.trim() : '',
    files: Array.isArray(files) ? files : [],
    branch: typeof branch === 'string' ? branch.trim() : '',
    at: Date.now(),
  }
  _results[projectId] = [_entry, ...(_results[projectId] ?? [])].slice(0, 10)
  writeGitAutoResults(_results)
  broadcast({ type: 'git_autocommit_result', projectId, result: _entry })
  logEvent('git.autocommit.result', { projectId, hash: _entry.hash })
  return { ok: true }
})

// 真的提交：一律走 Invoke-ProjectCommit.ps1（規則檢查、staging、Co-Author 都在腳本裡，server 不重複一套）
app.post('/api/git/commit', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, message, stage, paths, noCoAuthor, dryRun } = request.body ?? {}
  const _proj = findGitProject(projectId)
  if (!_proj) return { ok: false, error: `專案「${projectId}」未設 git 規則` }
  if (typeof message !== 'string' || !message.trim()) return { ok: false, error: 'commit 訊息不可空白' }

  // 訊息與檔案清單都走暫存檔：命令列傳多行中文會被殼層咬掉、檔名含空白/逗號也不會被拆錯
  const _stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const _msgFile = path.join(os.tmpdir(), `tc_commit_msg_${_stamp}.txt`)
  const _pathsFile = path.join(os.tmpdir(), `tc_commit_paths_${_stamp}.json`)
  const _args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROJECT_COMMIT_SCRIPT,
    '-Project', projectId, '-MessageFile', _msgFile]
  if (['none', 'all', 'paths'].includes(stage)) _args.push('-Stage', stage)
  if (Array.isArray(paths) && paths.length) _args.push('-PathsFile', _pathsFile)
  if (noCoAuthor) _args.push('-NoCoAuthor')
  if (dryRun) _args.push('-DryRun')

  let _result
  try {
    fs.writeFileSync(_msgFile, message.trim(), 'utf8')
    if (Array.isArray(paths) && paths.length) fs.writeFileSync(_pathsFile, JSON.stringify(paths), 'utf8')
    // 輸出由本端解析、視窗只會是空白一閃 → 一律不配視窗
    const _r = spawnSync('powershell.exe', _args, { encoding: 'utf-8', cwd: gitRepoRoot(_proj), windowsHide: true })
    const _lines = (_r.stdout ?? '').split(/\r?\n/).filter(l => l.trim())
    try { _result = JSON.parse(_lines[_lines.length - 1] ?? '') } catch {
      _result = { ok: false, error: `腳本輸出無法解析：${(_r.stdout ?? '').trim() || (_r.stderr ?? '').trim() || '無輸出'}` }
    }
  } catch (e) {
    _result = { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(_msgFile) } catch {}
    try { fs.unlinkSync(_pathsFile) } catch {}
  }

  if (_result.ok && !dryRun) {
    const _drafts = readGitDrafts()
    delete _drafts[projectId]          // 提交完的草稿留著只會下次誤送
    writeGitDrafts(_drafts)
  }
  logEvent('git.commit', { projectId, ok: !!_result.ok, hash: _result.hash ?? null, dryRun: !!dryRun })
  return _result
})

// ─── 酒窖（Cellar）工具箱（少爺 2026-08-06）：純 launcher——點擊即跑 ────────────
// 工具介面歸工具自己（如 UE_AnimToolkit 的 UE 內 GUI），酒窖只負責啟動。
// 未來加工具：CELLAR_TOOLS push 一筆即現身（exec 未接上前點擊回「開發中」提示）。
// kind：execute＝spawn 外部程式／claude＝喚一個 Claude 子進程跑固定 prompt（少爺 2026-08-14）
// 一鍵 Commit 的 prompt 依「該專案的 git 規則」動態產生（少爺 2026-08-14：
// 「設定完規則後直接按 Commit，就像我在 VS Code 那樣自動照規則根據專案處理」「我很少手動輸入 commit 內容」）。
// ⚠️ 單一產生點：酒窖 tc-commit 與版控面板的自動 Commit 共用本函式 —— prompt 只有一份，規則改了兩邊同步。
function buildAutoCommitPrompt(projectId, proj, policy, entry) {
  const _root = gitRepoRoot(proj)
  const _name = proj.name ?? projectId
  const _zh = policy.lang !== 'en'
  // staging 規則決定「看哪些變更」與「能不能自己 add」——羅馬 none＝只認少爺已 staged 的，絕不擅自加檔
  const _stageLine = policy.staging === 'all'
    ? `本專案規則＝全部變更都會進 commit（staging=all）。`
    : policy.staging === 'paths'
      ? `本專案規則＝只提交指定路徑（staging=paths）；沒有指定就不要提交，回報需要少爺先選檔。`
      : `本專案規則＝**只 commit 既有 staged**（staging=none）。**絕對不要 git add**；若 staged 為空就回報「沒有 staged 檔案」並結束。`
  return [
    `(${entry}) 請把「${_name}」目前的變更提交掉。全程不要問我、不要 push。`,
    ``,
    `1. 先看清楚改了什麼：git -C ${_root} status --short 與 git -C ${_root} diff --staged`,
    `   ${_stageLine}`,
    `   （沒有可提交的變更就回報並結束，不要硬擠一個 commit）`,
    `2. 寫${_zh ? '繁體中文' : '英文'} commit message：subject＝「type(scope)${_zh ? '：' : ': '}事實短句」；body＝flat bullet 列「哪個檔／模組改了什麼」，`,
    `   簡潔事實、不解釋因果（不寫 Why/How）、不巢狀 sub-bullet${_zh ? '' : '；訊息本身用英文，回報給少爺時附繁中對照'}`,
    `3. 訊息寫成 UTF-8 檔後執行（staging／語言／Co-Authored-By 都由腳本處理，不要自己跑 git add / git commit）：`,
    `   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Project\\MasterBrain\\.agent\\scripts\\Invoke-ProjectCommit.ps1" -Project ${projectId} -MessageFile <訊息檔>`,
    `4. 腳本回單行 JSON：ok=false 就照 error 修正後重試一次，仍失敗就回報錯誤原文`,
    `5. 提交成功後把最終內容回寫版控面板（少爺會在 TC 版控區「展開」檢視，缺了他就看不到你寫了什麼）：`,
    `   POST http://127.0.0.1:3001/api/git/auto-commit/result，JSON 欄位 {projectId:'${projectId}', hash, message（原文全文）, messageZh${_zh ? '（=message）' : '（**逐條繁中對照**全文）'}, files（檔案路徑陣列）, branch}`,
    `   （中文 body 走 UTF-8 bytes：Invoke-RestMethod -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json))，同 ProjectCommit_SOP 草稿作法）`,
    `6. ⭐ 最後一定要用**繁體中文**回報給少爺（這是他在聊天室唯一會看到的東西，缺了等於沒交付）：`,
    `   ① hash ＋ 檔案數 ② commit message 原文${_zh ? '' : '（英文）＋**逐條繁中對照**'} ③ 標明「未 push」`,
    `   ${_zh ? '' : '⚠️ message 本身維持英文寫進 git，但聊天室的回報必須是繁體中文；'}不要只貼英文就結束。`,
    ``,
    `規則細節：C:\\Project\\MasterBrain\\.agent\\workflows\\ProjectCommit_SOP.md`,
    `（${_name}＝${policy.staging === 'all' ? '全 staged' : policy.staging === 'paths' ? '指定路徑' : '只 commit 既有 staged'}、${_zh ? '繁中' : '英文'} message、${policy.coAuthor ? '自動補 Co-Author' : '不補 Co-Author'}）`,
  ].join('\n')
}

// 版控面板「一鍵依規則 Commit」：message 留空按下即走此路 —— 喚 Claude 讀 diff、依規則寫訊息、直接提交
app.post('/api/git/auto-commit', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId } = request.body ?? {}
  const _proj = findGitProject(projectId)
  if (!_proj) return { ok: false, error: `專案「${projectId}」未設 git 規則` }
  const _root = gitRepoRoot(_proj)
  if (!_root || !fs.existsSync(path.join(_root, '.git'))) return { ok: false, error: `不是 git repo：${_root}` }
  if (!isSafeCwd(_root)) return { ok: false, error: `工作目錄不存在：${_root}` }
  // 專案層閘門（不是聊天室排隊）：同 repo 有無頭聊天室正在改檔時不提交，免得把別人改到一半的檔案包進 commit
  if (claudeLanes.runningInProject(_root).length) return { ok: false, error: `該專案已有 Claude 進程執行中（可能正在改檔），等它跑完再按` }

  const _policy = gitProjectPolicy(_proj)
  const _prompt = buildAutoCommitPrompt(projectId, _proj, _policy, 'TC 版控面板「一鍵依規則 Commit」')
  const _quiet = isQuietSetting(QA_AUTO_COMMIT_QUIET_KEY)
  spawnClaude(_root, _prompt, null, 'sonnet', 'low', null, 0, _quiet)
  logEvent('git.autocommit.spawn', { projectId, staging: _policy.staging, lang: _policy.lang, quiet: _quiet })
  return { ok: true, spawned: true, message: `已喚起 Claude 依「${_proj.name ?? projectId}」規則提交（${_policy.staging === 'none' ? '只 commit 既有 staged' : _policy.staging === 'all' ? '全部變更' : '指定路徑'}、${_policy.lang === 'en' ? '英文' : '繁中'} message）` }
})

// ─── 逐筆推送（少爺 2026-08-29）：把遠端還沒有的 commits 由舊到新一筆一筆推上去 ──────────
// 為什麼不是一次 push：commit 累積太多時單次傳輸量會爆掉（GitHub 單次 push 上限 2GiB）。
// 與 commit 同一個原則——面板不自己複製一套 git 規則，一律委派 MasterBrain 共用腳本（repoRoot 也讀同一份 sommelier.json）。
// 打包是「讀 log 檔續管」因為 UAT 跑很久且 server 可能重啟；逐筆推是幾分鐘的事，直接接管 stdout 就夠。
const PROJECT_PUSH_SCRIPT = 'C:\\Project\\MasterBrain\\.agent\\scripts\\Invoke-ProjectPushOneByOne.ps1'
const GIT_PUSH_TAIL_MAX = 200

let gitPushJob = null      // { projectId, projectName, status, dryRun, total, done, current, remote, branch, tail[], result, startedAt, finishedAt }
let gitPushProc = null     // 本 server 生命週期內才有；重啟後為 null（狀態一併視為中斷）
let gitPushBuf = ''

function broadcastGitPush() {
  if (!gitPushJob) return
  broadcast({ type: 'git_push_update', job: gitPushJob })
}

// 解析腳本的進度行（協定見 Invoke-ProjectPushOneByOne.ps1 檔頭）：少爺要看得到「推到第幾筆」而不是只有轉圈
function parseGitPushLine(line) {
  if (!gitPushJob) return
  const _t = (line ?? '').replace(/\r$/, '')
  if (!_t.trim()) return

  gitPushJob.tail.push(_t)
  if (gitPushJob.tail.length > GIT_PUSH_TAIL_MAX) gitPushJob.tail.shift()

  const _plan = _t.match(/^\[Push\] plan (\d+) (\S+) (\S+)$/)
  if (_plan) {
    gitPushJob.total = Number(_plan[1])
    gitPushJob.remote = _plan[2]
    gitPushJob.branch = _plan[3]
    broadcastGitPush()
    return
  }
  const _step = _t.match(/^\[Push\] step (\d+)\/(\d+) (\S+) ?(.*)$/)
  if (_step) {
    gitPushJob.done = Number(_step[1]) - 1        // 這筆才正要推，完成數還是前一筆
    gitPushJob.total = Number(_step[2])
    gitPushJob.current = { index: Number(_step[1]), short: _step[3], subject: _step[4] ?? '' }
    broadcastGitPush()
    return
  }
  const _ok = _t.match(/^\[Push\] ok (\d+)\/(\d+) /)
  if (_ok) {
    gitPushJob.done = Number(_ok[1])
    gitPushJob.total = Number(_ok[2])
    broadcastGitPush()
    return
  }
  if (/^\[Push\] log /.test(_t)) { broadcastGitPush(); return }

  // 非進度行＝腳本的收尾 JSON（或雜訊）；解析成功就是最終結果
  try {
    const _j = JSON.parse(_t)
    if (typeof _j === 'object' && _j !== null && 'ok' in _j) gitPushJob.result = _j
  } catch { /* 不是 JSON 就只留在 tail 裡 */ }
}

function finalizeGitPushJob(code) {
  if (!gitPushJob) return
  gitPushProc = null
  gitPushJob.finishedAt = Date.now()
  gitPushJob.current = null
  const _r = gitPushJob.result
  gitPushJob.status = _r?.ok ? 'done' : 'failed'
  if (!_r) {
    // 腳本沒吐出收尾 JSON＝啟動層就掛了（PowerShell 找不到腳本、語法錯…）；把 tail 當錯誤原文回報
    gitPushJob.status = 'failed'
    gitPushJob.result = { ok: false, error: `腳本沒有回傳結果（exit ${code}）：${gitPushJob.tail.slice(-5).join(' / ') || '無輸出'}` }
  }
  if (_r?.ok && typeof _r.pushed === 'number') gitPushJob.done = _r.pushed
  broadcastGitPush()
  logEvent('git.push.finish', { projectId: gitPushJob.projectId, ok: !!gitPushJob.result?.ok, pushed: gitPushJob.done, total: gitPushJob.total })
}

app.get('/api/git/push/status', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  return { ok: true, job: gitPushJob }
})

app.post('/api/git/push/start', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, dryRun } = request.body ?? {}
  const _proj = findGitProject(projectId)
  if (!_proj) return { ok: false, error: `專案「${projectId}」未設 git 規則` }
  const _root = gitRepoRoot(_proj)
  if (!_root || !fs.existsSync(path.join(_root, '.git'))) return { ok: false, error: `不是 git repo：${_root}` }
  if (gitPushJob?.status === 'running') {
    return { ok: false, error: `「${gitPushJob.projectName}」的推送還在跑（${gitPushJob.done}/${gitPushJob.total}），等它跑完再按` }
  }
  if (!fs.existsSync(PROJECT_PUSH_SCRIPT)) return { ok: false, error: `找不到推送腳本：${PROJECT_PUSH_SCRIPT}` }

  gitPushBuf = ''
  gitPushJob = {
    projectId, projectName: _proj.name ?? projectId, repoRoot: _root,
    status: 'running', dryRun: !!dryRun,
    total: 0, done: 0, current: null, remote: '', branch: '',
    tail: [], result: null, startedAt: Date.now(), finishedAt: null,
  }
  broadcastGitPush()

  const _args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROJECT_PUSH_SCRIPT, '-Project', projectId]
  if (dryRun) _args.push('-DryRun')
  try {
    gitPushProc = spawn('powershell.exe', _args, { cwd: _root, windowsHide: true })
  } catch (e) {
    gitPushJob.status = 'failed'
    gitPushJob.result = { ok: false, error: `啟動推送腳本失敗：${e.message}` }
    broadcastGitPush()
    return { ok: false, error: gitPushJob.result.error }
  }

  gitPushProc.stdout.setEncoding('utf-8')
  gitPushProc.stdout.on('data', (chunk) => {
    gitPushBuf += chunk
    const _lines = gitPushBuf.split(/\r?\n/)
    gitPushBuf = _lines.pop() ?? ''        // 最後一段可能是半行，留到下一批再併
    for (const _l of _lines) parseGitPushLine(_l)
  })
  // 腳本把該說的都寫進 stdout；stderr 只在 PowerShell 自己出事時有東西，收進 tail 當診斷用
  gitPushProc.stderr.setEncoding('utf-8')
  gitPushProc.stderr.on('data', (chunk) => {
    for (const _l of String(chunk).split(/\r?\n/)) {
      if (_l.trim()) gitPushJob?.tail.push(`[stderr] ${_l}`)
    }
  })
  gitPushProc.on('close', (code) => {
    if (gitPushBuf.trim()) { parseGitPushLine(gitPushBuf); gitPushBuf = '' }
    finalizeGitPushJob(code)
  })
  gitPushProc.on('error', (e) => {
    if (!gitPushJob) return
    gitPushJob.result = { ok: false, error: `推送腳本執行失敗：${e.message}` }
    finalizeGitPushJob(-1)
  })

  logEvent('git.push.start', { projectId, dryRun: !!dryRun, repoRoot: _root })
  return { ok: true, started: true, job: gitPushJob }
})

const CELLAR_TOOLS = [
  {
    id: 'tc-commit', name: 'TC Commit（一鍵提交）', kind: 'claude',
    desc: '喚 Claude 讀 TC 變更、照繁中規則寫訊息並直接提交（不 push）',
    // prompt 不寫死：執行時用 buildAutoCommitPrompt 依 sommelier.json 的 tc 規則現算（與版控面板同一產生點）
    claude: { cwd: 'C:\\Project\\TheClaudenental', model: 'sonnet', effort: 'low', gitProjectId: 'tc' },
  },
  {
    id: 'cooldown-timer', name: 'Claude 冷卻鬧鐘', kind: 'execute',
    desc: '到冷卻時間自動點擊繼續（AutoClicker）',
    exec: ['wscript.exe', ['C:\\Project\\MasterBrain\\AI_Utils\\ClaudeCooldownTimer\\啟動鬧鐘點擊器.vbs']],
  },
  {
    id: 'anim-toolkit', name: 'UE 動畫工具包', kind: 'execute',
    desc: '啟動動畫工具包服務面板（選資產＋勾服務執行；需 UE Editor 開啟）',
    exec: ['cmd.exe', ['/c', 'C:\\Project\\UE_AnimToolkit\\AnimToolkit.bat']],
  },
  {
    id: 'mixamo-root-motion', name: 'Mixamo → UE Root Motion 加工器', kind: 'execute',
    desc: 'Mixamo 下載的 FBX 轉成 UE Root Motion 動畫（拖放批量；走 Blender，不需 UE Editor）',
    // 與 anim-toolkit 同模式：cmd.exe /c 中介，.bat 內再 start pythonw 開 GUI
    exec: ['cmd.exe', ['/c', 'C:\\Project\\UE_AnimToolkit\\MixamoRootMotion.bat']],
  },
  {
    id: 'footwork-synth', name: '米字步步法生成器', kind: 'execute',
    desc: '以一支架式待機生成維持架式的八方向步法動畫＋曲線加工＋BlendSpace＋機檢（需 UE Editor 開著）',
    // 與 anim-toolkit 同模式：cmd.exe /c 中介，.bat 內再 start pythonw 開 GUI
    exec: ['cmd.exe', ['/c', 'C:\\Project\\UE_AnimToolkit\\FootworkSynth.bat']],
  },
  {
    id: 'mesh-fracture', name: '網格切碎塊 / 階段破損', kind: 'execute',
    desc: '把模型切成碎塊並產生階段破損版（可破壞建築用；走 Blender，不需 UE Editor）',
    // 與 anim-toolkit 同模式：cmd.exe /c 中介，.bat 無參數時 start pythonw 開 GUI（detached 無主控台，結果走彈窗）
    exec: ['cmd.exe', ['/c', 'C:\\Project\\UE_MeshToolkit\\MeshFracture.bat']],
  },
  {
    id: 'music-forge', name: 'Music Forge 程序化配樂', kind: 'execute',
    desc: '依分數腳本渲染互動配樂分軌＋QA 報告、只重寫音樂庫、互動試聽（純 Python，不需 UE Editor）',
    // 同 mesh-fracture 模式：.bat 無參數時 start pythonw 開 GUI（detached 無主控台，結果走彈窗）
    exec: ['cmd.exe', ['/c', 'C:\\Project\\UE_AudioToolkit\\MusicForge.bat']],
  },
  {
    id: 'ue-ref-viewer', name: 'UE Reference Viewer（裝進 VS Code）', kind: 'execute',
    desc: 'VS Code 擴充：選取符號按 Alt+R 開三欄引用圖；點此確保裝的是最新版',
    // 擴充沒有獨立視窗可開，「啟動」＝把 repo 裡最新的 .vsix 裝進 VS Code（已是最新就跳過）
    // 必經 cmd.exe 中介：酒窖 spawn 是 detached + stdio ignore，powershell 直跑會拿不到標準 handle 而以 exit 0 空跑；同理沒有主控台，腳本結果走彈窗
    exec: ['cmd.exe', ['/c', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Project\\vscode-ue-reference-viewer\\Install-Extension.ps1']],
  },
  {
    id: 'knowledge-sub-theorangeduck', name: '知識訂閱：The Orange Duck（立即檢查）', kind: 'execute',
    desc: '立刻跑一輪誓約 Claude_知識訂閱_TheOrangeDuck：偵測新文章／文章修改／微部落格，有新內容就自動吸收；結果看 Marker 與自動建立的 TC 卡',
    // 觸發同一個 Windows 排程，Marker 的上次執行與成敗同步更新
    exec: ['cmd.exe', ['/c', 'schtasks', '/run', '/tn', 'Claude_知識訂閱_TheOrangeDuck']],
    // 跑的就是該誓約的排程 → 勿擾與誓約共用同一個設定（兩邊顯示、改哪邊都一樣）
    markerId: 'win:Claude_知識訂閱_TheOrangeDuck',
  },
]
// 酒窖工具的勿擾設定鍵：觸發誓約排程的工具沿用該誓約的鍵
function cellarQuietKey(InTool) { return InTool.markerId ? markerQuietKey(InTool.markerId) : `cellar.quiet.${InTool.id}` }
app.get('/api/tools', async () => ({
  ok: true,
  tools: CELLAR_TOOLS.map(t => ({ id: t.id, name: t.name, kind: t.kind, desc: t.desc, quiet: isQuietSetting(cellarQuietKey(t)), quietMarkerId: t.markerId ?? null })),
}))
app.post('/api/tools/quiet', async (request, reply) => {
  const { id, quiet } = request.body ?? {}
  const _t = CELLAR_TOOLS.find(t => t.id === id)
  if (!_t || typeof quiet !== 'boolean') { reply.code(400); return { ok: false, error: '需要有效的工具 id 與 quiet（true／false）' } }
  if (_t.markerId) {
    const _r = await setMarkerQuiet(_t.markerId, quiet)
    if (!_r.ok) reply.code(_r.code ?? 500)
    return { ok: _r.ok, quiet: _r.quiet, error: _r.error }
  }
  writeTcSettings({ [cellarQuietKey(_t)]: quiet })
  logEvent('cellar.quiet.set', { id: _t.id, quiet })
  return { ok: true, quiet }
})
app.post('/api/tools/run/:id', async (request) => {
  const _t = CELLAR_TOOLS.find(t => t.id === request.params.id)
  if (!_t) return { ok: false, error: '未知工具' }
  const _quiet = isQuietSetting(cellarQuietKey(_t))
  // 喚 Claude 型：跑固定 prompt 的子進程（打包失敗自動分析同一套做法）
  if (_t.kind === 'claude') {
    const _c = _t.claude ?? {}
    if (!isSafeCwd(_c.cwd)) return { ok: false, error: `工作目錄不存在：${_c.cwd}` }
    // 專案層閘門（不是聊天室排隊）：酒窖的 Claude 工具目前都是提交類，同 cwd 有無頭聊天室正在改檔時不跑
    if (claudeLanes.runningInProject(_c.cwd).length) return { ok: false, error: `「${_t.name}」：該專案已有 Claude 進程執行中（可能正在改檔），等它跑完再按` }
    // gitProjectId 型：prompt 依該專案當下的 git 規則現算（規則改了不必動程式碼）
    let _prompt = _c.prompt
    if (_c.gitProjectId) {
      const _gp = findGitProject(_c.gitProjectId)
      if (!_gp) return { ok: false, error: `「${_t.name}」：專案「${_c.gitProjectId}」未設 git 規則` }
      _prompt = buildAutoCommitPrompt(_c.gitProjectId, _gp, gitProjectPolicy(_gp), `TC 酒窖「${_t.name}」`)
    }
    if (!_prompt) return { ok: false, error: `「${_t.name}」：沒有可執行的 prompt` }
    spawnClaude(_c.cwd, _prompt, null, _c.model ?? null, _c.effort ?? null, null, 0, _quiet)
    logEvent('cellar.claude.spawn', { id: _t.id, cwd: _c.cwd, model: _c.model ?? null, effort: _c.effort ?? null, quiet: _quiet })
    return { ok: true, ran: `${_t.name}（已喚起 Claude${_quiet ? '・勿擾' : ''}，完成後看版控狀態或聊天室）` }
  }
  if (_t.kind !== 'execute') return { ok: false, error: '此工具非執行型（execute）' }
  if (!_t.exec) return { ok: false, error: `「${_t.name}」尚未接上啟動指令（UE 內 GUI 開發中）` }
  try {
    // 不加 windowsHide：執行型工具可能自帶 UI（AutoClicker 介面）要顯示給少爺；windowsHide 的 SW_HIDE 會連那個介面一起藏
    // 勿擾改經 RunHidden 轉交：只拿掉主控台視窗，工具介面照常
    const _hidden = _quiet && await ensureRunHiddenExe()
    if (_hidden) spawn(RUN_HIDDEN_EXE, [_t.exec[0], ..._t.exec[1]], { detached: true, stdio: 'ignore' }).unref()
    else spawn(_t.exec[0], _t.exec[1], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, ran: `${_t.name}${_hidden ? '（勿擾）' : _quiet ? '（⚠️ 勿擾未生效：啟動器建置失敗）' : ''}` }
  } catch (e) { return { ok: false, error: e.message } }
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

// ─── 互動式簡報（少爺 2026-07-21：回應風格濾鏡＋演出回放＋合作資料優化）──────────
// 轉譯管線沿用 tagger 基建（TAGGER_CWD＝繼承 History/側欄排除、haiku 預設、stream-json 取
// result、關閉即刪 transcript、s2tw 正規化）；快取＝transcript jsonl 的 type:'ai-present' 行
//（比照 ai-tags/ai-title），同 msgHash 取最後一行 → 回放零成本。
const PRESENT_PIPELINE_VER = 1
const PRESENT_CONFIG_FILE = path.join(os.homedir(), '.claude', 'tc_user_config', 'present.json')
const PRESENT_FEEDBACK_FILE = path.join(os.homedir(), '.claude', 'tc_present_feedback.jsonl')
const presentCache = new Map()   // msgHash → { payload, ts }（in-memory 熱路徑；jsonl 為持久層）

function readPresentConfig() {
  try { return { mode: 'official', model: TAG_LLM_MODEL, ...JSON.parse(fs.readFileSync(PRESENT_CONFIG_FILE, 'utf8')) } }
  catch { return { mode: 'official', model: TAG_LLM_MODEL } }
}

app.get('/api/present/config', async () => ({ ok: true, config: readPresentConfig() }))

app.post('/api/present/config', async (request) => {
  const _next = readPresentConfig()
  if (['official', 'present'].includes(request.body?.mode)) _next.mode = request.body.mode
  if (typeof request.body?.model === 'string') _next.model = request.body.model || TAG_LLM_MODEL
  try { fs.mkdirSync(path.dirname(PRESENT_CONFIG_FILE), { recursive: true }) } catch {}
  atomicWriteJson(PRESENT_CONFIG_FILE, _next)
  return { ok: true, config: _next }
})

function msgHashOf(text) { return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16) }

/** 簡報回饋聚合 → prompt 指引句（近 80 筆；與評分系統同哲學：少爺的訊號蓋過預設） */
function getPresentFeedbackGuidance() {
  try {
    const _lines = fs.readFileSync(PRESENT_FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).slice(-80)
    const _cnt = {}
    for (const _l of _lines) {
      try { for (const _t of (JSON.parse(_l).tags ?? [])) _cnt[_t] = (_cnt[_t] ?? 0) + 1 } catch {}
    }
    const _g = []
    if ((_cnt['太碎'] ?? 0) >= 3) _g.push('卡片數量曾被嫌太碎——合併相近重點，上限 5 張')
    if ((_cnt['太密'] ?? 0) >= 3) _g.push('單張資訊量曾被嫌太密——每張只留一個重點、body 兩句內')
    if ((_cnt['重點錯'] ?? 0) >= 3) _g.push('重點判讀曾多次失準——verdict 優先摘原文結論句原話，不自行改寫')
    if ((_cnt['要更多細節'] ?? 0) >= 3) _g.push('少爺想要更多細節——關鍵數字/檔名/路徑保留進卡片')
    return _g
  } catch { return [] }
}

/** 轉譯 prompt：注入規矩偏好文字＋少爺自訂詞（領域詞彙保真）＋簡報回饋指引（優化迴路 v1） */
function buildPresentPrompt(text) {
  let _prefs = ''
  try { _prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')).text ?? '' } catch {}
  const _terms = getCustomTagTerms()
  const _guides = getPresentFeedbackGuidance()
  return `你是「互動簡報轉譯器」：把一則 AI 助手的回覆轉成少爺能秒懂的漸進揭示卡片流。只輸出一個 JSON 物件，不要任何其他文字。

JSON 格式：
{"title":"一句話主旨","verdict":"最重要的結論或答案（沒有明確結論則為 null）","sections":[{"kind":"point|action|risk|info|code","heading":"卡片標題（短）","body":"內容（最多兩句）","code":"（僅 kind=code 時：程式碼或指令原文）"}],"followups":["原文中提到的下一步或待決事項"]}

規則：
- 全部繁體中文（台灣用語）。
- verdict 盡量摘原文的結論句原話，不自行改寫語意。
- sections 3~6 張，每張只講一個重點；行動用 action、風險/坑用 risk、程式碼或指令用 code、背景補充用 info。
- 檔名、函式名、數字、路徑等關鍵識別字保留原樣，不翻譯不改寫。
- 只根據原文，不發明原文沒有的內容；followups 沒有就給空陣列。
${_terms.length ? `- 領域詞彙（出現時保留原樣）：${_terms.join('、')}\n` : ''}${_prefs ? `- 少爺回應偏好：\n${_prefs}\n` : ''}${_guides.length ? `- 少爺對過往簡報的回饋（必須遵守）：\n${_guides.map(g => `  - ${g}`).join('\n')}\n` : ''}
原文：
<<<
${text}
>>>`
}

/** 解析＋守門：非法 kind 收斂為 point、張數上限、s2tw 正規化 */
function parsePresentResult(text) {
  try {
    const _m = String(text ?? '').match(/\{[\s\S]*\}/)
    if (!_m) return null
    const _p = JSON.parse(_m[0])
    if (!_p || !Array.isArray(_p.sections) || !_p.sections.length) return null
    const _tw = (s) => { try { return s == null ? s : s2tw(String(s)) } catch { return s } }
    return {
      title: _tw(_p.title ?? ''),
      verdict: _p.verdict ? _tw(_p.verdict) : null,
      sections: _p.sections.slice(0, 8).map(s => ({
        kind: ['point', 'action', 'risk', 'info', 'code'].includes(s.kind) ? s.kind : 'point',
        heading: _tw(s.heading ?? ''),
        body: _tw(s.body ?? ''),
        ...(s.code ? { code: String(s.code) } : {}),
      })),
      followups: (_p.followups ?? []).slice(0, 6).map(_tw),
    }
  } catch { return null }
}

/** 一次性無頭 Claude（不留聊天室）：TAGGER_CWD 起、max-turns 1、回傳 result 文字（失敗回 null）、結束即刪 transcript。
 *  互動簡報轉譯與待定奪「進一步說明」共用 */
function runOneShotClaude(prompt, { model = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const _cwdNorm = TAGGER_CWD.replace(/\\/g, '/').toLowerCase()
    try { fs.mkdirSync(TAGGER_CWD, { recursive: true }) } catch {}
    pendingSpawnCwds.add(_cwdNorm)
    const args = ['--model', model || TAG_LLM_MODEL, '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions', '--max-turns', '1', '-p', prompt]
    let _proc
    try { _proc = spawn(getClaudeExe(), args, { cwd: TAGGER_CWD, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { pendingSpawnCwds.delete(_cwdNorm); resolve(null); return }
    let _sid = null, _text = '', _buf = ''
    const _timeout = setTimeout(() => { try { _proc.kill() } catch {} }, timeoutMs)
    _proc.stdout.setEncoding('utf-8')   // 同上：避免跨 chunk 的中文字被切壞
    _proc.stdout.on('data', c => {
      _buf += c
      const _lines = _buf.split('\n'); _buf = _lines.pop()
      for (const l of _lines) {
        try {
          const ev = JSON.parse(l)
          if (ev.type === 'system' && ev.subtype === 'init') { _sid = ev.session_id; subprocessSids.add(_sid) }
          if (ev.type === 'result' && typeof ev.result === 'string') _text = ev.result
        } catch {}
      }
    })
    _proc.on('close', () => {
      clearTimeout(_timeout)
      pendingSpawnCwds.delete(_cwdNorm)
      // 自己的 transcript 不留（否則 History 長出轉譯器聊天室）
      if (_sid) { try { const _fp = findJsonlPath(_sid); if (_fp) fs.unlinkSync(_fp) } catch {} }
      resolve(_text)
    })
  })
}

function spawnPresentLLM(text, model) {
  return runOneShotClaude(buildPresentPrompt(text), { model }).then(parsePresentResult)
}

/** 讀 jsonl 快取：同 msgHash 最後一行（ver 不符視同 miss → 自動重譯） */
function findAiPresentPayload(sessionId, msgHash) {
  const _fp = findJsonlPath(sessionId)
  if (!_fp) return null
  try {
    const _lines = fs.readFileSync(_fp, 'utf8').split('\n')
    for (let i = _lines.length - 1; i >= 0; i--) {
      if (!_lines[i].includes('"ai-present"')) continue
      try {
        const _o = JSON.parse(_lines[i])
        if (_o.type === 'ai-present' && _o.msgHash === msgHash && _o.ver === PRESENT_PIPELINE_VER) return _o.payload
      } catch {}
    }
  } catch {}
  return null
}

app.post('/api/present', async (request) => {
  const { sessionId, text, force } = request.body ?? {}
  if (!text || !String(text).trim()) return { ok: false, error: 'missing text' }
  const _hash = msgHashOf(text)
  if (!force) {
    const _mem = presentCache.get(_hash)
    if (_mem) return { ok: true, cached: true, msgHash: _hash, payload: _mem.payload }
    if (sessionId) {
      const _disk = findAiPresentPayload(sessionId, _hash)
      if (_disk) { presentCache.set(_hash, { payload: _disk, ts: Date.now() }); return { ok: true, cached: true, msgHash: _hash, payload: _disk } }
    }
  }
  const _cfg = readPresentConfig()
  const _payload = await spawnPresentLLM(String(text), _cfg.model)
  if (!_payload) return { ok: false, error: 'transform failed' }
  presentCache.set(_hash, { payload: _payload, ts: Date.now() })
  if (sessionId) appendTranscriptLine(sessionId, { type: 'ai-present', msgHash: _hash, ver: PRESENT_PIPELINE_VER, payload: _payload, ts: Date.now() })
  logEvent('present.transformed', { sessionId: sessionId ?? null, msgHash: _hash, model: _cfg.model ?? null, cached: false })
  return { ok: true, cached: false, msgHash: _hash, payload: _payload }
})

app.post('/api/present/feedback', async (request) => {
  const { sessionId, msgHash, reaction, tags } = request.body ?? {}
  if (!reaction && !(tags?.length)) return { ok: false }
  try { fs.appendFileSync(PRESENT_FEEDBACK_FILE, JSON.stringify({ ts: Date.now(), sessionId: sessionId ?? null, msgHash: msgHash ?? null, reaction: reaction ?? null, tags: tags ?? [] }) + '\n', 'utf8') } catch {}
  return { ok: true }
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
  // commit 規則（少爺 2026-08-14）：從 TC 直接改，不必手改 sommelier.json。
  // git:null＝撤掉規則（該專案的版控區塊即停用）；欄位逐一驗，沒帶的欄位保留原值。
  if (body.git === null) delete proj.git
  else if (body.git && typeof body.git === 'object') {
    const _g = { ...(proj.git ?? {}) }
    if (['none', 'all', 'paths'].includes(body.git.staging)) _g.staging = body.git.staging
    if (['en', 'zh-TW'].includes(body.git.lang)) _g.lang = body.git.lang
    if (typeof body.git.coAuthor === 'boolean') _g.coAuthor = body.git.coAuthor
    if (typeof body.git.allowStageOverride === 'boolean') _g.allowStageOverride = body.git.allowStageOverride
    if (typeof body.git.repoRoot === 'string') {
      if (body.git.repoRoot.trim()) _g.repoRoot = body.git.repoRoot.trim()
      else delete _g.repoRoot            // 清空＝回去用 projectRoot / projectPath
    }
    _g.staging ??= 'none'                // 新建規則的預設＝最保守：不代為 staged
    _g.lang ??= 'en'
    proj.git = _g
  }
  atomicWriteJson(SOMMELIER_CONFIG_FILE, cfg)
  logEvent('projects.registry.update', { id: proj.id, enabled: proj.enabled !== false, git: proj.git ?? null })
  return { ok: true, git: proj.git ?? null }
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
    // 設計脈絡層（第五血肉，選配，少爺 2026-09-07 立）：design_intent/*.md 由 extract_design_intent.mjs 萃取；建 symbol→intent 反查索引
    let designIntent = null
    const symbolIntentIndex = {}
    try {
      designIntent = JSON.parse(fs.readFileSync(path.join(proj.dataDir, 'generated', 'design_intent.json'), 'utf8'))
      for (const it of designIntent.intents ?? [])
        for (const ref of it.symbolRefs ?? []) {
          (symbolIntentIndex[ref.name] ??= []).push({ id: it.id, title: it.title, scope: it.scope, invariants: (it.invariants ?? []).length })
        }
    } catch { /* design_intent.json 不存在 → 前四層照回,前端優雅降級 */ }
    // 情境體驗層（第六血肉，選配，少爺 2026-09-15 立）：scenario/S##_*.md 由 extract_scenario_experience.mjs 萃取；建 intent→scenario 反查索引（意圖細節頁「出現在這些情境」）
    let scenario = null
    const intentScenarioIndex = {}
    try {
      scenario = JSON.parse(fs.readFileSync(path.join(proj.dataDir, 'generated', 'scenario_experience.json'), 'utf8'))
      for (const sc of scenario.scenarios ?? [])
        for (const iid of sc.intentLinks ?? []) {
          (intentScenarioIndex[iid] ??= []).push({ id: sc.id, title: sc.title, phase: sc.phase, status: sc.status })
        }
    } catch { /* scenario_experience.json 不存在 → 前五層照回,前端優雅降級 */ }
    return { ok: true, data, arch, symbolCanvasIndex, memory, symbolMemoryIndex, assetGraph, symbolBpIndex, designIntent, symbolIntentIndex, scenario, intentScenarioIndex, extractCommand: proj.extractCommand ?? null }
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
    // 開著的侍酒師就地重抓（待定奪面板看得到子任務剛寫進 md 的定案／Claude 回覆）
    broadcast({ type: 'sommelier_refreshed', projectId: proj.id, ok })
    return { ok, code: r.status, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-800) }
  } catch (e) { reply.code(500); return { ok: false, error: e.message } }
})

// ─── 待定奪面板（少爺 2026-09-29「待我定奪的項目都照 VS Code 這樣（原生的方式）」）────────────
// 侍酒師「設計脈絡／情境體驗」的 OPEN-n 改成原生提問面板：直接選選項／其他＝自由回覆想法／進一步說明。
// 送出＝兩段：① TC 把「決定」寫回原 md（決定性程序放 harness 層）：選項 → `- [x] OPEN-n …（日期 少爺定：…）`，
// 回覆 → 該條目下的 `**少爺回覆**（日期 時刻）：…` 子項，情境檔另記進「討論紀錄」；② 派子任務（Claude 聊天室）做判斷類後續：
// 落成不變量／情境標記、牽動檔同步、機檢刷新、後續實作（實作走 QA 閘門），並建待辦卡綁定該子任務。
// 條目格式與解析 SSOT：MasterBrain/.agent/scripts/open_decisions.mjs（design_intent／scenario 兩支萃取器共用）。

const DECISION_EXPLAIN_FILE = path.join(os.homedir(), '.claude', 'tc_decision_explain.json')     // 進一步說明快取（內容變了才重算）
const DECISION_DISPATCH_FILE = path.join(os.homedir(), '.claude', 'tc_decision_dispatch.json')   // 定奪 → 子任務（卡片／聊天室）紀錄
const DECISION_EXPLAIN_VER = 1
const DECISION_EXPLAIN_DEFAULT_MODEL = 'sonnet'
const DECISION_EXPLAIN_TIMEOUT_MS = 180_000
const DECISION_DISPATCH_MAX = 300
const DECISION_HEAD_RE = /^(\s*-\s*\[)([ xX])(\]\s*\**)(OPEN-\d+)(\**\s*)(.*)$/
const decisionExplainInflight = new Map()   // 說明 key → 進行中的 Promise（同一題重複按只跑一次）
const sommelierRefreshState = new Map()     // projectId → { running, pending }（非同步重萃取合併）

function findSommelierProject(InProjectId) {
  return (readSommelierConfig().projects ?? []).find(p => p.id === InProjectId) ?? null
}

/** 待定奪來源檔的絕對路徑：檔名白名單＋必須落在該層目錄內（intent＝designIntentDir、scenario＝scenarioDir） */
function decisionSourcePath(InProj, InLayer, InFile) {
  const _dir = InLayer === 'intent' ? InProj?.designIntentDir : InLayer === 'scenario' ? InProj?.scenarioDir : null
  if (!_dir || !/^[\w.-]+\.md$/.test(String(InFile ?? ''))) return null
  const _root = path.resolve(_dir)
  const _fp = path.resolve(_root, InFile)
  return _fp.startsWith(_root + path.sep) && fs.existsSync(_fp) ? _fp : null
}

/** 讀 md 並記住原本的行尾與 BOM，寫回時原樣保留 */
function readMdKeepFormat(InPath) {
  let _text = fs.readFileSync(InPath, 'utf8')
  const _bom = _text.charCodeAt(0) === 0xFEFF
  if (_bom) _text = _text.slice(1)
  return { lines: _text.split(/\r?\n/), eol: _text.includes('\r\n') ? '\r\n' : '\n', bom: _bom }
}
function writeMdKeepFormat(InPath, InDoc) {
  const _tmp = `${InPath}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(_tmp, (InDoc.bom ? '\uFEFF' : '') + InDoc.lines.join(InDoc.eol), 'utf8')
  fs.renameSync(_tmp, InPath)
}

/** `## …` 段落的 [起, 迄)（起＝標題下一行）；找不到回 null */
function mdSectionRange(InLines, InTitleRe) {
  const _start = InLines.findIndex(l => /^##\s+/.test(l) && InTitleRe.test(l))
  if (_start < 0) return null
  let _end = InLines.length
  for (let i = _start + 1; i < InLines.length; i++) if (/^##\s+/.test(InLines[i])) { _end = i; break }
  return [_start + 1, _end]
}
function mdSectionText(InLines, InTitleRe, InMax = 2000) {
  const _r = mdSectionRange(InLines, InTitleRe)
  if (!_r) return ''
  const _t = InLines.slice(_r[0], _r[1]).join('\n').trim()
  return _t.length > InMax ? `${_t.slice(0, InMax)}…` : _t
}
function mdFrontmatter(InLines) {
  const _fm = {}
  if (InLines[0]?.trim() !== '---') return _fm
  for (let i = 1; i < InLines.length && InLines[i].trim() !== '---'; i++) {
    const _kv = InLines[i].match(/^([\w.]+):\s*(.*)$/)
    if (_kv) _fm[_kv[1]] = _kv[2].trim()
  }
  return _fm
}

/** 待定奪段內的某個 OPEN 條目：標題行＋子項範圍（子項＝緊接著、有縮排、不是下一個條目的行） */
function findOpenBlock(InLines, InOpenId) {
  const _sec = mdSectionRange(InLines, /待定奪/)
  if (!_sec) return null
  for (let i = _sec[0]; i < _sec[1]; i++) {
    const _m = InLines[i].match(DECISION_HEAD_RE)
    if (!_m || _m[4] !== InOpenId) continue
    let _end = i + 1
    while (_end < _sec[1] && /^\s+\S/.test(InLines[_end]) && !DECISION_HEAD_RE.test(InLines[_end])) _end++
    return { head: i, end: _end, match: _m, raw: InLines.slice(i, _end).join('\n') }
  }
  return null
}

const decisionOneLine = (InText) => String(InText ?? '').replace(/\r?\n+/g, ' ／ ').replace(/[ \t]+/g, ' ').trim()
// 定案括號的解析以全形「）」收尾（`[^）]*`），內文的全形括號一律換半形
const decisionResolutionSafe = (InText) => decisionOneLine(InText).replace(/（/g, '(').replace(/）/g, ')')
function nowHHMM() {
  const _d = new Date()
  return `${String(_d.getHours()).padStart(2, '0')}:${String(_d.getMinutes()).padStart(2, '0')}`
}
const decisionHash = (InRaw) => crypto.createHash('sha1').update(String(InRaw ?? ''), 'utf8').digest('hex').slice(0, 16)

/** 一筆回答寫進 doc（記憶體中）；回傳寫入結果與送子任務要用的快照 */
function applyDecisionAnswer(InDoc, InLayer, InAnswer, InStamp) {
  const _blk = findOpenBlock(InDoc.lines, InAnswer.openId)
  if (!_blk) return { ok: false, error: `找不到 ${InAnswer.openId}（檔案可能剛被改過）`, stale: true }
  const _m = _blk.match
  if (_m[2] !== ' ') return { ok: false, error: `${InAnswer.openId} 已經定案`, stale: true }
  const _title = _m[6].trim()
  if (InAnswer.title && String(InAnswer.title).trim() !== _title) return { ok: false, error: `${InAnswer.openId} 題目已變更，請重新整理後再答`, stale: true }
  const _question = _title.replace(/\*\*/g, '')
  const _indent = InDoc.lines[_blk.head + 1]?.match(/^(\s+)-/)?.[1] ?? '  '
  let _decision = '', _reply = ''
  if (InAnswer.kind === 'choose') {
    _decision = decisionResolutionSafe(`${InAnswer.choiceKey}) ${InAnswer.choiceText}${InAnswer.note?.trim() ? `；補充：${InAnswer.note}` : ''}`)
    InDoc.lines[_blk.head] = `${_m[1]}x${_m[3]}${_m[4]}${_m[5]}${_title}（${InStamp.date} 少爺定：${_decision}）`
  } else {
    _reply = decisionOneLine(InAnswer.text)
    InDoc.lines.splice(_blk.end, 0, `${_indent}- **少爺回覆**（${InStamp.date} ${InStamp.time}）：${_reply}`)
  }
  // 情境檔：原話逐字進「討論紀錄」（z_sub_scenario_experience §2）
  if (InLayer === 'scenario') {
    const _sec = mdSectionRange(InDoc.lines, /討論紀錄/)
    if (_sec) {
      const _body = InDoc.lines.slice(_sec[0], _sec[1]).map((l, i) => ({ l, i: _sec[0] + i })).filter(x => x.l.trim())
      if (_body.length === 1 && /^[-\s]*[（(]尚無/.test(_body[0].l)) InDoc.lines.splice(_body[0].i, 1)
      const _sec2 = mdSectionRange(InDoc.lines, /討論紀錄/)
      let _at = _sec2[1]
      while (_at > _sec2[0] && !InDoc.lines[_at - 1].trim()) _at--
      const _q = _question.length > 60 ? `${_question.slice(0, 60)}…` : _question
      InDoc.lines.splice(_at, 0, InAnswer.kind === 'choose'
        ? `- ${InStamp.date} 〔TC 待定奪〕${InAnswer.openId}〈${_q}〉少爺定：${_decision}`
        : `- ${InStamp.date} 〔TC 待定奪〕${InAnswer.openId}〈${_q}〉少爺回覆：「${_reply}」`)
    }
  }
  return { ok: true, raw: _blk.raw, question: _question, decision: _decision, reply: _reply }
}

function bumpFrontmatterUpdated(InLines, InDate) {
  if (InLines[0]?.trim() !== '---') return
  for (let i = 1; i < InLines.length && InLines[i].trim() !== '---'; i++)
    if (/^updated:\s*/.test(InLines[i])) { InLines[i] = `updated: ${InDate}`; return }
}

/** 侍酒師重萃取（非同步、同專案合併成一次）：完成後廣播 sommelier_refreshed，開著的面板就地重抓 */
function scheduleSommelierRefresh(InProj) {
  if (!InProj?.extractCommand) return false
  const _st = sommelierRefreshState.get(InProj.id) ?? { running: false, pending: false }
  sommelierRefreshState.set(InProj.id, _st)
  if (_st.running) { _st.pending = true; return true }
  _st.running = true
  const _t0 = Date.now()
  const _done = (InCode) => {
    _st.running = false
    logEvent('sommelier.refresh.async', { projectId: InProj.id, ok: InCode === 0, code: InCode, ms: Date.now() - _t0 })
    broadcast({ type: 'sommelier_refreshed', projectId: InProj.id, ok: InCode === 0 })
    if (_st.pending) { _st.pending = false; scheduleSommelierRefresh(InProj) }
  }
  try {
    const _p = spawn(InProj.extractCommand, { shell: true, stdio: 'ignore', windowsHide: true })
    _p.on('error', () => _done(-1))
    _p.on('close', _done)
  } catch { _done(-1) }
  return true
}

function readDecisionExplainCache() { try { return JSON.parse(fs.readFileSync(DECISION_EXPLAIN_FILE, 'utf8')) } catch { return { items: {} } } }
function readDecisionDispatch() { try { return JSON.parse(fs.readFileSync(DECISION_DISPATCH_FILE, 'utf8')) } catch { return { items: [] } } }
function updateDecisionDispatch(InId, InPatch) {
  const _d = readDecisionDispatch()
  const _rec = _d.items.find(x => x.id === InId)
  if (!_rec) return
  Object.assign(_rec, InPatch)
  atomicWriteJson(DECISION_DISPATCH_FILE, _d)
  broadcast({ type: 'decision_dispatch_update', projectId: _rec.projectId })
}

/** 送子任務的 prompt：無頭出身的聊天室不知道本面板的任何脈絡，所以條目原文、檔案絕對路徑、流程指針全寫進來 */
function composeDecisionPrompt(InProj, InDone, InOpts) {
  const _root = InProj.projectRoot ?? InProj.projectPath ?? ''
  const _l = []
  _l.push(`(TC 待定奪) 少爺在 TC 侍酒師的待定奪面板送出 ${InDone.length} 筆定奪／回覆（${InOpts.stamp.date} ${InOpts.stamp.time}，專案 ${InProj.name}${_root ? `，${_root}` : ''}）。`)
  _l.push('TC 已經把「決定」本身寫回原檔（harness 層，不必重寫）：選項定奪＝`- [x] OPEN-n …（日期 少爺定：…）`；回覆＝該 OPEN 條目下的 `**少爺回覆**` 子項；情境檔另記進「討論紀錄」。你負責之後的判斷與落實。')
  _l.push('', '【定奪清單】')
  InDone.forEach((d, i) => {
    _l.push(`${i + 1}. ${d.layer === 'intent' ? '🧭 設計脈絡' : '🎬 情境體驗'}｜${d.sourceTitle || d.sourceId}（${d.fp.replace(/\\/g, '/')}）${d.openId} ${d.question}`)
    for (const _sub of d.raw.split('\n').slice(1)) if (_sub.trim()) _l.push(`   ${_sub.trim()}`)
    _l.push(d.kind === 'choose' ? `   ✅ 少爺定：${d.decision}` : `   💬 少爺回覆（尚未定案）：「${d.reply}」`)
  })
  _l.push('', '【請依序處理】', 'A. 資料維護（每一筆都要做）')
  _l.push('  1. 動工前先跑 task_kickoff_check：讀原檔全文，以及「牽動」列出的意圖檔／情境檔（§B 首列與「情境」列）。')
  _l.push('  2. 選項定奪 → 把決定落成事實：意圖檔寫成不變量 `INV-n`（寫前查該檔最大編號、寫後查重複），情境檔把被採用的提案 💡→📐、被否決的標 ❌ 並留原話；再到該 OPEN 行尾的定案括號內補「→ 落為 INV-n」「→ 無需實作」或「→ 待實作」。「牽動」列到的其他檔一併同步。')
  _l.push('  3. 回覆（尚未定案）→ 先判斷少爺的回覆夠不夠定案：夠 → 由你把該條改成 `- [x]`（定案括號寫你整理出的決定；原話已在 `**少爺回覆**`），再照 2. 落實；不夠、或少爺是在發問 → 在該 OPEN 條目最後加一行 `  - **Claude 回覆**（YYYY-MM-DD HH:mm）：…` 說明或追問（必要時改寫「選項」讓他能直接點選），保持 `- [ ]`——TC 面板會把一問一答顯示成對話串。')
  // 約束傳播（少爺 2026-09-30「遊戲是環環相扣的，就像解數獨的技巧一樣」）：每筆定奪都順著連動題往下推
  const _nbBlocks = InOpts.graph ? InDone.map((d, i) => ({ i, lines: decisionNeighborLines(InOpts.graph, d.key) })).filter(x => x.lines.length) : []
  _l.push('  3.5 約束傳播（數獨）：定了一題就順著連動往下推——連動題已被這個決定（加上品味／現況）**完全決定** → 改成 `- [x] OPEN-n …（YYYY-MM-DD 推導定：<決定>；依據：由 [[X]] OPEN-n 少爺定推導…）`；只被縮小 → 加 `  - **推導**：<選項> 已排除（依據）`；互相衝突 → 在該題寫 `**Claude 回覆**` 指出衝突請少爺裁決。定的若是 🔑 關鍵意圖（有「解鎖」），它解鎖的每一題都要處理。除了下列明示的連動，也要想「還有哪些題因此被回答」（同一機制、同一情境、同一個玩家體驗）。推導只寫真的被決定的，傾向寫成 `**建議**`。')
  if (_nbBlocks.length) {
    _l.push('  【連動題】（程式從 md 的引用／取決於／解鎖建出）')
    for (const b of _nbBlocks) { _l.push(`   第 ${b.i + 1} 筆：`); for (const x of b.lines) _l.push(`   - ${x}`) }
  }
  _l.push(`  4. 機檢：\`python C:/Project/MasterBrain/.agent/scripts/Check-DesignIntent.py\` 與 \`Check-ScenarioExperience.py\`（後者只報不擋）；最後 POST http://127.0.0.1:3001/api/sommelier/refresh/${InProj.id} 讓侍酒師吃到最新。`)
  _l.push('B. 後續實作（有需要才做）')
  _l.push('  - 定案要改程式／資產／設定時，照 task_kickoff_check 與 `.agent/workflows/z_sub_scenario_experience.md` §5 落實表走既有流程（新機制 `z_sub_add_new_mechanism.md`、新 UI、文案 StringTable…）；不需要實作的明寫「無需實作」。')
  _l.push(InOpts.qaForImpl
    ? '  - 有實作的項目走 Mode C QA：照 theclaudenental_operator skill「QA Run 操作 SOP」開 QA Run（必綁 boundSessionId＝本 session id、boundProjectPath、project；wakeMode 由 server 決定，回應帶 mountCommand 就在同一個 response 掛起），列計畫等少爺確認後才編譯；純資料維護不開 QA Run。'
    : '  - 少爺這次沒勾「實作走 QA」：動 C++／資產之前先把實作計畫回報在聊天室，等少爺確認再做。')
  if (InOpts.cardId) _l.push(`C. 進度：TC 待辦卡 ${InOpts.cardId} 已建立（欄位 doing）。每完成一個階段就 PATCH http://127.0.0.1:3001/api/todos/${InOpts.cardId}（noteAppend 寫進度；全部完成推 done，需要少爺回答推 discussing）。`)
  _l.push('完成時回報：每一筆的落點（檔案＋INV 編號或情境標記）、連帶推導了哪些題（推導定／縮小）、需不需要實作、還有哪些題要少爺再回答。')
  return _l.join('\n')
}

/** 進一步說明的 prompt：題目原文＋來源檔脈絡＋牽動的意圖檔／情境（全部內嵌，不讓模型自己翻檔） */
function buildDecisionExplainPrompt(InProj, InLayer, InDoc, InBlock, InFile, InGraph = null, InKey = null) {
  const _fm = mdFrontmatter(InDoc.lines)
  const _title = _fm.title ?? InFile
  let _thesis = ''
  try { _thesis = JSON.parse(fs.readFileSync(path.join(InProj.dataDir, 'generated', 'scenario_experience.json'), 'utf8')).thesis ?? '' } catch {}
  const _readIntent = (InId) => {
    const _fp = decisionSourcePath(InProj, 'intent', `${InId}.md`)
    if (!_fp) return null
    const _d = readMdKeepFormat(_fp)
    return { title: mdFrontmatter(_d.lines).title ?? InId, intent: mdSectionText(_d.lines, /意圖/, 700), invariants: mdSectionText(_d.lines, /不變量/, 900) }
  }
  const _links = [...new Set([...InBlock.raw.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim()))]
  const _parts = []
  if (InLayer === 'intent') {
    _parts.push(`【來源檔：設計脈絡「${_title}」】`,
      `意圖：\n${mdSectionText(InDoc.lines, /意圖/, 1800)}`,
      `不變量：\n${mdSectionText(InDoc.lines, /不變量/, 2200)}`,
      `相關脈絡：\n${mdSectionText(InDoc.lines, /相關脈絡/, 700)}`)
    const _scenDir = InProj.scenarioDir
    const _hits = []
    try {
      for (const _f of fs.readdirSync(_scenDir).filter(f => /^S\d{2}_.+\.md$/.test(f)).sort()) {
        const _d = readMdKeepFormat(path.join(_scenDir, _f))
        const _sfm = mdFrontmatter(_d.lines)
        const _ids = String(_sfm.intents ?? '').split(',').map(s => s.trim())
        if (!_ids.includes(_fm.id) && !_d.lines.some(l => l.includes(`[[${_fm.id}]]`))) continue
        _hits.push(`- ${_sfm.title ?? _f}：${mdSectionText(_d.lines, /體驗一句話/, 240).replace(/\s+/g, ' ')}`)
        if (_hits.length >= 5) break
      }
    } catch {}
    if (_hits.length) _parts.push(`【這個機制出現在這些情境（玩家體驗）】\n${_hits.join('\n')}`)
  } else {
    const _gapIds = [...new Set([...InBlock.raw.matchAll(/\bG-\d+\b/g)].map(m => m[0]))]
    const _gaps = mdSectionText(InDoc.lines, /缺口/, 20000)
    const _gapText = _gapIds.length
      ? _gapIds.map(g => (_gaps.split(/\n(?=- )/).find(b => b.includes(g)) ?? '').slice(0, 700)).filter(Boolean).join('\n')
      : _gaps.slice(0, 1500)
    _parts.push(`【來源檔：情境體驗「${_title}」（階段 ${_fm.phase ?? '?'}）】`,
      `體驗一句話：\n${mdSectionText(InDoc.lines, /體驗一句話/, 500)}`,
      `題目對照：\n${mdSectionText(InDoc.lines, /題目對照/, 1600)}`,
      `進入與離開：\n${mdSectionText(InDoc.lines, /進入與離開/, 700)}`,
      `運作中的機制：\n${mdSectionText(InDoc.lines, /運作中的機制/, 1600)}`,
      `題目提到的缺口與提案：\n${_gapText}`)
    for (const l of String(_fm.intents ?? '').split(',').map(s => s.trim()).filter(Boolean)) if (!_links.includes(l)) _links.push(l)
  }
  const _intentIds = _links.filter(l => /^[A-Z][A-Za-z0-9]+$/.test(l) && l !== _fm.id).slice(0, 4)
  const _intentText = _intentIds.map(id => {
    const _it = _readIntent(id)
    return _it ? `- 「${_it.title}」（${id}）\n  意圖：${_it.intent.replace(/\s+/g, ' ')}\n  不變量摘錄：${_it.invariants.replace(/\s+/g, ' ').slice(0, 600)}` : null
  }).filter(Boolean)
  if (_intentText.length) _parts.push(`【牽動的意圖檔】\n${_intentText.join('\n')}`)
  const _scenIds = _links.filter(l => /^S\d{2}_/.test(l)).slice(0, 3)
  const _scenText = _scenIds.map(id => {
    const _fp = decisionSourcePath(InProj, 'scenario', `${id}.md`)
    if (!_fp) return null
    const _d = readMdKeepFormat(_fp)
    return `- ${mdFrontmatter(_d.lines).title ?? id}：${mdSectionText(_d.lines, /體驗一句話/, 240).replace(/\s+/g, ' ')}`
  }).filter(Boolean)
  if (_scenText.length) _parts.push(`【題目提到的其他情境】\n${_scenText.join('\n')}`)
  // 連動題（數獨盤面上的鄰居）：上游關鍵題／本題解鎖／明示引用，附目前狀態——讓說明能指出「這題其實已被回答／取決於哪題」
  const _nb = InGraph && InKey ? decisionNeighborLines(InGraph, InKey) : []
  if (_nb.length) _parts.push(`【連動題】\n${_nb.map(x => `- ${x}`).join('\n')}`)

  return `你是這個遊戲專案的設計顧問。少爺（遊戲製作人）在待定奪面板上看不懂下面這一題，按了「進一步說明」。請用白話把完整的情境與脈絡講清楚，讓他能自己做決定。只輸出一個 JSON 物件，不要任何其他文字，也不要呼叫任何工具（需要的內容都在下方）。

JSON 格式：
{"scene":"玩家此刻的情境：遊戲的哪一段、看到／聽到／能做什麼（2~4 句）","question":"這題白話在問什麼（1~2 句，不用術語）","whyNow":"為什麼需要少爺決定、不決定會卡住什麼（1~2 句）","options":[{"key":"A","label":"短標題（12 字內）","experience":"選了之後玩家會感受到什麼","cost":"開發成本與要動到哪些機制","risk":"代價或風險"}],"recommend":{"key":"A","reason":"一句話理由（只是建議，決定權在少爺）"},"context":["相關機制、不變量或情境的短句"],"glossary":[{"term":"術語","meaning":"白話解釋"}]}

規則：
- 全部繁體中文（台灣用語）；程式識別字（類別、函式、檔名、資產名）保留原文。
- 只根據下方資料，資料沒提到的寫「資料未提及」，不要編造。
- options：題目有列選項就逐一對應同樣的 key；題目沒列選項就整理 2~4 個可行方案（key 用 A、B、C…）。
- 以玩家體驗為主軸說明後果${_thesis ? `（這個專案的題目是：「${_thesis}」）` : ''}。
- glossary 收 2~6 個少爺可能不熟的術語，沒有就給空陣列；recommend 沒把握就給 null。
- 遊戲是環環相扣的：若這題其實已被【連動題】的定案、品味或現況回答，或只要先答某個上游關鍵題就能推出來，whyNow 第一句就明說（例「這題可能已有答案：…」「先答 X，這題就能推出來」）。

【這一題】（${InLayer === 'intent' ? '設計脈絡' : '情境體驗'}「${_title}」，檔案 ${InFile}）
${InBlock.raw}

${_parts.filter(Boolean).join('\n\n')}`
}

function parseDecisionExplain(InText) {
  try {
    const _m = String(InText ?? '').match(/\{[\s\S]*\}/)
    if (!_m) return null
    const _p = JSON.parse(_m[0])
    const _tw = (s) => { try { return s == null ? '' : s2tw(String(s)) } catch { return String(s ?? '') } }
    const _key = (k) => { const _k = String(k ?? '').trim().toUpperCase(); return /^[A-H]$/.test(_k) ? _k : null }
    const options = (Array.isArray(_p.options) ? _p.options : []).slice(0, 6)
      .map(o => ({ key: _key(o?.key), label: _tw(o?.label), experience: _tw(o?.experience), cost: _tw(o?.cost), risk: _tw(o?.risk) }))
      .filter(o => o.key)
    if (!_p.scene && !_p.question && !options.length) return null
    const _rk = _key(_p.recommend?.key)
    return {
      scene: _tw(_p.scene), question: _tw(_p.question), whyNow: _tw(_p.whyNow), options,
      recommend: _rk ? { key: _rk, reason: _tw(_p.recommend?.reason) } : null,
      context: (Array.isArray(_p.context) ? _p.context : []).slice(0, 8).map(_tw).filter(Boolean),
      glossary: (Array.isArray(_p.glossary) ? _p.glossary : []).slice(0, 8)
        .map(g => ({ term: _tw(g?.term), meaning: _tw(g?.meaning) })).filter(g => g.term),
    }
  } catch { return null }
}

// 非同步重萃取（面板的 ↻）：立即回應，完成時廣播 sommelier_refreshed；舊的 /refresh 是同步（跑完才回、期間卡住 server）
app.post('/api/sommelier/refresh-async/:projectId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const _proj = findSommelierProject(request.params.projectId)
  if (!_proj?.extractCommand) { reply.code(404); return { ok: false, error: 'no extractCommand for project' } }
  return { ok: true, scheduled: scheduleSommelierRefresh(_proj) }
})

// 面板狀態：已快取的說明（附 stale＝題目內容已變）＋每題最近一次派出的子任務
app.get('/api/decisions/state/:projectId', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const _pid = request.params.projectId
  const _proj = findSommelierProject(_pid)
  if (!_proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const _docs = new Map()
  const _currentHash = (InLayer, InFile, InOpenId) => {
    const _fp = decisionSourcePath(_proj, InLayer, InFile)
    if (!_fp) return null
    if (!_docs.has(_fp)) { try { _docs.set(_fp, readMdKeepFormat(_fp)) } catch { _docs.set(_fp, null) } }
    const _blk = _docs.get(_fp) ? findOpenBlock(_docs.get(_fp).lines, InOpenId) : null
    return _blk ? decisionHash(_blk.raw) : null
  }
  const explanations = {}
  for (const [k, v] of Object.entries(readDecisionExplainCache().items ?? {})) {
    if (!k.startsWith(`${_pid}|`)) continue
    const [, _layer, , _openId] = k.split('|')
    explanations[k] = { ...v, stale: v.ver !== DECISION_EXPLAIN_VER || (v.file ? _currentHash(_layer, v.file, _openId) !== v.hash : false) }
  }
  const dispatches = {}
  for (const _rec of readDecisionDispatch().items) {
    if (_rec.projectId !== _pid) continue
    const _running = !!_rec.sessionId && !!claudeLanes.runningEntry(_rec.sessionId)
    for (const k of _rec.keys ?? []) dispatches[k] = { id: _rec.id, ts: _rec.ts, cardId: _rec.cardId ?? null, sessionId: _rec.sessionId ?? null, target: _rec.target, kind: _rec.kinds?.[k] ?? null, running: _running }
  }
  return { ok: true, explanations, dispatches, explainModel: getTcSetting('decision.explainModel', DECISION_EXPLAIN_DEFAULT_MODEL), graph: buildDecisionGraph(_proj, _pid) }
})

// 進一步說明：讀原檔＋牽動檔，一次性無頭 Claude 產白話說明（快取；題目內容變了才重算，force＝強制重算）
app.post('/api/decisions/explain', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, layer, sourceId, file, openId, force } = request.body ?? {}
  const _proj = findSommelierProject(projectId)
  if (!_proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const _fp = decisionSourcePath(_proj, layer, file)
  if (!_fp || !/^OPEN-\d+$/.test(String(openId ?? ''))) { reply.code(400); return { ok: false, error: '找不到來源檔或題號不對' } }
  const _doc = readMdKeepFormat(_fp)
  const _blk = findOpenBlock(_doc.lines, openId)
  if (!_blk) { reply.code(404); return { ok: false, error: `${file} 裡找不到 ${openId}` } }
  const _key = `${projectId}|${layer}|${sourceId}|${openId}`
  const _hash = decisionHash(_blk.raw)
  const _hit = readDecisionExplainCache().items?.[_key]
  if (!force && _hit && _hit.hash === _hash && _hit.ver === DECISION_EXPLAIN_VER) return { ok: true, cached: true, key: _key, explanation: { ..._hit, stale: false } }
  if (decisionExplainInflight.has(_key)) return await decisionExplainInflight.get(_key)
  const _job = (async () => {
    const _model = getTcSetting('decision.explainModel', DECISION_EXPLAIN_DEFAULT_MODEL)
    const _t0 = Date.now()
    const _text = await runOneShotClaude(buildDecisionExplainPrompt(_proj, layer, _doc, _blk, file, buildDecisionGraph(_proj, projectId), _key), { model: _model, timeoutMs: DECISION_EXPLAIN_TIMEOUT_MS })
    const _parsed = parseDecisionExplain(_text)
    logEvent('decision.explain', { key: _key, model: _model, ok: !!_parsed, ms: Date.now() - _t0 })
    if (!_parsed) return { ok: false, error: '說明產生失敗（模型沒有回傳可解析的內容），可以再按一次' }
    const _entry = { ..._parsed, file, hash: _hash, ver: DECISION_EXPLAIN_VER, model: _model, generatedAt: Date.now(), ms: Date.now() - _t0 }
    const _cache = readDecisionExplainCache()
    _cache.items ??= {}
    _cache.items[_key] = _entry
    atomicWriteJson(DECISION_EXPLAIN_FILE, _cache)
    return { ok: true, cached: false, key: _key, explanation: { ..._entry, stale: false } }
  })().finally(() => decisionExplainInflight.delete(_key))
  decisionExplainInflight.set(_key, _job)
  return await _job
})

// 送出定奪：寫回原檔（harness）→ 非同步重萃取 → 建待辦卡＋派子任務。dryRun＝只回報會寫什麼與子任務 prompt，不動檔不派工
app.post('/api/decisions/submit', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, answers, dispatch = {}, dryRun = false } = request.body ?? {}
  const _proj = findSommelierProject(projectId)
  if (!_proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const _answers = (Array.isArray(answers) ? answers : []).filter(a => a
    && ['intent', 'scenario'].includes(a.layer) && /^OPEN-\d+$/.test(String(a.openId ?? '')) && a.file
    && ((a.kind === 'choose' && /^[A-H]$/.test(String(a.choiceKey ?? '')) && String(a.choiceText ?? '').trim())
      || (a.kind === 'reply' && String(a.text ?? '').trim())))
  if (!_answers.length) { reply.code(400); return { ok: false, error: '沒有可送出的定奪（選一個選項，或在「其他」寫下想法）' } }
  const _stamp = { date: todayStamp(), time: nowHHMM() }
  const _groups = new Map()
  for (const a of _answers) {
    const _k = `${a.layer}|${a.file}`
    if (!_groups.has(_k)) _groups.set(_k, [])
    _groups.get(_k).push(a)
  }
  const results = []
  const _done = []
  const preview = []
  for (const [_k, _arr] of _groups) {
    const [_layer, _file] = _k.split('|')
    const _fp = decisionSourcePath(_proj, _layer, _file)
    if (!_fp) { for (const a of _arr) results.push({ key: a.key ?? null, openId: a.openId, file: _file, ok: false, error: `找不到來源檔 ${_file}` }); continue }
    const _doc = readMdKeepFormat(_fp)
    const _before = _doc.lines.slice()
    let _changed = false
    for (const a of _arr) {
      const _r = applyDecisionAnswer(_doc, _layer, a, _stamp)
      results.push({ key: a.key ?? null, openId: a.openId, file: _file, ok: _r.ok, error: _r.error ?? null, stale: !!_r.stale })
      if (_r.ok) { _changed = true; _done.push({ ...a, fp: _fp, raw: _r.raw, question: _r.question, decision: _r.decision, reply: _r.reply }) }
    }
    if (!_changed) continue
    bumpFrontmatterUpdated(_doc.lines, _stamp.date)
    if (dryRun) preview.push({ file: _file, added: _doc.lines.filter(l => !_before.includes(l)) })
    else writeMdKeepFormat(_fp, _doc)
  }
  if (!_done.length) return { ok: false, error: results.find(r => r.error)?.error ?? '沒有寫入任何定奪', results }
  const _qaForImpl = dispatch.qaForImpl !== false
  if (dryRun) return { ok: true, dryRun: true, results, preview, prompt: composeDecisionPrompt(_proj, _done, { stamp: _stamp, qaForImpl: _qaForImpl, cardId: '(卡片 id)' }) }

  for (const d of _done) logEvent('decision.submit', { projectId, layer: d.layer, file: d.file, openId: d.openId, kind: d.kind, choiceKey: d.choiceKey ?? null })
  const refresh = scheduleSommelierRefresh(_proj)
  if (dispatch.enabled === false) return { ok: true, results, written: _done.length, refresh, dispatched: false }
  const _graph = buildDecisionGraph(_proj, projectId)
  const _short = (s) => { const _t = String(s ?? '').replace(/（.*$/, '').trim(); return _t.length > 18 ? `${_t.slice(0, 18)}…` : _t }
  const _first = _done[0]
  const _sent = await dispatchDecisionTask(_proj, projectId, {
    title: `定奪落實：${_short(_first.sourceTitle || _first.sourceId)} ${_first.openId}${_done.length > 1 ? ` 等 ${_done.length} 筆` : ''}`,
    note: `TC 待定奪面板 ${_stamp.date} ${_stamp.time} 送出（已寫回原檔，子任務處理後續＋連動題約束傳播）\n\n${_done.map(d => `- ${d.layer === 'intent' ? '🧭' : '🎬'} ${_short(d.sourceTitle || d.sourceId)} ${d.openId}：${d.kind === 'choose' ? `✅ ${d.decision}` : `💬 回覆「${d.reply.slice(0, 80)}」`}`).join('\n')}`,
    promptOf: (InCardId) => composeDecisionPrompt(_proj, _done, { stamp: _stamp, qaForImpl: _qaForImpl, cardId: InCardId, graph: _graph }),
    keys: _done.map(d => d.key).filter(Boolean),
    kinds: Object.fromEntries(_done.filter(d => d.key).map(d => [d.key, d.kind])),
    dispatch,
  })
  return { ok: true, results, written: _done.length, refresh, ..._sent }
})

/** 派子任務（定奪落實／數獨推導共用）：建待辦卡 → 以卡片 id 組 prompt → 聊天室
 *  開新＝直接 spawnClaude（init 後把 session id 綁回卡片與派工紀錄）；送入既有＝走 /api/claude/run（原地聯動／排隊照舊） */
async function dispatchDecisionTask(InProj, InProjectId, { title, note, promptOf, keys, kinds, dispatch = {} }) {
  const _projectRoot = String(InProj.projectRoot ?? InProj.projectPath ?? '')
  const _projectPath = _projectRoot.replace(/\//g, path.sep)
  if (!isSafeCwd(_projectPath)) return { dispatched: false, dispatchError: `專案路徑無效：${_projectPath || '(未設定 projectRoot)'}` }
  const _card = (await app.inject({ method: 'POST', url: '/api/todos', payload: { title, column: 'doing', note } })).json()?.card ?? null
  const _model = (typeof dispatch.model === 'string' && dispatch.model.trim()) ? dispatch.model.trim() : null
  const _effort = EFFORT_LEVELS.includes(dispatch.effort) ? dispatch.effort : null
  const _prompt = promptOf(_card?.id ?? null)
  const _target = dispatch.target === 'session' && /^[0-9a-f-]{36}$/i.test(String(dispatch.sessionId ?? '')) ? 'session' : 'new'
  const _recId = `dd${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const _store = readDecisionDispatch()
  _store.items = [..._store.items, { id: _recId, ts: Date.now(), projectId: InProjectId, keys, kinds, cardId: _card?.id ?? null, sessionId: _target === 'session' ? dispatch.sessionId : null, target: _target, model: _model, effort: _effort }].slice(-DECISION_DISPATCH_MAX)
  atomicWriteJson(DECISION_DISPATCH_FILE, _store)
  const _bindCard = (InSid) => { if (_card?.id && InSid) app.inject({ method: 'PATCH', url: `/api/todos/${_card.id}`, payload: { sessionId: InSid } }).catch(() => {}) }
  let run
  if (_target === 'new') {
    spawnClaude(_projectPath, _prompt, null, _model, _effort, (InSid) => { updateDecisionDispatch(_recId, { sessionId: InSid }); _bindCard(InSid) })
    run = { target: 'new', projectPath: normalizePath(_projectPath) }
  } else {
    const _runRes = await app.inject({ method: 'POST', url: '/api/claude/run', payload: { projectPath: _projectPath, prompt: _prompt, sessionId: dispatch.sessionId, model: _model, effort: _effort } })
    run = { target: 'session', sessionId: dispatch.sessionId, ...(_runRes.json() ?? {}) }
    _bindCard(dispatch.sessionId)
  }
  logEvent('decision.dispatch', { projectId: InProjectId, recId: _recId, target: _target, cardId: _card?.id ?? null, count: keys.length })
  broadcast({ type: 'decision_dispatch_update', projectId: InProjectId })
  return { dispatched: true, card: _card ? { id: _card.id, title: _card.title } : null, run, dispatchId: _recId, projectRoot: _projectRoot }
}

// ── 數獨推導（少爺 2026-09-30「遊戲是環環相扣的，就像解數獨的技巧一樣」「有時候問題只是缺少數幾的關鍵意圖，對齊後就能完善後續的實作與推理」）──
// 盤面＝兩層萃取資料的每一題；邊＝明示引用（ref）／取決於（depends）／解鎖（unlocks）。
// 決定性的部分（誰連到誰）由程式從 md 建；判斷性的部分（能不能推、推成什麼）交給子任務，結果一律寫成可推翻的「推導定」。

/** 待定奪連動圖：nodes＝每一題（未定＋已定），edges＝key → [{ key, kind:'ref'|'depends'|'unlocks', dir:'out'|'in' }] */
function buildDecisionGraph(InProj, InProjectId) {
  const _read = (InFile) => { try { return JSON.parse(fs.readFileSync(path.join(InProj.dataDir, 'generated', InFile), 'utf8')) } catch { return null } }
  const nodes = {}
  const _full = {}
  const _add = (InLayer, InSrc, InD) => {
    const key = `${InProjectId}|${InLayer}|${InSrc.id}|${InD.id}`
    _full[key] = InD
    nodes[key] = {
      key, layer: InLayer, sourceId: InSrc.id, sourceTitle: InSrc.title, file: InSrc.file, openId: InD.id,
      question: InD.question ?? InD.title, resolved: !!InD.resolved, resolvedBy: InD.resolvedBy ?? (InD.resolved ? 'owner' : null),
      resolution: InD.resolution ?? '', basis: InD.basis ?? '',
    }
  }
  for (const it of _read('design_intent.json')?.intents ?? []) for (const d of it.openDecisions ?? []) _add('intent', it, d)
  for (const s of _read('scenario_experience.json')?.scenarios ?? []) for (const d of s.openDecisions ?? []) _add('scenario', s, d)
  const _keyOf = (InFrom, InRef) => {
    const _target = InRef.target ?? InFrom.sourceId
    const _k = `${InProjectId}|${/^S\d{2}_/.test(_target) ? 'scenario' : 'intent'}|${_target}|${InRef.openId}`
    return nodes[_k] ? _k : null
  }
  const edges = {}
  const _seen = new Set()
  const _link = (InA, InB, InKind) => {
    if (!InA || !InB || InA === InB) return
    for (const [a, b, dir] of [[InA, InB, 'out'], [InB, InA, 'in']]) {
      const _s = `${a}|${b}|${InKind}|${dir}`
      if (_seen.has(_s)) continue
      _seen.add(_s)
      ;(edges[a] ??= []).push({ key: b, kind: InKind, dir })
    }
  }
  for (const n of Object.values(nodes)) {
    const d = _full[n.key]
    for (const r of d.refs ?? []) _link(n.key, _keyOf(n, r), 'ref')
    for (const r of d.dependsOn ?? []) _link(n.key, _keyOf(n, r), 'depends')
    for (const r of d.unlocks ?? []) _link(n.key, _keyOf(n, r), 'unlocks')
  }
  return { nodes, edges }
}

/** 一題的連動題（人讀的清單行）：上游關鍵題、下游被解鎖題、明示引用 */
function decisionNeighborLines(InGraph, InKey) {
  const _state = (n) => n.resolved ? `${n.resolvedBy === 'derived' ? '推導定' : '已定'}：${String(n.resolution || '').slice(0, 60)}` : '未定'
  return (InGraph.edges[InKey] ?? []).map(e => {
    const n = InGraph.nodes[e.key]
    if (!n) return null
    const _rel = e.kind === 'unlocks' ? (e.dir === 'out' ? '本題解鎖' : '上游關鍵題')
      : e.kind === 'depends' ? (e.dir === 'out' ? '上游關鍵題' : '本題解鎖') : '明示引用'
    return `【${_rel}】${n.layer === 'intent' ? '🧭' : '🎬'} ${n.sourceId} ${n.openId} ${String(n.question).slice(0, 70)}（${_state(n)}；檔案 ${n.file}）`
  }).filter(Boolean)
}

/** 數獨推導的 prompt：整張盤面（未定＋已定）＋解法步驟；子任務不知道面板脈絡，所以全寫進來 */
function composeDecisionSolvePrompt(InProj, InGraph, InOpts) {
  const _root = InProj.projectRoot ?? InProj.projectPath ?? ''
  const _all = Object.values(InGraph.nodes)
  const _open = _all.filter(n => !n.resolved)
  const _l = []
  _l.push(`(TC 待定奪・數獨推導) 少爺按了「🧩 數獨推導」（${InOpts.stamp.date} ${InOpts.stamp.time}，專案 ${InProj.name}${_root ? `，${_root}` : ''}）。`)
  _l.push('把目前的待定奪當數獨解：遊戲環環相扣，定一題會連帶回答、縮小或消去其他題；有時只缺少數幾個關鍵意圖，對齊後就能推完一整群（少爺 2026-09-30 品味，memory `feedback_decision_sudoku_propagation.md`）。')
  _l.push(`意圖檔目錄：${String(InProj.designIntentDir ?? '').replace(/\\/g, '/')}；情境檔目錄：${String(InProj.scenarioDir ?? '').replace(/\\/g, '/')}`)
  _l.push('', `【盤面：未定 ${_open.length} 題】（🔑＝關鍵意圖、⛓＝取決於上游）`)
  for (const n of _open) {
    const _nb = decisionNeighborLines(InGraph, n.key)
    const _mark = _nb.some(x => x.startsWith('【本題解鎖】')) ? '🔑' : _nb.some(x => x.startsWith('【上游關鍵題】')) ? '⛓' : '・'
    _l.push(`${_mark} ${n.layer}|${n.sourceId}|${n.openId}（${n.file}）${n.question}`)
    for (const x of _nb) _l.push(`   ${x}`)
  }
  _l.push('', '【線索：已定】')
  for (const n of _all.filter(x => x.resolved)) _l.push(`- ${n.layer}|${n.sourceId}|${n.openId} ${String(n.question).slice(0, 60)} ⇒ ${n.resolvedBy === 'derived' ? '推導定' : '少爺定'}：${String(n.resolution || '').slice(0, 90)}`)
  _l.push('', '【解法】依序做，每一步都寫進原檔（格式見 memory `feedback_design_intent_layer.md` §待定奪；少爺可在 TC 逐筆推翻，所以要可追溯）')
  _l.push('0. 先跑 task_kickoff_check；讀每題原檔的整個待定奪段，以及 MEMORY.md 索引裡的品味類 feedback。')
  _l.push('1. 消去已有答案的題：對照（a）其他已定案（b）品味類 memory（例：手感參數工具化、互動視覺寫實風、打擊感鬼武者／隻狼、中介軟體照業界慣例、玩家＝陣型整體…）（c）現況（程式碼、設定檔、意圖檔不變量、最近的實作）。**真的被決定**才改成 `- [x] OPEN-n …（YYYY-MM-DD 推導定：<決定>；依據：<檔案:行／memory 名／[[X]] OPEN-n>）`；只是傾向的寫成 `**建議**`，不推導。')
  _l.push('2. 合併重複題：同一題出現在兩處 → 保留資訊較完整的一題，另一題 `推導定：併入 [[X]] OPEN-n`，並把它獨有的現況／選項補進保留那題。')
  _l.push('3. 縮小：選項已被品味／現況／其他定案排除 → 加 `  - **推導**：<選項> 已排除（依據）`；兩個選項其實描述同一個現狀也寫明。題目一部分已被回答、只剩一部分時，把已回答的部分推導定，剩下的部分另開新題（寫前查該檔最大 OPEN 編號）。')
  _l.push('4. 分清誰的球：選項是「我去查／我去確認」的是 Claude 的工作——查完寫成事實（能定就推導定，不能定就改寫題目，只留真正的設計取捨）。')
  _l.push('5. 找關鍵意圖：把剩下的題分群，每群問「是不是缺一個上游意圖，少爺一句話就能推完這群」。有就在 `design_intent/DesignPillars.md` 的待定奪新增關鍵題（選項＝幾種方向、每個選項寫它會把下游題推成什麼），加 `**解鎖**：[[X]] OPEN-n、…`，並在每個下游題加 `**取決於**：[[DesignPillars]] OPEN-n`。某題本身就是上游（例如一場遊戲的結構題）就直接在它身上加 `**解鎖**`，不重複發問。')
  _l.push(`6. 機檢：\`python C:/Project/MasterBrain/.agent/scripts/Check-DesignIntent.py\` 與 \`Check-ScenarioExperience.py\`；最後 POST http://127.0.0.1:3001/api/sommelier/refresh/${InProj.id}。`)
  _l.push('7. 回報：消去 N 題（每題一行：題目 ⇒ 推導定＋依據）、合併 N 組、縮小 N 題、關鍵意圖 N 題（各解鎖哪些）、剩下真正要少爺定的 N 題。')
  _l.push('禁止：替少爺做真正的設計取捨；把傾向寫成推導定；刪掉任何題（一律用 [x]＋依據保留可追溯）；動程式碼（本任務只整理待定奪）。')
  if (InOpts.cardId) _l.push(`進度：TC 待辦卡 ${InOpts.cardId} 已建立。每完成一步就 PATCH http://127.0.0.1:3001/api/todos/${InOpts.cardId}（noteAppend 寫進度；完成推 discussing 請少爺確認推導）。`)
  return _l.join('\n')
}

// 🧩 數獨推導：整張盤面交給子任務解（消去／合併／縮小／關鍵意圖），結果寫成推導定供少爺確認。dryRun＝只回 prompt
app.post('/api/decisions/solve', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, dispatch = {}, dryRun = false } = request.body ?? {}
  const _proj = findSommelierProject(projectId)
  if (!_proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const _stamp = { date: todayStamp(), time: nowHHMM() }
  const _graph = buildDecisionGraph(_proj, projectId)
  const _open = Object.values(_graph.nodes).filter(n => !n.resolved)
  if (!_open.length) return { ok: false, error: '目前沒有未定的待定奪' }
  if (dryRun) return { ok: true, dryRun: true, open: _open.length, prompt: composeDecisionSolvePrompt(_proj, _graph, { stamp: _stamp, cardId: '(卡片 id)' }) }
  const _sent = await dispatchDecisionTask(_proj, projectId, {
    title: `數獨推導：${_proj.name} 待定奪 ${_open.length} 題`,
    note: `TC 待定奪面板 ${_stamp.date} ${_stamp.time} 按「🧩 數獨推導」：消去已有答案的題、合併重複題、縮小選項、找關鍵意圖；結果寫成可推翻的推導定`,
    promptOf: (InCardId) => composeDecisionSolvePrompt(_proj, _graph, { stamp: _stamp, cardId: InCardId }),
    keys: [], kinds: {}, dispatch,
  })
  logEvent('decision.solve', { projectId, open: _open.length })
  return { ok: true, open: _open.length, ..._sent }
})

// 推導定的確認／推翻（少爺在面板上按）：確認＝改成少爺定並保留依據；推翻＝回到未定、在題下記「推翻推導」讓他重新作答
app.post('/api/decisions/review', async (request, reply) => {
  if (!requireOwner(request, reply)) return { ok: false, error: 'owner only' }
  const { projectId, items } = request.body ?? {}
  const _proj = findSommelierProject(projectId)
  if (!_proj) { reply.code(404); return { ok: false, error: 'unknown project' } }
  const _stamp = { date: todayStamp(), time: nowHHMM() }
  const _derivedRe = /（(\d{4}-\d{2}-\d{2})\s*推導定[：:]\s*([^）]*)）/
  const results = []
  const _groups = new Map()
  for (const it of Array.isArray(items) ? items : []) {
    if (!['intent', 'scenario'].includes(it?.layer) || !['confirm', 'reject'].includes(it?.action) || !/^OPEN-\d+$/.test(String(it?.openId ?? ''))) continue
    const _k = `${it.layer}|${it.file}`
    if (!_groups.has(_k)) _groups.set(_k, [])
    _groups.get(_k).push(it)
  }
  for (const [_k, _arr] of _groups) {
    const [_layer, _file] = _k.split('|')
    const _fp = decisionSourcePath(_proj, _layer, _file)
    if (!_fp) { for (const it of _arr) results.push({ key: it.key ?? null, ok: false, error: `找不到來源檔 ${_file}` }); continue }
    const _doc = readMdKeepFormat(_fp)
    let _changed = false
    for (const it of _arr) {
      const _blk = findOpenBlock(_doc.lines, it.openId)
      const _m = _blk ? _doc.lines[_blk.head].match(_derivedRe) : null
      if (!_blk || !_m) { results.push({ key: it.key ?? null, ok: false, error: `${it.openId} 不是推導定（可能已被確認或改過）`, stale: true }); continue }
      const [_decision, ..._basis] = _m[2].split(/[；;]\s*依據[：:]\s*/)
      if (it.action === 'confirm') {
        _doc.lines[_blk.head] = _doc.lines[_blk.head].replace(_derivedRe, `（${_stamp.date} 少爺定：${_decision.trim()}；依據：${_basis.join('；').trim() || '依脈絡推導'}；確認推導 ${_m[1]}）`)
      } else {
        const _hm = _doc.lines[_blk.head].replace(_derivedRe, '').match(DECISION_HEAD_RE)
        _doc.lines[_blk.head] = `${_hm[1]} ${_hm[3]}${_hm[4]}${_hm[5]}${_hm[6].trimEnd()}`
        const _indent = _doc.lines[_blk.head + 1]?.match(/^(\s+)-/)?.[1] ?? '  '
        const _why = decisionOneLine(it.text)
        _doc.lines.splice(_blk.end, 0, `${_indent}- **少爺回覆**（${_stamp.date} ${_stamp.time}）：推翻推導「${decisionOneLine(_decision)}」${_why ? `——${_why}` : ''}`)
      }
      _changed = true
      results.push({ key: it.key ?? null, openId: it.openId, file: _file, ok: true, action: it.action })
      logEvent('decision.review', { projectId, file: _file, openId: it.openId, action: it.action })
    }
    if (!_changed) continue
    bumpFrontmatterUpdated(_doc.lines, _stamp.date)
    writeMdKeepFormat(_fp, _doc)
  }
  const refresh = results.some(r => r.ok) ? scheduleSommelierRefresh(_proj) : false
  return { ok: results.some(r => r.ok), results, refresh }
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
// 總設定 'qa.newRunCountdownSecs' 存在時=少爺強制模式（蓋過 Claude 帶的值，「都直接倒數中」語義）；未設定=Claude 值優先、fallback 30
app.post('/api/qa/runs', async (request) => {
  const body = request.body ?? {}
  const _forcedCountdown = getTcSetting('qa.newRunCountdownSecs', undefined)
  const countdownSecs = typeof _forcedCountdown === 'number' ? _forcedCountdown
    : (typeof body.countdownSecs === 'number' ? body.countdownSecs : 30)
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
    wakeMode: decideWakeMode(body.boundSessionId ?? null, body.wakeMode),
    archivedAt: null,
    requirement: body.requirement ?? '',
    qapPath: body.qapPath ?? '',
    sessionDir: body.sessionDir ?? '',   // 絕對路徑；artifact 路由以此為根
    criteria: Array.isArray(body.criteria) ? body.criteria : [],
    // C 區塊（少爺 2026-09-09）：設計說明。每筆 = 一顆可展開的按鈕，內容用結構化 blocks 排版
    // { id, title, tag, summary, blocks:[{type:'text'|'table'|'tree'|'steps'|'note'|'kv', ...}] }
    designs: Array.isArray(body.designs) ? body.designs : [],
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
  logEvent('qa.run.create', { id: run.id, topic: run.topic, status: run.status, wakeMode: run.wakeMode })
  qaBroadcast(run)
  // monitor 模式＝「建 run」與「掛監看」是同一個 response 的兩步、缺一則聯動失效——把指令直接回給 Claude 端
  return { ok: true, run, ...(run.wakeMode === 'monitor' ? { mountCommand: monitorMountCommand(run.boundSessionId) } : {}) }
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
    if (run.claudeAck && ['pending', 'undelivered'].includes(run.claudeAck.state)) { run.claudeAck.state = 'working'; dirty = true }
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
  const _prevStatus = run.status
  if (typeof body.status === 'string') {
    run.status = body.status
    if (body.status === 'running' && !run.startedAt) run.startedAt = Date.now()
    if (body.status === 'finished' || body.status === 'aborted') run.finishedAt = Date.now()
  }
  // 預約結案（少爺 2026-10-05）：Claude 依少爺在聊天室的話預約（closeArmed:true），或判斷留言不是要結案時取消（false）
  if (body.closeArmed === true && run.status !== 'closed') qaArmClose(run, 'claude', typeof body.closeArmedReason === 'string' ? body.closeArmedReason : null)
  if (body.closeArmed === false) qaDisarmClose(run, 'claude')
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
  if (Array.isArray(body.criteria)) run.criteria = body.criteria // A 區塊 criteria 整批重設(補字串→物件用；PATCH 入口，2026-07-15)
  if (Array.isArray(body.addCriteria)) for (const c of body.addCriteria) run.criteria.push(c)
  // C 區塊設計說明（少爺 2026-09-09）：designs 整批重設 / addDesigns 逐筆 upsert（同 id 覆蓋，改稿不長出重複按鈕）
  if (Array.isArray(body.designs)) run.designs = body.designs
  if (Array.isArray(body.addDesigns)) {
    if (!Array.isArray(run.designs)) run.designs = []
    for (const d of body.addDesigns) {
      const _i = run.designs.findIndex(x => x && x.id === d.id)
      if (_i >= 0) run.designs[_i] = d
      else run.designs.push(d)
    }
  }
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
  if (run.claudeAck) { if (['pending', 'undelivered'].includes(run.claudeAck.state)) run.claudeAck.state = 'working'; run.claudeAck.workingAt = Date.now() }
  // 少爺引導語（2026-07-07：接手後換成告訴少爺當下該做什麼，如「請 PIE 後將 Feedback 填入留言」；空字串=清除）
  if (typeof body.guidance === 'string') run.guidance = body.guidance ? { text: body.guidance, t: Date.now() } : null
  // 分支迴圈開新一輪（轉回待放行／倒數中）或中止＝少爺表態的是上一輪，預約結案作廢
  if (transitionCancelsArm(_prevStatus, run.status)) qaDisarmClose(run, `status:${_prevStatus}→${run.status}`)
  // ⭐ 預約結案代按：run 在（或剛進）已完成且有預約 → 做跟 ✔ 結案鈕完全相同的事。必須在上面「任何 PATCH＝處理中」之後，
  //    否則本次 PATCH 會把結案剛設的「等待接手」翻掉
  const _autoClose = (run.status === 'finished' && run.closeArmed) ? run.closeArmed : null
  if (_autoClose) qaApplyClose(run, _autoClose)
  run.updatedAt = Date.now()
  writeQaRuns(data)
  qaBroadcast(run)
  if (_autoClose) {
    logEvent('qa.run.control', { id: run.id, action: 'close', auto: true, source: _autoClose.source })
    logEvent('qa.close.auto', { id: run.id, source: _autoClose.source, via: 'patch-finished' })
    qaWakeBoundSession(run, 'close', qaAutoCloseWakeText(_autoClose), [], null, null, true)
    return { ok: true, run, autoClosed: true,
      note: '少爺已預約結案：TC 已代按 ✔ 結案，run 轉為已結案，結案通知（階段五）照聯動方式送到綁定聊天室（監看印出／直投／無頭喚醒；本聊天室忙碌時排在本回合之後）。收到那則再照階段五執行，本回合不要先做，免得重複。' }
  }
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
// 提早「處理中」訊號（少爺 2026-07-15：留言後 QA 分頁掛「等待接手」直到 Claude 第一次 PATCH，
// transcript「真回應」時間戳：最後一行 type:"assistant" 的 timestamp（epoch ms）。
// ⚠️ 不可用檔案 mtime 當活性訊號——CLI 的 queue-operation/enqueue user turn 也會動 mtime，
// 造成「喚醒已沉沒但面板顯示處理中」假活（2026-07-17 close 喚醒石沉實錄）。讀尾 256KB 就夠。
function lastAssistantActivityMs(watchFp) {
  try {
    if (!watchFp) return 0
    const _size = fs.statSync(watchFp).size
    const _fd = fs.openSync(watchFp, 'r')
    const _len = Math.min(_size, 256 * 1024)
    const _buf = Buffer.alloc(_len)
    fs.readSync(_fd, _buf, 0, _len, _size - _len)
    fs.closeSync(_fd)
    const _lines = _buf.toString('utf8').split('\n')
    for (let _i = _lines.length - 1; _i >= 0; _i--) {
      if (!_lines[_i].includes('"type":"assistant"')) continue
      try {
        const _e = JSON.parse(_lines[_i])
        if (_e.type === 'assistant' && _e.timestamp) return new Date(_e.timestamp).getTime()
      } catch {}
    }
    return 0
  } catch { return 0 }
}

// 空窗約 4 分鐘常被誤判沒做動）——喚醒後輪詢 transcript，一出現 assistant 回應就把 ack 翻成 working
function armAckEarlyFlip(runId, watchFp, baselineMtime) {
  const _timer = setInterval(() => {
    try {
      const _mt = lastAssistantActivityMs(watchFp)
      if (_mt <= baselineMtime) return
      clearInterval(_timer)
      const _d = readQaRuns()
      const _r = _d.runs.find(x => x.id === runId)
      if (_r?.claudeAck && ['pending', 'undelivered'].includes(_r.claudeAck.state)) {
        _r.claudeAck.state = 'working'
        _r.claudeAck.workingAt = Date.now()
        writeQaRuns(_d)
        qaBroadcast(_r)
      }
    } catch {}
  }, 8 * 1000)
  setTimeout(() => clearInterval(_timer), 160 * 1000)
}

// 喚醒石沉（headless resume 零 assistant 產出、重試仍失敗）→ 綁定該 session 的活 run 標 undelivered，
// QA 面板顯示紅字指引（請少爺在 VS Code 聊天室說「請繼續」）。狀態在 Claude 下次真的觸碰 API 時翻 working。
function markWakeUndelivered(sessionId) {
  try {
    const _d = readQaRuns()
    let _dirty = false
    for (const _r of _d.runs) {
      if (_r.boundSessionId !== sessionId || _r.archivedAt) continue
      if (!_r.claudeAck || !['pending', 'working'].includes(_r.claudeAck.state)) continue
      _r.claudeAck.state = 'undelivered'
      _r.claudeAck.undeliveredAt = Date.now()
      _r.updatedAt = Date.now()
      _dirty = true
      logEvent('qa.wake.undelivered', { id: _r.id, sessionId })
      qaBroadcast(_r)
    }
    if (_dirty) writeQaRuns(_d)
  } catch (e) { logEvent('qa.wake.undelivered.error', { sessionId, error: String(e?.message ?? e) }) }
}

const QA_WAKE_ACTIONS = { 'start-now': '按了「▶ 立即開跑」→ 請進入階段二（埋 LOG + 雙編譯 + 重啟 Editor）', pause: '要求暫停', resume: '要求繼續', abort: '要求中止', comment: '留言', close: '按了「✔ 結案」→ 階段五（清 QAC LOG + 雙編譯 + 重啟 Editor；無頭啟動 Editor 用 Start-Process detached）＋維護侍酒師閉環：把本 run 需求「實作驗證後的收斂」沉澱回四種血肉（C++ code / 架構 canvas / 拼圖 memory；藍圖 md 暫跳過），Editor 開著時跑 extract_asset_graph.py 更新藍圖資產層，最後 POST /api/sommelier/refresh/roman 重萃取讓侍酒師吃到最新拼圖＋設計思路模板維護（增量）：分析本 run「需求原話→設計決策/取捨→驗證結果」軌跡，萃取少爺這輪怎麼設計體驗，增量併入 .agent/knowledge/Roman_DesignThinking_Templates.md（基線 2026-07-31 全量、此後僅以 run 為單位增量），有更新列入 knowledgeUpdated 回寫＋情境體驗層維護（少爺 2026-09-15 立）：本 run 動到的意圖檔所涵蓋的情境檔 scenario/S##_*.md 推進狀態標記（💡→📐→🔬→✅）、補討論紀錄與素材清單（qa_finalize_check.py B8 機檢；SOP .agent/workflows/z_sub_scenario_experience.md §6）' }
function qaWakeBoundSession(run, action, text, attachPaths = [], model = null, effort = null, inPlaceLink = true) {
  try {
    // 預約結案中的留言喚醒：讓 Claude 知道推 finished 時 TC 會代按 ✔ 結案（少爺 2026-10-05）
    const _armNote = (action === 'comment' && run.closeArmed)
      ? `\n（TC 已預約結案：照 Mode C 逐項勾核、全過推 finished 時，TC 會自動代按 ✔ 結案並送出結案喚醒，不必請少爺再按；若判斷少爺不是要結案，PATCH /api/qa/runs/${run.id} {closeArmed:false} 取消）`
      : ''
    // ⭐ 做法 B（少爺 2026-10-04）：監看沒活著、但綁定分頁已登記直投 → 直接投進分頁當場處理（取代原本只能走的無頭補送）。
    //    監看活著時維持既有監看聯動——監看會自己從 run 資料印出這個動作，再直投＝重複送達。
    //    投不出去才退回下方既有鏈（inPlaceLink=false＝強制無頭，等同原本監看死掉後的補送）。
    if (inPlaceLink !== false && run.boundSessionId && !isMonitorAlive(run.boundSessionId) && ccmsgAvailable(run.boundSessionId)) {
      const _dFp = findJsonlPath(run.boundSessionId)
      const _dBefore = lastAssistantActivityMs(_dFp)
      let _dPrompt = `(TC QA 聯動通知) 少爺在 QA Monitor 對 run「${run.topic}」(${run.id}) ${QA_WAKE_ACTIONS[action] ?? action}${text ? `：「${text}」` : ''}。請照 Mode C 流程繼續（QA/README.md §Mode C），先 GET http://127.0.0.1:3001/api/qa/runs/${run.id}?ackComments=1 讀留言。${_armNote}`
      for (const _p of (Array.isArray(attachPaths) ? attachPaths : [])) _dPrompt += `\n${_p}`
      ccmsgPostVerified(run.boundSessionId, _dPrompt, { kind: `qa-${action}` }).then((_r) => {
        if (_r.state === 'not_sent') {
          logEvent('qa.wake.direct_failed', { id: run.id, action, sessionId: run.boundSessionId, error: _r.error })
          qaWakeBoundSession(run, action, text, attachPaths, model, effort, false)
          return
        }
        logEvent('qa.wake.direct', { id: run.id, action, sessionId: run.boundSessionId, tag: _r.tag, receipt: _r.receipt ?? null })
        if (_r.receipt === 'none') { markWakeUndelivered(run.boundSessionId); return }
        armAckEarlyFlip(run.id, _dFp, _dBefore)
      }).catch((e) => logEvent('qa.wake.error', { id: run.id, action, error: String(e?.message ?? e) }))
      return
    }
    // monitor 模式＝該 session 自掛監看，不可 spawn（雙寫 transcript）；其餘一律喚醒。
    // ⭐ 心跳活著也走本分支（少爺 2026-07-17）：run 還掛 spawn 但監看確實在跑時，喚醒本就靠監看輪詢 run 資料原地聯動，
    //    再 spawn 無頭＝雙重觸發。以 VERIFIED 心跳為準，活著一律交給原地聯動、不 spawn。
    // 看門狗（少爺 2026-07-15「確保機制能運作」）：分頁被關掉＝監看已死——心跳斷即刻無頭補送；心跳在但 transcript
    //    150 秒沒新回應（監看活著但卡住）才退回無頭喚醒＋run 轉回 spawn 模式（喚醒永不聾）。
    // inPlaceLink=false＝少爺在留言列關掉「🔗 聯動」→ 本次強制走無頭，不佔用分頁
    if (inPlaceLink !== false && (run.wakeMode === 'monitor' || isMonitorAlive(run.boundSessionId))) {
      const _mFp = findJsonlPath(run.boundSessionId)
      const _mBefore = lastAssistantActivityMs(_mFp)
      const _mPrompt = `(TC QA 聯動通知) 少爺在 QA Monitor 對 run「${run.topic}」(${run.id}) ${QA_WAKE_ACTIONS[action] ?? action}${text ? `：「${text}」` : ''}。原 monitor 監看已無回應（分頁可能已關閉），本喚醒為無頭補送，run 已轉回 spawn 模式。請照 Mode C 流程繼續（QA/README.md §Mode C），先 GET /api/qa/runs/${run.id}?ackComments=1 讀留言。${_armNote}`
      // 無頭補送（監看確定不在／卡住時保底）：run 轉回 spawn、避免同進程雙寫
      const _doHeadlessFallback = (reason) => {
        const _d = readQaRuns()
        const _r = _d.runs.find(x => x.id === run.id)
        if (_r) { _r.wakeMode = 'spawn'; _r.updatedAt = Date.now(); writeQaRuns(_d); qaBroadcast(_r) }
        logEvent('qa.wake.monitor_fallback', { id: run.id, action, sessionId: run.boundSessionId, reason })
        const _pp = (run.boundProjectPath ?? 'C:/Project/RomanPrototype').replace(/\//g, path.sep)
        if (!isSafeCwd(_pp)) { logEvent('qa.wake.error', { id: run.id, action, error: `unsafe cwd ${_pp}` }); return }
        const _sp = getSessionPrefs(run.boundSessionId)
        // ⚠️ 補送絕不丟（少爺 2026-10-05 實錄：舊版「專案有別的聊天室在跑就 return」把 603e640e／966a3d51 的留言喚醒整個吃掉）：
        //    同室忙碌＝排進該室隊伍（併入同室已排的一則），閒置＝直接起；別室在跑不相干
        const _lane = runOrQueueForSession(_pp, _mPrompt, run.boundSessionId, _sp?.model ?? null, _sp?.effort ?? null, null, { coalesce: true, coalesceSeparator: '\n\n(追加喚醒) ' })
        logEvent(_lane.queued ? (_lane.coalesced ? 'qa.wake.coalesced' : 'qa.wake.queued') : 'qa.wake.spawned', { id: run.id, action, sessionId: run.boundSessionId, via: 'monitor_fallback' })
      }
      // 心跳已斷＝分頁確定沒掛監看：不等 150s，立即無頭補送（喚醒不聾、不拖延）。
      // 心跳沒斷的話，喚醒本就靠監看輪詢 run 資料原地聯動（不 spawn）——只留 transcript 活性看門狗防「監看活著但卡住」
      if (!isMonitorAlive(run.boundSessionId))
      {
        _doHeadlessFallback('heartbeat-dead')
        return
      }
      armAckEarlyFlip(run.id, _mFp, _mBefore)
      // ⭐ 看門狗判準＝「這次喚醒有沒有被處理」，不是「聊天室有沒有在講話」（少爺 2026-08-21 實錄）：
      //    舊版比對 transcript assistant 活動 → 少爺剛好在同一個聊天室聊別的事，就被當成「已送達」→
      //    結案通知整個蒸發（監看是孤兒、根本沒人收）。改看 run.claudeAck 是否仍停在 pending：
      //    只有真的有人接手（Claude 觸碰 API 時翻 working）才算送達，否則一律無頭補送。
      //    順帶把 150s 縮到 45s——少爺按下去到補送的空窗要短。
      setTimeout(() => {
        try {
          const _d = readQaRuns()
          const _r = _d.runs.find(x => x.id === run.id)
          if (!_r) return
          if (_r.claudeAck?.state && _r.claudeAck.state !== 'pending') return   // 有人接手了（working/done）
          _doHeadlessFallback('ack-still-pending-45s')
        } catch {}
      }, 45 * 1000)
      return
    }
    // 少爺 2026-07-14「QA 送出＝仕酒師同做法」：未綁定聊天室（或 wakeMode none）不再沉默——
    // 像「開新聊天室」spawn 新 session 接手，並在 init 拿到 session id 後自動綁回 run（自癒「沒綁定＝按鈕聾的」）
    const _unbound = !run.boundSessionId
    // 留言沒明選模型/強度 → 沿用該聊天室記住的偏好（少爺 2026-07-14）
    const _sessPrefs = getSessionPrefs(run.boundSessionId)
    const _model = model ?? _sessPrefs?.model ?? null
    const _effort = effort ?? _sessPrefs?.effort ?? null
    const detail = QA_WAKE_ACTIONS[action] ?? action
    let prompt = `(TC QA 聯動通知) 少爺在 QA Monitor 對 run「${run.topic}」(${run.id}) ${detail}${text ? `：「${text}」` : ''}。請照 Mode C 流程繼續（QA/README.md §Mode C）。${_armNote}`
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
    // 少爺 2026-07-06 的「開可視 CLI 視窗」路徑已於 2026-09-08 移除：條件早在 2026-07-17 就被
    // false && 停用（pm2 服務脈絡下 Start-Process 無聲失敗 → 卡 90 秒看門狗），留著只是死設計；
    // 「看得到處理過程」的正解是原地聯動（monitor），不是另開一個視窗。
    // 提早「處理中」訊號（spawn/queue 皆適用；未綁定新開的 run 等 Claude 首次 PATCH 才翻）
    if (run.boundSessionId) {
      const _aFp = findJsonlPath(run.boundSessionId)
      armAckEarlyFlip(run.id, _aFp, lastAssistantActivityMs(_aFp))
    }
    // 只有「綁定的同一個聊天室」正在跑才排隊；別的聊天室在跑照樣並行（少爺 2026-10-05）。未綁定＝開新聊天室，永不排隊。
    // 同室已有排隊中的一則 → 併入同一則（少爺 2026-07-15 修：喚醒堆積成 N 個回合、每回合重複回答）
    const _r = runOrQueueForSession(projectPath, prompt, run.boundSessionId ?? null, _model, _effort, _onInit, { coalesce: true, coalesceSeparator: '\n\n(追加喚醒) ' })
    logEvent(_r.queued ? (_r.coalesced ? 'qa.wake.coalesced' : 'qa.wake.queued') : 'qa.wake.spawned', { id: run.id, action, sessionId: run.boundSessionId ?? null })
  } catch (e) { logEvent('qa.wake.error', { id: run.id, action, error: String(e?.message ?? e) }) }
}

// ─── 預約結案（少爺 2026-10-05）──────────────────────────────────────────────────
// 「如果我說 QA 進入{或是按下}結案，Run 進入已完成的狀態，就會自動補上（替我手按），讓 QA Run 進入已結案」。
// 少爺表態時 run 常常還在執行中（Claude 還要逐項勾核、推 finished），舊流程得等推完再回來按一次 ✔ 結案。
// 預約後 run 一進「已完成」，server 就做跟按 ✔ 結案完全相同的事（轉已結案＋喚醒綁定聊天室進階段五）。
// 預約來源：執行中 ✔ 結案鈕／整則留言表態結案（判斷在 qaCloseArm.js）／Claude 依少爺在聊天室的話 PATCH closeArmed:true。
// 轉回待放行／倒數中（分支迴圈新一輪）或中止＝預約作廢；QA 面板可取消。

/** 記下預約（已預約就保留最早那筆的來源） */
function qaArmClose(InRun, InSource, InText = null) {
  if (InRun.closeArmed) return false
  InRun.closeArmed = { t: Date.now(), source: InSource, text: InText ? String(InText).slice(0, 200) : null }
  logEvent('qa.close.armed', { id: InRun.id, source: InSource })
  return true
}

/** 預約作廢 */
function qaDisarmClose(InRun, InReason) {
  if (!InRun.closeArmed) return false
  InRun.closeArmed = null
  logEvent('qa.close.disarmed', { id: InRun.id, reason: InReason })
  return true
}

/** 結案狀態轉換（✔ 結案鈕與預約代按共用）：已完成／已中止 → 已結案、等 Claude 接手做階段五。InAuto＝代按時的預約紀錄 */
function qaApplyClose(InRun, InAuto = null) {
  if (InRun.status !== 'finished' && InRun.status !== 'aborted') return false
  InRun.status = 'closed'
  InRun.closedAt = Date.now()
  InRun.claudeAck = { action: 'close', t: Date.now(), state: 'pending' }
  InRun.guidance = null
  if (InAuto) InRun.autoClose = { t: Date.now(), source: InAuto.source, text: InAuto.text ?? null }
  InRun.closeArmed = null
  return true
}

/** 代按結案時附在喚醒 prompt「按了 ✔ 結案」後面的說明 */
function qaAutoCloseWakeText(InArm) {
  const _src = { button: '按了執行中的 ✔ 結案', comment: '留言表態結案', claude: '在聊天室表態結案' }[InArm?.source] ?? '表態結案'
  return `預約結案——少爺${_src}${InArm?.text ? `（${InArm.text}）` : ''}，run 已到已完成，由 TC 代按`
}

// 少爺控制：start-now / pause / resume / abort / comment / close / disarm-close
// pause / abort 對跑動中的 run 只立 flag，由 emitter 在「項目邊界」執行後 ack（狀態乾淨、不硬斷 PIE）
app.post('/api/qa/runs/:id/control', async (request, reply) => {
  const data = readQaRuns()
  const run = data.runs.find(r => r.id === request.params.id)
  if (!run) { reply.code(404); return { ok: false, error: 'not found' } }
  const { action, text, itemId, attachments, model, effort, inPlaceLink, armClose } = request.body ?? {}
  // 取消預約結案：只動標記，不喚醒 Claude、不改處理中狀態
  if (action === 'disarm-close') {
    if (qaDisarmClose(run, 'owner-cancel')) { run.updatedAt = Date.now(); writeQaRuns(data); qaBroadcast(run) }
    return { ok: true, run }
  }
  const _prevStatus = run.status
  let _wakeAction = action    // 留言表態結案且 run 已完成＝當場代按，喚醒改走結案
  let _wakeText = action === 'comment' ? String(text ?? '') : ''
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
    // 預約結案：執行中 ✔ 結案鈕（armClose）或整則留言在表態結案 → run 已完成就當場代按、還沒到就預約
    if (armClose === true || commentIntendsClose(text, itemId ?? null)) {
      const _arm = { source: armClose === true ? 'button' : 'comment', text: String(text ?? '') }
      if (run.status === 'finished') {
        qaApplyClose(run, _arm)
        _wakeAction = 'close'
        _wakeText = qaAutoCloseWakeText(_arm)
        logEvent('qa.close.auto', { id: run.id, source: _arm.source, via: 'comment-on-finished' })
      } else if (canArmInStatus(run.status)) qaArmClose(run, _arm.source, _arm.text)
    }
  } else if (action === 'close') {
    // 少爺結案（第五階段觸發訊號）：已完成/已中止 → 結案；Claude 收到通知後清 QAC LOG + 雙編譯
    if (!qaApplyClose(run)) { reply.code(400); return { ok: false, error: `cannot close run in status ${run.status}` } }
  } else { reply.code(400); return { ok: false, error: `unknown action ${action}` } }
  // 中止＝這輪不做了，預約結案作廢
  if (run.status === 'aborted' && _prevStatus !== 'aborted') qaDisarmClose(run, 'aborted')
  // 少爺動作 → 顯示「等待 Claude 接手」（Claude 第一次 API 觸碰時翻成 working — 見 PATCH/events/ackComments）
  run.claudeAck = { action: _wakeAction, t: Date.now(), state: 'pending' }
  // 少爺推進了狀態 → 上一階段的引導語過期；留言＝Feedback 送達（2026-07-07 少爺：送出後要顯示新階段、不是還掛「請進 PIE」）
  if (_wakeAction !== 'comment') run.guidance = null
  else run.guidance = { text: 'Feedback 已送出，等待 Claude 讀取分析…', t: Date.now() }
  run.updatedAt = Date.now()
  writeQaRuns(data)
  logEvent('qa.run.control', { id: run.id, action, ...(_wakeAction !== action ? { wakeAs: _wakeAction } : {}) })
  qaBroadcast(run)
  qaWakeBoundSession(run, _wakeAction, _wakeText, _attachPaths, action === 'comment' ? _wakeModel : null, action === 'comment' ? _wakeEffort : null, inPlaceLink !== false)
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

// ─── 陪聊（少爺 2026-10-04）────────────────────────────────────────────────────
// 「QA Run 中有個按鈕(對應不同的QA)…陪我腦力激盪…將我的想法整理並實作，也會即時回應我」＋「仕酒師也需要…
//  加入購物車…我可以知道你將我哪些想法加入購物車」＋「語音功能算是附加的(第二套做法)…原本的文字互動依舊保留」。
// 每個 QA run／侍酒師專案一位常駐無頭 Claude（stream-json 輸入、唯讀三工具、不載 MCP、關 hook），每輪回覆尾端附
// <tc-board> 機讀區塊 → server 維護想法板。QA＝少爺按「交付實作」或說「交付」才送進綁定分頁（走既有留言＋喚醒鏈，
// 含做法 B 直投）；侍酒師＝想法即時進購物車（client 端 localStorage），可撤回。語音在 client 端（瀏覽器內建辨識與朗讀）。
// 規格：memory project_spec_tc_companion.md
const COMPANION_FILE = path.join(os.homedir(), '.claude', 'tc_companions.json')
const COMPANION_CWD = path.join(os.homedir(), '.claude', 'tc-companion')   // transcript 落在含 tc-companion 的專案夾：History／側欄排除
const COMPANION_MSG_MAX = 200
const COMPANION_RECAP_MSGS = 12
const companionProcs = new Map()   // key → { proc, buf, status, turnText, turnMsgId, pending[], idleTimer, deltaTimer }
const companionStore = (() => { try { return JSON.parse(fs.readFileSync(COMPANION_FILE, 'utf-8')) } catch { return {} } })()
let _companionPersistTimer = null
function persistCompanions() {
  if (_companionPersistTimer) return
  _companionPersistTimer = setTimeout(() => {
    _companionPersistTimer = null
    try { atomicWriteJson(COMPANION_FILE, companionStore) } catch {}
  }, 500)
}

/** 陪聊對象的脈絡：標題、專案根、可讀資料夾、簡介 */
function companionContext(InScope, InRefId) {
  if (InScope === 'qa') {
    const _run = readQaRuns().runs.find(r => r.id === InRefId)
    if (!_run) return null
    const _proj = findSommelierProject(_run.project ?? 'roman')
    const _memDirs = String(_proj?.memoryDir ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return {
      title: `QA｜${_run.topic}`,
      projectId: _proj?.id ?? null,
      projectRoot: _run.boundProjectPath ?? _proj?.projectRoot ?? null,
      dirs: [_proj?.designIntentDir, _proj?.scenarioDir, ..._memDirs].filter(Boolean),
      brief: [
        `QA run「${_run.topic}」(${_run.id})，狀態 ${_run.status}；${_run.boundSessionId ? `綁定實作聊天室 ${_run.boundSessionId}` : '尚未綁定實作聊天室（交付時會開新聊天室接手）'}`,
        _run.requirement ? `需求：${String(_run.requirement).slice(0, 1500)}` : '',
        _run.items?.length ? `驗收項目：${_run.items.slice(0, 20).map(it => `${it.id}. ${it.text}（${it.status}）`).join('；').slice(0, 1800)}` : '',
        _run.qapPath ? `計畫檔：${_run.qapPath}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
  if (InScope === 'som') {
    const _proj = findSommelierProject(InRefId)
    if (!_proj) return null
    const _memDirs = String(_proj.memoryDir ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return {
      title: `侍酒師｜${_proj.name}`,
      projectId: _proj.id,
      projectRoot: _proj.projectRoot ?? null,
      dirs: [_proj.designIntentDir, _proj.scenarioDir, ..._memDirs].filter(Boolean),
      brief: `專案 ${_proj.name}（${_proj.id}）${_proj.designIntentDir ? `；設計意圖在 ${_proj.designIntentDir}` : ''}${_proj.scenarioDir ? `；情境檔在 ${_proj.scenarioDir}` : ''}`,
    }
  }
  return null
}

// ─── 侍酒師目錄（少爺 2026-10-06「陪聊過程就會邊從仕酒師的脈絡跟情境理解我的議題，並將這些內容都加入購物車
//     (視同我原本手動加入的操作)」）：把六層萃取資料攤成一行一條的目錄檔，陪聊用 Grep 查關鍵字、第一欄 ref 原樣
//     回報；client 再用手動 🛒 同一份快照放進購物車。萃取資料換版（檔案戳記變）才重寫。
const companionCatalogCache = new Map()   // projectId → { stamp, file, refs: Map(ref → { title, icon }) }
function companionCatalog(InProjectId) {
  const _proj = InProjectId ? findSommelierProject(InProjectId) : null
  if (!_proj?.dataDir) return null
  const _gen = path.join(_proj.dataDir, 'generated')
  const _names = ['design_intent.json', 'scenario_experience.json', 'cpp_symbols.json', 'asset_graph.json', 'memory_notes.json', 'arch_canvas.json']
  const _stamp = _names.map(f => { try { return fs.statSync(path.join(_gen, f)).mtimeMs } catch { return 0 } }).join('|')
  const _file = `catalog_${_proj.id}.md`
  const _cached = companionCatalogCache.get(_proj.id)
  if (_cached?.stamp === _stamp && fs.existsSync(path.join(COMPANION_CWD, _file))) return _cached
  const _read = (InName) => { try { return JSON.parse(fs.readFileSync(path.join(_gen, InName), 'utf8')) } catch { return null } }
  const _one = (InText, InMax) => String(InText ?? '').replace(/\s+/g, ' ').trim().slice(0, InMax)
  const _refs = new Map()
  const _lines = [`# 侍酒師目錄（${_proj.name}）：每行第一欄就是 ref，放進購物車時原樣照抄；用 Grep 查關鍵字，要細節再 Read「檔案」欄的原檔`, '']
  const _add = (InRef, InIcon, InTitle, InRest) => {
    if (!InRef || /[\r\n]/.test(InRef) || _refs.has(InRef)) return
    _refs.set(InRef, { title: InTitle, icon: InIcon })
    _lines.push([InRef, InTitle, ...InRest.filter(Boolean)].join(' ｜ '))
  }
  const _intent = _read('design_intent.json')
  _lines.push('## 🧭 設計脈絡（intent）')
  for (const it of _intent?.intents ?? [])
    _add(`intent:${it.id}`, '🧭', _one(it.title, 120), [`範圍 ${(it.scope ?? []).join('/')}`, _one(it.intent, 160),
      _proj.designIntentDir && it.file ? `檔案 ${_proj.designIntentDir}/${it.file}` : '', it.symbolRefs?.length ? `符號 ${it.symbolRefs.slice(0, 8).map(r => r.name).join(',')}` : ''])
  const _scenario = _read('scenario_experience.json')
  _lines.push('', '## 🎬 情境（scenario）')
  for (const sc of _scenario?.scenarios ?? [])
    _add(`scenario:${sc.id}`, '🎬', _one(sc.title, 100), [sc.phase ? `階段 ${sc.phase}` : '', _one(sc.oneLiner, 140),
      _proj.scenarioDir && sc.file ? `檔案 ${_proj.scenarioDir}/${sc.file}` : '', sc.intentLinks?.length ? `涵蓋意圖 ${sc.intentLinks.join(',')}` : ''])
  const _cpp = _read('cpp_symbols.json')
  _lines.push('', '## ◆ C++ 符號（symbol）')
  for (const s of _cpp?.symbols ?? [])
    _add(`symbol:${s.name}`, '◆', s.name, [s.kind, s.file ? `檔案 ${_proj.projectRoot ? `${_proj.projectRoot}/` : ''}${s.file}` : '', _one(s.comment, 100)])
  const _assets = _read('asset_graph.json')
  _lines.push('', '## 🎨 藍圖（bp）')
  for (const b of _assets?.blueprints ?? [])
    _add(`bp:${b.path}`, '🎨', b.name, [`${b.class ?? ''} 繼承 ${b.parentName ?? '?'}`])
  const _memory = _read('memory_notes.json')
  const _memDirs = String(_proj.memoryDir ?? '').split(',').map(s => s.trim()).filter(Boolean)
  // 拼圖的檔案欄多半只有檔名 → 在各拼圖資料夾找到實際位置，陪聊才 Read 得到
  const _memFile = (InFile) => {
    if (!InFile || path.isAbsolute(InFile)) return InFile
    for (const _d of _memDirs) if (fs.existsSync(path.join(_d, InFile))) return `${_d}/${InFile}`
    return InFile
  }
  _lines.push('', '## 📓 拼圖（memory）')
  for (const n of _memory?.notes ?? [])
    _add(`memory:${n.name}`, '📓', _one(n.title, 80), [n.type, _one(n.description, 140), n.file ? `檔案 ${_memFile(n.file)}` : ''])
  const _arch = _read('arch_canvas.json')
  _lines.push('', '## 🗺️ 架構節點（arch）')
  for (const c of _arch?.canvases ?? [])
    for (const nd of c.nodes ?? [])
      _add(`arch:${c.file}#${nd.id}`, '🗺️', _one(nd.title, 80), [`canvas ${_one(c.title, 60)}`, _one(nd.text, 120), nd.symbolRefs?.length ? `符號 ${nd.symbolRefs.slice(0, 6).map(r => r.name).join(',')}` : ''])
  try {
    fs.mkdirSync(COMPANION_CWD, { recursive: true })
    fs.writeFileSync(path.join(COMPANION_CWD, _file), _lines.join('\n'), 'utf8')
  } catch (e) { logEvent('tc.companion.catalog_error', { projectId: _proj.id, error: String(e?.message ?? e) }); return null }
  const _entry = { stamp: _stamp, file: _file, refs: _refs }
  companionCatalogCache.set(_proj.id, _entry)
  logEvent('tc.companion.catalog', { projectId: _proj.id, refs: _refs.size })
  return _entry
}

const COMPANION_RULES = [
  '你是少爺的「開發者朋友」：一起做這款遊戲的資深遊戲開發夥伴（與 TC「遊戲製作人朋友」同一個精神——看得見、感覺得到、一起走下去）。有自己的看法，會說「我覺得…」，誠實指出風險與取捨，但尊重少爺的直覺；品味類拼圖（memory:feedback_… 標「品味」者）已回答的方向直接套用，不再拿來問少爺。',
  '全程繁體中文、口語、短句（一到三句），像坐在旁邊的同事；不念表格、程式碼、路徑、長清單，少爺要細節再說。',
  '你的工作是聽懂少爺的想法、在關鍵處追問一句、把想法整理成條目；不要動手改任何檔案、不要假裝已經做了什麼。',
  '需要佐證時可以用 Read／Grep／Glob 查專案的設計意圖、情境檔與計畫，但回覆仍要短。',
  '少爺的訊息可能來自語音辨識（沒有標點、有錯字）：讀意圖，關鍵字聽不懂就問。',
  '訊息開頭的「（系統：…）」是 TC 告訴你的狀態變化（例如少爺手動改了想法板、已交付），照著更新，不必複述。',
  '每次回覆的最後另起一行附一個機讀區塊（少爺看不到）：<tc-board>{JSON}</tc-board>，只能有一個、必須是合法 JSON。',
]

/** 目錄規則：每個議題先查侍酒師脈絡再對齊（少爺 2026-10-06 語音原話「希望以後陪聊都能即時檢索設計脈絡還有情境，這樣子我們才能達成共識」） */
function companionCatalogRules(InCtx) {
  if (!InCtx.catalogFile) return []
  return [
    `・侍酒師目錄在你的工作目錄 ${InCtx.catalogFile}（每行第一欄是 ref：intent:／scenario:／symbol:／bp:／memory:／arch:）。少爺每提一個議題，先用 Grep 在目錄查相關的設計脈絡、情境、C++ 符號、藍圖、拼圖、架構節點，必要時 Read「檔案」欄的原檔，再用專案自己的說法跟少爺對齊——這是少爺要的達成共識方式，主動做、不要等他提醒。`,
    '・語音聽不清楚的詞，先拿目錄比對最像的專案名詞（例如 after→Actor、充兵＝補充兵力），再跟少爺確認。',
    '・要查資料前先說一句「我查一下○○」再動工具（少爺可能在聽語音，查資料要十幾秒，別讓他乾等）。',
  ]
}

/** 設計推理（少爺 2026-10-08「陪聊要以開發者朋友的角度，在過程中也根據脈絡體驗兼顧設計推理完善遊戲中的其他系統與體驗設計」） */
function companionDesignRules(InCtx) {
  return [
    '・每個議題都在心裡走一輪設計推理，推理寫進想法板，嘴上只說結論與一個問題：',
    '  ① 從玩家感受倒推：這個改動玩家會看到、聽到、感受到什麼？',
    '  ② 脈絡：牽動哪幾份設計意圖（intent:），它們的不變量有沒有被碰到、要不要跟著改？',
    '  ③ 體驗：落在哪幾張情境（scenario:），九個面向——陣型玩法／手感／帶入感／機體操作／運鏡／關卡互動／演出／節奏／主題——哪幾格會變？',
    '  ④ 橫向：陣型的長處與劣處還成對嗎？這一題是不是其實在回答某個上游關鍵意圖（設計支柱）？',
    '  ⑤ 連帶：順著意圖檔的「相關脈絡」與情境的連結，找出其他系統或體驗可以順勢完善、或必須跟著調整的地方。',
    InCtx.catalogFile ? '・推理工具都在目錄裡：設計思路模板（memory:Roman_DesignThinking_Templates，對照各模板的「觸發情境」套思路）、設計支柱（intent:DesignPillars）、陣型職能矩陣（intent:FormationRoleMatrix）——有就用，沒有就照上面五步。' : '',
    '・連帶建議放進想法板的 ripples：推理走到 ②～⑤ 時，凡是發現「這個改動會讓別的系統或體驗變弱、變得不一致，或順勢可以變更好」，就寫成一條 ripple，附理由（引用哪份意圖、情境或支柱）與牽動的條目——你嘴上說出的每個取捨（例如「但 X 會變得沒那麼特別」）都一定要有對應的 ripple，提出補救或配套。每輪最多新增兩條；口語上只說一句「順帶一提，○○也可以一起調，要嗎？」。少爺同意才算數，不擅自擴大範圍；範圍有蔓延風險時直說。',
  ].filter(Boolean)
}

// 交接摘要（少爺 2026-10-08「我預期他幫我理的脈絡，也都是之後聊天室能完善處理」）：實作聊天室只看得到這份摘要＋購物車條目／交付留言
const COMPANION_BRIEF_FORMAT = '・brief＝這段討論的交接摘要（每次全量）：{"summary":"議題一段話：要做什麼、為什麼、玩家會感受到什麼","decisions":["已經跟少爺說定的事"],"open":["還要少爺定的事"]}——之後實作的聊天室看不到這段對話，只看得到這份摘要與相關條目，所以要寫到它不用重聊就能動工。'
// 交接要求：侍酒師結帳與 QA 交付共用同一份（client 從公開狀態取，不另寫一份）
const COMPANION_HANDOFF_DUTIES = [
  '動工前先讀相關條目的原檔（設計意圖、情境、程式、藍圖、拼圖），確認現況與陪聊整理的一致；不一致以原檔現況為準並告訴少爺。',
  '「還要少爺定的事」在動工前先問掉；採納的連帶建議若會擴大範圍，先跟少爺確認再做。',
  '改動後同步維護設計脈絡：牽動的設計意圖補不變量／待定奪，牽動的情境檔補九面向與缺口（依專案既有工作流）。',
]

const COMPANION_RIPPLE_FORMAT ='・ripples＝目前完整的連帶建議清單（每次全量、id 沿用，如 r1）：{"id":"r1","text":"建議一句話","why":"理由（引用哪份意圖、情境或支柱）","facets":["手感","演出"],"refs":["intent:…"],"status":"proposed|adopted|dismissed"}；facets 只能用九面向的名稱，refs 照抄目錄第一欄。少爺同意就標 adopted 並同時把它加進 ideas，不要就標 dismissed。'

function companionSystemPrompt(InScope, InCtx) {
  if (InScope === 'qa') return [
    '你是 TheClaudenental 的「陪聊」：少爺（遊戲製作人）的開發者朋友，現在陪他聊一個 QA run——一起把這個議題想清楚，也順帶看見遊戲裡其他該跟著完善的系統與體驗。',
    InCtx.brief,
    '規則：', ...COMPANION_RULES.map(r => `・${r}`), ...companionCatalogRules(InCtx), ...companionDesignRules(InCtx),
    '<tc-board> 格式：{"ideas":[{"id":"i1","text":"整理後的一句話","status":"draft|confirmed","facets":["手感"]}],"ripples":[],"brief":{"summary":"","decisions":[],"open":[]},"refs":[],"handoff":null}',
    '・ideas＝目前完整的想法清單（每次全量給、id 沿用不重編）；少爺明確同意的標 confirmed；被否決的直接移除；已交付的不必再列；facets＝會影響的體驗面向（九面向名稱，可省略）。',
    COMPANION_RIPPLE_FORMAT,
    COMPANION_BRIEF_FORMAT,
    '・refs＝跟這個議題相關的目錄條目 ref（照抄目錄第一欄，可累加），交付時會一併附給實作聊天室當脈絡。',
    '・少爺表示要交給實作（例如「就這樣做」「交給它」）時，handoff 填 {"summary":"給實作聊天室的一段完整整理：背景、要做什麼、怎麼驗收"}，口語上問一句「要交付嗎？」——真正送出要等少爺按「交付實作」或說「交付」，你只提議，不要說已送出。',
  ].join('\n')
  return [
    '你是 TheClaudenental 侍酒師的「陪聊」：少爺（遊戲製作人）的開發者朋友，陪他做前期腦力激盪——從侍酒師的脈絡與情境理解他的議題，兼顧設計推理、順帶看見其他該跟著完善的系統與體驗，把議題本身和相關條目放進侍酒師購物車，之後少爺結帳開新聊天室實作。',
    InCtx.brief,
    '規則：', ...COMPANION_RULES.map(r => `・${r}`), ...companionCatalogRules(InCtx), ...companionDesignRules(InCtx),
    '<tc-board> 格式：{"ideas":[{"id":"i1","text":"整理後的一句話","status":"draft|carted","facets":["手感"]}],"ripples":[],"brief":{"summary":"","decisions":[],"open":[]},"cart":[{"id":"i1","text":"放進購物車的一句話","anchors":["相關名詞"]}],"uncart":[],"refs":[],"unrefs":[]}',
    '・ideas＝目前完整的想法清單（每次全量、id 沿用）；已放進購物車的標 carted；facets＝會影響的體驗面向（九面向名稱，可省略）。',
    COMPANION_RIPPLE_FORMAT,
    COMPANION_BRIEF_FORMAT,
    '・brief 會自動成為購物車裡的「陪聊整理」選件，少爺結帳開新聊天室時一起帶去。',
    '・連帶建議被採納後，跟一般想法一樣放進 cart，牽動的條目也放進 refs。',
    '・cart＝這一輪「新」放進購物車的想法（只列新的）；少爺說要放，或想法已清楚成形、值得帶去結帳時就放；anchors 填相關名詞（沒有就給空陣列）。',
    '・refs＝這一輪「新」放進購物車的目錄條目（照抄目錄第一欄的 ref，只列新的）——等同少爺手動按 🛒 加入：議題牽涉到的設計脈絡、情境、C++ 符號、藍圖、拼圖、架構節點都要放，結帳開新聊天室的實作者才拿得到完整脈絡。',
    '・放了什麼，口語上用標題簡短說一句讓少爺知道（不要念 ref）。',
    '・少爺說拿掉／不要了：從 ideas 移除並在 uncart 列出 id；查證後發現不相關的條目放進 unrefs。',
  ].join('\n')
}

/** 給 client 的狀態（不含進程物件；訊息只回最近 100 則） */
function companionPublic(InKey) {
  const _c = companionStore[InKey]
  if (!_c) return null
  const _p = companionProcs.get(InKey)
  return {
    key: InKey, scope: _c.scope, refId: _c.refId, title: _c.title,
    messages: _c.messages.slice(-100), ideas: _c.ideas, ripples: _c.ripples ?? [], cartLog: _c.cartLog, cartRefs: _c.cartRefs ?? [], contextRefs: _c.contextRefs ?? [],
    brief: _c.brief ?? null, briefRev: _c.briefRev ?? 0, briefDoneRev: _c.briefDoneRev ?? 0, handoffDuties: COMPANION_HANDOFF_DUTIES,
    pendingHandoff: _c.pendingHandoff,
    status: _p ? _p.status : 'off', model: _c.model ?? null, updatedAt: _c.updatedAt,
  }
}
function companionBroadcast(InKey) { broadcast({ type: 'companion_update', key: InKey, state: companionPublic(InKey) }) }

function companionPushMessage(InKey, InRole, InText, InVia = null) {
  const _c = companionStore[InKey]
  const _m = { id: `cm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, role: InRole, text: String(InText ?? ''), ts: Date.now(), ...(InVia ? { via: InVia } : {}) }
  _c.messages.push(_m)
  if (_c.messages.length > COMPANION_MSG_MAX) _c.messages = _c.messages.slice(-COMPANION_MSG_MAX)
  _c.updatedAt = Date.now()
  persistCompanions()
  return _m
}

/** 串流中顯示的文字：藏掉 <tc-board> 區塊（含尚未寫完的開頭片段） */
function companionVisibleText(InText) {
  let _t = String(InText ?? '')
  const _i = _t.indexOf('<tc-board')
  if (_i >= 0) return _t.slice(0, _i).trimEnd()
  const _m = _t.match(/<[a-z-]{0,8}$/)
  if (_m && '<tc-board'.startsWith(_m[0])) _t = _t.slice(0, _m.index)
  return _t.trimEnd()
}

/** 取最後一個能解析的想法板：模型偶爾先寫壞一段再自行補正（實測），從尾端往前找第一個合法 JSON */
function companionParseBoard(InText) {
  const _text = String(InText ?? '')
  const _open = '<tc-board>', _close = '</tc-board>'
  for (let _end = _text.lastIndexOf(_close); _end >= 0; _end = _text.lastIndexOf(_close, _end - 1)) {
    for (let _start = _text.lastIndexOf(_open, _end); _start >= 0; _start = _text.lastIndexOf(_open, _start - 1)) {
      try { return JSON.parse(_text.slice(_start + _open.length, _end).trim()) } catch { /* 往前找 */ }
    }
  }
  return null
}

// 情境九面向（Roman_ScenarioExperience_System.md §〇 題目）：想法與連帶建議標「會影響哪幾格」只收這九個名稱
const COMPANION_FACETS = ['陣型玩法', '手感', '帶入感', '機體操作', '運鏡', '關卡互動', '演出', '節奏', '主題']
function companionFacets(InList) {
  return (Array.isArray(InList) ? InList : []).map(String).filter(f => COMPANION_FACETS.includes(f)).slice(0, 9)
}

/** 套用想法板：ideas 全量覆蓋（已交付的保留為紀錄）；侍酒師的 cart／uncart 轉成購物車事件 */
function companionApplyBoard(InKey, InBoard) {
  const _c = companionStore[InKey]
  if (!_c || !InBoard || typeof InBoard !== 'object') return
  if (Array.isArray(InBoard.ideas)) {
    const _handed = _c.ideas.filter(i => i.status === 'handed')
    const _fresh = InBoard.ideas
      .filter(i => i && typeof i.text === 'string' && i.text.trim())
      .map(i => ({ id: String(i.id ?? `i${Math.random().toString(36).slice(2, 6)}`), text: i.text.trim().slice(0, 400), status: ['draft', 'confirmed', 'carted'].includes(i.status) ? i.status : 'draft', facets: companionFacets(i.facets), ts: Date.now() }))
      .filter(i => !_handed.some(h => h.id === i.id))
    // 少爺剛手動加的、或剛採納的連帶建議：陪聊還沒收到通知前，這一輪的全量清單不會有它——先留著不被洗掉
    const _unacked = _c.ideas.filter(i => i.pendingAck && !_fresh.some(f => f.id === i.id) && !_handed.some(h => h.id === i.id))
    _c.ideas = [..._handed, ..._fresh, ..._unacked]
  }
  // 目錄條目 ref：只收目錄裡真的有的；查無的告訴陪聊下一句修正（不靜默丟）
  const _catalog = companionCatalog(companionContext(_c.scope, _c.refId)?.projectId)
  const _validRefs = (InList) => {
    const _ok = [], _bad = []
    for (const _r of (Array.isArray(InList) ? InList : [])) {
      const _ref = String(_r ?? '').trim()
      if (!_ref) continue
      if (_catalog?.refs.has(_ref)) _ok.push(_ref); else _bad.push(_ref)
    }
    if (_bad.length) _c.notes.push(`這些 ref 不在目錄裡、已略過，請用 Grep 查目錄照抄第一欄：${_bad.slice(0, 6).join('、')}`)
    return _ok
  }
  // 連帶建議（開發者朋友的設計推理）：全量覆蓋，但少爺在面板按過「採納／不要」的維持少爺的決定
  if (Array.isArray(InBoard.ripples)) {
    const _prev = new Map((_c.ripples ?? []).map(r => [r.id, r]))
    _c.ripples = InBoard.ripples
      .filter(r => r && typeof r.text === 'string' && r.text.trim())
      .slice(0, 12)
      .map(r => {
        const _id = String(r.id ?? `r${Math.random().toString(36).slice(2, 6)}`)
        const _old = _prev.get(_id)
        return {
          id: _id, text: r.text.trim().slice(0, 300), why: String(r.why ?? '').trim().slice(0, 400), facets: companionFacets(r.facets),
          refs: _validRefs(r.refs).map(ref => ({ ref, title: _catalog.refs.get(ref).title, icon: _catalog.refs.get(ref).icon })),
          status: _old?.userDecided ? _old.status : (['proposed', 'adopted', 'dismissed'].includes(r.status) ? r.status : 'proposed'),
          userDecided: !!_old?.userDecided, ts: _old?.ts ?? Date.now(),
        }
      })
    // 少爺決定過、但這輪陪聊沒再列的，保留紀錄
    for (const [_id, _old] of _prev) if (_old.userDecided && !_c.ripples.some(r => r.id === _id)) _c.ripples.push(_old)
  }
  // 交接摘要：內容有變才升版號（侍酒師的「陪聊整理」選件與結帳標記都看版號）
  if (InBoard.brief && typeof InBoard.brief === 'object') {
    const _list = (InList) => (Array.isArray(InList) ? InList : []).map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 12).map(x => x.slice(0, 300))
    const _brief = { summary: String(InBoard.brief.summary ?? '').trim().slice(0, 1500), decisions: _list(InBoard.brief.decisions), open: _list(InBoard.brief.open) }
    if ((_brief.summary || _brief.decisions.length || _brief.open.length) && JSON.stringify(_brief) !== JSON.stringify(_c.brief ?? null)) {
      _c.brief = _brief
      _c.briefRev = (_c.briefRev ?? 0) + 1
    }
  }
  if (_c.scope === 'qa') {
    if (InBoard.handoff && typeof InBoard.handoff.summary === 'string' && InBoard.handoff.summary.trim()) {
      _c.pendingHandoff = { summary: InBoard.handoff.summary.trim().slice(0, 4000), ts: Date.now() }
    }
    _c.contextRefs = _c.contextRefs ?? []
    for (const _ref of _validRefs(InBoard.refs)) {
      if (_c.contextRefs.some(x => x.ref === _ref)) continue
      _c.contextRefs.push({ ref: _ref, title: _catalog.refs.get(_ref).title, icon: _catalog.refs.get(_ref).icon, ts: Date.now() })
    }
  }
  if (_c.scope === 'som') {
    // 目錄條目進購物車（client 用手動 🛒 同一份快照）；已在車上的不重送，拿掉後再放算新的一筆
    _c.cartRefs = _c.cartRefs ?? []
    const _addRefs = []
    for (const _ref of _validRefs(InBoard.refs)) {
      if (_c.cartRefs.some(x => x.ref === _ref && !x.removed && !x.checkedOut)) continue
      const _meta = _catalog.refs.get(_ref)
      const _entry = { ref: _ref, title: _meta.title, icon: _meta.icon, ts: Date.now(), removed: false, checkedOut: false }
      _c.cartRefs = _c.cartRefs.filter(x => x.ref !== _ref)
      _c.cartRefs.push(_entry)
      _addRefs.push(_entry)
    }
    const _removeRefs = []
    for (const _r of (Array.isArray(InBoard.unrefs) ? InBoard.unrefs : [])) {
      const _e = _c.cartRefs.find(x => x.ref === String(_r) && !x.removed)
      if (_e) { _e.removed = true; _removeRefs.push(_e.ref) }
    }
    const _added = []
    for (const _it of (Array.isArray(InBoard.cart) ? InBoard.cart : [])) {
      if (!_it || typeof _it.text !== 'string' || !_it.text.trim()) continue
      const _id = String(_it.id ?? `i${Math.random().toString(36).slice(2, 6)}`)
      const _existing = _c.cartLog.find(x => x.id === _id)
      if (_existing && !_existing.removed) continue
      const _facets = companionFacets(_it.facets).length ? companionFacets(_it.facets) : (_c.ideas.find(i => i.id === _id)?.facets ?? [])
      const _entry = { id: _id, text: _it.text.trim().slice(0, 400), anchors: Array.isArray(_it.anchors) ? _it.anchors.map(String).slice(0, 8) : [], facets: _facets, ts: Date.now(), removed: false }
      if (_existing) Object.assign(_existing, _entry); else _c.cartLog.push(_entry)
      _added.push(_entry)
    }
    const _removed = []
    for (const _id of (Array.isArray(InBoard.uncart) ? InBoard.uncart : [])) {
      const _e = _c.cartLog.find(x => x.id === String(_id))
      if (_e && !_e.removed) { _e.removed = true; _removed.push(_e.id) }
    }
    if (_added.length || _removed.length || _addRefs.length || _removeRefs.length) {
      broadcast({ type: 'companion_cart', key: InKey, projectId: _c.refId, add: _added, remove: _removed, addRefs: _addRefs, removeRefs: _removeRefs })
      logEvent('tc.companion.cart', { key: InKey, add: _added.length, remove: _removed.length, addRefs: _addRefs.length, removeRefs: _removeRefs.length })
    }
  }
  _c.updatedAt = Date.now()
  persistCompanions()
}

function companionArmIdle(InKey) {
  const _p = companionProcs.get(InKey)
  if (!_p) return
  clearTimeout(_p.idleTimer)
  const _mins = Number(getTcSetting('companion.idleMinutes', 15)) || 15
  _p.idleTimer = setTimeout(() => companionStop(InKey, 'idle'), _mins * 60 * 1000)
}

function companionStop(InKey, InReason) {
  const _p = companionProcs.get(InKey)
  if (!_p) return
  clearTimeout(_p.idleTimer)
  clearTimeout(_p.deltaTimer)
  companionProcs.delete(InKey)
  try { _p.proc.stdin.end() } catch {}
  setTimeout(() => { try { _p.proc.kill() } catch {} }, 3000)
  logEvent('tc.companion.stop', { key: InKey, reason: InReason })
  if (companionStore[InKey]) companionBroadcast(InKey)
}

/** 寫一則使用者訊息進常駐進程（stream-json 輸入） */
function companionWrite(InKey, InText) {
  const _p = companionProcs.get(InKey)
  if (!_p) return false
  _p.status = 'thinking'
  _p.turnText = ''
  _p.turnMsgId = `cm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  try { _p.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: InText } })}\n`) } catch { return false }
  companionArmIdle(InKey)
  companionBroadcast(InKey)
  return true
}

/** 一輪結束：解析想法板、收進訊息、送下一則排隊中的話 */
function companionFinishTurn(InKey, InResultText) {
  const _p = companionProcs.get(InKey)
  const _c = companionStore[InKey]
  if (!_p || !_c) return
  const _full = _p.turnText || String(InResultText ?? '')
  companionApplyBoard(InKey, companionParseBoard(_full))
  const _visible = companionVisibleText(_full)
  if (_visible) {
    const _m = companionPushMessage(InKey, 'assistant', _visible)
    _m.id = _p.turnMsgId ?? _m.id
  }
  _p.status = 'idle'
  _p.turnText = ''
  clearTimeout(_p.deltaTimer)
  _p.deltaTimer = null
  companionBroadcast(InKey)
  if (_p.pending.length) {
    const _next = _p.pending.splice(0).join('\n')
    companionWrite(InKey, _next)
  }
}

function companionSpawn(InKey) {
  const _c = companionStore[InKey]
  if (!_c) return null
  const _ctx = companionContext(_c.scope, _c.refId)
  if (!_ctx) return null
  try { fs.mkdirSync(COMPANION_CWD, { recursive: true }) } catch {}
  _ctx.catalogFile = companionCatalog(_ctx.projectId)?.file ?? null
  const _model = getTcSetting('companion.model', null) || 'sonnet'
  const _effort = getTcSetting('companion.effort', null)
  const _args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', _model, '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--settings', JSON.stringify({ disableAllHooks: true }), '--dangerously-skip-permissions',
    '--append-system-prompt', companionSystemPrompt(_c.scope, _ctx)]
  if (EFFORT_LEVELS.includes(_effort)) _args.push('--effort', _effort)
  for (const _d of [_ctx.projectRoot, ..._ctx.dirs]) if (_d && isSafeCwd(_d)) _args.push('--add-dir', _d)
  if (_c.claudeSid && findJsonlPath(_c.claudeSid)) _args.push('--resume', _c.claudeSid)
  else _c.claudeSid = null
  const _env = { ...process.env }
  for (const _k of Object.keys(_env)) if (_k.startsWith('CLAUDE')) delete _env[_k]
  let _proc
  try { _proc = spawn(getClaudeExe(), _args, { cwd: COMPANION_CWD, env: _env, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (e) { logEvent('tc.companion.spawn_error', { key: InKey, error: String(e?.message ?? e) }); return null }
  // 狀態直接給 idle：stream-json 輸入模式要等第一句話寫進去才會吐 init（實測），stdin 先收著不會掉
  const _p = { proc: _proc, buf: '', status: 'idle', gotInit: false, turnText: '', turnMsgId: null, pending: [], idleTimer: null, deltaTimer: null, recapDue: !_c.claudeSid && _c.messages.length > 0 }
  companionProcs.set(InKey, _p)
  _c.title = _ctx.title
  _c.model = _model
  logEvent('tc.companion.spawn', { key: InKey, model: _model, resume: !!_c.claudeSid })
  _proc.stdout.setEncoding('utf-8')
  _proc.stdout.on('data', (InChunk) => {
    _p.buf += InChunk
    const _lines = _p.buf.split('\n')
    _p.buf = _lines.pop()
    for (const _line of _lines) {
      if (!_line.trim()) continue
      let _ev
      try { _ev = JSON.parse(_line) } catch { continue }
      if (_ev.type === 'system' && _ev.subtype === 'init') {
        _p.gotInit = true
        if (_ev.session_id && _c.claudeSid !== _ev.session_id) {
          _c.claudeSid = _ev.session_id
          subprocessSids.add(_ev.session_id)
          persistSubprocessSids()
          persistCompanions()
        }
        continue
      }
      if (_ev.type === 'stream_event') {
        const _e = _ev.event
        if (_e?.type === 'content_block_start' && _e.content_block?.type === 'tool_use') {
          if (_p.status !== 'tool') { _p.status = 'tool'; companionBroadcast(InKey) }
        } else if (_e?.type === 'content_block_delta' && _e.delta?.type === 'text_delta') {
          if (_p.status !== 'thinking') { _p.status = 'thinking' }
          _p.turnText += _e.delta.text
          if (!_p.deltaTimer) {
            _p.deltaTimer = setTimeout(() => {
              _p.deltaTimer = null
              broadcast({ type: 'companion_delta', key: InKey, msgId: _p.turnMsgId, text: companionVisibleText(_p.turnText), status: _p.status })
            }, 80)
          }
        }
        continue
      }
      if (_ev.type === 'result') {
        if (_ev.is_error || (_ev.subtype && _ev.subtype !== 'success')) companionPushMessage(InKey, 'system', `這一句陪聊沒有完成（${_ev.subtype ?? 'error'}），可以再說一次。`)
        companionFinishTurn(InKey, _ev.result)
      }
    }
  })
  _proc.stderr.setEncoding('utf-8')
  _proc.stderr.on('data', (InChunk) => { const _t = String(InChunk).trim(); if (_t) logEvent('tc.companion.stderr', { key: InKey, text: _t.slice(0, 300) }) })
  _proc.on('close', (InCode) => {
    if (companionProcs.get(InKey) !== _p) return
    clearTimeout(_p.idleTimer)
    clearTimeout(_p.deltaTimer)
    companionProcs.delete(InKey)
    logEvent('tc.companion.exit', { key: InKey, code: InCode, midTurn: _p.status !== 'idle', gotInit: _p.gotInit })
    // 回合中途結束或啟動就失敗（續聊 id 失效＝「No conversation found」實測）：清掉續聊 id，
    // 下一句改帶前情提要重開，不會反覆用壞掉的 id 重試；有話卡在半路才告訴少爺
    if ((_p.status !== 'idle' || !_p.gotInit) && companionStore[InKey]) {
      companionStore[InKey].claudeSid = null
      persistCompanions()
      if (_p.status !== 'idle') companionPushMessage(InKey, 'system', '陪聊中斷了，再說一句就會自動重新接上（會帶前情提要）。')
    }
    if (companionStore[InKey]) companionBroadcast(InKey)
  })
  companionArmIdle(InKey)
  return _p
}

/** 前情提要：續聊 id 失效重開時，把最近幾則對話與想法板帶進第一句 */
function companionRecap(InKey) {
  const _c = companionStore[InKey]
  const _recent = _c.messages.filter(m => m.role !== 'system').slice(-COMPANION_RECAP_MSGS)
  const _lines = _recent.map(m => `${m.role === 'user' ? '少爺' : '你'}：${m.text.slice(0, 300)}`)
  const _ideas = _c.ideas.map(i => `${i.id}［${i.status}］${i.text}`)
  return `（系統：陪聊重新接上，前情提要——\n${_lines.join('\n')}${_ideas.length ? `\n目前想法板：\n${_ideas.join('\n')}` : ''}\n）`
}

function companionEnsure(InScope, InRefId) {
  const _key = `${InScope}:${InRefId}`
  if (!companionStore[_key]) {
    const _ctx = companionContext(InScope, InRefId)
    if (!_ctx) return null
    companionStore[_key] = { scope: InScope, refId: InRefId, title: _ctx.title, messages: [], ideas: [], ripples: [], cartLog: [], cartRefs: [], contextRefs: [], pendingHandoff: null, notes: [], claudeSid: null, createdAt: Date.now(), updatedAt: Date.now() }
    persistCompanions()
  }
  return _key
}

function companionSay(InKey, InText, InVia) {
  const _c = companionStore[InKey]
  if (!_c) return { ok: false, error: 'no companion' }
  const _text = String(InText ?? '').trim()
  if (!_text) return { ok: false, error: 'empty' }
  companionPushMessage(InKey, 'user', _text, InVia)
  let _p = companionProcs.get(InKey)
  if (!_p) _p = companionSpawn(InKey)
  if (!_p) { companionBroadcast(InKey); return { ok: false, error: '找不到陪聊對象（run 或專案已不存在）' } }
  const _prefix = []
  if (_p.recapDue) { _prefix.push(companionRecap(InKey)); _p.recapDue = false }
  if (_c.notes?.length) {
    _prefix.push(..._c.notes.map(n => `（系統：${n}）`))
    _c.notes = []
    for (const _i of _c.ideas) if (_i.pendingAck) delete _i.pendingAck
  }
  const _payload = [..._prefix, _text].join('\n')
  if (_p.status === 'thinking' || _p.status === 'tool') _p.pending.push(_payload)
  else companionWrite(InKey, _payload)
  companionBroadcast(InKey)
  return { ok: true }
}

app.post('/api/companion/open', async (request, reply) => {
  const { scope, refId, warm } = request.body ?? {}
  if (!['qa', 'som'].includes(scope) || !refId) { reply.code(400); return { ok: false, error: 'bad scope/refId' } }
  const _key = companionEnsure(scope, String(refId))
  if (!_key) { reply.code(404); return { ok: false, error: '找不到陪聊對象' } }
  // 預熱：開面板就先起進程，第一句話不必等啟動
  if (warm !== false && !companionProcs.get(_key)) companionSpawn(_key)
  return { ok: true, key: _key, state: companionPublic(_key) }
})
app.get('/api/companion/state', async (request) => {
  const _key = request.query?.key
  return { ok: !!companionStore[_key], state: companionPublic(_key) }
})
app.post('/api/companion/say', async (request) => {
  const { key, text, via } = request.body ?? {}
  return companionSay(key, text, via === 'voice' ? 'voice' : 'text')
})
// 手動改想法板（刪除／確認／改字／新增）；改動以系統訊息帶給陪聊，下一句生效
app.post('/api/companion/board', async (request) => {
  const { key, op, id, text } = request.body ?? {}
  const _c = companionStore[key]
  if (!_c) return { ok: false, error: 'no companion' }
  const _idea = _c.ideas.find(i => i.id === id)
  if (op === 'remove' && _idea) { _c.ideas = _c.ideas.filter(i => i !== _idea); _c.notes.push(`少爺從想法板刪掉了 ${_idea.id}「${_idea.text}」`) }
  else if (op === 'confirm' && _idea) { _idea.status = 'confirmed'; _c.notes.push(`少爺確認了 ${_idea.id}「${_idea.text}」`) }
  else if (op === 'edit' && _idea && String(text ?? '').trim()) { _idea.text = String(text).trim().slice(0, 400); _c.notes.push(`少爺把 ${_idea.id} 改成「${_idea.text}」`) }
  else if (op === 'add' && String(text ?? '').trim()) {
    const _new = { id: `u${Date.now().toString(36)}`, text: String(text).trim().slice(0, 400), status: 'confirmed', ts: Date.now(), pendingAck: true }
    _c.ideas.push(_new)
    _c.notes.push(`少爺自己加了想法 ${_new.id}「${_new.text}」`)
  } else return { ok: false, error: 'bad op' }
  _c.updatedAt = Date.now()
  persistCompanions()
  companionBroadcast(key)
  return { ok: true }
})
// 連帶建議：少爺按「採納／不要」（程式判定，不交給模型）。採納＝變成想法；侍酒師另外放進購物車（含牽動的條目）
app.post('/api/companion/ripple', async (request) => {
  const { key, id, op } = request.body ?? {}
  const _c = companionStore[key]
  const _r = (_c?.ripples ?? []).find(x => x.id === id)
  if (!_c || !_r || !['adopt', 'dismiss'].includes(op)) return { ok: false }
  _r.status = op === 'adopt' ? 'adopted' : 'dismissed'
  _r.userDecided = true
  if (op === 'adopt') {
    const _ideaId = `x${_r.id}`
    if (!_c.ideas.some(i => i.id === _ideaId))
      _c.ideas.push({ id: _ideaId, text: _r.text, status: _c.scope === 'som' ? 'carted' : 'confirmed', facets: _r.facets ?? [], fromRipple: _r.id, ts: Date.now(), pendingAck: true })
    if (_c.scope === 'som') {
      const _entry = { id: _ideaId, text: _r.text, why: _r.why ?? '', anchors: [], facets: _r.facets ?? [], ts: Date.now(), removed: false }
      _c.cartLog = [..._c.cartLog.filter(x => x.id !== _ideaId), _entry]
      _c.cartRefs = _c.cartRefs ?? []
      const _addRefs = []
      for (const _ref of _r.refs ?? []) {
        if (_c.cartRefs.some(x => x.ref === _ref.ref && !x.removed && !x.checkedOut)) continue
        const _e = { ref: _ref.ref, title: _ref.title, icon: _ref.icon, ts: Date.now(), removed: false, checkedOut: false }
        _c.cartRefs = [..._c.cartRefs.filter(x => x.ref !== _ref.ref), _e]
        _addRefs.push(_e)
      }
      broadcast({ type: 'companion_cart', key, projectId: _c.refId, add: [_entry], remove: [], addRefs: _addRefs, removeRefs: [] })
    }
    _c.notes.push(`少爺採納了連帶建議 ${_r.id}「${_r.text}」，已加進想法板（想法 id ${_ideaId}）${_c.scope === 'som' ? '並放進購物車' : ''}`)
  } else _c.notes.push(`少爺不要連帶建議 ${_r.id}「${_r.text}」`)
  _c.updatedAt = Date.now()
  persistCompanions()
  companionBroadcast(key)
  logEvent('tc.companion.ripple', { key, id, op })
  return { ok: true }
})
// 侍酒師：少爺在購物車手動移除／放回陪聊加的想法（id）或目錄條目（ref）→ 記下來並告訴陪聊
app.post('/api/companion/cart-sync', async (request) => {
  const { key, id, ref, brief, removed } = request.body ?? {}
  const _c = companionStore[key]
  if (!_c) return { ok: false }
  // 「陪聊整理」選件：拿掉＝這一版摘要不再自動放回（摘要有新版才會再出現）；放回＝回到未處理
  if (brief) {
    _c.briefDoneRev = removed ? (_c.briefRev ?? 0) : Math.max(0, (_c.briefRev ?? 0) - 1)
    persistCompanions()
    companionBroadcast(key)
    return { ok: true }
  }
  const _e = ref ? (_c.cartRefs ?? []).find(x => x.ref === ref) : _c.cartLog.find(x => x.id === id)
  if (!_e) return { ok: false }
  _e.removed = !!removed
  if (!removed) _e.checkedOut = false
  _c.notes.push(`少爺${removed ? '從購物車拿掉了' : '把它放回購物車：'} ${ref ? `${_e.ref}「${_e.title}」` : `${_e.id}「${_e.text}」`}`)
  persistCompanions()
  companionBroadcast(key)
  return { ok: true }
})
// 侍酒師：少爺結帳（送入／開新聊天室）或清空購物車 → 陪聊放進去的都標「已結帳」，之後補回時不會再塞回去
app.post('/api/companion/cart-checkout', async (request) => {
  const { key, reason } = request.body ?? {}
  const _c = companionStore[key]
  if (!_c) return { ok: false }
  let _n = 0
  for (const _e of [..._c.cartLog, ...(_c.cartRefs ?? [])]) if (!_e.removed && !_e.checkedOut) { _e.checkedOut = true; _n++ }
  _c.briefDoneRev = _c.briefRev ?? 0
  for (const _r of _c.ripples ?? []) if (_r.status === 'adopted') _r.handed = true
  if (_n) _c.notes.push(reason === 'cleared' ? '少爺清空了購物車；之後的新想法是新一輪' : '少爺已結帳，把購物車帶去新聊天室實作；之後的新想法是新一輪')
  persistCompanions()
  companionBroadcast(key)
  logEvent('tc.companion.checkout', { key, reason: reason ?? 'checkout', items: _n })
  return { ok: true, items: _n }
})
// QA 交付：組成留言走既有 /control 留言鏈（含喚醒：監看活著→監看、否則做法 B 直投、再否則無頭／新開聊天室接手）
app.post('/api/companion/handoff', async (request, reply) => {
  const { key, summary, via } = request.body ?? {}
  const _c = companionStore[key]
  if (!_c || _c.scope !== 'qa') { reply.code(400); return { ok: false, error: '只有 QA 陪聊可以交付' } }
  const _ideas = _c.ideas.filter(i => i.status !== 'handed')
  const _summary = String(summary ?? _c.pendingHandoff?.summary ?? '').trim()
  if (!_summary && !_ideas.length) return { ok: false, error: '想法板是空的，沒有可交付的內容' }
  const _ctxRefs = _c.contextRefs ?? []
  const _brief = _c.brief ?? null
  const _text = [
    '🗣 陪聊交付（少爺在 TC 陪聊中整理並確認要實作的想法）',
    _summary,
    _brief?.summary && _brief.summary !== _summary ? `議題摘要：${_brief.summary}` : '',
    _brief?.decisions?.length ? `已跟少爺說定：\n${_brief.decisions.map(x => `- ${x}`).join('\n')}` : '',
    _brief?.open?.length ? `還要少爺定（動工前先問）：\n${_brief.open.map(x => `- ${x}`).join('\n')}` : '',
    _ideas.length ? `想法清單：\n${_ideas.map(i => `- ${i.status === 'confirmed' ? '［已確認］' : '［草稿］'}${i.text}`).join('\n')}` : '',
    _ctxRefs.length ? `相關脈絡（侍酒師目錄條目，可在侍酒師或原檔查）：\n${_ctxRefs.map(r => `- ${r.icon ?? ''}${r.title}（${r.ref}）`).join('\n')}` : '',
    (() => {
      const _adopted = (_c.ripples ?? []).filter(r => r.status === 'adopted' && !r.handed)
      return _adopted.length ? `少爺採納的連帶建議（陪聊的設計推理，連同理由）：\n${_adopted.map(r => `- ${r.text}${r.why ? `——${r.why}` : ''}${r.facets?.length ? `〔影響：${r.facets.join('、')}〕` : ''}`).join('\n')}` : ''
    })(),
    `交接要求：\n${COMPANION_HANDOFF_DUTIES.map(x => `- ${x}`).join('\n')}`,
    '請照 Mode C 流程處理：先列計畫給少爺在 QA 分頁審，少爺放行前不動工。',
  ].filter(Boolean).join('\n\n')
  const _res = await app.inject({ method: 'POST', url: `/api/qa/runs/${_c.refId}/control`, payload: { action: 'comment', text: _text, inPlaceLink: true } })
  let _body = null
  try { _body = _res.json() } catch {}
  if (_res.statusCode >= 400 || !_body?.ok) return { ok: false, error: _body?.error ?? `HTTP ${_res.statusCode}` }
  for (const _i of _ideas) _i.status = 'handed'
  for (const _r of _c.ripples ?? []) if (_r.status === 'adopted') _r.handed = true
  _c.pendingHandoff = null
  _c.notes.push('少爺已把目前的想法交付給實作聊天室；之後的新想法另外整理')
  companionPushMessage(key, 'system', `已交付給實作聊天室（${_ideas.length} 個想法${via === 'voice' ? '，語音口令觸發' : ''}）。實作聊天室會先列計畫，請到 QA 分頁審查。`)
  logEvent('tc.companion.handoff', { key, ideas: _ideas.length, via: via ?? 'button' })
  companionBroadcast(key)
  return { ok: true }
})
app.post('/api/companion/dismiss-handoff', async (request) => {
  const _c = companionStore[request.body?.key]
  if (!_c) return { ok: false }
  _c.pendingHandoff = null
  _c.notes.push('少爺說再想想，交付先擱著')
  persistCompanions()
  companionBroadcast(request.body.key)
  return { ok: true }
})
app.post('/api/companion/close', async (request) => {
  companionStop(request.body?.key, 'closed')
  return { ok: true }
})
app.post('/api/companion/reset', async (request) => {
  const _key = request.body?.key
  const _c = companionStore[_key]
  if (!_c) return { ok: false }
  companionStop(_key, 'reset')
  Object.assign(_c, { messages: [], ideas: [], ripples: [], cartLog: [], cartRefs: [], contextRefs: [], brief: null, briefRev: 0, briefDoneRev: 0, pendingHandoff: null, notes: [], claudeSid: null, updatedAt: Date.now() })
  persistCompanions()
  companionBroadcast(_key)
  return { ok: true }
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

// 誓約勿擾對帳：開機一次＋每半小時——排程被別的腳本重新註冊後，趕在下次執行前補包回去
setTimeout(() => reconcileMarkerQuiet(null, 'boot'), 15_000)
setInterval(() => reconcileMarkerQuiet(), MARKER_QUIET_RECONCILE_MS)

// 模型目錄：開機建一次、每日重建一次。Claude Code 升版帶進新模型 alias 與新版官方模型表時自動被吃到，
// 不必有人記得去改三份硬編清單（少爺 2026-08-15「要能自動更新這個功能」）
refreshModelCatalog('boot')
setInterval(() => refreshModelCatalog('daily'), MODEL_REFRESH_MS)

// 換版偵測：每小時只比指紋（stat claude.exe ＋ 讀 skill 目錄名），有變才做完整重建，
// 讓少爺升級 Claude Code 後不必等到隔天、也不必自己按重整（2026-09-24）
let modelFingerprint = catalogFingerprint(getClaudeExe())
setInterval(() => {
  const _fp = catalogFingerprint(getClaudeExe())
  if (_fp === modelFingerprint) return
  modelFingerprint = _fp
  refreshModelCatalog('claude-code 換版')
}, MODEL_FINGERPRINT_MS)
