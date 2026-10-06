// AutoQA Monitor — 少爺的 QA 可視化介面
// 對應 RomanPrototype/.agent/knowledge/UE5.8_QAToolsets_Plan.md §5.7（Phase M-2）
// A 計畫區（目的+方法）/ B 即時區（進度+截圖+異常）/ C 設計說明區（按鈕展開、逐型別排版）+ 留言雙向
// ws 更新走 window 'tc-qa-run-update' 自訂事件（App.jsx handleServerMessage 一行轉發，不侵入既有結構）
import { useState, useEffect, useRef, useCallback } from 'react'
import { useModelOptions, EFFORT_OPTIONS } from './modelOptions.js'
import { confirmIfLiveInteractive } from './liveSessionGuard.js'
import { reloginSession } from './relogin.js'
import { WorkflowLauncher } from './WorkflowLauncher.jsx'
import { CompanionPanel } from './CompanionPanel.jsx'

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

// C 區塊（少爺 2026-09-09）：設計說明的排版渲染器。
// 「那些設計仰賴排版才能完整表達」⇒ 不用純文字，逐型別給版面：
//   text 段落／table 表格／tree 等寬樹狀骨架／steps 編號步驟／kv 參數對照／note 警語
//   image 圖（少爺 2026-09-28「在 TC 的設計說明看到實作參數的圖文說明」：path 相對 run.sessionDir，點圖放大）
function DesignBlock({ block: b, imgUrl, onZoom }) {
  if (!b || !b.type) return null

  if (b.type === 'image') {
    const _src = imgUrl ? imgUrl(b.path) : null
    return (
      <figure className="space-y-1">
        {_src && (
          <img src={_src} alt={b.caption ?? b.path}
            className="w-full max-h-[360px] object-contain rounded border border-[var(--border)] bg-black/40 cursor-zoom-in"
            onClick={() => onZoom?.(_src)} />
        )}
        {b.caption && <figcaption className="text-[10px] text-[var(--text)]/80 whitespace-pre-wrap">{b.caption}</figcaption>}
      </figure>
    )
  }

  if (b.type === 'text') {
    return <p className="text-[11px] leading-relaxed text-[var(--text)]/90 whitespace-pre-wrap">{b.text}</p>
  }

  if (b.type === 'table') {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="text-[var(--text-muted)] uppercase tracking-wider">
              {(b.headers ?? []).map((h, i) => (
                <th key={i} className="text-left py-1 pr-3 border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(b.rows ?? []).map((r, i) => (
              <tr key={i} className="border-b border-[var(--border)]/30 align-top">
                {r.map((c, j) => (
                  <td key={j} className={`py-1 pr-3 ${j === 0 ? 'font-mono text-[var(--gold)] whitespace-nowrap' : 'text-[var(--text)]/90'}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (b.type === 'tree') {
    return (
      <pre className="text-[10px] font-mono leading-snug bg-black/30 border border-[var(--border)] rounded p-2 overflow-x-auto text-[var(--text)]/85">
        {(b.lines ?? []).join('\n')}
      </pre>
    )
  }

  if (b.type === 'steps') {
    return (
      <ol className="space-y-1 list-none">
        {(b.items ?? []).map((s, i) => (
          <li key={i} className="text-[11px] flex gap-2">
            <span className="shrink-0 text-[var(--gold)] font-mono">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-[var(--text)]/90 whitespace-pre-wrap">{s}</span>
          </li>
        ))}
      </ol>
    )
  }

  if (b.type === 'kv') {
    return (
      <div className="space-y-1">
        {(b.pairs ?? []).map(([k, v], i) => (
          <div key={i} className="flex gap-3 items-start">
            <div className="text-[10px] font-mono text-[var(--gold)] whitespace-nowrap min-w-[130px]">{k}</div>
            <div className="text-[10px] text-[var(--text)]/90 whitespace-pre-wrap flex-1">{v}</div>
          </div>
        ))}
      </div>
    )
  }

  if (b.type === 'note') {
    const _tone = b.tone === 'danger' ? 'border-red-500/50 text-red-300 bg-red-500/5'
      : b.tone === 'warn' ? 'border-amber-500/50 text-amber-300 bg-amber-500/5'
      : 'border-[var(--border)] text-[var(--text-muted)] bg-black/20'
    return (
      <div className={`text-[10px] border-l-2 pl-2 py-1 rounded-r whitespace-pre-wrap ${_tone}`}>{b.text}</div>
    )
  }

  return null
}

function DesignSection({ design: d, imgUrl, onZoom }) {
  return (
    <div className="mt-2 border border-[var(--border)]/60 rounded bg-black/20 p-2.5 space-y-2">
      {d.summary && <div className="text-[10px] text-[var(--text-muted)] italic">{d.summary}</div>}
      {(d.blocks ?? []).map((b, i) => (
        <div key={i} className="space-y-1">
          {b.heading && <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">{b.heading}</div>}
          <DesignBlock block={b} imgUrl={imgUrl} onZoom={onZoom} />
        </div>
      ))}
    </div>
  )
}

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
  const MODEL_OPTIONS = useModelOptions()   // server 目錄推來就自動換清單（少爺 2026-08-15）
  const [runs, setRuns] = useState([])
  // 少爺 2026-08-07：記住最後的選擇操作（記憶在 localStorage）——切工具列分頁回來，未選擇就保持未選擇、有選就還原選的那筆
  const [selectedRunId, setSelectedRunId] = useState(() => localStorage.getItem('tc_qa_selected_run') || null)
  useEffect(() => { try { localStorage.setItem('tc_qa_selected_run', selectedRunId ?? '') } catch {} }, [selectedRunId])
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
  // 少爺 2026-09-08「全部都要聯動」＋「預設聯動選項要是啟動的」：
  // 原本這格是「👁 視窗」（開可視 CLI 視窗），server 端條件早在 2026-07-17 就被停用＝死選項。
  // 改成「🔗 聯動」＝把少爺的動作送進他開著的 VS Code 分頁原地處理，**預設開啟**；
  // 關掉才強制走無頭進程（不佔用分頁）。localStorage 用新 key，舊值不誤沿用。
  const [qaInPlaceLink, setQaInPlaceLink] = useState(() => localStorage.getItem('tc_qa_inplace_link') !== '0')
  useEffect(() => { try { localStorage.setItem('tc_qa_inplace_link', qaInPlaceLink ? '1' : '0') } catch {} }, [qaInPlaceLink])
  // 監看到底掛上了沒——聯動壞掉最久的原因是「沒有人看得出來它壞了」，這裡把它變成看得見的燈
  const [monitorAlive, setMonitorAlive] = useState(null)   // null=未知 / true=原地聯動中 / false=會走無頭
  const [commentItemId, setCommentItemId] = useState('')
  const [qaAttach, setQaAttach] = useState([])   // [{name,dataUrl,type}]：feedback 附檔，一併傳給 Claude 分析
  const qaAttachRef = useRef(null)
  const [lightbox, setLightbox] = useState(null)   // artifact url 放大檢視
  // C 區塊：目前展開哪一份設計說明（null = 全部收合）
  const [openDesignId, setOpenDesignId] = useState(null)
  // 🗣 陪聊（少爺 2026-10-04）：每個 run 各自一段陪聊；開著的是哪個 run（null＝關）
  const [companionRunId, setCompanionRunId] = useState(null)
  const selectedRunIdRef = useRef(null)
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])

  // 少爺 2026-08-05：QA run 狀態 filter（複選 OR）——空集合＝全顯示；有選＝只顯示選中狀態的聯集。記憶在 localStorage。
  const [statusFilter, setStatusFilter] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('tc_qa_status_filter') || '[]')) } catch { return new Set() }
  })
  useEffect(() => { try { localStorage.setItem('tc_qa_status_filter', JSON.stringify([...statusFilter])) } catch {} }, [statusFilter])
  const toggleStatusFilter = useCallback((s) => setStatusFilter(prev => {
    const next = new Set(prev)
    if (next.has(s)) next.delete(s); else next.add(s)
    return next
  }), [])
  // 少爺 2026-08-05：篩選區塊預設收合，點「篩選」按鈕才展開（chips 佔空間）；open 狀態記憶在 localStorage
  const [filterOpen, setFilterOpen] = useState(() => localStorage.getItem('tc_qa_filter_open') === '1')
  useEffect(() => { try { localStorage.setItem('tc_qa_filter_open', filterOpen ? '1' : '0') } catch {} }, [filterOpen])

  // ─── 打包控制（少爺 2026-08-04）：後綴輸入框 ×1 ＋ 打包鈕 ×3 ＋ 開資料夾鈕 ×2 ───
  // 命名 SSOT 與 Invoke-RomanPackage.ps1 一致：Windows_<Dev|Shipping>_<yyyyMMdd><suffix>
  const [pkgSuffix, setPkgSuffix] = useState(() => localStorage.getItem('tc_pkg_suffix') ?? '_WithExtraWorks')
  useEffect(() => { try { localStorage.setItem('tc_pkg_suffix', pkgSuffix) } catch {} }, [pkgSuffix])
  const [pkgJob, setPkgJob] = useState(null)
  const [pkgHint, setPkgHint] = useState('')
  // 折疊（少爺 2026-08-06）：打包／開啟專案區塊可點標題折疊，記憶 localStorage
  const [pkgCollapsed, setPkgCollapsed] = useState(() => localStorage.getItem('tc_pkg_collapsed') === '1')
  useEffect(() => { try { localStorage.setItem('tc_pkg_collapsed', pkgCollapsed ? '1' : '0') } catch {} }, [pkgCollapsed])
  const [openProjCollapsed, setOpenProjCollapsed] = useState(() => localStorage.getItem('tc_openproj_collapsed') === '1')
  useEffect(() => { try { localStorage.setItem('tc_openproj_collapsed', openProjCollapsed ? '1' : '0') } catch {} }, [openProjCollapsed])

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

  // 開啟專案（少爺 2026-08-06）：隨 activeProjectId 開 uproject／workspace／根目錄 explorer
  const openProject = useCallback(async (target) => {
    setPkgHint('')
    const _res = await fetch('/api/project/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: activeProjectId ?? 'roman', target }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    if (!_res.ok) setPkgHint(`⚠️ ${_res.error ?? '開啟失敗'}`)
    else setPkgHint(`📂 已開啟：${_res.opened}${_res.hint ? `｜${_res.hint}` : ''}`)
  }, [activeProjectId])

  const cancelPackage = useCallback(async () => {
    if (!confirm('中止進行中的打包？')) return
    // ⚠️ 一定要帶 Content-Type + body：Fastify 對無 content-type 的 POST 回 415（2026-08-05 實測）
    await fetch('/api/package/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {})
  }, [])

  // ─── 版控 Commit（少爺 2026-08-14）：手動 commit——Claude 出草稿、這裡確認送出 ───
  // 規則（staging／語言／Co-Author）SSOT 在 sommelier.json projects[].git，執行走 Invoke-ProjectCommit.ps1；
  // 這個面板只負責「看清楚要提交什麼、確認、送出」，不自己複製一套規則。
  const [gitCollapsed, setGitCollapsed] = useState(() => localStorage.getItem('tc_git_collapsed') !== '0')
  useEffect(() => { try { localStorage.setItem('tc_git_collapsed', gitCollapsed ? '1' : '0') } catch {} }, [gitCollapsed])
  // 專案不自己選：一律跟著高桌會切的 activeProjectId（少爺 2026-08-14）。
  // TC 自身不進這裡——它走酒窖的「TC Commit」一鍵提交。
  const [gitProjects, setGitProjects] = useState([])
  const gitProjectId = activeProjectId ?? ''
  const [gitStatus, setGitStatus] = useState(null)
  const [gitMessage, setGitMessage] = useState('')
  const [gitMessageZh, setGitMessageZh] = useState('')
  const [gitPickedPaths, setGitPickedPaths] = useState([])   // staging=paths 時勾選的檔案
  const [gitBusy, setGitBusy] = useState(false)
  const [gitHint, setGitHint] = useState('')
  const [gitDraftAt, setGitDraftAt] = useState(null)          // 有草稿＝Claude 推來的，標示給少爺看
  const [gitRuleOpen, setGitRuleOpen] = useState(false)       // 規則編輯（⚙）展開中
  const [gitAutoResults, setGitAutoResults] = useState([])    // 依規則 Commit 的回寫紀錄（當前專案，新→舊）
  const [gitAutoOpen, setGitAutoOpen] = useState(false)       // 紀錄展開中
  // 逐筆推送（少爺 2026-08-29）：server 全域一次只跑一個，所以這裡也只存一個 job
  const [gitPushJob, setGitPushJob] = useState(null)

  const gitProject = gitProjects.find(p => p.id === gitProjectId) ?? null
  const gitPushRunning = gitPushJob?.status === 'running'

  // 草稿套進輸入框（切專案／Claude 推新草稿都走這裡；少爺已在打字時不覆蓋他的內容）
  const applyGitDraft = useCallback((draft, force = false) => {
    if (!draft) { if (force) { setGitMessage(''); setGitMessageZh(''); setGitDraftAt(null) } return }
    setGitMessage(prev => (force || !prev.trim() ? draft.message ?? '' : prev))
    setGitMessageZh(draft.messageZh ?? '')
    setGitPickedPaths(Array.isArray(draft.paths) ? draft.paths : [])
    setGitDraftAt(draft.at ?? null)
  }, [])

  const loadGitProjects = useCallback(async () => {
    const _res = await fetch('/api/git/projects').then(r => r.json()).catch(() => ({ ok: false }))
    if (!_res.ok) return
    setGitProjects(_res.projects ?? [])
    if (gitProjectId) applyGitDraft((_res.drafts ?? {})[gitProjectId], true)
    setGitAutoResults(gitProjectId ? ((_res.autoResults ?? {})[gitProjectId] ?? []) : [])
  }, [gitProjectId, applyGitDraft])

  const loadGitStatus = useCallback(async (projectId) => {
    if (!projectId) { setGitStatus(null); return }
    const _res = await fetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`)
      .then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setGitStatus(_res.ok ? _res : null)
    setGitHint(_res.ok ? '' : '')      // 未設規則的專案不算錯誤，區塊自己會說明
  }, [])

  useEffect(() => { loadGitProjects() }, [loadGitProjects])
  // 切專案＝換 repo：狀態重讀、輸入框清空（訊息屬於前一個 repo，留著只會誤送）
  useEffect(() => {
    setGitMessage(''); setGitMessageZh(''); setGitPickedPaths([]); setGitDraftAt(null); setGitHint('')
    setGitAutoOpen(false)
    loadGitStatus(gitProjectId)
  }, [gitProjectId, loadGitStatus])

  // Claude 推草稿上來（ws）→ 若是當前專案就直接填進輸入框並展開區塊
  useEffect(() => {
    const onDraft = (e) => {
      const _drafts = e.detail ?? {}
      if (!gitProjectId) return
      const _d = _drafts[gitProjectId]
      applyGitDraft(_d ?? null, true)
      if (_d) { setGitCollapsed(false); loadGitStatus(gitProjectId) }
    }
    window.addEventListener('tc-git-draft', onDraft)
    return () => window.removeEventListener('tc-git-draft', onDraft)
  }, [gitProjectId, applyGitDraft, loadGitStatus])

  // 依規則 Commit 完成（ws）→ 是當前專案就記一筆、自動展開紀錄並刷新 git 狀態
  useEffect(() => {
    const onAuto = (e) => {
      const _d = e.detail ?? {}
      if (!gitProjectId || _d.projectId !== gitProjectId || !_d.result) return
      setGitAutoResults(prev => [_d.result, ...prev].slice(0, 10))
      setGitAutoOpen(true)
      setGitCollapsed(false)
      setGitHint(`✅ 依規則 Commit 完成：${_d.result.hash || '(hash 未回報)'}（未 push）`)
      loadGitStatus(gitProjectId)
    }
    window.addEventListener('tc-git-autocommit', onAuto)
    return () => window.removeEventListener('tc-git-autocommit', onAuto)
  }, [gitProjectId, loadGitStatus])

  // 逐筆推送進度（ws）：job 是 server 全域的，所以不論哪個專案在推都收下來——
  // 少爺切走再切回來也看得到進度，跑完的那一刻順手刷新 git 狀態（ahead 會歸零）
  useEffect(() => {
    fetch('/api/git/push/status').then(r => r.json()).then(d => setGitPushJob(d.job ?? null)).catch(() => {})
    const onPush = (e) => {
      const _job = e.detail ?? null
      setGitPushJob(_job)
      if (_job && _job.status !== 'running') {
        setGitCollapsed(false)
        if (_job.projectId === gitProjectId) loadGitStatus(gitProjectId)
      }
    }
    window.addEventListener('tc-git-push', onPush)
    return () => window.removeEventListener('tc-git-push', onPush)
  }, [gitProjectId, loadGitStatus])

  // 改該專案的 commit 規則（即改即存）：寫回 sommelier.json projects[].git——規則只有那一份 SSOT
  const patchGitPolicy = useCallback(async (patch) => {
    if (!gitProjectId) return
    setGitBusy(true)
    const _res = await fetch(`/api/projects/registry/${encodeURIComponent(gitProjectId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git: patch }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setGitBusy(false)
    if (!_res.ok) { setGitHint(`⚠️ ${_res.error ?? '規則存檔失敗'}`); return }
    setGitHint(patch === null ? '已撤掉這個專案的 commit 規則' : '✅ 規則已更新')
    await loadGitProjects()
    loadGitStatus(gitProjectId)
  }, [gitProjectId, loadGitProjects, loadGitStatus])

  // 少爺 2026-08-14：「設定完規則後直接按 Commit」「我很少手動輸入 commit 內容」
  // → 訊息留空按 Commit＝喚 Claude 依該專案 git 規則讀 diff、寫訊息、直接提交（試跑仍需自備訊息）
  const runAutoCommit = useCallback(async () => {
    if (!gitProjectId) return
    setGitBusy(true); setGitHint('喚 Claude 依規則提交中…')
    const _res = await fetch('/api/git/auto-commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: gitProjectId }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setGitBusy(false)
    setGitHint(_res.ok ? `⚡ ${_res.message ?? '已喚起 Claude'}（完成後這裡會刷新）` : `❌ ${_res.error ?? '喚起失敗'}`)
  }, [gitProjectId])

  // 逐筆推送（少爺 2026-08-29）：把遠端還沒有的 commits 由舊到新一筆一筆推上去，
  // 避免累積太多 commit 時單次傳輸量爆掉。規則與 repo 來源都在 Invoke-ProjectPushOneByOne.ps1，這裡只負責按下去與看進度。
  const runPushOneByOne = useCallback(async () => {
    if (!gitProjectId || !gitStatus) return
    const _ahead = gitStatus.ahead ?? 0
    if (_ahead === 0) { setGitHint('沒有需要推送的 commits，已與遠端同步'); return }
    // push 是對外動作：確認框把「推幾筆、推去哪、哪個 repo」講清楚再走
    if (!confirm(
      `逐筆推送「${gitProject?.name ?? gitProjectId}」？\n\n`
      + `分支：${gitStatus.branch}\n待推：${_ahead} 筆（由舊到新一筆一筆推）\n`
      + `repo：${gitStatus.repoRoot}\n\n這會把 commits 推上遠端。`
    )) return
    setGitBusy(true); setGitHint('')
    const _res = await fetch('/api/git/push/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: gitProjectId }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setGitBusy(false)
    if (!_res.ok) { setGitHint(`❌ ${_res.error ?? '推送啟動失敗'}`); return }
    setGitPushJob(_res.job ?? null)
  }, [gitProjectId, gitProject, gitStatus])

  const runCommit = useCallback(async (dryRun = false) => {
    if (!gitProjectId) return
    // 訊息空 + 非試跑 → 走自動路徑（由 Claude 依規則產生訊息並提交）
    if (!gitMessage.trim() && !dryRun) { runAutoCommit(); return }
    if (!gitMessage.trim()) { setGitHint('⚠️ 試跑需要先有 commit 訊息'); return }
    setGitBusy(true); setGitHint(dryRun ? '試跑中…' : '提交中…')
    const _res = await fetch('/api/git/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: gitProjectId, message: gitMessage, dryRun,
        stage: gitProject?.staging === 'paths' ? 'paths' : undefined,
        paths: gitProject?.staging === 'paths' ? gitPickedPaths : undefined,
      }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setGitBusy(false)
    if (!_res.ok) { setGitHint(`❌ ${_res.error ?? '提交失敗'}`); return }
    if (dryRun) { setGitHint(`✅ 試跑通過：${_res.files?.length ?? 0} 個檔案會進 commit`); return }
    setGitHint(`✅ ${_res.hash} · ${_res.subject}（${_res.files?.length ?? 0} 檔、未 push）`)
    setGitMessage(''); setGitMessageZh(''); setGitPickedPaths([]); setGitDraftAt(null)
    loadGitStatus(gitProjectId)
  }, [gitProjectId, gitMessage, gitProject, gitPickedPaths, loadGitStatus, runAutoCommit])

  // 少爺 2026-08-07：進 QA 分頁不再預設自動選最新 run——選擇一律由少爺顯式動作（點 run／新宣告聚焦／會議室聯動）產生
  const reload = useCallback(() => {
    fetch('/api/qa/runs?limit=100').then(r => r.json()).then(d => {
      setRuns(d.runs ?? [])
    }).catch(() => {})
  }, [])

  useEffect(() => { reload() }, [reload])

  // 監看存活燈（少爺 2026-09-08）：聯動壞得最久的原因是「壞了看不出來」——把它變成留言列上看得見的狀態。
  // alive=true → 少爺的動作會送進那個 VS Code 分頁原地處理；false → 只會走無頭進程，分頁不動。
  const _boundSid = runs.find(r => r.id === selectedRunId)?.boundSessionId ?? null
  useEffect(() => {
    if (!_boundSid) { setMonitorAlive(null); return }
    let _stop = false
    const _poll = () => fetch(`/api/qa/monitor-status?session=${_boundSid}`)
      .then(r => r.json()).then(d => { if (!_stop) setMonitorAlive(!!d.alive) })
      .catch(() => { if (!_stop) setMonitorAlive(null) })
    _poll()
    const _t = setInterval(_poll, 10_000)
    return () => { _stop = true; clearInterval(_t) }
  }, [_boundSid])

  // 切專案：選中 run 不屬於新專案 → 清空選擇（少爺 2026-08-07：不自動改選最新，等少爺自己點）
  useEffect(() => {
    const cur = runs.find(r => r.id === selectedRunIdRef.current)
    if (cur && !runMatchesProject(cur)) setSelectedRunId(null)
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
      // 新宣告的 run 自動聚焦（少爺打開視窗就是要看它）；一般更新不補位聚焦（少爺 2026-08-07：預設不自動選）
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

  async function sendComment(overrideText, extra = {}) {
    // onClick={sendComment} 會把 event 當第一參數傳入 → 只認字串 override（心腹 ⚡ 啟動用）
    const text = (typeof overrideText === 'string' ? overrideText : commentText).trim()
    if (!text && qaAttach.length === 0) return
    // 少爺 2026-07-14「警示＋照送」：spawn 模式卻綁著 VS Code 活 session（錯配——活 session 應走 monitor）→ 確認後才喚醒
    if (run?.wakeMode === 'spawn' && run?.boundSessionId)
      if (!(await confirmIfLiveInteractive(run.boundSessionId, '無頭喚醒'))) return
    const _res = await control('comment', { text, itemId: commentItemId ? Number(commentItemId) : null, attachments: qaAttach, model: qaModel || null, effort: qaEffort || null, inPlaceLink: qaInPlaceLink, ...extra })
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

  // 少爺 2026-08-05：狀態 filter 後的可見清單（複選 OR）＋各狀態計數（chip 上顯示、不受 filter 影響）
  const _statusPass = (r) => statusFilter.size === 0 || statusFilter.has(r.status)
  const _projectRuns = runs.filter(r => !r.archivedAt && runMatchesProject(r))
  const _visibleRuns = _projectRuns.filter(_statusPass)
  const _statusCounts = {}
  for (const _r of _projectRuns) _statusCounts[_r.status] = (_statusCounts[_r.status] ?? 0) + 1

  return (
    <div className="flex h-full min-h-0">
      {companionRunId && (
        <CompanionPanel key={companionRunId} scope="qa" refId={companionRunId}
          subtitle={runs.find(r => r.id === companionRunId)?.topic ?? ''}
          onClose={() => setCompanionRunId(null)} />
      )}
      {/* C 歷史區（左欄）；少爺 2026-08-07：點空白處（run 清單以外的底）＝取消選擇，右側回到乾淨等待畫面 */}
      <aside onClick={(e) => { if (e.target === e.currentTarget) setSelectedRunId(null) }}
        className="w-52 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] overflow-y-auto">
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
          <div className="flex items-center justify-between gap-1">
            <span>QA Runs（永久保留）</span>
            <button onClick={() => setFilterOpen(v => !v)} title="展開／收合狀態篩選"
              className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border tracking-normal normal-case ${
                statusFilter.size > 0 ? 'text-[var(--gold)] border-[var(--gold)]/50' : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)]'}`}>
              {filterOpen ? '▾' : '▸'} 篩選{statusFilter.size > 0 ? ` (${statusFilter.size})` : ''}
            </button>
          </div>
          {/* 少爺 2026-08-05：狀態 filter chips（複選 OR，任一滿足即顯示；數字＝該狀態筆數）；點「篩選」按鈕展開／收合 */}
          {filterOpen && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {Object.entries(STATUS_META).map(([_s, _m]) => {
              const _on = statusFilter.has(_s)
              const _cnt = _statusCounts[_s] ?? 0
              return (
                <button key={_s} onClick={() => toggleStatusFilter(_s)} title={`${_on ? '取消篩選' : '篩選'}：${_m.label}（${_cnt} 筆）`}
                  className={`text-[9px] px-1.5 py-0.5 rounded border tracking-normal normal-case ${
                    _on ? `${_m.cls} bg-white/10` : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)]'}`}>
                  {_m.label}{_cnt > 0 && <span className="ml-0.5 opacity-60">{_cnt}</span>}
                </button>
              )
            })}
            {statusFilter.size > 0 && (
              <button onClick={() => setStatusFilter(new Set())} title="清除篩選"
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] tracking-normal normal-case">✕ 清除</button>
            )}
          </div>
          )}
        </div>
        {_visibleRuns.length === 0 && (
          <div onClick={() => setSelectedRunId(null)}
            className="px-3 py-4 text-[10px] text-[var(--text-muted)] text-center">
            {_projectRuns.length === 0 ? '尚無 QA run' : '無符合篩選的 run'}
          </div>
        )}
        {_visibleRuns.map(r => (
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
        {/* ── 開啟專案（少爺 2026-08-06）：隨 activeProjectId 切路徑、可折疊 ── */}
        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <button onClick={() => setOpenProjCollapsed(v => !v)} title="折疊／展開開啟專案"
            className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--gold)]">
            {openProjCollapsed ? '▸' : '▾'} 開啟專案
          </button>
          {!openProjCollapsed && (
            <div className="flex items-center gap-2 flex-wrap mt-1.5">
              <div className="flex rounded overflow-hidden border border-[var(--border)]">
                {[['uproject', '🎮 UE 專案'], ['workspace', '📘 VS Code'], ['explorer', '📁 資料夾'], ['fmod', '🎵 FMOD']].map(([_t, _label], _i) => (
                  <button key={_t} onClick={() => openProject(_t)} title={`開啟目前專案的 ${_label}`}
                    className={`text-[11px] px-2.5 py-1 text-[var(--text)] hover:bg-[var(--gold)]/15 hover:text-[var(--gold)] ${_i > 0 ? 'border-l border-[var(--border)]' : ''}`}>
                    {_label}
                  </button>
                ))}
              </div>
              <span className="text-[9px] text-[var(--text-muted)]">目前：{activeProjectId ?? 'roman'}</span>
            </div>
          )}
        </div>

        {/* ── 打包控制列（少爺 2026-08-04）：不依賴選中 run，永遠可用；標題折疊（少爺 2026-08-06）── */}
        <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <button onClick={() => setPkgCollapsed(v => !v)} title="折疊／展開打包"
            className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--gold)]">
            {pkgCollapsed ? '▸' : '▾'} 打包{pkgJob?.status === 'running' ? ' · 打包中' : ''}
          </button>
          {!pkgCollapsed && (<>
          <div className="flex items-center gap-2 flex-wrap mt-1.5">

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
                  <span>{{ starting: '準備中', cooking: 'Cook / Build 中',
                    uat_build: '編譯中', uat_cook: 'Cook 中', uat_stage: 'Stage 中', uat_package: 'Pak 中', uat_archive: 'Archive 中',
                    archiving: '壓縮中' }[pkgJob.phase] ?? pkgJob.phase}</span>
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
          </>)}
        </div>

        {/* ── 版控 Commit（少爺 2026-08-14）：Claude 出草稿、少爺確認送出；規則隨專案自動套用 ── */}
        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <button onClick={() => setGitCollapsed(v => !v)} title="折疊／展開版控"
            className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--gold)]">
            {gitCollapsed ? '▸' : '▾'} 版控{gitDraftAt ? ' · 有 Claude 草稿' : ''}
          </button>

          {!gitCollapsed && (<>
          <div className="flex items-center gap-2 flex-wrap mt-1.5">
            {/* 專案跟著上方的專案切換走，這裡只顯示是哪一個 repo */}
            <span className="text-[11px] text-[var(--text)]">{gitProject?.name ?? (gitProjectId || '未選專案')}</span>

            {/* 規則徽章：這次會怎麼 staged、message 該用什麼語言——送出前一眼看到 */}
            {gitProject && (<>
              <span title="staging 規則（sommelier.json projects[].git.staging）"
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                {{ none: '只 commit 既有 staged', all: '全部 staged', paths: '挑檔 staged' }[gitProject.staging] ?? gitProject.staging}
              </span>
              <span title="commit message 語言規則"
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                {gitProject.lang === 'zh-TW' ? '繁中 message' : '英文 message'}
              </span>
              {gitProject.coAuthor && (
                <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">Co-Author</span>
              )}
            </>)}

            {gitStatus && (
              <span className="text-[10px] text-[var(--text-muted)] font-mono">
                ⎇ {gitStatus.branch || '—'} · staged {gitStatus.staged.length} / 未 staged {gitStatus.unstaged.length} / 未追蹤 {gitStatus.untracked.length}
                {gitStatus.ahead > 0 && <span className="text-[var(--gold)]"> · ↑{gitStatus.ahead} 未推</span>}
                {gitStatus.behind > 0 && <span className="text-amber-400"> · ↓{gitStatus.behind} 落後</span>}
              </span>
            )}

            <div className="flex-1" />
            <button onClick={() => setGitRuleOpen(v => !v)} title="設定這個專案的 commit 規則"
              className={`text-[11px] px-2 py-1 ${gitRuleOpen ? 'text-[var(--gold)]' : 'text-[var(--text-muted)]'} hover:text-[var(--gold)]`}>⚙</button>
            <button onClick={() => loadGitStatus(gitProjectId)} title="重新讀取 git 狀態"
              className="text-[11px] px-2 py-1 text-[var(--text-muted)] hover:text-[var(--gold)]">↻</button>
          </div>

          {/* 沒設規則的專案：說明＋一鍵建規則，不用去手改 sommelier.json */}
          {!gitProject && gitProjectId && !gitRuleOpen && (
            <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
              這個專案還沒設 commit 規則——
              <button onClick={() => setGitRuleOpen(true)} className="text-[var(--gold)] hover:underline">按這裡設定</button>
              （或按上方 ⚙）
            </div>
          )}

          {/* 規則編輯（即改即存）：寫回 sommelier.json projects[].git，腳本與面板共讀同一份 */}
          {gitRuleOpen && gitProjectId && (
            <div className="mt-1.5 border border-[var(--border)] rounded bg-black/20 p-2 space-y-2">
              {!gitProject && (
                <div className="text-[10px] text-amber-400">尚未建立規則——改動任一項即建立（未動到的欄位用上面顯示的預設值）</div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-[var(--text-muted)] w-20 shrink-0">staging</span>
                <select value={gitProject?.staging ?? 'none'} disabled={gitBusy}
                  onChange={e => patchGitPolicy({ staging: e.target.value })}
                  className="text-[11px] bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]">
                  <option value="none">只 commit 既有 staged（我不幫你 staged）</option>
                  <option value="all">全部 staged（提交前 git add -A）</option>
                  <option value="paths">挑檔 staged（在清單勾選）</option>
                </select>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-[var(--text-muted)] w-20 shrink-0">message 語言</span>
                <select value={gitProject?.lang ?? 'en'} disabled={gitBusy}
                  onChange={e => patchGitPolicy({ lang: e.target.value })}
                  className="text-[11px] bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]">
                  <option value="en">英文（Claude 回覆附繁中對照）</option>
                  <option value="zh-TW">繁體中文</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-[10px] text-[var(--text)] cursor-pointer">
                <input type="checkbox" checked={gitProject?.coAuthor !== false} disabled={gitBusy}
                  onChange={e => patchGitPolicy({ coAuthor: e.target.checked })} />
                結尾自動補 Co-Authored-By
              </label>
              <label className="flex items-center gap-2 text-[10px] text-[var(--text)] cursor-pointer">
                <input type="checkbox" checked={gitProject?.allowStageOverride === true} disabled={gitBusy}
                  onChange={e => patchGitPolicy({ allowStageOverride: e.target.checked })} />
                允許單次覆寫 staging 規則
                <span className="text-[var(--text-muted)]">（勾了才擋不住「代你 staged」）</span>
              </label>
              <div className="flex items-center gap-2 pt-1 border-t border-[var(--border)]">
                <span className="text-[9px] text-[var(--text-muted)] flex-1">存進 sommelier.json 的 projects[].git，腳本與面板共用</span>
                {gitProject && (
                  <button onClick={() => { if (confirm('撤掉這個專案的 commit 規則？版控區塊會停用。')) patchGitPolicy(null) }}
                    className="text-[10px] px-2 py-0.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10">撤掉規則</button>
                )}
                <button onClick={() => setGitRuleOpen(false)}
                  className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">收起</button>
              </div>
            </div>
          )}

          {/* 挑檔模式：勾要進這次 commit 的檔案；其他模式只列出來讓少爺確認範圍 */}
          {gitProject && gitStatus && (
            <div className="mt-1.5 max-h-28 overflow-y-auto border border-[var(--border)] rounded bg-black/20 px-2 py-1">
              {gitProject?.staging === 'paths' ? (
                [...gitStatus.unstaged.map(f => f.file), ...gitStatus.untracked, ...gitStatus.staged.map(f => f.file)]
                  .filter((f, i, arr) => arr.indexOf(f) === i)
                  .map(_f => (
                    <label key={_f} className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--text)] cursor-pointer">
                      <input type="checkbox" checked={gitPickedPaths.includes(_f)}
                        onChange={e => setGitPickedPaths(prev => e.target.checked ? [...prev, _f] : prev.filter(p => p !== _f))} />
                      {_f}
                    </label>
                  ))
              ) : (
                (gitProject?.staging === 'none' ? gitStatus.staged.map(f => `${f.code} ${f.file}`)
                  : [...gitStatus.staged.map(f => `${f.code} ${f.file}`),
                     ...gitStatus.unstaged.map(f => `${f.code} ${f.file}`),
                     ...gitStatus.untracked.map(f => `? ${f}`)]
                ).map((_l, _i) => <div key={_i} className="text-[10px] font-mono text-[var(--text-muted)] truncate">{_l}</div>)
              )}
              {gitProject?.staging === 'none' && gitStatus.staged.length === 0 && (
                <div className="text-[10px] text-amber-400">staged 為空——這個專案只 commit 你自己 staged 好的內容</div>
              )}
            </div>
          )}

          {gitProject && (<>
          <textarea value={gitMessage} onChange={e => { setGitMessage(e.target.value); setGitDraftAt(null) }}
            rows={4} placeholder={gitProject.lang === 'zh-TW' ? 'type(scope)：繁中事實描述' : 'type(scope): factual description'}
            className="w-full mt-1.5 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text)]" />

          {/* 英文規則專案的繁中對照：只給少爺看，不寫進 commit */}
          {gitMessageZh && (
            <div className="mt-1 text-[10px] text-[var(--text-muted)] border-l-2 border-[var(--gold)]/40 pl-2 whitespace-pre-wrap">
              {gitMessageZh}
            </div>
          )}

          <div className="flex items-center gap-2 mt-1.5">
            {gitDraftAt && <span className="text-[9px] text-[var(--gold)]">Claude 草稿 {fmtTime(gitDraftAt)}</span>}
            <div className="flex-1" />
            {/* 逐筆推送（少爺 2026-08-29）：與 commit 分開的動作——commit 只進本地，這顆才會動到遠端。
                刻意不用金色：金色是「Commit」那顆主動作的顏色，別讓兩顆看起來像同一件事 */}
            <button onClick={runPushOneByOne}
              disabled={gitBusy || gitPushRunning || !(gitStatus?.ahead > 0)}
              title={gitPushRunning ? '已有推送在進行中'
                : !(gitStatus?.ahead > 0) ? '沒有待推的 commits'
                  : `把 ${gitStatus.ahead} 筆未推 commits 由舊到新逐筆推上 ${gitStatus.branch}（避免單次傳輸量過大）`}
              className={`text-[11px] px-2.5 py-1 rounded border ${
                gitBusy || gitPushRunning || !(gitStatus?.ahead > 0)
                  ? 'border-[var(--border)] text-[var(--text-muted)] opacity-40 cursor-not-allowed'
                  : 'border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/15'}`}>
              ⬆ 逐筆推送{gitStatus?.ahead > 0 ? `（${gitStatus.ahead}）` : ''}
            </button>
            <button onClick={() => runCommit(true)} disabled={gitBusy || !gitMessage.trim()}
              title="不真的提交，只驗規則與範圍"
              className={`text-[11px] px-2.5 py-1 rounded border border-[var(--border)] ${
                gitBusy || !gitMessage.trim() ? 'text-[var(--text-muted)] opacity-40 cursor-not-allowed' : 'text-[var(--text)] hover:bg-white/10'}`}>
              試跑
            </button>
            <button onClick={() => runCommit(false)} disabled={gitBusy || !gitProjectId}
              title={gitMessage.trim() ? '用上面的訊息提交' : '訊息留空＝喚 Claude 依本專案規則讀 diff、寫訊息並提交（不 push）'}
              className={`text-[11px] px-2.5 py-1 rounded border ${
                gitBusy || !gitProjectId ? 'border-[var(--border)] text-[var(--text-muted)] opacity-40 cursor-not-allowed'
                  : 'border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/15'}`}>
              {gitMessage.trim() ? 'Commit' : '⚡ 依規則 Commit'}
            </button>
          </div>
          </>)}

          {/* 逐筆推送進度（少爺 2026-08-29）：job 是 server 全域的——別的專案在推也看得到，免得兩邊互相搶 */}
          {gitPushJob && (
            <div className="mt-1.5 border border-[var(--border)] rounded bg-black/20 px-2 py-1.5">
              <div className="flex items-center gap-2 text-[10px] font-mono">
                {/* 試算不能寫「推送完成」——那會讓人以為東西已經上遠端了 */}
                <span className={gitPushRunning ? 'text-[var(--gold)]'
                  : gitPushJob.result?.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {gitPushRunning ? (gitPushJob.dryRun ? '⬆ 試算中' : '⬆ 推送中')
                    : gitPushJob.result?.ok ? (gitPushJob.dryRun ? '✅ 試算完成（未推送）' : '✅ 推送完成')
                      : gitPushJob.dryRun ? '❌ 試算失敗' : '❌ 推送失敗'}
                </span>
                <span className="text-[var(--text-muted)]">
                  {gitPushJob.projectName}
                  {gitPushJob.branch && ` · ${gitPushJob.remote}/${gitPushJob.branch}`}
                </span>
                <span className="flex-1 text-right text-[var(--text-muted)]">
                  {gitPushJob.dryRun ? `${gitPushJob.total} 筆待推` : `${gitPushJob.done}/${gitPushJob.total || '?'} 筆`}
                </span>
              </div>

              {/* 進度條：total 還沒解析出來（fetch 階段）就不畫，免得顯示一條假的滿格；
                  試算沒有「推到第幾筆」可言，畫一條永遠 0% 的條只會像卡住 */}
              {gitPushJob.total > 0 && !gitPushJob.dryRun && (
                <div className="mt-1 h-1 rounded bg-white/10 overflow-hidden">
                  <div className={`h-full ${gitPushRunning ? 'bg-[var(--gold)]' : gitPushJob.result?.ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.round((gitPushJob.done / gitPushJob.total) * 100)}%` }} />
                </div>
              )}

              {gitPushRunning && gitPushJob.current && (
                <div className="mt-1 text-[10px] font-mono text-[var(--text)] truncate">
                  {gitPushJob.current.short} {gitPushJob.current.subject}
                </div>
              )}

              {!gitPushRunning && gitPushJob.result && (
                <div className={`mt-1 text-[10px] ${gitPushJob.result.ok ? 'text-[var(--text-muted)]' : 'text-red-400'} whitespace-pre-wrap break-all`}>
                  {gitPushJob.result.ok ? gitPushJob.result.message : gitPushJob.result.error}
                </div>
              )}

              {gitPushJob.result?.warnings?.length > 0 && (
                <div className="mt-1 text-[10px] text-amber-400 whitespace-pre-wrap break-all">
                  {gitPushJob.result.warnings.map((_w, _i) => <div key={_i}>⚠ {_w}</div>)}
                </div>
              )}

              {/* 逐筆輸出：失敗時要看得到是哪一筆炸的、git 說了什麼 */}
              {gitPushJob.tail?.length > 0 && (
                <details className="mt-1">
                  <summary className="text-[9px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--gold)]">
                    推送輸出（{gitPushJob.tail.length} 行）
                  </summary>
                  <div className="mt-1 max-h-40 overflow-y-auto">
                    {gitPushJob.tail.map((_l, _i) => (
                      <div key={_i} className="text-[9px] font-mono text-[var(--text-muted)] whitespace-pre-wrap break-all">{_l}</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* 依規則 Commit 紀錄（少爺 2026-08-20）：子進程提交完回寫的內容，按鍵展開檢視英文 message＋繁中對照 */}
          {gitProject && gitAutoResults.length > 0 && (
            <div className="mt-1.5 border border-[var(--border)] rounded bg-black/20">
              <button onClick={() => setGitAutoOpen(v => !v)}
                className="w-full flex items-center gap-2 px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]">
                <span>{gitAutoOpen ? '▾' : '▸'}</span>
                <span>⚡ 依規則 Commit 紀錄（{gitAutoResults.length}）</span>
                <span className="flex-1 text-right font-mono truncate">
                  {gitAutoResults[0].hash && `${gitAutoResults[0].hash} · `}{fmtTime(gitAutoResults[0].at)}
                </span>
              </button>
              {gitAutoOpen && (
                <div className="px-2 pb-2 space-y-2 max-h-64 overflow-y-auto">
                  {gitAutoResults.map((_r, _i) => (
                    <div key={_r.at ?? _i} className={`${_i > 0 ? 'border-t border-[var(--border)] pt-2' : ''}`}>
                      <div className="flex items-center gap-2 text-[9px] text-[var(--text-muted)] font-mono">
                        {_r.hash && <span className="text-[var(--gold)]">{_r.hash}</span>}
                        {_r.branch && <span>⎇ {_r.branch}</span>}
                        <span>{_r.files?.length ?? 0} 檔 · 未 push</span>
                        <span className="flex-1 text-right">{fmtTime(_r.at)}</span>
                      </div>
                      <pre className="mt-1 text-[10px] font-mono text-[var(--text)] whitespace-pre-wrap break-all">{_r.message}</pre>
                      {_r.messageZh && _r.messageZh !== _r.message && (
                        <div className="mt-1 text-[10px] text-[var(--text-muted)] border-l-2 border-[var(--gold)]/40 pl-2 whitespace-pre-wrap">
                          {_r.messageZh}
                        </div>
                      )}
                      {_r.files?.length > 0 && (
                        <details className="mt-1">
                          <summary className="text-[9px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--gold)]">檔案清單（{_r.files.length}）</summary>
                          {_r.files.map((_f, _j) => (
                            <div key={_j} className="text-[9px] font-mono text-[var(--text-muted)] truncate pl-2">{_f}</div>
                          ))}
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {gitHint && <div className="text-[10px] mt-1 text-[var(--text-muted)] font-mono break-all">{gitHint}</div>}
          </>)}
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
                {run.status === 'closed' && run.autoClose && (
                  <span title={`預約結案：run 到已完成時由 TC 代按 ✔ 結案${run.autoClose.text ? `（你說「${run.autoClose.text}」）` : ''}`}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">⏳ 預約代按結案</span>
                )}
                <button onClick={() => setCompanionRunId(run.id)}
                  title="陪聊：陪你腦力激盪這個 QA，想法即時整理在想法板，確認後交付給綁定聊天室實作（文字為本、語音可選）"
                  className="text-[10px] px-2 py-0.5 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10">🗣 陪聊</button>
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
                  {run.boundSessionId && (
                    <button onClick={() => reloginSession(run.boundSessionId, run.boundProjectPath ?? null, '綁定聊天室')}
                      title="或直接在終端重新登入這個聊天室並掛起監看"
                      className="ml-2 text-[11px] px-1.5 py-0.5 rounded border border-red-400/50 text-red-300 hover:bg-red-400/10">🔁 重新登入聯動</button>
                  )}
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
                {/* 少爺 2026-10-05：執行中直接結案＝等同留言輸入「OK」送出（走同一條留言喚醒鏈，Claude 照 Mode C 判定全過→推 finished→結案） */}
                {/* 同日：並預約結案——Claude 推 finished 時 TC 代按 ✔ 結案，不必回來再按一次 */}
                {run.status === 'running' && !run.closeArmed && (
                  <button title="結案＝等同在留言輸入「OK」送出並預約結案：Claude 逐項判定、推到已完成時，TC 自動代按 ✔ 結案進入階段五"
                    onClick={() => { if (confirm('全部 OK、結案這輪 QA？等同在留言送出「OK」；Claude 推到已完成時會自動結案，不必再按一次')) sendComment('OK', { armClose: true }) }}
                    className="text-[11px] px-3 py-1 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10">✔ 結案</button>
                )}
                {run.closeArmed && !['finished', 'closed', 'aborted'].includes(run.status) && (
                  <span title={`預約來源：${{ button: '執行中 ✔ 結案鈕', comment: '留言表態結案', claude: 'Claude 依你在聊天室的話預約' }[run.closeArmed.source] ?? run.closeArmed.source}${run.closeArmed.text ? `「${run.closeArmed.text}」` : ''}`}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--gold)]/40 text-[var(--gold)] flex items-center gap-1.5">
                    ⏳ 已預約結案：進入已完成時自動結案
                    <button onClick={() => control('disarm-close')} title="取消預約：run 到已完成時停住，等你自己按 ✔ 結案"
                      className="text-[10px] px-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">取消</button>
                  </span>
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

            {/* C 設計區（少爺 2026-09-09）：每份設計一顆按鈕，點開才展開排版內容 */}
            {run.designs?.length > 0 && (
              <div className="border border-[var(--border)] rounded bg-[var(--surface)] p-3">
                <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">
                  C · 設計說明（{run.designs.length} 份 — 點按鈕展開）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {run.designs.map(d => {
                    const _on = openDesignId === d.id
                    return (
                      <button key={d.id}
                        onClick={() => setOpenDesignId(_on ? null : d.id)}
                        title={d.summary || d.title}
                        className={`text-[10px] px-2 py-1 rounded border transition-colors text-left ${
                          _on ? 'border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]'
                              : 'border-[var(--border)] text-[var(--text)]/80 hover:border-[var(--gold)]/60 hover:text-[var(--gold)]'}`}>
                        {d.tag && <span className="text-[9px] opacity-70 mr-1">[{d.tag}]</span>}
                        {d.title}
                        <span className="ml-1 opacity-60">{_on ? '▾' : '▸'}</span>
                      </button>
                    )
                  })}
                </div>
                {run.designs.filter(d => d.id === openDesignId).map(d => (
                  <DesignSection key={d.id} design={d} imgUrl={artifactUrl} onZoom={setLightbox} />
                ))}
              </div>
            )}

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
                  {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value} title={o.title} disabled={o.disabled}>{o.label}</option>)}
                </select>
                <select value={qaEffort} onChange={e => setQaEffort(e.target.value)} title="模型強度（claude --effort）"
                  className="shrink-0 bg-black/30 border border-[var(--border)] rounded px-1 py-1 text-[10px] text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold)]/50">
                  {EFFORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <label title={qaInPlaceLink
                  ? (monitorAlive === true ? '原地聯動中：送出後由該 VS Code 分頁當場處理，回應即時出現在分頁與 CHAT'
                    : monitorAlive === false ? '⚠️ 已開啟聯動，但該聊天室的監看沒掛上 → 本次仍會走無頭進程、分頁不動。在該分頁隨便輸入一句，它會自動補掛監看'
                    : '原地聯動：優先送進少爺開著的 VS Code 分頁處理（未綁定聊天室時無作用）')
                  : '已關閉聯動：本次強制走無頭進程，不佔用 VS Code 分頁'}
                  className={`shrink-0 flex items-center gap-1 text-[10px] cursor-pointer select-none px-1.5 rounded border ${qaInPlaceLink ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
                  <input type="checkbox" checked={qaInPlaceLink} onChange={e => setQaInPlaceLink(e.target.checked)} className="accent-[var(--gold)] w-3 h-3" />
                  🔗 聯動{qaInPlaceLink && monitorAlive !== null && (monitorAlive ? '·通' : '·斷')}
                </label>
                {/* 🔁 重新登入聯動（少爺 2026-09-16）：監看沒掛＝綁定聊天室不是活分頁 → 一鍵在終端 claude --resume 起活分頁並自動掛監看 */}
                {qaInPlaceLink && monitorAlive === false && _boundSid && (
                  <button onClick={() => reloginSession(_boundSid, runs.find(r => r.id === selectedRunId)?.boundProjectPath ?? null, '綁定聊天室')}
                    title="重新登入聯動：在終端重新開啟綁定的聊天室（claude --resume）並自動掛起監看，約 10 秒後這裡會變成 ·通"
                    className="shrink-0 text-[10px] px-1.5 py-1 rounded border border-amber-400/50 text-amber-300 hover:bg-amber-400/10">🔁 重新登入聯動</button>
                )}
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
