// AutoQA Monitor — 少爺的 QA 可視化介面
// 對應 RomanPrototype/.agent/knowledge/UE5.8_QAToolsets_Plan.md §5.7（Phase M-2）
// A 計畫區（目的+方法）/ B 即時區（進度+截圖+異常）/ C 歷史區 + 留言雙向
// ws 更新走 window 'tc-qa-run-update' 自訂事件（App.jsx handleServerMessage 一行轉發，不侵入既有結構）
import { useState, useEffect, useRef, useCallback } from 'react'

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

export function QAMonitorPanel({ selectedSessionId = null }) {
  const [runs, setRuns] = useState([])
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [commentText, setCommentText] = useState('')
  const [commentItemId, setCommentItemId] = useState('')
  const [lightbox, setLightbox] = useState(null)   // artifact url 放大檢視
  const selectedRunIdRef = useRef(null)
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])

  const reload = useCallback(() => {
    fetch('/api/qa/runs?limit=100').then(r => r.json()).then(d => {
      const list = d.runs ?? []
      setRuns(list)
      // 預設選最新的「進行中」run；沒有就選最新一筆
      if (!selectedRunIdRef.current) {
        const live = list.find(r => ['announced', 'countdown', 'running', 'paused'].includes(r.status))
        setSelectedRunId((live ?? list[0])?.id ?? null)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => { reload() }, [reload])

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

  // 倒數 tick（250ms 精度）
  useEffect(() => {
    if (run?.status !== 'countdown') return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [run?.status])

  async function control(action, extra = {}) {
    if (!run) return
    await fetch(`/api/qa/runs/${run.id}/control`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    }).catch(() => {})
  }

  async function sendComment() {
    const text = commentText.trim()
    if (!text) return
    await control('comment', { text, itemId: commentItemId ? Number(commentItemId) : null })
    setCommentText('')
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
          QA Runs（永久保留）
        </div>
        {runs.length === 0 && (
          <div className="px-3 py-4 text-[10px] text-[var(--text-muted)] text-center">尚無 QA run</div>
        )}
        {runs.filter(r => !r.archivedAt).map(r => (
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
                    <button onClick={() => control('start-now')}
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
                    onClick={() => { if (confirm('結案這輪 QA？Claude 會收到通知並移除為驗證埋的 LOG（第五階段）')) control('close') }}
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
              <div className="flex gap-2 mt-1">
                <input value={commentItemId} onChange={e => setCommentItemId(e.target.value)}
                  placeholder="項目#" className="w-14 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px]" />
                <input value={commentText} onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendComment() }}
                  placeholder="對這輪 QA 留言…（Enter 送出）"
                  className="flex-1 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px]" />
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
