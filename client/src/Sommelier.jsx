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

export function SommelierPanel() {
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(null)
  const [payload, setPayload] = useState(null)   // { data, extractCommand }
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState(null)
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
  useEffect(() => {
    try { localStorage.setItem(CART_STORE_KEY, JSON.stringify({ items: cart, draft })) } catch {}
  }, [cart, draft])

  const flash = useCallback((msg, ms = 4000) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), ms)
  }, [])

  useEffect(() => {
    fetch('/api/sommelier/projects').then(r => r.json())
      .then(d => {
        setProjects(d.projects ?? [])
        if (d.projects?.length) setProjectId(d.projects[0].id)
        else { setLoading(false); setError('尚未設定任何專案 — 編輯 ~/.claude/tc_user_config/sommelier.json') }
      })
      .catch(e => { setLoading(false); setError(String(e)) })
  }, [])

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
    const r = await fetch('/api/claude/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: projectPath ?? 'C:/Project/RomanPrototype', prompt: composed, sessionId: sessionId ?? null }),
    }).then(r => r.json()).catch(() => ({ ok: false }))
    flash(r.ok
      ? (r.queued ? `📨 已排入該聊天室佇列（第 ${r.queuePos} 位）` : (sessionId ? '📨 已送入聊天室 — 到 CHAT 分頁看回應' : '➕ 新聊天室已建立 — 到 CHAT 分頁看回應'))
      : '送入失敗 — 請改用複製', 6000)
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
        <div className="flex-1" />
        <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="搜尋名詞 / 成員 / 註解(中文可)… 快捷鍵 /"
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
              </div>

              {/* 選件列表 */}
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">選件(結帳前可移除)</div>
                {cart.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">還沒有選件——在條目或搜尋結果點 🛒 加入。</div>}
                <div className="space-y-1">
                  {cart.map(it => (
                    <div key={it.key} className="flex items-start gap-2 px-2 py-1 rounded border border-[var(--border)]">
                      <span className="text-[9px] text-[var(--text-muted)] w-3 text-center shrink-0">
                        {it.member ? (MEMBER_ICON[it.kind] ?? '·') : (KIND_META[it.kind]?.icon ?? '◆')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <code className="text-[10px] text-[var(--text)] break-all">
                          {it.member ? `${it.symbol}::${it.member}` : it.symbol}
                        </code>
                        {it.comment && <div className="text-[9px] text-[var(--text-muted)] truncate">{it.comment.split('\n')[0]}</div>}
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
