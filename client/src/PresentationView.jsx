// ─── 互動式簡報演出（少爺 2026-07-21：回應風格濾鏡＋回放）────────────────────────
// assistant 回覆經 server /api/present LLM 轉譯成卡片流，這裡負責「演出」。
// 形態＝IG 限時動態 / Spotify Wrapped 式（少爺 2026-07-21 拍板）：一頁一卡、頂部分段進度條、
// 每頁依字量動態配時自動換頁、末頁停留不關；點左緣=上一頁/右緣=下一頁；⏸ 暫停/恢復（空白鍵）。
// PresentButton＝自含入口（CHAT 訊息列 / HISTORY 詳閱共用）；usePresentation＝可程式觸發（自動演出用）。
import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mdComponents } from './chatSupport.jsx'

const KIND_META = {
  point:  { icon: '◆', label: '重點', frame: 'border-[var(--gold-border)]', head: 'text-[var(--text-h)]' },
  action: { icon: '▶', label: '行動', frame: 'border-green-500/60',         head: 'text-green-300' },
  risk:   { icon: '⚠', label: '風險', frame: 'border-red-500/60',           head: 'text-red-300' },
  info:   { icon: '·', label: '補充', frame: 'border-[var(--border)]',       head: 'text-[var(--text-muted)]' },
  code:   { icon: '⌨', label: '程式', frame: 'border-sky-600/50',            head: 'text-sky-300' },
}
const FEEDBACK_TAGS = ['剛好', '太碎', '太密', '重點錯', '要更多細節']

/** 每頁自動換頁時長：依字量動態配時（中文閱讀速度），3~12 秒夾住；code 頁加權 */
function pageDurationMs(page) {
  let _chars = 0
  if (page.kind === 'verdict') _chars = page.body.length
  else if (page.kind === 'followups') _chars = page.list.join('').length
  else _chars = (page.s.heading ?? '').length + (page.s.body ?? '').length + (page.s.code ?? '').length * 1.5
  return Math.max(3000, Math.min(12000, 2000 + Math.round(_chars * 60)))
}

function PresentOverlay({ state, sessionId, onClose, onRegenerate }) {
  const { status, payload, raw, cached, msgHash, error } = state
  // 頁面：verdict → sections → followups（title 常駐 header）
  const pages = []
  if (payload?.verdict) pages.push({ kind: 'verdict', body: payload.verdict })
  for (const s of payload?.sections ?? []) pages.push({ kind: 'section', s })
  if (payload?.followups?.length) pages.push({ kind: 'followups', list: payload.followups })
  const total = pages.length

  const [page, setPage] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [barEpoch, setBarEpoch] = useState(0)   // 回到同一頁時重跑該頁進度條用
  const [showRaw, setShowRaw] = useState(false)
  const [fbSent, setFbSent] = useState(false)
  const [fbTags, setFbTags] = useState([])
  useEffect(() => { setPage(0); setPlaying(true); setShowRaw(false); setFbSent(false); setFbTags([]) }, [msgHash, status])

  const isLast = page >= total - 1
  const goNext = () => { setPage(p => Math.min(total - 1, p + 1)); setBarEpoch(e => e + 1) }
  const goPrev = () => { setPage(p => Math.max(0, p - 1)); setBarEpoch(e => e + 1) }

  // 鍵盤動線：空白=暫停/恢復、→/Enter=次頁、←=前頁、Esc=關閉
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (status !== 'ready') return
      if (e.key === ' ') { e.preventDefault(); setPlaying(v => !v) }
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, total])

  // 看原文＝停留久一點的一種 → 自動暫停（恢復由 ⏸/▶ 或空白鍵）
  useEffect(() => { if (showRaw) setPlaying(false) }, [showRaw])

  function toggleFbTag(t) { setFbTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]) }
  function sendFeedback(reaction) {
    setFbSent(true)
    fetch('/api/present/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId ?? null, msgHash, reaction, tags: fbTags }),
    }).catch(() => {})
  }

  const cur = pages[page]
  const dur = cur ? pageDurationMs(cur) : 0

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <style>{'@keyframes tcPresentFill { from { width: 0% } to { width: 100% } }'}</style>
      <div className="w-full max-w-2xl h-[86vh] max-h-[720px] flex flex-col rounded-lg border border-[var(--gold-border)] bg-[var(--surface)] shadow-2xl overflow-hidden">

        {/* 分段進度條（IG 式）：過去=滿、當前=依配時填滿（onAnimationEnd 換頁）、未來=空；末頁不倒數 */}
        {status === 'ready' && (
          <div className="shrink-0 flex gap-1 px-3 pt-2.5">
            {pages.map((_, i) => (
              <div key={i} className="flex-1 h-[3px] rounded-full bg-[var(--border)] overflow-hidden">
                {i < page && <div className="h-full w-full bg-[var(--gold)]" />}
                {i === page && (isLast
                  ? <div className="h-full w-full bg-[var(--gold)]" />
                  : <div key={`${page}-${barEpoch}`} onAnimationEnd={goNext}
                      className="h-full bg-[var(--gold)]"
                      style={{ animationName: 'tcPresentFill', animationDuration: `${dur}ms`, animationTimingFunction: 'linear', animationFillMode: 'forwards', animationPlayState: playing ? 'running' : 'paused' }} />)}
              </div>
            ))}
          </div>
        )}

        {/* Header */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2">
          <span className="text-sm">🎬</span>
          <span className="flex-1 text-[13px] text-[var(--text-h)] font-semibold truncate">
            {status === 'ready' ? (payload.title || '簡報') : status === 'loading' ? '轉譯中…' : '轉譯失敗'}
          </span>
          {status === 'ready' && (<>
            <span className="text-[9px] text-[var(--text-muted)] tabular-nums">{page + 1}/{total}</span>
            {cached && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]" title="這則之前轉譯過，直接回放快取">⚡</span>}
            {!isLast && (
              <button onClick={() => setPlaying(v => !v)} title={playing ? '暫停自動換頁（空白鍵）' : '恢復自動換頁（空白鍵）'}
                className={`text-[11px] px-2 py-0.5 rounded border ${playing ? 'border-[var(--border)] text-[var(--text-muted)]' : 'border-[var(--gold)] text-[var(--gold)] bg-[var(--gold)]/10'} hover:border-[var(--gold-border)] hover:text-[var(--gold)]`}>
                {playing ? '⏸' : '▶'}
              </button>
            )}
            <button onClick={onRegenerate} title="用目前設定重新轉譯這則"
              className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]">🔄</button>
          </>)}
          <button onClick={onClose} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] px-1">✕</button>
        </div>

        {/* Stage（一頁一卡；左緣=上一頁、右緣=下一頁，中間留給選字/捲動） */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center px-6 py-3 overflow-hidden">
          {status === 'loading' && (
            <div className="text-center text-[11px] text-[var(--text-muted)] animate-pulse">
              🎬 正在把這則回覆轉譯成簡報…（首次約 30~90 秒；同則之後回放走快取、秒開）
            </div>
          )}
          {status === 'error' && (
            <div className="text-center space-y-2">
              <div className="text-[11px] text-red-400">轉譯失敗：{error}</div>
              <button onClick={onRegenerate}
                className="text-[10px] px-3 py-1 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10">重試</button>
            </div>
          )}
          {status === 'ready' && cur && (
            <div key={page} className="w-full max-h-full overflow-y-auto tc-present-page">
              <style>{'.tc-present-page { animation: tcPresentIn .28s ease-out } @keyframes tcPresentIn { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }'}</style>
              {cur.kind === 'verdict' && (
                <div className="rounded-lg border-2 border-[var(--gold)]/70 bg-[var(--gold)]/10 px-5 py-6 text-center">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--gold)]/70 mb-2">結論</div>
                  <div className="text-lg leading-relaxed text-[var(--gold)] font-semibold">{cur.body}</div>
                </div>
              )}
              {cur.kind === 'followups' && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/50 px-5 py-5">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">下一步</div>
                  {cur.list.map((f, fi) => (
                    <div key={fi} className="text-[13px] text-[var(--text)] leading-relaxed py-0.5">→ {f}</div>
                  ))}
                </div>
              )}
              {cur.kind === 'section' && (() => {
                const meta = KIND_META[cur.s.kind] ?? KIND_META.point
                return (
                  <div className={`rounded-lg border ${meta.frame} bg-[var(--surface-2)]/40 px-5 py-5`}>
                    <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">{meta.icon} {meta.label}</div>
                    <div className={`text-[15px] font-semibold ${meta.head} leading-snug`}>{cur.s.heading}</div>
                    {cur.s.body && <div className="mt-2 text-[13px] leading-relaxed text-[var(--text)]">{cur.s.body}</div>}
                    {cur.s.code && (
                      <pre className="mt-3 text-[11px] text-sky-300/80 bg-black/40 rounded p-2.5 overflow-x-auto text-left">{cur.s.code}</pre>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
          {/* 邊緣點擊區（IG 式）：只佔左右 22%，中間留給文字選取與捲動 */}
          {status === 'ready' && (<>
            {page > 0 && (
              <div className="absolute inset-y-0 left-0 w-[22%] cursor-pointer group flex items-center justify-start pl-2"
                onClick={goPrev} title="上一頁（←）">
                <span className="text-[var(--text-muted)] opacity-0 group-hover:opacity-60 text-lg select-none">‹</span>
              </div>
            )}
            {!isLast && (
              <div className="absolute inset-y-0 right-0 w-[22%] cursor-pointer group flex items-center justify-end pr-2"
                onClick={goNext} title="下一頁（→）">
                <span className="text-[var(--text-muted)] opacity-0 group-hover:opacity-60 text-lg select-none">›</span>
              </div>
            )}
          </>)}
        </div>

        {/* Footer：原文 + 回饋（回饋在末頁出現） */}
        {status === 'ready' && (
          <div className="shrink-0 border-t border-[var(--border)]">
            <div className="flex items-center gap-2 px-4 py-2">
              <button onClick={() => setShowRaw(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded border ${showRaw ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'} hover:border-[var(--gold-border)]`}
                title="展開原文（會暫停自動換頁）">
                📄 原文
              </button>
              <div className="flex-1" />
              {isLast && !fbSent && (<>
                {FEEDBACK_TAGS.map(t => (
                  <button key={t} onClick={() => toggleFbTag(t)}
                    className={`text-[9px] px-1.5 py-0.5 rounded-full border ${fbTags.includes(t) ? 'border-[var(--gold)] text-[var(--gold)] bg-[var(--gold)]/10' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>{t}</button>
                ))}
                <button onClick={() => sendFeedback('up')} title="這個簡報有幫助（會用來優化之後的轉譯）" className="text-[13px] hover:scale-110 transition-transform">👍</button>
                <button onClick={() => sendFeedback('down')} title="不好（會用來優化之後的轉譯）" className="text-[13px] hover:scale-110 transition-transform">👎</button>
              </>)}
              {fbSent && <span className="text-[9px] text-green-400">✓ 已回饋，之後的轉譯會參考</span>}
            </div>
            {showRaw && (
              <div className="max-h-56 overflow-y-auto px-4 pb-3 border-t border-[var(--border)]/50">
                <div className="md-body text-[11px] text-[var(--text-muted)] pt-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{raw || ''}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 可程式觸發的演出（ChatPanel 自動演出用）；回傳 present(text) 與 overlay 節點 */
export function usePresentation(sessionId) {
  const [state, setState] = useState(null)
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId

  async function present(text, { force = false } = {}) {
    setState({ status: 'loading', raw: text })
    try {
      const d = await fetch('/api/present', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sidRef.current ?? null, text, force }),
      }).then(r => r.json())
      if (!d.ok) { setState({ status: 'error', raw: text, error: d.error ?? '轉譯失敗' }); return }
      setState({ status: 'ready', raw: text, payload: d.payload, cached: d.cached, msgHash: d.msgHash })
    } catch (e) {
      setState({ status: 'error', raw: text, error: e.message })
    }
  }

  const overlay = state ? (
    <PresentOverlay state={state} sessionId={sidRef.current}
      onClose={() => setState(null)}
      onRegenerate={() => present(state.raw, { force: true })} />
  ) : null
  return { present, overlay }
}

/** 自含入口：🎬 按鈕＋overlay（CHAT 訊息列 / HISTORY 詳閱共用） */
export function PresentButton({ sessionId, text }) {
  const { present, overlay } = usePresentation(sessionId)
  if (!text?.trim()) return null
  return (<>
    <button onClick={() => present(text)} title="演出 — 以互動簡報回放這則回覆"
      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)] hover:text-[var(--gold)] transition-colors opacity-50 hover:opacity-100 select-none">
      🎬
    </button>
    {overlay}
  </>)
}
