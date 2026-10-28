import { useState, useEffect, useCallback } from 'react'

// ─── ⏸ 用量中斷（少爺 2026-10-10）─────────────────────────────────────────────
// Token 用完使聊天室中斷時，TC 自動記下哪個聊天室斷了、何時重設；自動續接預設關（主帳號有他人共用），
// 關著時到點只通知，在這裡按「立即續接」把該聊天室接回原處。開關與用量護欄在 ⚙ 總設定「用量中斷」。
// 資料：GET /api/usage/interrupts；動作：POST /api/usage/interrupts/:sid/{resume|dismiss|exclude}
// 第二階段（少爺 2026-10-10）：上方「帳號」區＝保管庫裡的帳號；自動換帳號開著時，目前帳號撞上限就換到沒冷卻的帳號、同一聊天室直接續接。
// 資料：GET /api/accounts；動作：POST /api/accounts/{import-current|login|:uuid/switch|:uuid/disable|:uuid/clear-cooling}、DELETE /api/accounts/:uuid

const STATUS_META = {
  waiting:             { label: '等重設',       cls: 'text-amber-400 border-amber-500/40' },
  resumed:             { label: '已續接',       cls: 'text-green-400 border-green-500/40' },
  stalled:             { label: '送達但沒動',   cls: 'text-red-400 border-red-500/40' },
  resolved:            { label: '已自行接上',   cls: 'text-green-400 border-green-500/40' },
  dismissed:           { label: '已略過',       cls: 'text-[var(--text-muted)] border-[var(--border)]' },
  account_unavailable: { label: '帳號不可用',   cls: 'text-red-400 border-red-500/40' },
}

const NOTICE_TEXT = {
  notify_off:           '已到點：自動續接關閉中，可按立即續接',
  notify_excluded:      '已到點：此聊天室已排除自動續接',
  notify_weekly:        '已到點：週上限只通知（週額度共用）',
  notify_undeliverable: '已到點：分頁開著但投不進去，請到該分頁輸入「繼續」',
  hold_quiet:           '已到點：位於不自動續接時段，時段結束後才續接',
  notify_stalled:       '續接訊息已送達，但聊天室 2 分鐘內沒有任何回覆——多半是被 Claude Code 的「等重設再繼續」扣住了，請到該分頁輸入「繼續」（或重開該分頁後按立即續接）',
}

const KIND_TEXT = {
  usage_limit:         '用量上限',
  account_unavailable: '帳號／帳務問題',
  transient:           '伺服器暫時忙碌',
}

const ACCOUNT_STATUS = {
  available: { label: '可用',       cls: 'text-green-400 border-green-500/40' },
  cooling:   { label: '冷卻中',     cls: 'text-amber-400 border-amber-500/40' },
  disabled:  { label: '停用',       cls: 'text-red-400 border-red-500/40' },
  expired:   { label: '登入過期',   cls: 'text-red-400 border-red-500/40' },
  unusable:  { label: '訂閱不可用', cls: 'text-red-400 border-red-500/40' },
}

const LOGIN_STATUS = {
  waiting_browser: '等您在瀏覽器登入…',
  done:            '✅ 已加入',
  failed:          '❌ 登入失敗',
  cancelled:       '已取消',
}

async function postJson(InUrl, InBody, InMethod = 'POST') {
  return fetch(InUrl, { method: InMethod, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(InBody ?? {}) }).then(x => x.json())
}

function accountLabel(InAccount) { return InAccount.email ?? InAccount.displayName ?? InAccount.accountUuid?.slice(0, 8) }

function accountLabelOf(InAccounts, InUuid) {
  const _a = (InAccounts?.accounts ?? []).find(x => x.accountUuid === InUuid)
  return _a ? accountLabel(_a) : InUuid.slice(0, 8)
}

/** 帳號區：保管庫裡的帳號、目前使用中的是哪個、加入／切換／停用 */
function AccountsSection({ accounts, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [job, setJob] = useState(null)
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!job || job.status !== 'waiting_browser') return
    const t = setInterval(() => {
      fetch(`/api/accounts/login/${job.id}`).then(r => r.json()).then(d => {
        if (d?.job) { setJob(d.job); if (d.job.status !== 'waiting_browser') onChanged() }
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [job, onChanged])

  const run = async (key, fn) => {
    setBusy(key); setErr(null)
    try { const r = await fn(); if (r && r.ok === false) setErr(r.error ?? '動作失敗') } catch (e) { setErr(String(e)) }
    setBusy(null)
    onChanged()
  }

  const startLogin = () => run('login', async () => {
    const r = await postJson('/api/accounts/login')
    if (r?.job) { setJob(r.job); setCode('') }
    return r
  })

  const s = accounts?.settings

  return (
    <div className="mb-3 rounded border border-[var(--border)] p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-[var(--gold)]">帳號</span>
        <span className="text-[9px] text-[var(--text-muted)]">
          自動換帳號：<span className={s?.enabled ? 'text-green-400' : 'text-amber-400'}>{s ? (s.enabled ? '開（目前帳號撞上限就換到沒冷卻的帳號，並直接續接）' : '關（開關在 ⚙ 總設定「用量中斷」）') : '…'}</span>
        </span>
      </div>
      {err && <div className="text-[10px] text-red-400 mb-1">⚠️ {err}</div>}
      {accounts && !accounts.liveInVault && (
        <div className="text-[9px] text-amber-400 mb-1 flex items-center gap-2">
          目前 VS Code 登入的帳號還沒收進保管庫。
          <button onClick={() => run('import', () => postJson('/api/accounts/import-current'))} disabled={!!busy}
            className="px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
            {busy === 'import' ? '匯入中…' : '匯入目前登入的帳號'}
          </button>
        </div>
      )}
      {(accounts?.accounts ?? []).map(x => {
        const st = ACCOUNT_STATUS[x.status] ?? ACCOUNT_STATUS.available
        return (
          <div key={x.accountUuid} className="flex items-center gap-2 py-1 border-t border-[var(--border)] first:border-t-0">
            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
            <span className="text-[11px] text-[var(--text)] truncate flex-1" title={x.disabledReason ?? x.accountUuid}>
              {x.active && <span className="text-[var(--gold)]">● 使用中 </span>}{accountLabel(x)}
              <span className="text-[9px] text-[var(--text-muted)]"> · {x.subscriptionType ?? '?'}{x.status === 'cooling' ? ` · 重設 ${fmtWhen(x.coolingUntil)}${x.coolingWeekly ? '（週）' : ''}` : ''}{x.disabled ? ` · ${x.disabledReason ?? ''}` : ''}</span>
            </span>
            {!x.active && x.status !== 'disabled' && x.status !== 'expired' && (
              <button onClick={() => run(`sw:${x.accountUuid}`, () => postJson(`/api/accounts/${x.accountUuid}/switch`))} disabled={!!busy}
                className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
                {busy === `sw:${x.accountUuid}` ? '切換中…' : '切換到此帳號'}
              </button>
            )}
            {x.status === 'cooling' && (
              <button onClick={() => run(`cc:${x.accountUuid}`, () => postJson(`/api/accounts/${x.accountUuid}/clear-cooling`))} disabled={!!busy}
                className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50">清除冷卻</button>
            )}
            <button onClick={() => run(`dis:${x.accountUuid}`, () => postJson(`/api/accounts/${x.accountUuid}/disable`, { disabled: !x.disabled }))} disabled={!!busy}
              className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50">
              {x.disabled ? '啟用' : '停用'}
            </button>
            {!x.active && (
              <button onClick={() => { if (window.confirm(`從保管庫移除 ${accountLabel(x)}？之後要用得重新加入。`)) run(`rm:${x.accountUuid}`, () => postJson(`/api/accounts/${x.accountUuid}`, null, 'DELETE')) }} disabled={!!busy}
                className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 disabled:opacity-50">移除</button>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2 mt-1.5">
        <button onClick={startLogin} disabled={!!busy || job?.status === 'waiting_browser'}
          className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
          ＋ 加入帳號（開瀏覽器登入）
        </button>
        {job && <span className="text-[9px] text-[var(--text-muted)]">{LOGIN_STATUS[job.status] ?? job.status}{job.error ? `：${job.error}` : ''}</span>}
        {job?.status === 'waiting_browser' && (
          <button onClick={() => run('cancel', async () => { const r = await postJson(`/api/accounts/login/${job.id}/cancel`); setJob(j => ({ ...j, status: 'cancelled' })); return r })}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">取消</button>
        )}
      </div>
      {job?.status === 'waiting_browser' && (
        <div className="text-[9px] text-[var(--text-muted)] mt-1 leading-relaxed">
          {job.url
            ? <>瀏覽器應已自動開啟登入頁；沒開的話<a href={job.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">點這裡登入</a>。請登入「要加入的那個帳號」（瀏覽器若已登入別的帳號，先在頁面上切換）。</>
            : '正在啟動登入…'}
          <div className="flex items-center gap-1 mt-1">
            登入後頁面若顯示授權碼，貼在這裡：
            <input value={code} onChange={e => setCode(e.target.value)} className="flex-1 text-[10px] px-1 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--text)]" />
            <button onClick={() => run('code', () => postJson(`/api/accounts/login/${job.id}/code`, { code }))} disabled={!code.trim() || !!busy}
              className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] disabled:opacity-50">送出</button>
          </div>
        </div>
      )}
      <div className="text-[9px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
        換帳號是全部聊天室一起換、分頁不必重開。加入後要換帳號請用這裡的「切換到此帳號」，不要再用 VS Code 的 Switch Account——它會登出原帳號，保管的那份登入就失效、要重新加入。
      </div>
    </div>
  )
}

/** OpenAI 帳號區（少爺 2026-10-25「AI只是驅動的燃料」）：聊天室外包給 GPT 時用「使用中」的那個帳號；不影響 Claude 聊天室的帳號 */
function OpenaiAccountsSection({ openai, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [job, setJob] = useState(null)

  useEffect(() => {
    if (!job || job.status !== 'waiting_browser') return
    const t = setInterval(() => {
      fetch(`/api/openai/accounts/login/${job.id}`).then(r => r.json()).then(d => {
        if (d?.job) { setJob(d.job); if (d.job.status !== 'waiting_browser') onChanged() }
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [job, onChanged])

  const run = async (key, fn) => {
    setBusy(key); setErr(null)
    try { const r = await fn(); if (r && r.ok === false) setErr(r.error ?? '動作失敗') } catch (e) { setErr(String(e)) }
    setBusy(null)
    onChanged()
  }

  const startLogin = () => run('login', async () => {
    const r = await postJson('/api/openai/accounts/login')
    if (r?.job) setJob(r.job)
    return r
  })

  return (
    <div className="mb-3 rounded border border-[var(--border)] p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-[var(--gold)]">OpenAI 帳號（外包用）</span>
        <span className="text-[9px] text-[var(--text-muted)]">
          Codex：<span className={openai?.codexFound ? 'text-green-400' : 'text-amber-400'}>{openai ? (openai.codexFound ? '已找到' : '找不到（請安裝 Codex App）') : '…'}</span>
        </span>
      </div>
      {err && <div className="text-[10px] text-red-400 mb-1">⚠️ {err}</div>}
      {openai && !openai.currentLoginInVault && (
        <div className="text-[9px] text-amber-400 mb-1 flex items-center gap-2">
          這台電腦的 Codex 已登入、但還沒登記到 TC。
          <button onClick={() => run('import', () => postJson('/api/openai/accounts/import-current'))} disabled={!!busy}
            className="px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
            {busy === 'import' ? '登記中…' : '登記目前的 Codex 登入'}
          </button>
        </div>
      )}
      {(openai?.accounts ?? []).map(x => {
        const st = ACCOUNT_STATUS[x.status] ?? ACCOUNT_STATUS.available
        return (
          <div key={x.accountId} className="flex items-center gap-2 py-1 border-t border-[var(--border)] first:border-t-0">
            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
            <span className="text-[11px] text-[var(--text)] truncate flex-1" title={x.accountId}>
              {x.active && <span className="text-[var(--gold)]">● 使用中 </span>}{x.email ?? x.accountId.slice(0, 8)}
              <span className="text-[9px] text-[var(--text-muted)]"> · {x.plan ?? '?'}{x.shared ? ' · 與 Codex App 共用登入' : ''}{x.lastUsedAt ? ` · 上次外包 ${fmtWhen(x.lastUsedAt)}` : ''}</span>
            </span>
            {!x.active && x.status === 'available' && (
              <button onClick={() => run(`act:${x.accountId}`, () => postJson(`/api/openai/accounts/${x.accountId}/activate`))} disabled={!!busy}
                className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">設為使用中</button>
            )}
            <button onClick={() => run(`dis:${x.accountId}`, () => postJson(`/api/openai/accounts/${x.accountId}/disable`, { disabled: !x.disabled }))} disabled={!!busy}
              className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50">
              {x.disabled ? '啟用' : '停用'}
            </button>
            <button onClick={() => { if (window.confirm(`從 TC 移除 ${x.email ?? x.accountId}？${x.shared ? '（只取消登記，Codex App 的登入不受影響）' : '之後要用得重新加入。'}`)) run(`rm:${x.accountId}`, () => postJson(`/api/openai/accounts/${x.accountId}`, null, 'DELETE')) }} disabled={!!busy}
              className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 disabled:opacity-50">移除</button>
          </div>
        )
      })}
      <div className="flex items-center gap-2 mt-1.5">
        <button onClick={startLogin} disabled={!!busy || job?.status === 'waiting_browser' || !openai?.codexFound}
          className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
          ＋ 加入 OpenAI 帳號（開瀏覽器登入）
        </button>
        {job && <span className="text-[9px] text-[var(--text-muted)]">{LOGIN_STATUS[job.status] ?? job.status}{job.error ? `：${job.error}` : ''}</span>}
        {job?.status === 'waiting_browser' && (
          <button onClick={() => run('cancel', async () => { const r = await postJson(`/api/openai/accounts/login/${job.id}/cancel`); setJob(j => ({ ...j, status: 'cancelled' })); return r })}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">取消</button>
        )}
      </div>
      {job?.status === 'waiting_browser' && job.url && (
        <div className="text-[9px] text-[var(--text-muted)] mt-1">瀏覽器應已開啟 ChatGPT 登入頁；沒開的話<a href={job.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">點這裡登入</a>。</div>
      )}
      <div className="text-[9px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
        聊天室要「外包給 GPT」時用使用中的帳號（工具 <code>Invoke-Outsource.py</code>）：GPT 親手產出成品（例如視覺），Claude 驗收後在專案裡實作。這裡換帳號不影響 Claude 聊天室。
      </div>
    </div>
  )
}

function fmtWhen(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1)
  if (d.toDateString() === tmr.toDateString()) return `明天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function fmtCountdown(ts) {
  const ms = (ts ?? 0) - Date.now()
  if (ms <= 0) return '已到點'
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分後` : `${m} 分後`
}

/** 頂列按鈕上的待處理數（等重設＋帳號不可用） */
export function useUsageInterruptCount() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/usage/interrupts').then(r => r.json())
      .then(d => { if (alive) setCount((d?.records ?? []).filter(r => r.status === 'waiting' || r.status === 'stalled' || r.status === 'account_unavailable').length) })
      .catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return count
}

export default function UsageInterruptPanel({ onClose }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const [showDone, setShowDone] = useState(false)

  const [accounts, setAccounts] = useState(null)
  const [openai, setOpenai] = useState(null)

  const load = useCallback(() => {
    fetch('/api/usage/interrupts').then(r => r.json()).then(setData).catch(e => setErr(String(e)))
    fetch('/api/accounts').then(r => r.json()).then(setAccounts).catch(() => {})
    fetch('/api/openai/accounts').then(r => r.json()).then(setOpenai).catch(() => {})
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

  const act = async (sid, action, body) => {
    setBusy(`${sid}:${action}`); setErr(null)
    try {
      const r = await fetch(`/api/usage/interrupts/${sid}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
      }).then(x => x.json())
      if (!r.ok) setErr(r.error ?? '動作失敗')
    } catch (e) { setErr(String(e)) }
    setBusy(null)
    load()
  }

  const records = (data?.records ?? []).filter(r => showDone || r.status === 'waiting' || r.status === 'stalled' || r.status === 'account_unavailable')
  const s = data?.settings

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="w-[620px] max-w-[94vw] max-h-[82vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">⏸ 用量中斷 · Usage Interrupts</span>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs">✕</button>
        </div>
        <div className="text-[9px] text-[var(--text-muted)] mb-3 leading-relaxed">
          自動續接：<span className={s?.enabled ? 'text-green-400' : 'text-amber-400'}>{s ? (s.enabled ? `開（每批 ${s.maxPerBatch} 室、間隔 ${s.batchGapSec} 秒${s.weeklyLimitAutoResume ? '' : '、週上限只通知'}${s.quietStart && s.quietEnd ? `、${s.quietStart}–${s.quietEnd} 不自動` : ''}）` : '關（只通知）') : '…'}</span>
          ；開關在 ⚙ 總設定「用量中斷」。偵測與記錄永遠開著、不花用量。
        </div>
        <AccountsSection accounts={accounts} onChanged={load} />
        <OpenaiAccountsSection openai={openai} onChanged={load} />
        <label className="flex items-center gap-1 text-[9px] text-[var(--text-muted)] mb-2">
          <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> 顯示已處理的紀錄
        </label>
        {err && <div className="text-[10px] text-red-400 mb-2">⚠️ {err}</div>}
        {data === null ? (
          <div className="text-[10px] text-[var(--text-muted)]">載入中…</div>
        ) : records.length === 0 ? (
          <div className="text-[10px] text-[var(--text-muted)]">目前沒有被用量中斷的聊天室。</div>
        ) : records.map(r => {
          const st = STATUS_META[r.status] ?? STATUS_META.waiting
          return (
            <div key={r.sessionId} className="mb-2 rounded border border-[var(--border)] p-2">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[9px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                <span className="text-[11px] text-[var(--text)] truncate flex-1" title={r.sessionId}>{r.title ?? r.name ?? '（未命名聊天室）'}</span>
                <span className="text-[9px] text-[var(--text-muted)]">{KIND_TEXT[r.kind] ?? r.kind}{r.weekly ? '（週）' : ''}</span>
              </div>
              <div className="text-[9px] text-[var(--text-muted)] leading-relaxed">
                中斷 {fmtWhen(r.interruptedAt)} · 重設 {fmtWhen(r.resetAt)}{r.estimated ? '（估計）' : ''}
                {r.status === 'waiting' && <> · <span className="text-[var(--gold)]">{fmtCountdown(r.resetAt)}</span></>}
                {r.cwd && <> · {String(r.cwd).split(/[\\/]/).pop()}</>}
                {r.accountUuid && <> · 帳號 {accountLabelOf(accounts, r.accountUuid)}</>}
              </div>
              {(r.status === 'waiting' || r.status === 'stalled') && r.notified && NOTICE_TEXT[r.notified] && (
                <div className="text-[9px] text-amber-400 mt-1">{NOTICE_TEXT[r.notified]}</div>
              )}
              {r.status === 'account_unavailable' && (
                <div className="text-[9px] text-red-400 mt-1">帳號或帳務異常（{r.error ?? '未知'}），不會自動續接；請先處理帳號：{r.text}</div>
              )}
              {r.history?.length > 0 && (
                <div className="text-[9px] text-[var(--text-muted)] mt-1">最近處理：{fmtWhen(r.history.at(-1).at)} {r.history.at(-1).reason === 'auto_switch' ? '換帳號後自動' : r.history.at(-1).reason === 'auto' ? '自動' : '手動'}{r.history.at(-1).ok ? '續接成功' : `失敗：${r.history.at(-1).error ?? ''}`}</div>
              )}
              {(r.status === 'waiting' || r.status === 'stalled') && (
                <div className="flex items-center gap-2 mt-1.5">
                  <button onClick={() => act(r.sessionId, 'resume')} disabled={!!busy}
                    className="text-[9px] px-2 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50">
                    {busy === `${r.sessionId}:resume` ? '續接中…' : '▶ 立即續接'}
                  </button>
                  <button onClick={() => act(r.sessionId, 'exclude', { excluded: !r.excluded })} disabled={!!busy}
                    className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50">
                    {r.excluded ? '恢復自動續接' : '排除自動續接'}
                  </button>
                  <button onClick={() => act(r.sessionId, 'dismiss')} disabled={!!busy}
                    className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50">
                    略過
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
