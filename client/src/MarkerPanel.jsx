import { useState, useEffect } from 'react'

// ─── Marker（誓約）彈跳視窗（少爺 2026-08-06）───────────────────────────────────
// 列出「你委託 Claude 定期履行的任務」＝ TC server 內建定時 ＋ Windows 排程（GET /api/markers）。
// John Wick 世界觀：Marker＝立下就必須履行的誓約，時候到了自己會執行。

const SOURCE_META = {
  'TC 內建':      { icon: '⧗', cls: 'text-blue-400 border-blue-500/40' },
  'Windows 排程': { icon: '🗓', cls: 'text-purple-400 border-purple-500/40' },
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1)
  if (d.toDateString() === tmr.toDateString()) return `明天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

export default function MarkerPanel({ onClose }) {
  const [markers, setMarkers] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetch('/api/markers').then(r => r.json()).then(d => {
      if (d.ok) setMarkers(d.markers ?? [])
      else setErr(d.error ?? '載入失敗')
    }).catch(e => setErr(String(e)))
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[560px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>

        {/* 標題列 */}
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-start justify-between">
          <div>
            <div className="text-[var(--gold)] text-sm tracking-widest uppercase">⧗ Marker · 誓約</div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5">你委託 Claude 定期履行的任務——時候到了，它們自己會執行</div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--gold)] text-lg leading-none shrink-0">✕</button>
        </div>

        {/* 誓約清單 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {!markers && !err && <div className="text-[10px] text-[var(--text-muted)] text-center py-8">載入中…</div>}
          {err && <div className="text-[10px] text-red-400 text-center py-8">⚠️ {err}</div>}
          {markers?.length === 0 && <div className="text-[10px] text-[var(--text-muted)] text-center py-8">尚無定時任務</div>}
          {markers?.map((m, i) => {
            const sm = SOURCE_META[m.source] ?? { icon: '•', cls: 'text-[var(--text-muted)] border-[var(--border)]' }
            const failed = m.lastResult != null && m.lastResult !== 0
            return (
              <div key={i} className="border border-[var(--border)] rounded p-2.5 hover:border-[var(--gold-border)] transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${sm.cls}`}>{sm.icon} {m.source}</span>
                  <span className="text-[12px] text-[var(--text)] flex-1 truncate">{m.name}</span>
                  <span className={`text-[9px] shrink-0 ${m.state === 'Disabled' ? 'text-[var(--text-muted)]' : 'text-green-400'}`}>{m.state}</span>
                </div>
                {m.desc && <div className="text-[9px] text-[var(--text-muted)] mt-1">{m.desc}</div>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-[9px]">
                  <span className="text-[var(--gold)]/80">🕒 {m.schedule}</span>
                  <span className="text-[var(--text-muted)]">上次 {fmtTime(m.lastRun)}{failed && <span className="text-red-400"> ✕ 失敗</span>}</span>
                  <span className="text-[var(--text-muted)]">下次 {fmtTime(m.nextRun)}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* 頁尾說明 */}
        <div className="px-4 py-2 border-t border-[var(--border)] text-[8px] text-[var(--text-muted)]">
          來源：TC server 內建定時 ＋ Windows 排程（名稱含 Claude／Roman）。未來新增同類任務會自動出現。
        </div>
      </div>
    </div>
  )
}
