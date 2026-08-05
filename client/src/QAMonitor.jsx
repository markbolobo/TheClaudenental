// AutoQA Monitor — 少爺的 QA 可視化介面
// 對應 RomanPrototype/.agent/knowledge/UE5.8_QAToolsets_Plan.md §5.7（Phase M-2）
// A 計畫區（目的+方法）/ B 即時區（進度+截圖+異常）/ C 歷史區 + 留言雙向
// ws 更新走 window 'tc-qa-run-update' 自訂事件（App.jsx handleServerMessage 一行轉發，不侵入既有結構）
import { useState, useEffect, useRef, useCallback } from 'react'
import { MODEL_OPTIONS, EFFORT_OPTIONS } from './modelOptions.js'
import { confirmIfLiveInteractive } from './liveSessionGuard.js'
import { WorkflowLauncher } from './WorkflowLauncher.jsx'

const STATUS_META = {
  announced: { label: '待放行', cls: 'text-yellow-400 border-yellow-500/50' },
  countdown: { label: '倒數中', cls: 'text-amber-400 border-amber-500/50' },
  running:   { label: '執行中', cls: 'text-green-400 border-green-500/50' },
  paused:    { label: '已暫停', cls: 'text-orange-400 border-orange-500/50' },
  aborted:   { label: '已中止', cls: 'text-red-400 border-red-500/50' },
  finished:  { label: '已完成', cls: 'text-blue-400 border-blue-500/50' },
  closed:    { label: '已結案', cls: 'text-[var(--text-muted)] border-[var(--border)]' },
}
const ITEM_ICON = { pending: '○', running: '▶', pass: '✅', fail: '❌', blocked: '🚧', skipped: '⏭' }
const OUTCOME_LABEL = { pass: '✅ 達標', fail: '❌ 未達標', blocked: '🚧 受阻' }

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? { label: status, cls: 'text-[var(--text-muted)] border-[var(--border)]' }
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-widest ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

export function QAMonitorPanel({ selectedSessionId = null, onGoToChat = null, projects = [], activeProjectId = null, onSelectProject = null, onManageProjects = null }) {
  const [runs, setRuns] = useState([])
  const [selectedRunId, setSelectedRunId] = useState(null)
  // 跨專案：run 未帶 project 欄位者為早期羅馬 run → 視為 'roman'（QA 綁專案；下拉選單與仕酒師共用 active 專案）
  const runMatchesProject = useCallback(
    (r) => !activeProjectId || (r.project ?? 'roman') === activeProjectId,
    [activeProjectId])
  const [now, setNow] = useState(Date.now())
  const [commentText, setCommentText] = useState('')
  // 少爺 2026-07-14：QA 留言可選喚醒 Claude 子進程的 AI 模型＋強度（空字串=預設；記憶在 localStorage）
  const [qaModel, setQaModel] = useState(() => localStorage.getItem('tc_qa_model') ?? '')
  useEffect(() => { try { localStorage.setItem('tc_qa_model', qaModel) } catch {} }, [qaModel])
  const [qaEffort, setQaEffort] = useState(() => localStorage.getItem('tc_qa_effort') ?? '')
  useEffect(() => { try { localStorage.setItem('tc_qa_effort', qaEffort) } catch {} }, [qaEffort])
  // 少爺 2026-07-14：喚醒改開「可視互動 CLI 視窗」盯進度（VS Code 已開分頁不會跟外部無頭進程同步——這是看得到的替代）
  const [qaWakeVisible, setQaWakeVisible] = useState(() => localStorage.getItem('tc_qa_wake_visible') === '1')
  useEffect(() => { try { localStorage.setItem('tc_qa_wake_visible', qaWakeVisible ? '1' : '0') } catch {} }, [qaWakeVisible])
  const [commentItemId, setCommentItemId] = useState('')
  const [qaAttach, setQaAttach] = useState([])   // [{name,dataUrl,type}]：feedback 附檔，一併傳給 Claude 分析
  const qaAttachRef = useRef(null)
  const [lightbox, setLightbox] = useState(null)   // artifact url 放大檢視
  const selectedRunIdRef = useRef(null)
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])

  // ─── 打包控制（少爺 2026-08-04）：後綴輸入框 ×1 ＋ 打包鈕 ×3 ＋ 開資料夾鈕 ×2 ───
  // 命名 SSOT 與 Invoke-RomanPackage.ps1 一致：Windows_<Dev|Shipping>_<yyyyMMdd><suffix>
  const [pkgSuffix, setPkgSuffix] = useState(() => localStorage.getItem('tc_pkg_suffix') ?? '_WithExtraWorks')
  useEffect(() => { try { localStorage.setItem('tc_pkg_suffix', pkgSuffix) } catch {} }, [pkgSuffix])
  const [pkgJob, setPkgJob] = useState(null)
  const [pkgHint, setPkgHint] = useState('')

  useEffect(() => {
    fetch('/api/package/status').then(r => r.json()).then(d => setPkgJob(d.job ?? null)).catch(() => {})
    const onPkg = (e) => setPkgJob(e.detail ?? null)
    window.addEventListener('tc-package-update', onPkg)
    return () => window.removeEventListener('tc-package-update', onPkg)
  }, [])

  const pkgRunning = pkgJob?.status === 'running'

  const startPackage = useCallback(async (config, overwrite = false) => {
    setPkgHint('')
    const _res = await fetch('/api/package/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, suffix: pkgSuffix, overwrite }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))

    // 同日重打：既有產物動輒 2GB+，覆寫前一定要你點頭
    if (_res.needsConfirm) {
      if (confirm(`以下產物已存在，繼續會「刪除後重打」：\n\n${_res.existing.join('\n')}\n\n確定覆寫？`)) {
        return startPackage(config, true)
      }
      setPkgHint('已取消（未覆寫既有產物）')
      return
    }
    if (!_res.ok) setPkgHint(`⚠️ ${_res.error ?? '啟動失敗'}`)
    else setPkgJob(_res.job ?? null)
  }, [pkgSuffix])

  const openPackageFolder = useCallback(async (target) => {
    setPkgHint('')
    const _res = await fetch('/api/package/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, suffix: pkgSuffix }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    if (!_res.ok) setPkgHint(`⚠️ ${_res.error ?? '開啟失敗'}`)
    else setPkgHint(`📂 ${_res.path}`)
  }, [pkgSuffix])

  const cancelPackage = useCallback(async () => {
    if (!confirm('中止進行中的打包？')) return
    // ⚠️ 一定要帶 Content-Type + body：Fastify 對無 content-type 的 POST 回 415（2026-08-05 實測）
    await fetch('/api/package/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {})
  }, [])

  const reload = useCallback(() => {
    fetch('/api/qa/runs?limit=100').then(r => r.json()).then(d => {
      const list = d.runs ?? []
      setRuns(list)
      // 預設選最新的「進行中」run；沒有就選最新一筆（只在當前專案範圍內選）
      if (!selectedRunIdRef.current) {
        const pool = list.filter(runMatchesProject)
        const live = pool.find(r => ['announced', 'countdown', 'running', 'paused'].includes(r.status))
        setSelectedRunId((live ?? pool[0])?.id ?? null)
      }
    }).catch(() => {})
  }, [runMatchesProject])

  useEffect(() => { reload() }, [reload])

  // 切專案：選中 run 不屬於新專案 → 改選該專案最新（進行中優先）
  useEffect(() => {
    const cur = runs.find(r => r.id === selectedRunIdRef.current)
    if (cur && runMatchesProject(cur)) return
    const pool = runs.filter(r => !r.archivedAt && runMatchesProject(r))
    const live = pool.find(r => ['announced', 'countdown', 'running', 'paused'].includes(r.status))
    setSelectedRunId((live ?? pool[0])?.id ?? null)
  }, [activeProjectId])  // eslint-disable-line react-hooks/exhaustive-deps

  // ws 即時更新（App.jsx 轉發）+ 10s 輪詢保險
  useEffect(() => {
    const onUpdate = (e) => {
      const run = e.detail
      if (!run?.id) return
      setRuns(prev => {
        const idx = prev.findIndex(r => r.id === run.id)
        if (idx >= 0) { const next = [...prev]; next[idx] = run; return next }
        return [run, ...prev]
      })
      // 新宣告的 run 自動聚焦（少爺打開視窗就是要看它）
      setSelectedRunId(prev => prev ?? run.id)
      if (['announced', 'countdown'].includes(run.status)) setSelectedRunId(run.id)
    }
    window.addEventListener('tc-qa-run-update', onUpdate)
    const poll = setInterval(reload, 10000)
    return () => { window.removeEventListener('tc-qa-run-update', onUpdate); clearInterval(poll) }
  }, [reload])

  // M-6 會議室聯動：TC 切換 session 時，自動聚焦綁定該聊天室的最新 run
  useEffect(() => {
    if (!selectedSessionId) return
    const bound = runs.filter(r => r.boundSessionId === selectedSessionId && !r.archivedAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (bound) setSelectedRunId(bound.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId])

  const run = runs.find(r => r.id === selectedRunId) ?? null

  // ── 心腹啟動器（少爺 2026-07-20）：CHAT 輸入區塊的「心腹」進駐留言列（與 📎 同排）──
  // ⚡ 啟動＝組好的心腹模板直接走既有留言路徑送出（喚醒 bound session，模型/強度/附檔全沿用）
  const [qaWfOpen, setQaWfOpen] = useState(false)

  // 倒數 tick（250ms 精度）
  useEffect(() => {
    if (run?.status !== 'countdown') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [run?.status])

  async function control(action, extra = {}) {
    if (!run) return null
    return await fetch(`/api/qa/runs/${run.id}/control`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    }).then(r => r.json()).catch(() => null)
  }

  // 少爺 2026-07-17：▶ 開跑 / ✔ 結案 也無縫切到 Chat 看 Claude 處理（沿用 sendComment 2026-07-08「送出＝手動階段完成→切 Chat」同一設計）。
  // server 對每個 control action 都會 qaWakeBoundSession 喚醒 Claude；monitor 模式下 TC 不 spawn、Chat 靠 session_live（jsonl 監看）直播，兩者並存不衝突。
  async function controlAndGoToChat(action, extra = {}) {
    const _res = await control(action, extra)
    const _run = _res?.run ?? run
    onGoToChat?.({ sessionId: _run?.boundSessionId ?? null, projectPath: _run?.boundProjectPath ?? 'C:/Project/RomanPrototype' })
    return _res
  }

  function handleQaAttach(e) {
    const files = Array.from(e.target.files ?? [])
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = ev => setQaAttach(prev => [...prev, { name: file.name, dataUrl: ev.target.result, type: file.type }])
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  async function sendComment(overrideText) {
    // onClick={sendComment} 會把 event 當第一參數傳入 → 只認字串 override（心腹 ⚡ 啟動用）
    const text = (typeof overrideText === 'string' ? overrideText : commentText).trim()
    if (!text && qaAttach.length === 0) return
    // 少爺 2026-07-14「警示＋照送」：spawn 模式卻綁著 VS Code 活 session（錯配——活 session 應走 monitor）→ 確認後才喚醒
    if (run?.wakeMode === 'spawn' && run?.boundSessionId)
      if (!(await confirmIfLiveInteractive(run.boundSessionId, '無頭喚醒'))) return
    const _res = await control('comment', { text, itemId: commentItemId ? Number(commentItemId) : null, attachments: qaAttach, model: qaModel || null, effort: qaEffort || null, wakeVisible: qaWakeVisible })
    setCommentText('')
    setQaAttach([])
    // 少爺 2026-07-08：送出 Feedback＝QA 手動階段完成 → 無縫切到 Chat 看 Claude 處理（同 History Continue / 仕酒師送入聊天室）
    // 少爺 2026-07-14：未綁定 run 也導過去——server 會像「開新聊天室」spawn 接手並自動綁回，Chat 面板 sessionId=null 照樣收直播
    const _run = _res?.run ?? run
    onGoToChat?.({ sessionId: _run?.boundSessionId ?? null, projectPath: _run?.boundProjectPath ?? 'C:/Project/RomanPrototype' })
  }

  const artifactUrl = (rel) => `/api/qa/runs/${run?.id}/artifact?path=${encodeURIComponent(rel)}`
  const shots = (run?.events ?? []).filter(e => e.kind === 'screenshot' && e.path)
  const doneCount = (run?.items ?? []).filter(i => ['pass', 'fail', 'blocked', 'skipped'].includes(i.status)).length
  const countdownLeft = run?.status === 'countdown' && run.countdownEndsAt
    ? Math.max(0, Math.ceil((run.countdownEndsAt - now) / 1000)) : null

  return (
    <div className="flex h-full min-h-0">
      {/* C 歷史區（左欄） */}
      <aside className="w-52 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] overflow-y-auto">
        <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
          {/* 跨專案下拉選單：與仕酒師共用 active 專案，任一邊切換兩邊受惠；🏛 = 高桌會分館認可管理 */}
          <div className="flex items-center gap-1 mb-1">
            {projects.length > 1 && (
              <select value={activeProjectId ?? ''} onChange={e => onSelectProject?.(e.target.value)}
                className="flex-1 min-w-0 bg-transparent border border-[var(--border)] rounded text-[10px] px-1 py-0.5 text-[var(--text)] normal-case tracking-normal">
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {projects.length === 1 && <span className="flex-1 text-[10px] text-[var(--text)] normal-case tracking-normal">{projects[0].name}</span>}
            {onManageProjects && (
              <button onClick={onManageProjects} title="高桌會：分館（專案）認可管理"
                className="shrink-0 text-[10px] px-1 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50 normal-case">🏛</button>
            )}
          </div>
          QA Runs（永久保留）
        </div>
        {runs.filter(r => !r.archivedAt && runMatchesProject(r)).length === 0 && (
          <div className="px-3 py-4 text-[10px] text-[var(--text-muted)] text-center">尚無 QA run</div>
        )}
        {runs.filter(r => !r.archivedAt && runMatchesProject(r)).map(r => (
          <div key={r.id} onClick={() => setSelectedRunId(r.id)}
            className={`relative w-full text-left px-3 py-2 border-b border-[var(--border)]/50 hover:bg-white/5 cursor-pointer group ${
              r.id === selectedRunId ? 'bg-white/10' : ''}`}>
            {/* 封存＝介面移除；資料與 session 資料夾永久保留 */}
            <button title="封存（介面移除，資料保留）"
              onClick={async (e) => {
                e.stopPropagation()
                if (!confirm(`封存「${r.topic}」？（介面移除，資料永久保留）`)) return
                await fetch(`/api/qa/runs/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) }).catch(() => {})
                setRuns(prev => prev.map(x => x.id === r.id ? { ...x, archivedAt: Date.now() } : x))
                if (selectedRunIdRef.current === r.id) setSelectedRunId(null)
              }}
              className="absolute top-1 right-1 w-5 h-5 rounded text-[11px] leading-5 text-center text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10">✕</button>
            <div className="text-[11px] truncate pr-5">{r.topic}</div>
            <div className="flex items-center gap-1 mt-0.5">
              <StatusBadge status={r.status} />
              {r.status === 'finished' && r.outcome && (
                <span className="text-[9px] text-[var(--text-muted)]">{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
              )}
            </div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5">{new Date(r.createdAt).toLocaleString()}</div>
          </div>
        ))}
      </aside>

      {/* 主面板 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {/* ── 打包控制列（少爺 2026-08-04）：不依賴選中 run，永遠可用 ── */}
        <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">打包</span>

            {/* 後綴輸入框：進資料夾名，只允許英數/底線/連字號 */}
            <input value={pkgSuffix} onChange={e => setPkgSuffix(e.target.value)}
              placeholder="_WithExtraWorks" title="資料夾名後綴：Windows_<Dev|Shipping>_<yyyyMMdd><後綴>"
              className="w-40 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text)]" />

            {/* 三個一組：打包 */}
            <div className="flex rounded overflow-hidden border border-[var(--border)]">
              {[['Dev', 'Dev'], ['Shipping', 'Shipping'], ['Both', 'Dev+Shipping']].map(([_cfg, _label], _i) => (
                <button key={_cfg} onClick={() => startPackage(_cfg)} disabled={pkgRunning}
                  title={pkgRunning ? '打包進行中' : `打包 ${_label}`}
                  className={`text-[11px] px-2.5 py-1 ${_i > 0 ? 'border-l border-[var(--border)]' : ''} ${
                    pkgRunning ? 'text-[var(--text-muted)] opacity-40 cursor-not-allowed'
                      : 'text-[var(--text)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)]'}`}>
                  {_label}
                </button>
              ))}
            </div>

            {/* 兩個一組：開啟產物資料夾（挑該組態最新一份） */}
            <div className="flex rounded overflow-hidden border border-[var(--border)]">
              {['Dev', 'Shipping'].map((_t, _i) => (
                <button key={_t} onClick={() => openPackageFolder(_t)}
                  title={`用檔案總管開啟最新的 ${_t} 打包資料夾`}
                  className={`text-[11px] px-2.5 py-1 text-[var(--text)] hover:bg-white/10 ${
                    _i > 0 ? 'border-l border-[var(--border)]' : ''}`}>
                  📂 {_t}
                </button>
              ))}
            </div>

            {pkgRunning && (
              <button onClick={cancelPackage}
                className="text-[11px] px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10">中止</button>
            )}

            <div className="flex-1" />

            {/* 狀態徽章 */}
            {pkgJob && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                pkgJob.status === 'running' ? 'border-blue-500/40 text-blue-400'
                  : pkgJob.status === 'done' ? 'border-green-500/40 text-green-400'
                  : pkgJob.status === 'cancelled' ? 'border-[var(--border)] text-[var(--text-muted)]'
                  : pkgJob.status === 'interrupted' ? 'border-amber-500/40 text-amber-400'
                  : 'border-red-500/40 text-red-400'}`}>
                {pkgJob.status === 'running' ? '打包中' : pkgJob.status === 'done' ? '✅ 成功'
                  : pkgJob.status === 'cancelled' ? '已中止'
                  : pkgJob.status === 'interrupted' ? '⚠️ 中斷（未跑完）' : '❌ 失敗'}
              </span>
            )}
          </div>

          {/* 進度：階段 + cook 百分比 + 最新一行輸出 */}
          {pkgJob && (
            <div className="mt-1.5">
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                <span className="font-mono">{pkgJob.config}{pkgJob.suffix}</span>
                {pkgJob.currentTarget && <span className="text-[var(--gold)]">▶ {pkgJob.currentTarget}</span>}
                {pkgJob.phase && pkgJob.phase !== 'idle' && (
                  <span>{{ starting: '準備中', cooking: 'Cook / Build 中', archiving: '壓縮中' }[pkgJob.phase] ?? pkgJob.phase}</span>
                )}
                {pkgJob.cook?.percent !== null && pkgJob.cook?.percent !== undefined && (
                  <span className="font-mono">cook {pkgJob.cook.percent}%（剩 {pkgJob.cook.remain}）</span>
                )}
                <span>· {fmtTime(pkgJob.startedAt)} → {fmtTime(pkgJob.finishedAt)}</span>
              </div>

              {pkgJob.cook?.percent !== null && pkgJob.cook?.percent !== undefined && (
                <div className="h-1 bg-black/40 rounded mt-1 overflow-hidden">
                  <div className="h-full bg-blue-400 transition-all" style={{ width: `${pkgJob.cook.percent}%` }} />
                </div>
              )}

              {/* 各組態結果 */}
              {pkgJob.results?.length > 0 && (
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {pkgJob.results.map((_r, _i) => (
                    <span key={_i} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      _r.status === 'ok' ? 'border-green-500/40 text-green-400' : 'border-red-500/40 text-red-400'}`}>
                      {_r.status === 'ok' ? `✅ ${_r.target} · ${_r.minutes} 分` : `❌ ${_r.target} · ${_r.reason}`}
                    </span>
                  ))}
                </div>
              )}

              {/* 失敗後的自動分析狀態 */}
              {pkgJob.status === 'failed' && pkgJob.analysis && (
                <div className="text-[10px] mt-1 text-amber-400">
                  {pkgJob.analysis.state === 'spawned'
                    ? '🔍 已喚醒 Claude 分析根因並建立修復 QA Run…'
                    : `分析未啟動：${pkgJob.analysis.reason ?? pkgJob.analysis.state}`}
                  {pkgJob.logPath && <span className="text-[var(--text-muted)] font-mono ml-2">log: {pkgJob.logPath}</span>}
                </div>
              )}

              {/* 最新輸出一行（看得到「還活著」） */}
              {pkgJob.tail?.length > 0 && pkgJob.status === 'running' && (
                <div className="text-[9px] text-[var(--text-muted)] font-mono truncate mt-1">
                  {pkgJob.tail[pkgJob.tail.length - 1]}
                </div>
              )}
            </div>
          )}

          {pkgHint && <div className="text-[10px] mt-1 text-[var(--text-muted)] font-mono truncate">{pkgHint}</div>}
        </div>

        {!run && (
          <div className="text-[var(--text-muted)] text-xs text-center mt-12">
            等待 Claude 宣告 QA 計畫…（autoqa 會在跑 QA 前把「目的+方法」推上這裡）
          </div>
        )}
        {run && (
          <div className="p-3 space-y-3">
            {/* Run Header */}
            <div className="border border-[var(--border)] rounded bg-[var(--surface)] p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-[var(--gold)] font-semibold">{run.topic}</span>
                <StatusBadge status={run.status} />
                <span className="text-[10px] text-[var(--text-muted)]">{run.env}</span>
                {/* 少爺 2026-07-14 環境戳記標準欄位（有填才顯示；舊 run 只有 env 自由文字照舊） */}
                {run.map && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">🗺 {run.map}</span>}
                {run.buildConfig && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">⚙ {run.buildConfig}</span>}
                {run.branch && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] font-mono">⎇ {run.branch}</span>}
                {run.commit && <span className="text-[10px] text-[var(--text-muted)] font-mono">@{run.commit.slice(0, 8)}</span>}
                {run.boundSessionId && (
                  <span title={`綁定聊天室 ${run.boundSessionId}`}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-blue-500/40 text-blue-400">🔗 {run.boundSessionId.slice(0, 8)}</span>
                )}
                <div className="flex-1" />
                <span className="text-[10px] text-[var(--text-muted)]">
                  {doneCount}/{run.items.length} 項 · {fmtTime(run.startedAt)} → {fmtTime(run.finishedAt)}
                </span>
              </div>

              {/* 進度條 */}
              <div className="h-1.5 bg-black/40 rounded mt-2 overflow-hidden">
                <div className="h-full bg-[var(--gold)] transition-all"
                  style={{ width: `${run.items.length ? (doneCount / run.items.length) * 100 : 0}%` }} />
              </div>

              {/* 倒數大字（少爺的攔截窗口） */}
              {countdownLeft !== null && (
                <div className="text-center py-2">
                  <div className="text-4xl font-mono text-amber-400">{countdownLeft}s</div>
                  <div className="text-[10px] text-[var(--text-muted)]">倒數結束自動開跑 — 可先看下方計畫，隨時攔截</div>
                </div>
              )}
              {run.status === 'announced' && (
                <div className="text-center py-1 text-[11px] text-yellow-400">等待少爺放行（按「立即開跑」）</div>
              )}
              {/* 少爺引導語（2026-07-07）：Claude 接手後告訴少爺當下該做什麼 — 有引導語時取代處理中橫幅 */}
              {run.guidance?.text && (
                <div className="text-center py-2 text-[12px] text-[var(--gold)] border border-[var(--gold)]/40 rounded bg-[var(--gold)]/5 my-1">
                  🕹 {run.guidance.text}
                </div>
              )}
              {/* Claude 接手/處理狀態（少爺 2026-07-06：送出 feedback/結案要看到處理中） */}
              {!run.guidance?.text && run.claudeAck && run.claudeAck.state === 'pending' && (
                <div className="text-center py-1 text-[11px] text-yellow-400">
                  ⏳ 已送出（{run.claudeAck.action}），等待 Claude 接手…
                </div>
              )}
              {!run.guidance?.text && run.claudeAck && run.claudeAck.state === 'working' && !['finished', 'closed', 'aborted'].includes(run.status) && (
                <div className="text-center py-1 text-[11px] text-blue-400">
                  🔵 Claude 處理中（最後動作 {fmtTime(run.claudeAck.workingAt)}）
                </div>
              )}
              {/* 喚醒石沉（headless 重試仍零回應）：需要少爺人工推一下活分頁（2026-07-17 結案沒反應根治） */}
              {run.claudeAck?.state === 'undelivered' && (
                <div className="text-center py-2 text-[12px] text-red-400 border border-red-400/40 rounded bg-red-400/5 my-1">
                  ⚠️ 喚醒未送達（{run.claudeAck.action}）——聊天室可能被開啟中的分頁佔用，請在該 VS Code 聊天室輸入「請繼續」接手
                </div>
              )}
              {/* 最新動態 ticker：Claude 的 mark 事件即進度資訊 */}
              {run.events?.length > 0 && (
                <div className="text-[10px] text-[var(--text-muted)] truncate mt-1">
                  最新動態：[{fmtTime(run.events[run.events.length - 1].t)}] {run.events[run.events.length - 1].note ?? run.events[run.events.length - 1].kind}
                </div>
              )}
              {run.controls?.pauseRequested && (
                <div className="text-center py-1 text-[11px] text-orange-400">暫停請求已送出 — 將在目前項目完成後生效</div>
              )}
              {run.controls?.abortRequested && (
                <div className="text-center py-1 text-[11px] text-red-400">中止請求已送出 — 將在目前項目完成後生效</div>
              )}

              {/* 控制鈕 */}
              <div className="flex gap-2 mt-2">
                {['announced', 'countdown'].includes(run.status) && (
                  <>
                    <button onClick={() => controlAndGoToChat('start-now')}
                      className="text-[11px] px-3 py-1 rounded border border-green-500/50 text-green-400 hover:bg-green-500/10">▶ 立即開跑</button>
                    {run.status === 'countdown' && (
                      <button onClick={() => control('pause')}
                        className="text-[11px] px-3 py-1 rounded border border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10">⏸ 暫停待審</button>
                    )}
                  </>
                )}
                {run.status === 'running' && !run.controls?.pauseRequested && (
                  <button onClick={() => control('pause')}
                    className="text-[11px] px-3 py-1 rounded border border-orange-500/50 text-orange-400 hover:bg-orange-500/10">⏸ 暫停（項目邊界）</button>
                )}
                {run.status === 'paused' && (
                  <button onClick={() => control('resume')}
                    className="text-[11px] px-3 py-1 rounded border border-green-500/50 text-green-400 hover:bg-green-500/10">▶ 繼續</button>
                )}
                {['announced', 'countdown', 'running', 'paused'].includes(run.status) && !run.controls?.abortRequested && (
                  <button onClick={() => { if (confirm('確定中止這輪 QA？')) control('abort') }}
                    className="text-[11px] px-3 py-1 rounded border border-red-500/50 text-red-400 hover:bg-red-500/10">■ 中止</button>
                )}
                {['finished', 'aborted'].includes(run.status) && (
                  <button title="結案＝通知 Claude 進入第五階段（移除驗證用 LOG + 雙編譯）"
                    onClick={() => { if (confirm('結案這輪 QA？Claude 會收到通知並移除為驗證埋的 LOG（第五階段）')) controlAndGoToChat('close') }}
                    className="text-[11px] px-3 py-1 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10">✔ 結案</button>
                )}
                <div className="flex-1" />
                {run.qapPath && <span className="text-[9px] text-[var(--text-muted)] font-mono self-center">{run.qapPath}</span>}
              </div>
            </div>

            {/* A 計畫區（目的+方法） */}
            <div className="border border-[var(--border)] rounded bg-[var(--surface)] p-3">
              <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">A · 測試計畫（目的與方法）</div>
              {run.requirement && (
                <blockquote className="text-[11px] border-l-2 border-[var(--gold)] pl-2 mb-2 text-[var(--text)]/90">
                  {run.requirement}
                </blockquote>
              )}
              {run.criteria.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-[var(--text-muted)] uppercase tracking-wider">
                        <th className="text-left py-1 pr-2">#</th>
                        <th className="text-left py-1 pr-2">驗證目的</th>
                        <th className="text-left py-1 pr-2">可觀測訊號</th>
                        <th className="text-left py-1 pr-2">情境</th>
                        <th className="text-left py-1 pr-2">通過條件</th>
                        <th className="text-left py-1">失敗證據</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.criteria.map(c => (
                        <tr key={c.id} className="border-t border-[var(--border)]/50 align-top">
                          <td className="py-1 pr-2 text-[var(--text-muted)]">{c.id}</td>
                          <td className="py-1 pr-2">{c.purpose}</td>
                          <td className="py-1 pr-2">{c.signal}</td>
                          <td className="py-1 pr-2 text-[var(--gold)]">{c.scenario}</td>
                          <td className="py-1 pr-2">{c.passCond}</td>
                          <td className="py-1 text-[var(--text-muted)]">{c.evidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* 🧩 拼圖結合（少爺 2026-07-14）：依據拼圖=Claude 這輪理解的來源外顯；拼圖沉澱=結案後驗證過的理解回寫了哪些檔 */}
              {(run.knowledge?.length > 0 || run.knowledgeUpdated?.length > 0) && (
                <div className="mt-2 pt-2 border-t border-[var(--border)]/50 space-y-1.5">
                  {run.knowledge?.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mr-1">🧩 依據拼圖</span>
                      {run.knowledge.map((k, i) => (
                        <span key={i} title={k}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-purple-500/40 text-purple-300 font-mono">
                          {k.split('/').pop()}
                        </span>
                      ))}
                    </div>
                  )}
                  {run.knowledgeUpdated?.length > 0 && (
                    <div className="space-y-0.5">
                      <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">🧩 拼圖沉澱（結案回寫）</span>
                      {run.knowledgeUpdated.map((u, i) => (
                        <div key={i} className="text-[10px] pl-2 text-[var(--text)]/90">
                          <span className="font-mono text-green-400" title={u.path}>{u.path.split('/').pop()}</span>
                          {u.summary && <span className="text-[var(--text-muted)]"> — {u.summary}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* B 即時區 */}
            <div className="border border-[var(--border)] rounded bg-[var(--surface)] p-3">
              <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">B · 進度與狀況</div>

              {/* 測試項目 */}
              <div className="space-y-1 mb-3">
                {run.items.map(it => (
                  <div key={it.id}
                    className={`flex items-start gap-2 text-[11px] px-2 py-1 rounded ${
                      it.status === 'running' ? 'bg-[var(--gold)]/10 border border-[var(--gold)]/40'
                      : it.status === 'fail' ? 'bg-red-500/5'
                      : ''}`}>
                    <span className="shrink-0">{ITEM_ICON[it.status] ?? '○'}</span>
                    <span className="text-[var(--text-muted)] shrink-0">{it.id}.</span>
                    <span className="min-w-0">{it.text}
                      {it.scenario && <span className="ml-1 text-[9px] text-[var(--gold)]">{it.scenario}</span>}
                      {it.resultNote && <span className="ml-1 text-[10px] text-[var(--text-muted)]">— {it.resultNote}</span>}
                    </span>
                  </div>
                ))}
              </div>

              {/* 異常 feed */}
              {run.anomalies.length > 0 && (
                <div className="mb-3 border border-red-500/40 rounded p-2 bg-red-900/10">
                  <div className="text-[10px] text-red-400 uppercase tracking-widest mb-1">異常（{run.anomalies.length}）</div>
                  {run.anomalies.slice(-8).map((a, i) => (
                    <div key={i} className="text-[10px] text-red-300/90 font-mono truncate">
                      [{fmtTime(a.t)}] {a.kind ?? 'anomaly'} — {a.note ?? a.message ?? JSON.stringify(a).slice(0, 120)}
                    </div>
                  ))}
                </div>
              )}

              {/* 截圖牆 */}
              {shots.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest mb-1">截圖（{shots.length}）</div>
                  <div className="flex gap-2 flex-wrap">
                    {shots.slice(-8).map((s, i) => (
                      <img key={i} src={artifactUrl(s.path)} alt={s.label ?? s.path}
                        title={`${s.label ?? ''} @ ${fmtTime(s.t)}`}
                        onClick={() => setLightbox(artifactUrl(s.path))}
                        className="h-24 rounded border border-[var(--border)] cursor-zoom-in object-cover" />
                    ))}
                  </div>
                </div>
              )}

              {/* 事件 timeline 尾段 */}
              {run.events.length > 0 && (
                <div className="max-h-40 overflow-y-auto bg-black/30 rounded p-2 font-mono text-[9px] text-[var(--text-muted)]">
                  {run.events.slice(-40).map((e, i) => (
                    <div key={i} className="truncate">
                      [{fmtTime(e.t)}] {e.kind}{e.note ? ` — ${e.note}` : ''}{e.label ? ` — ${e.label}` : ''}
                    </div>
                  ))}
                  <div className="text-right text-[8px]">共 {run.eventsTotal} 筆（完整 events.jsonl 在 session 資料夾）</div>
                </div>
              )}
            </div>

            {/* 留言（雙向 — 不浪費對專案的理解） */}
            <div className="border border-[var(--border)] rounded bg-[var(--surface)] p-3">
              <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
                留言（Claude 會在項目邊界讀取並回應）
              </div>
              {run.comments.map((c, i) => (
                <div key={i} className="mb-2 text-[11px]">
                  <div>
                    <span className="text-[var(--gold)]">少爺</span>
                    {c.itemId != null && <span className="text-[9px] text-[var(--text-muted)]"> · 項目 {c.itemId}</span>}
                    <span className="text-[9px] text-[var(--text-muted)]"> · {fmtTime(c.t)}</span>
                    {!c.seenByClaude && <span className="text-[9px] text-yellow-400"> · 未讀</span>}
                  </div>
                  <div className="pl-2">{c.text}</div>
                  {c.reply && (
                    <div className="pl-4 mt-0.5 text-[var(--text-muted)]">↳ <span className="text-blue-400">Claude</span>：{c.reply}</div>
                  )}
                </div>
              ))}
              {qaAttach.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  {qaAttach.map((a, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-black/30 border border-[var(--border)] text-[var(--text)] flex items-center gap-1">
                      📎 {a.name}
                      <button onClick={() => setQaAttach(prev => prev.filter((_, j) => j !== i))} className="text-[var(--text-muted)] hover:text-red-400" title="移除">✕</button>
                    </span>
                  ))}
                </div>
              )}
              {/* ⚡ 心腹（少爺 2026-07-20，仿 CHAT composer）：⚡ 啟動＝模板直接當留言送出（喚醒沿用下方模型/強度/附檔） */}
              {qaWfOpen && (
                <WorkflowLauncher className="mt-1 mb-1 border border-[var(--border)] rounded bg-black/20 p-2"
                  launchLabel="⚡ 啟動（送出留言）"
                  onLaunch={prompt => { setQaWfOpen(false); sendComment(prompt) }} />
              )}
              <div className="flex gap-2 mt-1">
                <button onClick={() => setQaWfOpen(v => !v)}
                  title="心腹 — 選 workflow 模板直接當留言送出"
                  className={`shrink-0 text-[11px] px-2 py-1 rounded border ${qaWfOpen ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'} hover:text-[var(--gold)] hover:border-[var(--gold)]/50`}>⚡</button>
                <select value={qaModel} onChange={e => setQaModel(e.target.value)} title="留言喚醒 Claude 時使用的 AI 模型"
                  className="shrink-0 bg-black/30 border border-[var(--border)] rounded px-1 py-1 text-[10px] text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold)]/50">
                  {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select value={qaEffort} onChange={e => setQaEffort(e.target.value)} title="模型強度（claude --effort）"
                  className="shrink-0 bg-black/30 border border-[var(--border)] rounded px-1 py-1 text-[10px] text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold)]/50">
                  {EFFORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <label title="喚醒改開可視的互動 Claude CLI 視窗盯進度（同專案已有無頭進程在跑時自動退回無頭排隊，避免同 session 雙寫）"
                  className={`shrink-0 flex items-center gap-1 text-[10px] cursor-pointer select-none px-1.5 rounded border ${qaWakeVisible ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
                  <input type="checkbox" checked={qaWakeVisible} onChange={e => setQaWakeVisible(e.target.checked)} className="accent-[var(--gold)] w-3 h-3" />
                  👁 視窗
                </label>
                <input value={commentItemId} onChange={e => setCommentItemId(e.target.value)}
                  placeholder="項目#" className="w-14 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px]" />
                <input value={commentText} onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendComment() }}
                  placeholder="對這輪 QA 留言…（Enter 送出）"
                  className="flex-1 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px]" />
                <button onClick={() => qaAttachRef.current?.click()} title="附加檔案給 Claude 分析"
                  className="text-[11px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50">📎</button>
                <input ref={qaAttachRef} type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv" className="hidden" onChange={handleQaAttach} />
                <button onClick={sendComment}
                  className="text-[11px] px-3 py-1 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10">送出</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 截圖 lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out"
          onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="screenshot" className="max-w-[95vw] max-h-[95vh] rounded shadow-2xl" />
        </div>
      )}
    </div>
  )
}
