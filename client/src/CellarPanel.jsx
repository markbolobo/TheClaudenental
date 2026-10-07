import { useState, useEffect } from 'react'
import QuietToggle, { QUIET_HINT } from './QuietToggle'

// ─── Cellar（酒窖）工具箱彈跳視窗（少爺 2026-08-06）──────────────────────────────
// 延續 TheClaudenental／侍酒師的酒主題：酒窖＝開發工具的私藏。
// 酒窖＝純 launcher：一律 execute 點擊即執行（POST /api/tools/run/:id）；
// 工具介面歸工具自己（如 UE_AnimToolkit 的 UE 內 GUI），酒窖不做各工具的表單。

const KIND_META = {
  execute: { icon: '▶', label: '點擊執行', cls: 'text-green-400 border-green-500/40' },
  // 喚 Claude 型（少爺 2026-08-14）：點一下喚子進程跑固定流程，結果回聊天室／各自的面板
  claude: { icon: '🤖', label: '喚 Claude', cls: 'text-[var(--gold)] border-[var(--gold)]/40' },
}

export default function CellarPanel({ onClose }) {
  const [tools, setTools] = useState(null)
  const [err, setErr] = useState(null)
  const [hint, setHint] = useState('')

  useEffect(() => {
    fetch('/api/tools').then(r => r.json()).then(d => {
      if (d.ok) setTools(d.tools ?? [])
      else setErr(d.error ?? '載入失敗')
    }).catch(e => setErr(String(e)))
  }, [])

  const runTool = async (t) => {
    setHint(`執行「${t.name}」…`)
    const _res = await fetch(`/api/tools/run/${t.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setHint(_res.ok ? `✅ 已執行：${_res.ran}` : `⚠️ ${_res.error ?? '執行失敗'}`)
  }

  // 勿擾逐項設定；與誓約共用的工具會連帶改那個誓約的排程（server 回讀驗證後才回 ok）
  const [quietBusy, setQuietBusy] = useState(null)
  const toggleQuiet = async (t, InQuiet) => {
    setQuietBusy(t.id)
    const _res = await fetch('/api/tools/quiet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, quiet: InQuiet }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setQuietBusy(null)
    if (_res.ok) setTools(_prev => _prev.map(x => x.id === t.id ? { ...x, quiet: _res.quiet } : x))
    setHint(_res.ok ? `${_res.quiet ? '🔕 已開啟' : '🔔 已關閉'}勿擾：${t.name}` : `⚠️ 勿擾設定失敗：${_res.error ?? '未知原因'}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[520px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>

        <div className="px-4 py-3 border-b border-[var(--border)] flex items-start justify-between">
          <div>
            <div className="text-[var(--gold)] text-sm tracking-widest uppercase">🍷 Cellar · 酒窖</div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5">開發工具的私藏——點擊啟動，工具介面歸工具自己；🔕 勿擾＝執行時不跳主控台視窗（逐項設定）</div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--gold)] text-lg leading-none shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {!tools && !err && <div className="text-[10px] text-[var(--text-muted)] text-center py-8">載入中…</div>}
          {err && <div className="text-[10px] text-red-400 text-center py-8">⚠️ {err}</div>}
          {tools?.length === 0 && <div className="text-[10px] text-[var(--text-muted)] text-center py-8">酒窖尚無工具</div>}
          {tools?.map(t => {
            const km = KIND_META[t.kind] ?? { icon: '•', label: t.kind, cls: 'text-[var(--text-muted)] border-[var(--border)]' }
            return (
              <div key={t.id} className="flex items-start gap-2 border border-[var(--border)] rounded p-2.5 hover:border-[var(--gold-border)] transition-colors">
                <button onClick={() => runTool(t)} className="flex-1 min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${km.cls}`}>{km.icon} {km.label}</span>
                    <span className="text-[12px] text-[var(--text)] flex-1">{t.name}</span>
                  </div>
                  {t.desc && <div className="text-[9px] text-[var(--text-muted)] mt-1">{t.desc}</div>}
                </button>
                <QuietToggle on={!!t.quiet} busy={quietBusy === t.id} onToggle={(v) => toggleQuiet(t, v)}
                  title={t.quietMarkerId ? `${QUIET_HINT}\n跑的是誓約排程，與 Marker 同一個設定（改哪邊都一樣）` : QUIET_HINT} />
              </div>
            )
          })}
        </div>

        {hint && <div className="px-4 py-2 border-t border-[var(--border)] text-[9px] text-[var(--text-muted)] font-mono truncate">{hint}</div>}
      </div>
    </div>
  )
}
