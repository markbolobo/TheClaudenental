import { useState, useEffect } from 'react'

// ─── Cellar（酒窖）工具箱彈跳視窗（少爺 2026-08-06）──────────────────────────────
// 延續 TheClaudenental／侍酒師的酒主題：酒窖＝開發工具的私藏。
// 酒窖＝純 launcher：一律 execute 點擊即執行（POST /api/tools/run/:id）；
// 工具介面歸工具自己（如 UE_AnimToolkit 的 UE 內 GUI），酒窖不做各工具的表單。

const KIND_META = {
  execute: { icon: '▶', label: '點擊執行', cls: 'text-green-400 border-green-500/40' },
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[520px] max-w-[92vw] max-h-[80vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>

        <div className="px-4 py-3 border-b border-[var(--border)] flex items-start justify-between">
          <div>
            <div className="text-[var(--gold)] text-sm tracking-widest uppercase">🍷 Cellar · 酒窖</div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5">開發工具的私藏——點擊啟動，工具介面歸工具自己</div>
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
              <button key={t.id} onClick={() => runTool(t)}
                className="w-full text-left border border-[var(--border)] rounded p-2.5 hover:border-[var(--gold-border)] transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${km.cls}`}>{km.icon} {km.label}</span>
                  <span className="text-[12px] text-[var(--text)] flex-1">{t.name}</span>
                </div>
                {t.desc && <div className="text-[9px] text-[var(--text-muted)] mt-1">{t.desc}</div>}
              </button>
            )
          })}
        </div>

        {hint && <div className="px-4 py-2 border-t border-[var(--border)] text-[9px] text-[var(--text-muted)] font-mono truncate">{hint}</div>}
      </div>
    </div>
  )
}
