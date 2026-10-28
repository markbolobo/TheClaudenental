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
  const [shelves, setShelves] = useState([])
  // 層架收合（少爺 2026-10-22 層架收納）：記住展開過的層架；預設全部收起
  const [openShelves, setOpenShelves] = useState(() => { try { return JSON.parse(localStorage.getItem('tc_cellar_open_shelves') ?? '[]') } catch { return [] } })
  const toggleShelf = (InId) => setOpenShelves(_prev => {
    const _next = _prev.includes(InId) ? _prev.filter(x => x !== InId) : [..._prev, InId]
    try { localStorage.setItem('tc_cellar_open_shelves', JSON.stringify(_next)) } catch { /* 無痕視窗 */ }
    return _next
  })
  const [err, setErr] = useState(null)
  const [hint, setHint] = useState('')

  useEffect(() => {
    fetch('/api/tools').then(r => r.json()).then(d => {
      if (d.ok) { setTools(d.tools ?? []); setShelves(d.shelves ?? []) }
      else setErr(d.error ?? '載入失敗')
    }).catch(e => setErr(String(e)))
  }, [])

  // 帶輸入型工具（少爺 2026-10-23 遊戲機制參考檔產生器）：輸入框內容逐工具記
  const [inputs, setInputs] = useState({})
  const runTool = async (t) => {
    const _input = (inputs[t.id] ?? '').trim()
    if (t.input && !_input) { setHint(`⚠️ 「${t.name}」請先輸入${t.input.placeholder ?? '內容'}`); return }
    setHint(`執行「${t.name}」…`)
    const _res = await fetch(`/api/tools/run/${t.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t.input ? { input: _input } : {}),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setHint(_res.ok ? `✅ 已執行：${_res.ran}` : `⚠️ ${_res.error ?? '執行失敗'}`)
    if (_res.ok && t.input) setInputs(_prev => ({ ..._prev, [t.id]: '' }))
  }

  // 已產出檔瀏覽（少爺 2026-10-23「可以瀏覽其他的這類檔案」）：點檔名＝Windows「選擇開啟方式」
  const [files, setFiles] = useState({})
  const [openFiles, setOpenFiles] = useState([])
  const loadFiles = async (t) => {
    const _res = await fetch(`/api/tools/files/${t.id}`).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    if (_res.ok) setFiles(_prev => ({ ..._prev, [t.id]: _res.files }))
    else setHint(`⚠️ 讀不到已產出檔：${_res.error ?? '未知原因'}`)
  }
  const toggleFiles = (t) => {
    const _open = openFiles.includes(t.id)
    setOpenFiles(_prev => _open ? _prev.filter(x => x !== t.id) : [..._prev, t.id])
    if (!_open) loadFiles(t)
  }
  const openFile = async (t, f) => {
    const _res = await fetch(`/api/tools/files/${t.id}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel: f.rel }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
    setHint(_res.ok ? `📄 已請 Windows 選擇開啟方式：${f.rel}` : `⚠️ 開不了：${_res.error ?? '未知原因'}`)
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
          {tools && shelves.map(s => {
            const _items = tools.filter(t => t.shelf === s.id)
            if (!_items.length) return null
            const _open = openShelves.includes(s.id)
            const _quietCount = _items.filter(t => t.quiet).length
            return (
              <div key={s.id} className="border border-[var(--border)] rounded">
                <button onClick={() => toggleShelf(s.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/5 transition-colors">
                  <span className="text-[10px] text-[var(--text-muted)] w-3">{_open ? '▾' : '▸'}</span>
                  <span className="text-[12px]">{s.icon}</span>
                  <span className="text-[11px] text-[var(--gold)] tracking-wider flex-1">{s.name}</span>
                  <span className="text-[9px] text-[var(--text-muted)] font-mono">{_items.length} 項{_quietCount ? ` · 🔕${_quietCount}` : ''}</span>
                </button>
                {_open && (
                  <div className="p-2 pt-0 space-y-2">
                    {_items.map(t => {
                      const km = KIND_META[t.kind] ?? { icon: '•', label: t.kind, cls: 'text-[var(--text-muted)] border-[var(--border)]' }
                      const _header = (
                        <>
                          <div className="flex items-center gap-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${km.cls}`}>{km.icon} {km.label}</span>
                            <span className="text-[12px] text-[var(--text)] flex-1">{t.name}</span>
                          </div>
                          {t.desc && <div className="text-[9px] text-[var(--text-muted)] mt-1">{t.desc}</div>}
                        </>
                      )
                      const _filesOpen = openFiles.includes(t.id)
                      return (
                        <div key={t.id} className="border border-[var(--border)] rounded p-2.5 hover:border-[var(--gold-border)] transition-colors">
                          <div className="flex items-start gap-2">
                            {/* 帶輸入型：整張卡不是按鈕，改由「產出」鈕執行 */}
                            {t.input
                              ? <div className="flex-1 min-w-0">{_header}</div>
                              : <button onClick={() => runTool(t)} className="flex-1 min-w-0 text-left">{_header}</button>}
                            <QuietToggle on={!!t.quiet} busy={quietBusy === t.id} onToggle={(v) => toggleQuiet(t, v)}
                              title={t.quietMarkerId ? `${QUIET_HINT}\n跑的是誓約排程，與 Marker 同一個設定（改哪邊都一樣）` : QUIET_HINT} />
                          </div>
                          {t.input && (
                            <div className="flex items-center gap-2 mt-2">
                              <input value={inputs[t.id] ?? ''} maxLength={t.input.maxLength ?? 80} placeholder={t.input.placeholder ?? ''}
                                onChange={e => setInputs(_prev => ({ ..._prev, [t.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) runTool(t) }}
                                className="flex-1 min-w-0 bg-black/30 border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:border-[var(--gold-border)] outline-none" />
                              <button onClick={() => runTool(t)}
                                className="text-[11px] px-3 py-1 rounded border border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/10 shrink-0">{t.input.button ?? '執行'}</button>
                            </div>
                          )}
                          {t.browse && (
                            <div className="mt-2">
                              <button onClick={() => toggleFiles(t)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]">
                                {_filesOpen ? '▾' : '▸'} 瀏覽已產出{files[t.id] ? `（${files[t.id].length}）` : ''}
                              </button>
                              {_filesOpen && (
                                <div className="mt-1 space-y-0.5">
                                  <button onClick={() => loadFiles(t)} className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)]">↻ 重新整理</button>
                                  {!files[t.id] && <div className="text-[9px] text-[var(--text-muted)]">載入中…</div>}
                                  {files[t.id]?.length === 0 && <div className="text-[9px] text-[var(--text-muted)]">還沒有產出的檔</div>}
                                  {files[t.id]?.map(f => (
                                    <button key={f.rel} onClick={() => openFile(t, f)} title={`${f.rel}\n點一下：Windows 選擇開啟方式`}
                                      className="w-full flex items-baseline gap-2 text-left px-1.5 py-0.5 rounded hover:bg-white/5">
                                      <span className="text-[11px] text-sky-300 underline underline-offset-2 truncate flex-1">{f.title}</span>
                                      <span className="text-[9px] text-[var(--text-muted)] font-mono shrink-0">{new Date(f.mtime).toLocaleDateString('zh-TW')}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {hint && <div className="px-4 py-2 border-t border-[var(--border)] text-[9px] text-[var(--text-muted)] font-mono truncate">{hint}</div>}
      </div>
    </div>
  )
}
