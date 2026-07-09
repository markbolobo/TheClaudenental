import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

// ─── Sommelier 侍酒師 — 專案名詞圖鑑(P0:C++ 骨架層 + P1:選件購物車)─────────
// 室內設計圖式層級瀏覽:模組 → 種類 → 類別 → (pragma region 分節的)成員。
// 購物車:點選名詞加入選件 → 結帳前可移除 → 結帳將「少爺描述 + 選件錨點」組成
// prompt 複製,貼到聊天室給 Claude 當精準上下文。
// 資料來自 /api/sommelier/*,由 extract_ue_cpp_symbols.mjs 離線萃取。

const KIND_META = {
  class:     { icon: '◆', label: '類別',  order: 0 },
  interface: { icon: '◇', label: '介面',  order: 1 },
  struct:    { icon: '▣', label: '結構',  order: 2 },
  enum:      { icon: '≡', label: '枚舉',  order: 3 },
  delegate:  { icon: '⚡', label: '委派', order: 4 },
}
const MEMBER_ICON = { function: 'ƒ', property: '·', delegate: '⚡', enumValue: '№' }
const MEMBER_LABEL = { function: '函式', property: '變數', delegate: '委派', enumValue: '枚舉值' }
const CART_STORE_KEY = 'tc_sommelier_cart_v1'

function daysAgo(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

function memberSig(m) {
  return m.kind === 'function'
    ? `${m.returnType ? m.returnType + ' ' : ''}${m.name}(${m.params ?? ''})${m.const ? ' const' : ''}${m.override ? ' override' : ''}`
    : m.kind === 'enumValue'
      ? `${m.name}${m.displayName ? `  「${m.displayName}」` : ''}`
      : `${m.type ?? ''} ${m.name}`.trim()
}

// 選件 key:條目級 = 專案:符號;成員級 = 專案:符號::成員@行號
const symbolKey = (pid, s) => `${pid}:${s.name}`
const memberKey = (pid, s, m) => `${pid}:${s.name}::${m.name}@${m.line ?? '?'}`

function ReflectChip({ m }) {
  if (m.kind === 'enumValue') return null
  const label = m.reflected ? (m.kind === 'property' ? 'UP' : 'UF') : 'C++'
  const bp = m.specs && /blueprint/i.test(m.specs)
  return (
    <span className="inline-flex gap-1 shrink-0">
      <span className={`text-[8px] px-1 rounded border ${m.reflected ? 'border-[var(--gold)]/40 text-[var(--gold)]/80' : 'border-[var(--border)] text-[var(--text-muted)]'}`}
        title={m.specs || '非反射 C++ 成員'}>{label}</span>
      {bp && <span className="text-[8px] px-1 rounded border border-sky-500/40 text-sky-400/90" title={m.specs}>BP</span>}
    </span>
  )
}

function CartButton({ inCart, onClick, title }) {
  return (
    <button onClick={onClick} title={title}
      className={`text-[10px] shrink-0 ${inCart ? 'text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--gold)]'}`}>
      {inCart ? '🛒✓' : '🛒'}
    </button>
  )
}

function MemberRow({ m, highlight, onOpenSource, file, inCart, onToggleCart }) {
  return (
    <div className={`px-2 py-1 rounded border ${highlight ? 'border-[var(--gold)]/50 bg-[var(--gold)]/5' : inCart ? 'border-[var(--gold)]/25' : 'border-transparent hover:border-[var(--border)]'}`}>
      <div className="flex items-start gap-2">
        <span className="text-[10px] text-[var(--text-muted)] w-3 shrink-0 text-center">{MEMBER_ICON[m.kind] ?? '·'}</span>
        <code className="text-[11px] text-[var(--text)] break-all flex-1">{memberSig(m)}</code>
        <ReflectChip m={m} />
        <CartButton inCart={inCart} onClick={() => onToggleCart(m)} title={inCart ? '從購物車移除' : '加入購物車'} />
        {m.line && (
          <button onClick={() => onOpenSource(file, m.line)} title={`${file}:${m.line} 在 VSCode 開啟`}
            className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] shrink-0">↗</button>
        )}
      </div>
      {m.comment && (
        <div className="ml-5 text-[10px] text-[var(--text-muted)] whitespace-pre-wrap">{m.comment}</div>
      )}
    </div>
  )
}

// 結帳:少爺描述 + 選件錨點 → prompt 文字
function composePrompt(draft, items) {
  const lines = []
  if (draft.trim()) lines.push(draft.trim(), '')
  if (items.length) {
    const proj = items[0]?.project ?? ''
    const commits = [...new Set(items.map(i => i.commit).filter(Boolean))]
    lines.push(`── 🍷 侍酒師選件(${proj}${commits.length ? ' @ ' + commits.join(', ') : ''})──`)
    items.forEach((it, idx) => {
      if (it.nodeKind === 'archNode') {
        lines.push(`${idx + 1}. 【系統節點】${it.nodeTitle} — ${it.canvasTitle}`)
        if (it.text) lines.push(`   設計說明: ${it.text.replace(/\n+/g, ' / ').slice(0, 400)}`)
        if (it.symbolRefs?.length) lines.push(`   關聯符號: ${it.symbolRefs.join(', ')}`)
        return
      }
      if (it.nodeKind === 'memoryNote') {
        lines.push(`${idx + 1}. 【拼圖】${it.noteTitle}（${it.noteType}）`)
        if (it.description) lines.push(`   摘要: ${it.description}`)
        if (it.text) lines.push(`   內容: ${it.text.replace(/\n+/g, ' / ').slice(0, 500)}`)
        return
      }
      if (it.nodeKind === 'bp') {
        lines.push(`${idx + 1}. 【藍圖】${it.bpName}（${it.bpClass}）繼承 ${it.parentName ?? '?'}`)
        if (it.deps?.length) lines.push(`   引用資產: ${it.deps.slice(0, 14).map(d => `${d.class}:${d.name}`).join(', ')}`)
        return
      }
      const head = it.member
        ? `${it.symbol}::${it.member} — ${MEMBER_LABEL[it.kind] ?? it.kind}${it.reflected === false ? '(非反射)' : ''}`
        : `${it.symbol} — ${KIND_META[it.kind]?.label ?? it.kind}`
      lines.push(`${idx + 1}. ${head}`)
      if (it.sig) lines.push(`   簽名: ${it.sig}`)
      if (it.file) lines.push(`   檔案: ${it.file}${it.line ? ':' + it.line : ''}`)
      if (it.region) lines.push(`   區塊: § ${it.region}`)
      if (it.comment) lines.push(`   註解: ${it.comment.replace(/\n/g, ' / ')}`)
    })
  }
  return lines.join('\n')
}

// Obsidian Canvas 顏色（1-6）→ 視覺色點
const CANVAS_COLOR = { '1': '#e05555', '2': '#e0954f', '3': '#d9c74f', '4': '#6fc74f', '5': '#4faec7', '6': '#a86fc7' }
const archNodeKey = (pid, canvasFile, nodeId) => `${pid}:arch:${canvasFile}:${nodeId}`

// 🗺️ 架構關聯視圖 — canvas → node → 逛關聯（node→node）+ 引用符號跳骨架
function ArchView({ arch, projectId, query, onJumpToSymbol, cartKeys, onToggleNodeCart }) {
  const canvases = arch?.canvases ?? []
  const [canvasFile, setCanvasFile] = useState(canvases[0]?.file ?? null)
  const [nodeId, setNodeId] = useState(null)

  // 常駐搜尋（query 由父層傳入）：canvas 命中(標題/檔名/含命中節點)、node 命中(標題/內文/引用符號)
  const ql = (query ?? '').trim().toLowerCase()
  const nodeMatch = (n) => !ql || (n.title ?? '').toLowerCase().includes(ql) || (n.text ?? '').toLowerCase().includes(ql) || (n.symbolRefs ?? []).some(r => r.name.toLowerCase().includes(ql))
  const filteredCanvases = ql ? canvases.filter(c => c.title.toLowerCase().includes(ql) || c.file.toLowerCase().includes(ql) || c.nodes.some(nodeMatch)) : canvases
  // query 有值且當前 canvas 未命中 → 自動跳到第一個命中的 canvas（搜「玩家能力」直達 PlayerAbilities）
  useEffect(() => {
    if (ql && filteredCanvases.length && !filteredCanvases.some(c => c.file === canvasFile)) {
      setCanvasFile(filteredCanvases[0].file); setNodeId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ql])

  const canvas = canvases.find(c => c.file === canvasFile)
  const node = canvas?.nodes.find(n => n.id === nodeId)
  const nodeEdges = useMemo(() => {
    if (!canvas || !node) return { out: [], in: [] }
    return {
      out: canvas.edges.filter(e => e.fromId === node.id),
      in: canvas.edges.filter(e => e.toId === node.id),
    }
  }, [canvas, node])

  if (!canvases.length) return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs px-6 text-center">
      尚無架構 canvas 資料 — 在 sommelier.json 該專案加 canvasDir 後跑刷新指令
    </div>
  )

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左：canvas 清單 */}
      <div className="w-56 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70 px-1 mb-1">架構 Canvas（{filteredCanvases.length}{ql ? `/${canvases.length}` : ''}）</div>
        {filteredCanvases.map(c => (
          <button key={c.file} onClick={() => { setCanvasFile(c.file); setNodeId(null) }}
            className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 mb-0.5 ${canvasFile === c.file ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
            <span className="truncate flex-1">{c.title}</span>
            <span className="text-[8px] text-[var(--text-muted)] shrink-0">{c.nodeCount}</span>
          </button>
        ))}
      </div>

      {/* 中：node 清單 */}
      <div className="w-64 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        {canvas?.nodes.filter(n => (n.kind === 'text' || n.kind === 'group') && nodeMatch(n)).map(n => (
          <button key={n.id} onClick={() => setNodeId(n.id)}
            className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 mb-0.5 ${nodeId === n.id ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
            {n.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CANVAS_COLOR[n.color] ?? '#888' }} />}
            <span className="truncate flex-1">{n.title}</span>
            {n.symbolRefs.length > 0 && <span className="text-[8px] text-[var(--text-muted)] shrink-0">{n.symbolRefs.length}⚙</span>}
          </button>
        ))}
      </div>

      {/* 右：node 細節 */}
      <div className="flex-1 overflow-y-auto p-3 min-w-0">
        {!node ? (
          <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-lg mx-auto mt-10 space-y-2">
            <div className="text-[var(--gold)] text-sm">🗺️ 架構關聯</div>
            <p>左欄選一張架構 canvas，中欄是它的系統節點。點任一節點看它的<b>設計說明</b>、<b>與其他系統的關聯（edge）</b>、以及它引用的 <b>C++ 符號</b>（可跳回骨架圖鑑）。</p>
            <p>沿著關聯的箭頭可以在系統之間 node→node 逛。看到相關節點點 🛒 把整個系統節點（含設計說明＋關聯符號）加入選件。</p>
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            {/* 節點頭 */}
            <div className="flex items-center gap-2 flex-wrap">
              {node.color && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: CANVAS_COLOR[node.color] ?? '#888' }} />}
              <code className="text-base text-[var(--text)]">{node.title}</code>
              <span className="text-[9px] text-[var(--text-muted)]">{canvas.title}</span>
              <button onClick={() => onToggleNodeCart(canvas, node)}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${cartKeys.has(archNodeKey(projectId, canvas.file, node.id)) ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                {cartKeys.has(archNodeKey(projectId, canvas.file, node.id)) ? '🛒✓ 已在購物車' : '🛒 加入系統節點'}
              </button>
            </div>

            {/* 設計說明 */}
            {node.text && (
              <div className="text-[11px] text-[var(--text)] whitespace-pre-wrap border-l-2 border-[var(--gold)]/30 pl-2 max-h-80 overflow-y-auto">{node.text}</div>
            )}

            {/* 系統關聯 edges */}
            {(nodeEdges.out.length > 0 || nodeEdges.in.length > 0) && (
              <div className="space-y-1">
                <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">系統關聯（點跳目標節點）</div>
                {nodeEdges.out.map(e => (
                  <button key={e.id} onClick={() => setNodeId(e.toId)}
                    className="w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] flex items-center gap-1 flex-wrap">
                    <span className="text-[var(--gold)]/60 shrink-0">→</span>
                    {e.label && <span className="text-[var(--text)]">[{e.label}]</span>}
                    <code className="text-[var(--gold)]/80">{e.toTitle}</code>
                  </button>
                ))}
                {nodeEdges.in.map(e => (
                  <button key={e.id} onClick={() => setNodeId(e.fromId)}
                    className="w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] flex items-center gap-1 flex-wrap">
                    <code className="text-[var(--gold)]/80">{e.fromTitle}</code>
                    {e.label && <span className="text-[var(--text)]">[{e.label}]</span>}
                    <span className="text-[var(--gold)]/60 shrink-0">→ 本節點</span>
                  </button>
                ))}
              </div>
            )}

            {/* 引用的 C++ 符號 */}
            {node.symbolRefs.length > 0 && (
              <div className="space-y-1">
                <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">引用的 C++ 符號（點跳骨架圖鑑）</div>
                <div className="flex flex-wrap gap-1">
                  {node.symbolRefs.map(r => (
                    <button key={r.name} onClick={() => onJumpToSymbol(r.name)} title={`${r.symbolKind} · ${r.confidence}`}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${r.confidence === 'backtick' ? 'border-[var(--gold)]/40 text-[var(--gold)]/90' : 'border-[var(--border)] text-[var(--text-muted)]'} hover:border-[var(--gold)] hover:text-[var(--gold)]`}>
                      <code>{r.name}</code>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const MEMORY_TYPE_META = {
  feedback:  { icon: '🧭', label: '紀律回饋' },
  project:   { icon: '📋', label: '專案進行' },
  reference: { icon: '📎', label: '參照' },
  user:      { icon: '👤', label: '業主' },
  note:      { icon: '📝', label: '筆記' },
}
const memoryNoteKey = (pid, noteName) => `${pid}:mem:${noteName}`

// 📓 拼圖視圖 — type 分組 → note → 逛拼圖網（[[link]]）+ 引用符號/canvas 跳轉
function MemoryView({ memory, projectId, query, onJumpToSymbol, onJumpToCanvas, cartKeys, onToggleNoteCart }) {
  const notes = memory?.notes ?? []
  const [noteName, setNoteName] = useState(null)

  const byName = useMemo(() => new Map(notes.map(n => [n.name, n])), [notes])
  const grouped = useMemo(() => {
    const g = new Map()
    const ql = (query ?? '').trim().toLowerCase()
    for (const n of notes) {
      if (ql && !n.name.toLowerCase().includes(ql) && !n.title.toLowerCase().includes(ql)
        && !(n.description ?? '').toLowerCase().includes(ql) && !n.text.toLowerCase().includes(ql)) continue
      if (!g.has(n.type)) g.set(n.type, [])
      g.get(n.type).push(n)
    }
    return g
  }, [notes, query])

  const note = noteName ? byName.get(noteName) : null

  if (!notes.length) return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs px-6 text-center">
      尚無拼圖 memory 資料 — 在 sommelier.json 該專案加 memoryDir 後跑刷新指令
    </div>
  )

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左：type 分組（搜尋走常駐搜尋欄）*/}
      <div className="w-72 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        {[...grouped.entries()].sort((a, b) => b[1].length - a[1].length).map(([type, arr]) => (
          <div key={type} className="mb-1">
            <div className="px-1 py-0.5 text-[10px] uppercase tracking-widest text-[var(--gold)]/70">
              {MEMORY_TYPE_META[type]?.icon} {MEMORY_TYPE_META[type]?.label ?? type} <span className="text-[8px]">({arr.length})</span>
            </div>
            {arr.map(n => (
              <button key={n.name} onClick={() => setNoteName(n.name)}
                className={`w-full text-left pl-4 pr-2 py-0.5 rounded text-[11px] flex items-center gap-1 ${noteName === n.name ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                <span className="truncate flex-1">{n.title}</span>
                {n.symbolRefs.length > 0 && <span className="text-[8px] text-[var(--text-muted)] shrink-0">{n.symbolRefs.length}⚙</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 右：note 細節 */}
      <div className="flex-1 overflow-y-auto p-3 min-w-0">
        {!note ? (
          <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-lg mx-auto mt-10 space-y-2">
            <div className="text-[var(--gold)] text-sm">📓 拼圖</div>
            <p>左欄是專案的持久記憶，按類型分組。點任一拼圖看內容、它引用的 <b>C++ 符號</b>與<b>架構 canvas</b>（可跳），以及它連到的<b>其他拼圖</b>（[[link]]，可 node→node 逛拼圖網）。</p>
            <p>看到相關拼圖點 🛒 加入選件，結帳時把「你我沉澱過的經驗」一起帶進 prompt。</p>
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">{MEMORY_TYPE_META[note.type]?.icon} {MEMORY_TYPE_META[note.type]?.label ?? note.type}</span>
              <code className="text-base text-[var(--text)]">{note.title}</code>
              <button onClick={() => onToggleNoteCart(note)}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${cartKeys.has(memoryNoteKey(projectId, note.name)) ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                {cartKeys.has(memoryNoteKey(projectId, note.name)) ? '🛒✓ 已在購物車' : '🛒 加入拼圖'}
              </button>
            </div>
            {note.description && <div className="text-[10px] text-[var(--text-muted)] italic">{note.description}</div>}
            {note.text && <div className="text-[11px] text-[var(--text)] whitespace-pre-wrap border-l-2 border-[var(--gold)]/30 pl-2 max-h-96 overflow-y-auto">{note.text}</div>}

            {/* 連到的拼圖 [[links]] — 逛拼圖網 */}
            {note.memoryLinks.length > 0 && (
              <div className="space-y-1">
                <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">連到的拼圖（點跳）</div>
                <div className="flex flex-wrap gap-1">
                  {note.memoryLinks.map(l => {
                    const exists = byName.has(l)
                    return <button key={l} disabled={!exists} onClick={() => exists && setNoteName(l)}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${exists ? 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold)] hover:text-[var(--gold)]' : 'border-[var(--border)]/40 text-[var(--text-muted)]/40 cursor-default'}`}>
                      [[{l}]]</button>
                  })}
                </div>
              </div>
            )}

            {/* 引用的 C++ 符號 + 架構 canvas */}
            {(note.symbolRefs.length > 0 || note.canvasRefs.length > 0) && (
              <div className="space-y-1">
                <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">引用（點跳）</div>
                <div className="flex flex-wrap gap-1">
                  {note.symbolRefs.map(r => (
                    <button key={r.name} onClick={() => onJumpToSymbol(r.name)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold)] hover:text-[var(--gold)]"><code>{r.name}</code></button>
                  ))}
                  {note.canvasRefs.map(c => (
                    <button key={c.file} onClick={() => onJumpToCanvas(c.file)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--gold)]/30 text-[var(--gold)]/80 hover:border-[var(--gold)]">🗺️ {c.title}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const bpKey = (pid, bpPath) => `${pid}:bp:${bpPath}`
const ASSET_CLASS_ICON = {
  Material: '🎨', MaterialInstanceConstant: '🎨', MaterialFunction: '🎨', Texture2D: '🖼',
  SoundWave: '🔊', SoundCue: '🔊', NiagaraSystem: '✨', NiagaraEmitter: '✨', ParticleSystem: '✨',
  SkeletalMesh: '🦴', StaticMesh: '📦', AnimMontage: '🎬', AnimSequence: '🎬', PoseSearchDatabase: '🔍', WidgetBlueprint: '🖥',
}

// 🎨 藍圖資產視圖 — BP 繼承樹（按父類分組）+ 引用的末端資產 + 繼承 C++ 跳骨架
function AssetView({ assetGraph, projectId, query, onJumpToSymbol, cartKeys, onToggleBpCart }) {
  const bps = assetGraph?.blueprints ?? []
  const [bpPath, setBpPath] = useState(null)
  const bp = bps.find(b => b.path === bpPath)

  const grouped = useMemo(() => {
    const g = new Map()
    const ql = (query ?? '').trim().toLowerCase()
    for (const b of bps) {
      if (ql && !b.name.toLowerCase().includes(ql) && !(b.parentName ?? '').toLowerCase().includes(ql)) continue
      const key = b.parentKind === 'cpp' ? `C++ ◆ ${b.parentName}` : b.parentKind === 'bp' ? `BP ◇ ${b.parentName}` : '（無父類）'
      if (!g.has(key)) g.set(key, [])
      g.get(key).push(b)
    }
    return g
  }, [bps, query])

  const depsByClass = useMemo(() => {
    const m = {}
    for (const d of bp?.deps ?? []) (m[d.class] ??= []).push(d)
    return m
  }, [bp])

  if (!bps.length) return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs px-6 text-center">
      尚無藍圖資產資料 — Editor 開著時跑 extract_asset_graph.py（透過 MCP execute_python）產出 asset_graph.json
    </div>
  )
  const stats = assetGraph?.stats?.byClass ?? {}

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左：BP 繼承樹（按父類分組，搜尋走常駐搜尋欄）*/}
      <div className="w-72 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        {[...grouped.entries()].sort((a, b) => b[1].length - a[1].length).map(([grp, arr]) => (
          <div key={grp} className="mb-1">
            <div className="px-1 py-0.5 text-[10px] text-[var(--gold)]/70 truncate">{grp} <span className="text-[8px]">({arr.length})</span></div>
            {arr.map(b => (
              <button key={b.path} onClick={() => setBpPath(b.path)}
                className={`w-full text-left pl-3 pr-2 py-0.5 rounded text-[11px] flex items-center gap-1 ${bpPath === b.path ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                <span className="truncate flex-1">{b.name}</span>
                {b.deps?.length > 0 && <span className="text-[8px] text-[var(--text-muted)] shrink-0">{b.deps.length}📎</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 右：BP 細節 或 資產總覽 */}
      <div className="flex-1 overflow-y-auto p-3 min-w-0">
        {!bp ? (
          <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-xl mx-auto mt-8 space-y-3">
            <div className="text-[var(--gold)] text-sm">🎨 藍圖資產</div>
            <p>左欄是專案的藍圖，按父類分組（C++ ◆ 可跳骨架圖鑑 / BP ◇ 繼承鏈）。點任一藍圖看它繼承的類、以及它引用的材質 / 音效 / 特效 / Mesh 等末端資產。</p>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70 mb-1">資產總覽（全專案 {assetGraph?.stats?.totalAssets ?? '?'} 項）</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {Object.entries(stats).slice(0, 18).map(([c, n]) => (
                  <div key={c} className="flex items-center gap-1 text-[10px]">
                    <span>{ASSET_CLASS_ICON[c] ?? '·'}</span>
                    <span className="truncate flex-1 text-[var(--text)]">{c}</span>
                    <span className="text-[var(--text-muted)]">{n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">{bp.class}</span>
              <code className="text-base text-[var(--text)]">{bp.name}</code>
              <button onClick={() => onToggleBpCart(bp)}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${cartKeys.has(bpKey(projectId, bp.path)) ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                {cartKeys.has(bpKey(projectId, bp.path)) ? '🛒✓ 已在購物車' : '🛒 加入藍圖'}
              </button>
            </div>
            <div className="text-[10px] text-[var(--text-muted)]">
              路徑：<code>{bp.path}</code>
            </div>
            {bp.parentName && (
              <div className="text-[11px]">繼承自：
                {bp.parentKind === 'cpp'
                  ? <button onClick={() => onJumpToSymbol(bp.parentName)} className="ml-1 text-[var(--gold)]/90 hover:underline"><code>◆ {bp.parentName}</code>（C++）</button>
                  : <code className="ml-1 text-[var(--text-muted)]">◇ {bp.parentName}（BP）</code>}
              </div>
            )}
            {/* 引用的末端資產（按類別分組）*/}
            {bp.deps?.length > 0 && (
              <div className="space-y-2">
                <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">引用的末端資產（{bp.deps.length}）</div>
                {Object.entries(depsByClass).sort((a, b) => b[1].length - a[1].length).map(([cls, arr]) => (
                  <div key={cls}>
                    <div className="text-[10px] text-[var(--text-muted)] mb-0.5">{ASSET_CLASS_ICON[cls] ?? '·'} {cls}（{arr.length}）</div>
                    <div className="flex flex-wrap gap-1">
                      {arr.map(d => (
                        <span key={d.path} title={d.path} className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text)]">{d.name}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!bp.deps?.length && <div className="text-[10px] text-[var(--text-muted)]">（此藍圖非核心 BP_，未展開末端資產依賴）</div>}
          </div>
        )}
      </div>
    </div>
  )
}

export function SommelierPanel({ onGoToChat, projects: projectsProp = null, activeProjectId = null, onSelectProject = null, onManageProjects = null }) {
  // 跨專案切換：App 傳入共享狀態時用它（與 QA 分頁同步切換）；未傳入則退回面板內自管（獨立使用相容）
  const [projectsLocal, setProjectsLocal] = useState([])
  const [projectIdLocal, setProjectIdLocal] = useState(null)
  const projects = projectsProp ?? projectsLocal
  const projectId = projectsProp ? activeProjectId : projectIdLocal
  const setProjectId = projectsProp ? (onSelectProject ?? (() => {})) : setProjectIdLocal
  const [payload, setPayload] = useState(null)   // { data, extractCommand }
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState(null)
  const [mode, setMode] = useState('skeleton')   // skeleton 骨架圖鑑 | arch 架構關聯
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [notice, setNotice] = useState('')
  const searchRef = useRef(null)

  // ── 購物車(localStorage 持久化,換分頁/重整不丟)──
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CART_STORE_KEY))?.items ?? [] } catch { return [] }
  })
  const [draft, setDraft] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CART_STORE_KEY))?.draft ?? '' } catch { return '' }
  })
  const [cartOpen, setCartOpen] = useState(false)
  const [attachments, setAttachments] = useState([])  // [{name,dataUrl,type}]：結帳送入聊天室時一併傳給 Claude 分析
  const attachInputRef = useRef(null)
  useEffect(() => {
    try { localStorage.setItem(CART_STORE_KEY, JSON.stringify({ items: cart, draft })) } catch {}
  }, [cart, draft])

  function handleAttachFiles(e) {
    const files = Array.from(e.target.files ?? [])
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = ev => setAttachments(prev => [...prev, { name: file.name, dataUrl: ev.target.result, type: file.type }])
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const flash = useCallback((msg, ms = 4000) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), ms)
  }, [])

  useEffect(() => {
    // App 已傳入共享專案清單 → 不重複抓；清單空時顯示設定提示
    if (projectsProp) {
      if (projectsProp.length === 0) { setLoading(false); setError('尚未設定任何專案 — 編輯 ~/.claude/tc_user_config/sommelier.json') }
      return
    }
    fetch('/api/sommelier/projects').then(r => r.json())
      .then(d => {
        setProjectsLocal(d.projects ?? [])
        if (d.projects?.length) setProjectIdLocal(d.projects[0].id)
        else { setLoading(false); setError('尚未設定任何專案 — 編輯 ~/.claude/tc_user_config/sommelier.json') }
      })
      .catch(e => { setLoading(false); setError(String(e)) })
  }, [projectsProp])

  // 專案切換（含從 QA 分頁切的）→ 清掉上一專案的選取，避免跨專案殘留
  useEffect(() => { setSelectedName(null) }, [projectId])

  useEffect(() => {
    if (!projectId) return
    setLoading(true); setError(null)
    fetch(`/api/sommelier/data/${projectId}`).then(r => r.json())
      .then(d => {
        if (d.ok) setPayload(d)
        else setError(`${d.error}${d.hint ? `\n刷新指令:${d.hint}` : ''}`)
        setLoading(false)
      })
      .catch(e => { setLoading(false); setError(String(e)) })
  }, [projectId])

  // ── 鍵盤動線:Esc 關條目/購物車回到查詢、/ 聚焦搜尋框 ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (cartOpen) setCartOpen(false)
        else setSelectedName(null)
        searchRef.current?.focus()
      } else if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cartOpen])

  const data = payload?.data
  const arch = payload?.arch
  const symbolCanvasIndex = payload?.symbolCanvasIndex ?? {}
  const memory = payload?.memory
  const symbolMemoryIndex = payload?.symbolMemoryIndex ?? {}
  const assetGraph = payload?.assetGraph
  const symbolBpIndex = payload?.symbolBpIndex ?? {}
  const symbols = data?.symbols ?? []

  const byName = useMemo(() => {
    const m = new Map()
    for (const s of symbols) m.set(s.name, s)
    return m
  }, [symbols])

  // 反向繼承索引:base name → 子類列表
  const derivedIndex = useMemo(() => {
    const m = new Map()
    for (const s of symbols)
      for (const b of (s.bases ?? [])) {
        if (!m.has(b)) m.set(b, [])
        m.get(b).push(s.name)
      }
    return m
  }, [symbols])

  // 樹:模組 → kind → symbols
  const tree = useMemo(() => {
    const mods = new Map()
    for (const s of symbols) {
      if (!mods.has(s.module)) mods.set(s.module, new Map())
      const kinds = mods.get(s.module)
      if (!kinds.has(s.kind)) kinds.set(s.kind, [])
      kinds.get(s.kind).push(s)
    }
    for (const kinds of mods.values())
      for (const arr of kinds.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return mods
  }, [symbols])

  // 搜尋:名稱 > 成員名 > 註解(中文註解也吃得到)
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out = []
    for (const s of symbols) {
      const nameHit = s.name.toLowerCase().includes(q)
      const commentHit = (s.comment ?? '').toLowerCase().includes(q)
      const memberHits = (s.members ?? []).filter(m =>
        m.name.toLowerCase().includes(q) || (m.comment ?? '').toLowerCase().includes(q))
      if (nameHit || commentHit || memberHits.length) {
        out.push({
          sym: s, memberHits,
          score: (s.name.toLowerCase().startsWith(q) ? 0 : nameHit ? 1 : memberHits.some(m => m.name.toLowerCase().includes(q)) ? 2 : 3),
        })
      }
    }
    out.sort((a, b) => a.score - b.score || a.sym.name.localeCompare(b.sym.name))
    return out.slice(0, 120)
  }, [query, symbols])

  const selected = selectedName ? byName.get(selectedName) : null
  const matchedMemberSet = useMemo(() => {
    if (!hits || !selected) return new Set()
    const h = hits.find(x => x.sym.name === selected.name)
    return new Set((h?.memberHits ?? []).map(m => `${m.name}:${m.line}`))
  }, [hits, selected])

  const toggle = (key) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const openSource = (file, line) => {
    fetch('/api/open-in-vscode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: file, line }),
    }).then(r => r.json())
      .then(d => { if (!d.ok) flash(`開檔失敗:${d.error}`) })
      .catch(() => {})
  }

  const copyExtract = () => {
    if (!payload?.extractCommand) return
    navigator.clipboard?.writeText(payload.extractCommand)
      .then(() => flash('刷新指令已複製 — 貼到 terminal 執行後重開本頁', 5000))
      .catch(() => {})
  }

  // ── 購物車操作(加入時做快照,萃取資料換版也不失效)──
  const cartKeys = useMemo(() => new Set(cart.map(i => i.key)), [cart])

  const toggleCartMember = (sym, m) => {
    const key = memberKey(projectId, sym, m)
    if (cartKeys.has(key)) { setCart(c => c.filter(i => i.key !== key)); return }
    setCart(c => [...c, {
      key, project: data?.project, commit: data?.commit,
      symbol: sym.name, member: m.name, kind: m.kind, reflected: m.reflected,
      sig: memberSig(m), file: sym.file, line: m.line ?? sym.line,
      region: m.region ?? null, comment: m.comment ?? '',
    }])
    flash(`已加入:${sym.name}::${m.name}`, 1500)
  }

  const toggleCartSymbol = (sym) => {
    const key = symbolKey(projectId, sym)
    if (cartKeys.has(key)) { setCart(c => c.filter(i => i.key !== key)); return }
    setCart(c => [...c, {
      key, project: data?.project, commit: data?.commit,
      symbol: sym.name, member: null, kind: sym.kind, reflected: sym.reflected,
      sig: sym.bases?.length ? `${sym.name} : ${sym.bases.join(', ')}` : sym.name,
      file: sym.file, line: sym.line, region: null,
      comment: sym.comment ?? '',
    }])
    flash(`已加入條目:${sym.name}`, 1500)
  }

  // 架構節點 → 選件（帶設計說明 + 關聯符號）
  const toggleCartNode = (canvas, node) => {
    const key = archNodeKey(projectId, canvas.file, node.id)
    if (cartKeys.has(key)) { setCart(c => c.filter(i => i.key !== key)); return }
    setCart(c => [...c, {
      key, project: data?.project, nodeKind: 'archNode',
      canvas: canvas.file, canvasTitle: canvas.title,
      nodeTitle: node.title, text: node.text,
      symbolRefs: node.symbolRefs.map(r => r.name),
    }])
    flash(`已加入系統節點：${node.title}`, 1500)
  }

  // 架構視圖點 C++ 符號 → 跳回骨架圖鑑該條目
  const jumpToSymbol = (name) => {
    let target = name
    if (!byName.has(target))
      for (const pre of ['U', 'A', 'I', 'F', 'E']) if (byName.has(pre + name)) { target = pre + name; break }
    if (!byName.has(target)) { flash(`骨架圖鑑中查無 ${name}（可能是非反射 / 未萃取）`); return }
    setMode('skeleton'); setSelectedName(target); setQuery('')
  }
  // 拼圖視圖點 canvas 引用 → 切架構關聯視圖
  const jumpToCanvas = () => setMode('arch')

  // 拼圖 → 選件（帶摘要 + 內文）
  const toggleCartNote = (note) => {
    const key = memoryNoteKey(projectId, note.name)
    if (cartKeys.has(key)) { setCart(c => c.filter(i => i.key !== key)); return }
    setCart(c => [...c, {
      key, project: data?.project, nodeKind: 'memoryNote',
      noteName: note.name, noteTitle: note.title, noteType: note.type,
      description: note.description, text: note.text,
    }])
    flash(`已加入拼圖：${note.title}`, 1500)
  }

  // 藍圖 → 選件（帶父類 + 引用資產）
  const toggleCartBp = (b) => {
    const key = bpKey(projectId, b.path)
    if (cartKeys.has(key)) { setCart(c => c.filter(i => i.key !== key)); return }
    setCart(c => [...c, {
      key, project: data?.project, nodeKind: 'bp',
      bpName: b.name, bpClass: b.class, parentName: b.parentName, deps: b.deps ?? [],
    }])
    flash(`已加入藍圖：${b.name}`, 1500)
  }

  const composed = useMemo(() => composePrompt(draft, cart), [draft, cart])

  const checkout = () => {
    if (!cart.length && !draft.trim()) { flash('購物車是空的——先點選名詞或寫描述'); return }
    navigator.clipboard?.writeText(composed)
      .then(() => flash('🧾 已複製組合 prompt — 直接貼到聊天室即可', 5000))
      .catch(() => flash('複製失敗 — 請直接框選下方預覽文字手動複製', 5000))
  }

  // 結帳出口 2/3（少爺 2026-07-06）：送入既有聊天室 / 直接開新聊天室（走 /api/claude/run）
  const [showSendMenu, setShowSendMenu] = useState(false)
  const [chatSessions, setChatSessions] = useState([])
  const openSendMenu = async () => {
    if (!cart.length && !draft.trim()) { flash('購物車是空的——先點選名詞或寫描述'); return }
    // 少爺 2026-07-06：要像 History 那樣列「全部」聊天室 → 改用 /api/history（掃全部 transcript、mtime 新到舊）
    const d = await fetch('/api/history').then(r => r.json()).catch(() => null)
    setChatSessions(d?.sessions ?? [])
    setShowSendMenu(v => !v)
  }
  const sendToChat = async (sessionId, projectPath) => {
    setShowSendMenu(false)
    const _path = projectPath ?? 'C:/Project/RomanPrototype'
    const r = await fetch('/api/claude/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: _path, prompt: composed, sessionId: sessionId ?? null, attachments }),
    }).then(r => r.json()).catch(() => ({ ok: false }))
    if (!r.ok) { flash('送入失敗 — 請改用複製', 6000); return }
    // 少爺 2026-07-07：送入/開新聊天室＝侍酒師工作完成 → 清空購物車與描述(+附檔) + 無接縫導到 Chat（同 History Continue）
    setCart([])
    setDraft('')
    setAttachments([])
    setCartOpen(false)
    // ⚠️ onGoToChat 會切分頁 unmount Sommelier，[cart,draft] 持久化 effect 可能來不及跑 → 直接同步清 localStorage，
    // 避免 remount 時 draft 從舊值 re-hydrate（少爺 2026-07-08：cart 清了 draft 沒清的不對稱 bug 根因）
    try { localStorage.setItem(CART_STORE_KEY, JSON.stringify({ items: [], draft: '' })) } catch {}
    flash(r.queued ? `📨 已排入佇列（第 ${r.queuePos} 位）— 已切到 Chat` : '📨 已送入 — 已切到 Chat', 4000)
    onGoToChat?.({ sessionId: sessionId ?? r.sessionId ?? null, projectPath: _path })
  }

  // 成員按 region 分節(維持首次出現順序;無 region 的排最前)
  const regionGroups = useMemo(() => {
    if (!selected) return []
    const groups = new Map()
    for (const m of selected.members ?? []) {
      const key = m.region ?? ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(m)
    }
    return [...groups.entries()]
  }, [selected])

  const stale = daysAgo(data?.generatedAt)

  if (loading) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs">讀取名詞圖鑑…</div>

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Header:專案 + 新鮮度 + 搜尋 + 購物車 */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 flex flex-wrap items-center gap-2">
        <button onClick={() => { setSelectedName(null); setQuery(''); searchRef.current?.focus() }}
          className="text-[var(--gold)] text-xs tracking-widest uppercase" title="回到查詢起點">🍷 Sommelier</button>
        {projects.length > 1 && (
          <select value={projectId ?? ''} onChange={e => { setProjectId(e.target.value); setSelectedName(null) }}
            className="bg-transparent border border-[var(--border)] rounded text-[10px] px-1 py-0.5 text-[var(--text)]">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {projects.length === 1 && <span className="text-[10px] text-[var(--text)]">{projects[0].name}</span>}
        {onManageProjects && (
          <button onClick={onManageProjects} title="高桌會：分館（專案）認可管理"
            className="text-[10px] px-1 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50">🏛</button>
        )}
        {data && (
          <>
            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${stale > 7 ? 'border-amber-500/50 text-amber-400' : 'border-[var(--border)] text-[var(--text-muted)]'}`}
              title={data.generatedAt}>
              {data.commit ?? '?'} · {stale === 0 ? '今天萃取' : `${stale} 天前萃取`}{stale > 7 ? ' ⚠ 建議刷新' : ''}
            </span>
            <button onClick={copyExtract} title={payload?.extractCommand ?? ''}
              className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50">
              ⟳ 複製刷新指令
            </button>
          </>
        )}
        <div className="flex rounded border border-[var(--border)] overflow-hidden shrink-0">
          <button onClick={() => setMode('skeleton')} className={`px-2 py-0.5 text-[10px] ${mode === 'skeleton' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>🍷 骨架圖鑑</button>
          <button onClick={() => setMode('arch')} className={`px-2 py-0.5 text-[10px] ${mode === 'arch' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>🗺️ 架構關聯</button>
          <button onClick={() => setMode('memory')} className={`px-2 py-0.5 text-[10px] ${mode === 'memory' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>📓 拼圖</button>
          <button onClick={() => setMode('asset')} className={`px-2 py-0.5 text-[10px] ${mode === 'asset' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>🎨 藍圖資產</button>
        </div>
        <div className="flex-1" />
        {/* 常駐搜尋欄（四視圖共用；placeholder 隨視圖變）*/}
        <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder={mode === 'skeleton' ? '搜尋名詞 / 成員 / 註解(中文可)… 快捷鍵 /'
            : mode === 'arch' ? '搜尋架構 canvas / 節點 / 引用符號…'
            : mode === 'memory' ? '搜尋拼圖（名稱 / 摘要 / 內文）…'
            : '搜尋藍圖 / 父類…'}
          className="w-64 max-w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1 text-[11px] text-[var(--text)] outline-none" />
        <button onClick={() => setCartOpen(o => !o)}
          className={`text-[11px] px-2 py-1 rounded border ${cart.length ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'} hover:border-[var(--gold)]`}
          title="選件購物車">
          🛒 {cart.length > 0 && <span className="font-bold">{cart.length}</span>}
        </button>
      </div>

      {notice && <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--gold)] bg-[var(--gold)]/10 border-b border-[var(--gold)]/20">{notice}</div>}
      {error && <div className="shrink-0 px-3 py-2 text-[10px] text-red-400 whitespace-pre-wrap">{error}</div>}

      <div className="flex-1 flex min-h-0">
        {mode === 'arch' ? (
          <ArchView arch={arch} projectId={projectId} query={query} onJumpToSymbol={jumpToSymbol}
            cartKeys={cartKeys} onToggleNodeCart={toggleCartNode} />
        ) : mode === 'memory' ? (
          <MemoryView memory={memory} projectId={projectId} query={query} onJumpToSymbol={jumpToSymbol}
            onJumpToCanvas={jumpToCanvas} cartKeys={cartKeys} onToggleNoteCart={toggleCartNote} />
        ) : mode === 'asset' ? (
          <AssetView assetGraph={assetGraph} projectId={projectId} query={query} onJumpToSymbol={jumpToSymbol}
            cartKeys={cartKeys} onToggleBpCart={toggleCartBp} />
        ) : (<>
        {/* 左:樹 / 搜尋結果 */}
        <div className="w-72 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
          {hits ? (
            <>
              <div className="text-[9px] text-[var(--text-muted)] px-1 mb-1">{hits.length} 個命中{hits.length >= 120 ? '(已截斷)' : ''}</div>
              {hits.map(({ sym, memberHits }) => (
                <div key={sym.id ?? sym.name} className="mb-0.5">
                  <div className="flex items-center">
                    <button onClick={() => setSelectedName(sym.name)}
                      className={`flex-1 text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 min-w-0 ${selectedName === sym.name ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                      <span className="text-[9px] text-[var(--text-muted)]">{KIND_META[sym.kind]?.icon ?? '·'}</span>
                      <code className="truncate">{sym.name}</code>
                      {memberHits.length > 0 && <span className="ml-auto text-[8px] text-[var(--text-muted)] shrink-0">{memberHits.length} 成員</span>}
                    </button>
                    <CartButton inCart={cartKeys.has(symbolKey(projectId, sym))} onClick={() => toggleCartSymbol(sym)} title="加入整個條目" />
                  </div>
                  {memberHits.slice(0, 4).map(m => (
                    <div key={`${m.name}:${m.line}`} className="ml-7 flex items-center gap-1 min-w-0">
                      <span className="text-[9px] text-[var(--text-muted)] truncate flex-1">
                        {MEMBER_ICON[m.kind] ?? '·'} {m.name}{m.comment ? ` — ${m.comment.split('\n')[0]}` : ''}
                      </span>
                      <CartButton inCart={cartKeys.has(memberKey(projectId, sym, m))} onClick={() => toggleCartMember(sym, m)} title="加入購物車" />
                    </div>
                  ))}
                </div>
              ))}
              {hits.length === 0 && <div className="text-[10px] text-[var(--text-muted)] px-2 py-4">查無命中 — 這個名詞可能是【加新】的機會</div>}
            </>
          ) : (
            [...tree.entries()].map(([mod, kinds]) => (
              <div key={mod} className="mb-1">
                <button onClick={() => toggle(`m:${mod}`)}
                  className="w-full text-left px-1 py-1 text-[10px] uppercase tracking-widest text-[var(--gold)]/80">
                  {collapsed.has(`m:${mod}`) ? '▸' : '▾'} {mod}
                </button>
                {!collapsed.has(`m:${mod}`) && [...kinds.entries()]
                  .sort((a, b) => (KIND_META[a[0]]?.order ?? 9) - (KIND_META[b[0]]?.order ?? 9))
                  .map(([kind, arr]) => (
                    <div key={kind} className="ml-2">
                      <button onClick={() => toggle(`k:${mod}:${kind}`)}
                        className="w-full text-left px-1 py-0.5 text-[10px] text-[var(--text-muted)]">
                        {collapsed.has(`k:${mod}:${kind}`) ? '▸' : '▾'} {KIND_META[kind]?.icon} {KIND_META[kind]?.label ?? kind}
                        <span className="ml-1 text-[8px]">({arr.length})</span>
                      </button>
                      {!collapsed.has(`k:${mod}:${kind}`) && arr.map(s => (
                        <button key={s.id ?? s.name} onClick={() => setSelectedName(s.name)}
                          className={`w-full text-left pl-5 pr-2 py-0.5 rounded text-[11px] flex items-center ${selectedName === s.name ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                          <code className="truncate">{s.name}</code>
                          <span className="ml-auto text-[8px] text-[var(--text-muted)]">{s.members?.length ?? 0}</span>
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            ))
          )}
        </div>

        {/* 中:條目細節 */}
        <div className="flex-1 overflow-y-auto p-3 min-w-0">
          {!selected ? (
            <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-xl mx-auto mt-10 space-y-3">
              <div className="text-[var(--gold)] text-sm">🍷 侍酒師為您服務</div>
              <p>左側是專案的<b>空間樹</b>:模組 → 種類 → 名詞。點任一名詞看條目——繼承鏈、pragma region 分節的成員、以及從程式碼註解收割的說明。</p>
              <p>上方搜尋框吃<b>名稱、成員、註解全文(含中文)</b>,快捷鍵 <code>/</code>。查無命中時,代表這個概念目前專案裡沒有——那就是「加新」的訊號。</p>
              <p>看到相關的名詞,點 <span className="text-[var(--gold)]">🛒</span> 加入選件;右上角購物車裡寫下你的需求描述,<b>結帳</b>會把「描述 + 選件錨點」組成 prompt 複製,貼到聊天室 Claude 就有精準上下文。<code>Esc</code> 隨時回到查詢。</p>
              {data && <p className="text-[9px]">目前庫藏:{data.stats.headers} 個 header、{data.stats.functions} 函式、{data.stats.properties} 屬性,萃取於 {data.branch} @ {data.commit}。</p>}
            </div>
          ) : (
            <div className="max-w-3xl">
              {/* 條目頭 */}
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => { setSelectedName(null); searchRef.current?.focus() }}
                  className="text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]" title="關閉條目,回到查詢(Esc)">←</button>
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">
                  {KIND_META[selected.kind]?.icon} {KIND_META[selected.kind]?.label ?? selected.kind}
                </span>
                <code className="text-base text-[var(--text)]">{selected.name}</code>
                {selected.reflected && <span className="text-[8px] px-1 rounded border border-[var(--gold)]/30 text-[var(--gold)]/70" title={selected.specs ?? ''}>REFLECTED</span>}
                <button onClick={() => toggleCartSymbol(selected)}
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${cartKeys.has(symbolKey(projectId, selected)) ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                  {cartKeys.has(symbolKey(projectId, selected)) ? '🛒✓ 已在購物車' : '🛒 加入整個條目'}
                </button>
                <button onClick={() => openSource(selected.file, selected.line)}
                  className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)]" title="在 VSCode 開啟">
                  {selected.file}:{selected.line} ↗
                </button>
              </div>

              {/* 繼承鏈 */}
              {(selected.bases?.length > 0 || derivedIndex.get(selected.name)?.length > 0) && (
                <div className="mt-2 text-[10px] space-y-0.5">
                  {selected.bases?.length > 0 && (
                    <div className="text-[var(--text-muted)]">繼承自:
                      {selected.bases.map(b => byName.has(b)
                        ? <button key={b} onClick={() => setSelectedName(b)} className="ml-1 text-[var(--gold)]/90 hover:underline"><code>{b}</code></button>
                        : <code key={b} className="ml-1 text-[var(--text-muted)]">{b}</code>)}
                    </div>
                  )}
                  {derivedIndex.get(selected.name)?.length > 0 && (
                    <div className="text-[var(--text-muted)]">被繼承 / 被實作:
                      {derivedIndex.get(selected.name).map(n =>
                        <button key={n} onClick={() => setSelectedName(n)} className="ml-1 text-[var(--gold)]/90 hover:underline"><code>{n}</code></button>)}
                    </div>
                  )}
                </div>
              )}

              {selected.comment && (
                <div className="mt-2 text-[11px] text-[var(--text)] whitespace-pre-wrap border-l-2 border-[var(--gold)]/30 pl-2">{selected.comment}</div>
              )}

              {/* 🗺️ 架構脈絡：這個符號出現在哪些架構 canvas 系統節點 */}
              {symbolCanvasIndex[selected.name]?.length > 0 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">🗺️ 架構脈絡（出現在這些系統節點）</div>
                  {symbolCanvasIndex[selected.name].map((ref, i) => (
                    <button key={i} onClick={() => setMode('arch')}
                      className="block w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]">
                      <span className="text-[var(--gold)]/60">{ref.canvasTitle}</span> → {ref.nodeTitle}
                    </button>
                  ))}
                </div>
              )}

              {/* 📓 拼圖脈絡：這個符號沉澱在哪些記憶 */}
              {symbolMemoryIndex[selected.name]?.length > 0 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">📓 拼圖脈絡（沉澱在這些記憶）</div>
                  {symbolMemoryIndex[selected.name].slice(0, 8).map((ref, i) => (
                    <button key={i} onClick={() => setMode('memory')}
                      className="block w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]">
                      <span className="text-[var(--gold)]/60">{MEMORY_TYPE_META[ref.type]?.icon ?? '📓'}</span> {ref.title}
                    </button>
                  ))}
                </div>
              )}

              {/* 🎨 藍圖脈絡：這個 C++ 類被哪些藍圖繼承 */}
              {symbolBpIndex[selected.name]?.length > 0 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">🎨 藍圖脈絡（被這些藍圖繼承）</div>
                  {symbolBpIndex[selected.name].slice(0, 10).map((ref, i) => (
                    <button key={i} onClick={() => setMode('asset')}
                      className="block w-full text-left text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)]">
                      ◇ {ref.name} <span className="text-[8px]">({ref.class})</span>
                    </button>
                  ))}
                </div>
              )}

              {/* 成員(pragma region 分節)*/}
              <div className="mt-3 space-y-3">
                {regionGroups.map(([region, members]) => (
                  <div key={region || '(top)'}>
                    {region && (
                      <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70 border-b border-[var(--border)] pb-0.5 mb-1">
                        § {region}
                      </div>
                    )}
                    <div className="space-y-0.5">
                      {members.map((m, idx) => (
                        <MemberRow key={`${m.name}:${m.line ?? idx}`} m={m} file={selected.file}
                          highlight={matchedMemberSet.has(`${m.name}:${m.line}`)} onOpenSource={openSource}
                          inCart={cartKeys.has(memberKey(projectId, selected, m))}
                          onToggleCart={(mm) => toggleCartMember(selected, mm)} />
                      ))}
                    </div>
                  </div>
                ))}
                {(selected.members?.length ?? 0) === 0 && (
                  <div className="text-[10px] text-[var(--text-muted)]">此條目沒有萃取到成員(委派 / 前向宣告)。</div>
                )}
              </div>
            </div>
          )}
        </div>

        </>)}
        {/* 右:購物車抽屜 */}
        {cartOpen && (
          <div className="absolute inset-y-0 right-0 w-96 max-w-[92vw] z-10 bg-[var(--surface)] border-l border-[var(--gold)]/30 shadow-2xl flex flex-col">
            <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
              <span className="text-[var(--gold)] text-xs">🛒 選件購物車({cart.length})</span>
              <div className="flex-1" />
              {cart.length > 0 && (
                <button onClick={() => setCart([])} className="text-[9px] text-[var(--text-muted)] hover:text-red-400">清空選件</button>
              )}
              <button onClick={() => setCartOpen(false)} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]" title="關閉(Esc)">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* 描述 */}
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">你的需求描述</div>
                <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={4}
                  placeholder="例:野蠻人要對玩家套用移動的權重,我想沿用/擴充下面選的機制…"
                  className="w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1.5 text-[11px] text-[var(--text)] outline-none resize-y" />
                {/* 附加檔案給 Claude 分析(仿 CHAT Upload from computer;結帳送入聊天室時一併傳) */}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <button onClick={() => attachInputRef.current?.click()}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/60">⬆ 附加檔案</button>
                  <input ref={attachInputRef} type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv" className="hidden" onChange={handleAttachFiles} />
                  {attachments.map((a, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] flex items-center gap-1">
                      📎 {a.name}
                      <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-[var(--text-muted)] hover:text-red-400" title="移除">✕</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* 選件列表 */}
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">選件(結帳前可移除)</div>
                {cart.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">還沒有選件——在條目或搜尋結果點 🛒 加入。</div>}
                <div className="space-y-1">
                  {cart.map(it => (
                    <div key={it.key} className="flex items-start gap-2 px-2 py-1 rounded border border-[var(--border)]">
                      <span className="text-[9px] text-[var(--text-muted)] w-3 text-center shrink-0">
                        {it.nodeKind === 'archNode' ? '🗺️' : it.nodeKind === 'memoryNote' ? '📓' : it.nodeKind === 'bp' ? '🎨' : it.member ? (MEMBER_ICON[it.kind] ?? '·') : (KIND_META[it.kind]?.icon ?? '◆')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <code className="text-[10px] text-[var(--text)] break-all">
                          {it.nodeKind === 'archNode' ? it.nodeTitle : it.nodeKind === 'memoryNote' ? it.noteTitle : it.nodeKind === 'bp' ? it.bpName : it.member ? `${it.symbol}::${it.member}` : it.symbol}
                        </code>
                        {it.nodeKind === 'archNode'
                          ? <div className="text-[9px] text-[var(--text-muted)] truncate">{it.canvasTitle}</div>
                          : it.nodeKind === 'memoryNote'
                          ? <div className="text-[9px] text-[var(--text-muted)] truncate">{it.description || MEMORY_TYPE_META[it.noteType]?.label}</div>
                          : it.nodeKind === 'bp'
                          ? <div className="text-[9px] text-[var(--text-muted)] truncate">{it.bpClass} · 繼承 {it.parentName}</div>
                          : it.comment && <div className="text-[9px] text-[var(--text-muted)] truncate">{it.comment.split('\n')[0]}</div>}
                      </div>
                      <button onClick={() => setCart(c => c.filter(x => x.key !== it.key))}
                        className="text-[10px] text-[var(--text-muted)] hover:text-red-400 shrink-0" title="移除">✕</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 組合預覽 */}
              {(cart.length > 0 || draft.trim()) && (
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">組合 prompt 預覽</div>
                  <pre className="text-[9px] text-[var(--text-muted)] whitespace-pre-wrap break-all border border-[var(--border)] rounded p-2 max-h-48 overflow-y-auto select-text">{composed}</pre>
                </div>
              )}
            </div>

            <div className="shrink-0 p-3 border-t border-[var(--border)] space-y-2">
              <button onClick={checkout}
                className="w-full py-2 rounded border border-[var(--gold)]/60 text-[var(--gold)] text-[11px] tracking-widest uppercase hover:bg-[var(--gold)]/10">
                🧾 結帳 — 複製組合 Prompt
              </button>
              {/* 結帳出口 2/3（少爺 2026-07-06）：送入聊天室 / 開新聊天室 */}
              <div className="flex gap-2">
                <button onClick={openSendMenu}
                  className="flex-1 py-1.5 rounded border border-blue-500/50 text-blue-400 text-[10px] tracking-widest uppercase hover:bg-blue-500/10">
                  📨 送入聊天室…
                </button>
                <button onClick={() => sendToChat(null, null)}
                  className="flex-1 py-1.5 rounded border border-green-500/50 text-green-400 text-[10px] tracking-widest uppercase hover:bg-green-500/10">
                  ➕ 開新聊天室
                </button>
              </div>
              {showSendMenu && (
                <div className="border border-[var(--border)] rounded max-h-40 overflow-y-auto">
                  {chatSessions.length === 0 && (
                    <div className="px-2 py-2 text-[10px] text-[var(--text-muted)] text-center">沒有可用聊天室 — 用「開新聊天室」</div>
                  )}
                  {chatSessions.map(s => (
                    <button key={s.sessionId} onClick={() => sendToChat(s.sessionId, s.cwd ?? null)}
                      className="w-full text-left px-2 py-1.5 text-[10px] hover:bg-white/5 border-b border-[var(--border)]/50">
                      <span className="text-[var(--text)]">{s.title}</span>
                      <span className="ml-1 text-[var(--text-muted)]">
                        {new Date(s.mtime).toLocaleDateString()}{s.cwd ? ` · ${s.cwd.split(/[\\/]/).pop()}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
