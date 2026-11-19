// ─── 視覺頁（少爺 2026-10-30「我想要在TC有個視覺頁面(跟著專案)，其中要有可以瀏覽各專案的視覺，我預期我會看到類似檔案總管的畫面，點擊任意視覺，就會直接在瀏覽器開新分頁顯示」）────────
// 左欄：專案切換（與侍酒師／QA 共用 active 專案）＋搜尋＋根目錄與資料夾樹；右側：所選資料夾的視覺檔（圖片縮圖、網頁與影片圖示）。
// 點任一檔＝瀏覽器新分頁開 /api/visuals/<專案>/file/<根>/<路徑>（網頁內的相對資源走同一條路由）。
// 根目錄設定：sommelier.json projects[].visualRoots；未設＝<projectRoot>/AI_Utils。
import { useCallback, useEffect, useMemo, useState } from 'react'

const KIND_ICON = { page: '📄', image: '🖼', video: '🎞' }

function fileUrl(InProjectId, InRootIndex, InRel) {
  return `/api/visuals/${encodeURIComponent(InProjectId)}/file/${InRootIndex}/${InRel.split('/').map(encodeURIComponent).join('/')}`
}

function formatSize(InBytes) {
  if (InBytes >= 1024 * 1024) return `${(InBytes / 1024 / 1024).toFixed(1)} MB`
  if (InBytes >= 1024) return `${Math.round(InBytes / 1024)} KB`
  return `${InBytes} B`
}

function formatTime(InMs) {
  const _D = new Date(InMs)
  const _P = n => String(n).padStart(2, '0')
  return `${_D.getMonth() + 1}/${_D.getDate()} ${_P(_D.getHours())}:${_P(_D.getMinutes())}`
}

// 資料夾樹的一個節點（遞迴）；InKey＝「根索引:相對路徑」
function FolderNode({ InNode, InRootIndex, InDepth, InSelected, InOnSelect, InOpen, InOnToggle }) {
  const _Key = `${InRootIndex}:${InNode.rel}`
  const _Count = InNode.files.length
  const _IsOpen = InOpen.has(_Key)
  return (
    <div>
      <div onClick={() => InOnSelect({ rootIndex: InRootIndex, rel: InNode.rel })}
        className={`flex items-center gap-1 px-1 py-0.5 cursor-pointer rounded text-[11px] ${InSelected === _Key ? 'bg-[var(--gold)]/15 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface-hover,rgba(255,255,255,0.05))]'}`}
        style={{ paddingLeft: 4 + InDepth * 12 }}>
        <button type="button" onClick={(e) => { e.stopPropagation(); InOnToggle(_Key) }}
          className={`w-3 shrink-0 text-[9px] text-[var(--text-muted)] ${InNode.dirs.length ? '' : 'invisible'}`}>{_IsOpen ? '▾' : '▸'}</button>
        <span className="shrink-0">📁</span>
        <span className="truncate">{InNode.rel ? InNode.name : '（根目錄）'}</span>
        {_Count > 0 && <span className="ml-auto shrink-0 text-[9px] text-[var(--text-muted)]">{_Count}</span>}
      </div>
      {_IsOpen && InNode.dirs.map(_D => (
        <FolderNode key={_D.rel} InNode={_D} InRootIndex={InRootIndex} InDepth={InDepth + 1} InSelected={InSelected}
          InOnSelect={InOnSelect} InOpen={InOpen} InOnToggle={InOnToggle} />
      ))}
    </div>
  )
}

// 依「根索引＋相對路徑」找節點
function findNode(InRoots, InRootIndex, InRel) {
  const _Root = InRoots.find(r => r.index === InRootIndex)
  if (!_Root) return null
  let _Node = _Root.tree
  if (!InRel) return _Node
  for (const _Seg of InRel.split('/')) {
    _Node = _Node.dirs.find(d => d.name === _Seg)
    if (!_Node) return null
  }
  return _Node
}

// 攤平全部檔案（搜尋用）
function flattenFiles(InRoots) {
  const _Out = []
  const _Walk = (InNode, InRoot) => {
    for (const _F of InNode.files) _Out.push({ ..._F, rootIndex: InRoot.index, rootLabel: InRoot.label })
    for (const _D of InNode.dirs) _Walk(_D, InRoot)
  }
  for (const _R of InRoots) _Walk(_R.tree, _R)
  return _Out
}

export default function VisualsPanel({ projects = [], activeProjectId = null, onSelectProject = null, onManageProjects = null }) {
  const [roots, setRoots] = useState([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)   // { rootIndex, rel }
  const [open, setOpen] = useState(() => new Set())
  const [query, setQuery] = useState('')

  const load = useCallback(() => {
    if (!activeProjectId) return
    setLoading(true)
    setError('')
    fetch(`/api/visuals/${encodeURIComponent(activeProjectId)}/tree`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error ?? '讀取失敗'); setRoots([]); return }
        setRoots(d.roots ?? [])
        setTruncated(!!d.truncated)
        setSelected(s => s && (d.roots ?? []).some(r => r.index === s.rootIndex) ? s : ((d.roots ?? [])[0] ? { rootIndex: d.roots[0].index, rel: '' } : null))
        setOpen(o => o.size ? o : new Set((d.roots ?? []).map(r => `${r.index}:`)))
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [activeProjectId])

  useEffect(() => { load() }, [load])

  const toggle = (InKey) => setOpen(o => { const _N = new Set(o); _N.has(InKey) ? _N.delete(InKey) : _N.add(InKey); return _N })
  const allFiles = useMemo(() => flattenFiles(roots), [roots])
  const q = query.trim().toLowerCase()
  const shown = q
    ? allFiles.filter(f => f.rel.toLowerCase().includes(q)).sort((a, b) => b.mtime - a.mtime)
    : ((selected ? findNode(roots, selected.rootIndex, selected.rel)?.files : null) ?? []).map(f => ({ ...f, rootIndex: selected.rootIndex }))
  const selectedKey = selected ? `${selected.rootIndex}:${selected.rel}` : ''
  const selectedLabel = selected ? `${roots.find(r => r.index === selected.rootIndex)?.label ?? ''}${selected.rel ? ' / ' + selected.rel : ''}` : ''
  const openFile = (InFile) => window.open(fileUrl(activeProjectId, InFile.rootIndex, InFile.rel), '_blank', 'noopener')

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col min-h-0">
        <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] space-y-1">
          <div className="flex items-center gap-1">
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
            <button onClick={load} disabled={loading} title="重新掃描"
              className="shrink-0 text-[10px] px-1 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] normal-case disabled:opacity-50">{loading ? '…' : '↻'}</button>
          </div>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋檔名或路徑"
            className="w-full bg-transparent border border-[var(--border)] rounded text-[11px] px-1.5 py-0.5 text-[var(--text)] normal-case tracking-normal" />
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {error && <div className="text-[11px] text-red-400 p-2">{error}</div>}
          {!error && !loading && roots.length === 0 && <div className="text-[11px] text-[var(--text-muted)] p-2">這個專案還沒有視覺資料夾（預設是專案根目錄下的 AI_Utils）。</div>}
          {roots.map(r => (
            <div key={r.index} className="mb-1">
              <div className="px-1 pt-1 text-[9px] uppercase tracking-widest text-[var(--text-muted)] truncate" title={r.path}>{r.label}</div>
              <FolderNode InNode={r.tree} InRootIndex={r.index} InDepth={0} InSelected={selectedKey}
                InOnSelect={(s) => { setQuery(''); setSelected(s) }} InOpen={open} InOnToggle={toggle} />
            </div>
          ))}
          {truncated && <div className="text-[10px] text-amber-400 p-2">檔案太多，只列出前 5000 個。</div>}
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto p-4">
        <div className="text-[11px] text-[var(--text-muted)] mb-3 truncate">
          {q ? `搜尋「${query.trim()}」：${shown.length} 個` : `${selectedLabel}（${shown.length} 個）`}　點一下在新分頁開啟
        </div>
        {shown.length === 0 && !loading && <div className="text-[12px] text-[var(--text-muted)]">這個資料夾沒有視覺檔。</div>}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {shown.map(f => (
            <button key={`${f.rootIndex}:${f.rel}`} type="button" onClick={() => openFile(f)} title={f.rel}
              className="text-left border border-[var(--border)] rounded bg-[var(--surface)] hover:border-[var(--gold)]/60 overflow-hidden">
              <div className="h-28 bg-black/30 flex items-center justify-center overflow-hidden">
                {f.kind === 'image'
                  ? <img src={fileUrl(activeProjectId, f.rootIndex, f.rel)} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
                  : <span className="text-3xl">{KIND_ICON[f.kind] ?? '📄'}</span>}
              </div>
              <div className="px-2 py-1.5">
                <div className="text-[11px] text-[var(--text)] truncate">{f.name}</div>
                <div className="text-[9px] text-[var(--text-muted)] truncate">{q ? `${f.rootLabel} / ${f.rel}` : `${formatSize(f.size)}・${formatTime(f.mtime)}`}</div>
              </div>
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}
