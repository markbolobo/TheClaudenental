import { useState, useEffect, useRef } from 'react'
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, closestCorners, useDroppable, DragOverlay } from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const COLUMNS = [
  { id: 'idea',       label: '想到了',  icon: '💡', color: 'text-yellow-300' },
  { id: 'discussing', label: '討論中',  icon: '🗣', color: 'text-blue-300' },
  { id: 'doing',      label: '實作中',  icon: '🔨', color: 'text-orange-300' },
  { id: 'verifying',  label: '驗證中',  icon: '🧪', color: 'text-purple-300' },
  { id: 'done',       label: '完成',    icon: '✅', color: 'text-green-300' },
  { id: 'paused',     label: '擱置',    icon: '⏸',  color: 'text-gray-400' },
  { id: 'storage',    label: '倉庫',    icon: '📦', color: 'text-stone-400' },
]
const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map(c => [c.id, c]))

// 階段建議啟發式：保守版（時間維度 + 明確語義關鍵字）
// 回傳建議 column id 或 null（無建議）
function suggestStageForCard(card) {
  const text = ((card.title ?? '') + ' ' + (card.note ?? '')).toLowerCase()
  const ageDays = (Date.now() - (card.updatedAt ?? card.createdAt ?? Date.now())) / 86400000
  // 內容明確訊號（最高優先）
  if (card.column !== 'done' && /(已完成|✅|完工|上線|ship(ped)?|done)/i.test(text)) return 'done'
  if (card.column === 'idea' && /(討論|提案|評估|想知道|請教)/.test(text)) return 'discussing'
  if (card.column === 'discussing' && /(去做|開工|動手|實作|implement)/i.test(text)) return 'doing'
  if (card.column === 'doing' && /(測試|驗證|看看|試一下|test)/i.test(text)) return 'verifying'
  // 時間維度（次優先，靜置太久建議擱置或推進）
  if (card.column === 'doing' && ageDays > 7) return 'paused'
  if (card.column === 'verifying' && ageDays > 5) return 'done'
  if (card.column === 'discussing' && ageDays > 14) return 'paused'
  return null
}

// Phase 5: 「下一步建議」— 比 stage suggestion 更廣，考慮自然進程而非只 mismatch
function nextStepForCard(card) {
  const text = ((card.title ?? '') + ' ' + (card.note ?? '')).toLowerCase()
  const ageDays = (Date.now() - (card.updatedAt ?? card.createdAt ?? Date.now())) / 86400000
  switch (card.column) {
    case 'idea':
      if (/(討論|提案|評估)/.test(text)) return { col: 'discussing', label: '進入討論', tone: 'normal' }
      if (ageDays > 30) return { col: 'storage', label: '想法太久未動 → 進倉庫', tone: 'cold' }
      return { col: 'discussing', label: '展開討論', tone: 'soft' }
    case 'discussing':
      if (/(去做|開工|動手|實作)/.test(text)) return { col: 'doing', label: '開工實作', tone: 'normal' }
      if (ageDays > 14) return { col: 'paused', label: '討論停滯 → 擱置', tone: 'warn' }
      return { col: 'doing', label: '達成共識後動手', tone: 'soft' }
    case 'doing':
      if (/(測試|驗證|跑跑看)/.test(text)) return { col: 'verifying', label: '送驗證', tone: 'normal' }
      if (ageDays > 7) return { col: 'paused', label: '實作卡住 → 擱置查原因', tone: 'warn' }
      return { col: 'verifying', label: '完成後送驗證', tone: 'soft' }
    case 'verifying':
      if (/(已完成|通過|✅|ok)/.test(text)) return { col: 'done', label: '驗證通過 → 結案', tone: 'normal' }
      if (ageDays > 5) return { col: 'doing', label: '驗證未過 → 回實作', tone: 'warn' }
      return { col: 'done', label: '驗證通過後結案', tone: 'soft' }
    case 'paused':
      if (ageDays > 30) return { col: 'storage', label: '長期擱置 → 進倉庫', tone: 'cold' }
      return { col: 'doing', label: '解鎖後可拖回實作', tone: 'soft' }
    case 'done':
      return null
    case 'storage':
      return { col: 'idea', label: '時機到 → 翻出來', tone: 'soft' }
    default:
      return null
  }
}

// 拖卡進入這些 column 會彈視窗讓使用者選 session（需要 Claude 動作的階段）
const TRIGGER_CHAT_COLUMNS = new Set(['discussing', 'doing', 'verifying'])

// 根據 from→to 產生 prompt 模板
function buildPromptForTransition(card, fromCol, toCol) {
  const prefix = {
    discussing: '討論這張 TODO 卡',
    doing: '開始實作這張 TODO 卡',
    verifying: '幫我驗證這張 TODO 卡',
  }[toCol] ?? '處理這張 TODO 卡'
  const themeNote = card.themeId ? `\n主題：${card.themeId}` : ''
  const cardNote = card.note ? `\n\n## 卡片內容\n${card.note}` : ''
  return `${prefix}：${card.title}${themeNote}${cardNote}\n\n（從 TODO 看板拖曳推進：${fromCol} → ${toCol}）`
}

export function TodoBoard({ sessions = [], onTriggerChat }) {
  const [cards, setCards] = useState([])
  const [tags, setTags] = useState([])
  const [activeThemes, setActiveThemes] = useState(new Set())
  const [storageExpanded, setStorageExpanded] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashCards, setTrashCards] = useState([])
  const [activeCardId, setActiveCardId] = useState(null)  // 詳情抽屜
  const [pendingDrag, setPendingDrag] = useState(null)    // { card, fromCol, toCol } 拖曳後彈窗用
  // 純方向 B：等 ChatPanel 送出後才 commit 的 pending transition
  // 重整 / 切 tab 仍可從 sessionStorage 復原
  const [pendingTransition, setPendingTransition] = useState(() => {
    try {
      const raw = sessionStorage.getItem('tc_pending_todo_transition')
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  })
  // 監聽 sessionStorage（Chat 送出後 commit 會 removeItem，要同步刷掉視覺 ring）
  // 用 polling（sessionStorage 沒 storage event in 同 tab，跨 tab 才有）
  useEffect(() => {
    if (!pendingTransition) return
    const tick = setInterval(() => {
      const raw = sessionStorage.getItem('tc_pending_todo_transition')
      if (!raw) {
        setPendingTransition(null)
        // server 端已被 ChatPanel commit，重新拉一次卡片狀態
        reloadCards()
      }
    }, 500)
    return () => clearInterval(tick)
  }, [pendingTransition?.cardId])
  const [tagManagerOpen, setTagManagerOpen] = useState(false)  // Phase 2: tag 管理 modal
  const [searchQuery, setSearchQuery] = useState('')           // Phase 3: 搜尋
  const [storageQuery, setStorageQuery] = useState('')         // Phase 4: 倉庫獨立搜尋
  // P2 階段 1：個人/工作分類
  const [categories, setCategories] = useState([])
  const [activeCategoryId, setActiveCategoryId] = useState(() => {
    try { return localStorage.getItem('tc_todo_active_category') || 'cat-personal' } catch { return 'cat-personal' }
  })
  useEffect(() => { try { localStorage.setItem('tc_todo_active_category', activeCategoryId) } catch {} }, [activeCategoryId])

  // P2 階段 4：協作者管理
  const [allUsers, setAllUsers] = useState([])
  const [currentUser, setCurrentUser] = useState(null)
  const [usersModalOpen, setUsersModalOpen] = useState(false)
  const [invites, setInvites] = useState([])

  async function reloadUsers() {
    try {
      const me = await fetch('/api/auth/whoami').then(r => r.json())
      if (me?.ok) setCurrentUser(me.user)
    } catch {}
    try {
      const d = await fetch('/api/auth/users').then(r => r.json())
      if (d?.users) setAllUsers(d.users)
    } catch {}
    try {
      const d = await fetch('/api/auth/invites').then(r => r.json())
      if (d?.invites) setInvites(d.invites)
    } catch {}
  }
  useEffect(() => { reloadUsers() }, [])

  const collaborators = allUsers.filter(u => u.role === 'collaborator')
  const isOwner = currentUser?.role === 'owner'

  async function shareCard(cardId, userIds) {
    const r = await fetch(`/api/todos/${cardId}/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.card) setCards(c => c.map(x => x.id === cardId ? r.card : x))
  }
  async function unshareCard(cardId, userId) {
    const r = await fetch(`/api/todos/${cardId}/share/${userId}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.card) setCards(c => c.map(x => x.id === cardId ? r.card : x))
  }

  async function createInvite(label) {
    const r = await fetch('/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || '受邀協作者' }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.invite) {
      setInvites(prev => [...prev, r.invite])
      return r.invite
    }
    return null
  }
  async function revokeInvite(inviteId) {
    if (!window.confirm('撤銷這個邀請連結？已用過的不影響，未用的點擊將失效。')) return
    await fetch(`/api/auth/invites/${inviteId}`, { method: 'DELETE' })
    setInvites(prev => prev.filter(i => i.id !== inviteId))
  }
  async function revokeUser(userId) {
    if (!window.confirm('撤銷此協作者？\n他將無法再登入，被分享的卡也會自動取消他的存取。')) return
    await fetch(`/api/auth/users/${userId}`, { method: 'DELETE' })
    reloadUsers()
    reloadCards()
  }
  // Phase 6: 視圖模式 A=膠囊聚焦 / B=多看板全景；持久化
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('tc_todo_view') || 'A' } catch { return 'A' }
  })
  useEffect(() => { try { localStorage.setItem('tc_todo_view', viewMode) } catch {} }, [viewMode])

  // 重新載資料（衝突 / 還原後用）
  async function reloadCards() {
    const d = await fetch('/api/todos').then(r => r.json()).catch(() => ({ cards: [] }))
    setCards(d.cards ?? [])
  }
  async function reloadTags() {
    const d = await fetch('/api/todo-tags').then(r => r.json()).catch(() => ({ tags: [] }))
    setTags(d.tags ?? [])
  }

  async function reloadCategories() {
    const d = await fetch('/api/todo-categories').then(r => r.json()).catch(() => ({ categories: [] }))
    setCategories(d.categories ?? [])
  }

  useEffect(() => { reloadCards(); reloadTags(); reloadCategories() }, [])

  const themes = tags.filter(t => t.kind === 'theme' && !t.parentId)

  // 含 hop limit 的循環防護版（前後端對稱）
  function rootThemeOf(themeId) {
    const byId = new Map(tags.map(t => [t.id, t]))
    let cur = byId.get(themeId)
    let hops = 0
    while (cur?.parentId && hops++ < 16) cur = byId.get(cur.parentId)
    return cur
  }

  // P2 階段 1：先用 category 過濾（永遠生效，預設個人）
  const categoryFiltered = cards.filter(c => (c.categoryId ?? 'cat-personal') === activeCategoryId)

  const themeFiltered = activeThemes.size === 0
    ? categoryFiltered
    : categoryFiltered.filter(c => {
        if (!c.themeId) return false
        const root = rootThemeOf(c.themeId)
        return root && activeThemes.has(root.id)
      })

  // Phase 3: 搜尋過濾（title + note + tag 名稱）
  const q = searchQuery.trim().toLowerCase()
  const filteredCards = !q ? themeFiltered : themeFiltered.filter(c => {
    if ((c.title ?? '').toLowerCase().includes(q)) return true
    if ((c.note ?? '').toLowerCase().includes(q)) return true
    for (const tid of c.tagIds ?? []) {
      const t = tags.find(x => x.id === tid)
      if (t && t.name.toLowerCase().includes(q)) return true
    }
    if (c.themeId) {
      const t = tags.find(x => x.id === c.themeId)
      if (t && t.name.toLowerCase().includes(q)) return true
    }
    return false
  })

  // 全部紅點卡（受主題篩選）
  const mismatchedCards = filteredCards.filter(c => {
    const sug = suggestStageForCard(c)
    return sug && sug !== c.column
  })

  async function createCard(column, title) {
    if (!title?.trim()) return
    const themeId = activeThemes.size === 1 ? [...activeThemes][0] : null
    const r = await fetch('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column, title: title.trim(), themeId, categoryId: activeCategoryId }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) setCards(c => [...c, r.card])
  }

  // P2 階段 1：分類管理
  async function createCategory(name) {
    if (!name?.trim()) return
    const r = await fetch('/api/todo-categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), icon: '📁' }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) {
      setCategories(cs => [...cs, r.category])
      setActiveCategoryId(r.category.id)
    }
  }
  async function deleteCategory(id) {
    const cat = categories.find(c => c.id === id)
    if (!cat || cat.isBuiltIn) return
    const cardCount = cards.filter(c => c.categoryId === id).length
    const msg = cardCount > 0
      ? `刪除分類「${cat.name}」？\n${cardCount} 張卡會被搬到「個人」分類`
      : `刪除分類「${cat.name}」？`
    if (!window.confirm(msg)) return
    const r = await fetch(`/api/todo-categories/${id}`, { method: 'DELETE' }).then(r => r.json()).catch(() => null)
    if (r?.ok) {
      setCategories(cs => cs.filter(c => c.id !== id))
      if (activeCategoryId === id) setActiveCategoryId('cat-personal')
      reloadCards()
    }
  }

  async function patchCard(id, patch) {
    const target = cards.find(c => c.id === id)
    if (!target) return
    // optimistic
    setCards(c => c.map(x => x.id === id ? { ...x, ...patch } : x))
    const res = await fetch(`/api/todos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': String(target.version ?? 1) },
      body: JSON.stringify(patch),
    }).catch(() => null)
    if (!res) return
    if (res.status === 409) {
      // 另一裝置已先改
      const data = await res.json().catch(() => null)
      const ok = window.confirm('這張卡片已被另一裝置修改。\n按「確定」重新載入最新狀態（你的這次修改會被丟棄）\n按「取消」保留你的修改（按下次儲存會強制覆蓋）')
      if (ok) {
        if (data?.currentCard) setCards(c => c.map(x => x.id === id ? data.currentCard : x))
        else reloadCards()
      } else if (data?.currentCard) {
        // 強制覆蓋：把 version 提升到 server 的版本，下次 PATCH 才不會再衝突
        setCards(c => c.map(x => x.id === id ? { ...x, ...patch, version: data.currentCard.version } : x))
      }
      return
    }
    const json = await res.json().catch(() => null)
    if (json?.ok && json.card) setCards(c => c.map(x => x.id === id ? json.card : x))
  }

  async function deleteCard(id) {
    setCards(c => c.filter(x => x.id !== id))
    fetch(`/api/todos/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  async function openTrash() {
    setTrashOpen(true)
    const d = await fetch('/api/todos/trash').then(r => r.json()).catch(() => ({ cards: [] }))
    setTrashCards(d.cards ?? [])
  }

  async function restoreCard(id) {
    const r = await fetch(`/api/todos/${id}/restore`, { method: 'POST' }).then(r => r.json()).catch(() => null)
    if (r?.ok && r.card) {
      setTrashCards(c => c.filter(x => x.id !== id))
      setCards(c => [...c, r.card])
    }
  }

  async function purgeCard(id) {
    if (!window.confirm('永久刪除這張卡片？無法復原。')) return
    const r = await fetch(`/api/todos/${id}/purge`, { method: 'POST' }).then(r => r.json()).catch(() => null)
    if (r?.ok) setTrashCards(c => c.filter(x => x.id !== id))
  }

  // Tag 管理 API
  async function createTag(payload) {
    const r = await fetch('/api/todo-tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) await reloadTags()
    return r
  }
  async function patchTag(id, patch) {
    const r = await fetch(`/api/todo-tags/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) await reloadTags()
    else if (r?.error) alert(`修改失敗：${r.error}`)
    return r
  }
  async function deleteTag(id, replaceWith) {
    const url = replaceWith ? `/api/todo-tags/${id}?replaceWith=${encodeURIComponent(replaceWith)}` : `/api/todo-tags/${id}`
    const r = await fetch(url, { method: 'DELETE' }).then(r => r.json()).catch(() => null)
    if (r?.ok) { await reloadTags(); await reloadCards() }
    else if (r?.error) alert(`刪除失敗：${r.error}`)
    return r
  }

  // 一鍵套用所有紅點卡的階段建議：批次更新 column + 自動 append note 紀錄歷史
  async function applyAllSuggestions() {
    if (mismatchedCards.length === 0) return
    const summary = mismatchedCards.map(c => {
      const sug = suggestStageForCard(c)
      const oldL = COLUMN_BY_ID[c.column]?.label ?? c.column
      const newL = COLUMN_BY_ID[sug]?.label ?? sug
      return `  • ${c.title}\n    ${oldL} → ${newL}`
    }).join('\n')
    if (!window.confirm(`套用 ${mismatchedCards.length} 張卡的階段建議？\n\n${summary}\n\n（會自動記錄到 note，可隨時手動拖回）`)) return

    let ok = 0
    for (const c of mismatchedCards) {
      const sug = suggestStageForCard(c)
      if (!sug) continue
      const ts = new Date().toLocaleString('zh-TW', { hour12: false })
      const oldL = COLUMN_BY_ID[c.column]?.label ?? c.column
      const newL = COLUMN_BY_ID[sug]?.label ?? sug
      const noteLine = `\n\n[${ts}] 自動推進：${oldL} → ${newL}（階段建議：保守啟發式）`
      const newNote = (c.note ?? '') + noteLine
      try {
        await patchCard(c.id, { column: sug, note: newNote })
        ok++
      } catch {}
    }
    // 重新載資料確保 UI 與 server 同步
    await reloadCards()
  }

  async function reorderCards(updates) {
    fetch('/api/todos/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    }).catch(() => {})
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  // 拖曳中的卡片 + 當前懸停的目標欄（給 ghost preview 用）
  const [activeDragCard, setActiveDragCard] = useState(null)
  const [overColumn, setOverColumn] = useState(null)
  // 剛落定的卡片（給「成功落定」微動畫用）
  const [justSettledCardId, setJustSettledCardId] = useState(null)

  function handleDragStart(event) {
    const card = cards.find(c => c.id === event.active.id)
    setActiveDragCard(card ?? null)
  }

  function handleDragOver(event) {
    const { over } = event
    if (!over) { setOverColumn(null); return }
    if (typeof over.id === 'string' && over.id.startsWith('col:')) {
      setOverColumn(over.id.slice(4))
    } else {
      const overCard = cards.find(c => c.id === over.id)
      setOverColumn(overCard?.column ?? null)
    }
  }

  function handleDragEndCleanup(cardId) {
    setActiveDragCard(null)
    setOverColumn(null)
    if (cardId) {
      setJustSettledCardId(cardId)
      setTimeout(() => setJustSettledCardId(null), 600)
    }
  }

  function handleDragEnd(event) {
    const { active, over } = event
    handleDragEndCleanup(active.id)
    if (!over || active.id === over.id) return
    const activeCard = cards.find(c => c.id === active.id)
    if (!activeCard) return

    // 拖到欄位 drop zone
    if (typeof over.id === 'string' && over.id.startsWith('col:')) {
      const newCol = over.id.slice(4)
      if (activeCard.column === newCol) return
      // 進入需要 Claude 動作的欄位 → 彈視窗
      if (TRIGGER_CHAT_COLUMNS.has(newCol)) {
        setPendingDrag({ card: activeCard, fromCol: activeCard.column, toCol: newCol })
        return
      }
      // 純記錄類（done / paused / storage）→ 直接 patch，append 紀錄
      const ts = new Date().toLocaleString('zh-TW', { hour12: false })
      const oldL = COLUMN_BY_ID[activeCard.column]?.label ?? activeCard.column
      const newL = COLUMN_BY_ID[newCol]?.label ?? newCol
      const noteLine = `\n\n[${ts}] 手動拖曳：${oldL} → ${newL}`
      patchCard(active.id, { column: newCol, order: Date.now(), note: (activeCard.note ?? '') + noteLine })
      return
    }

    // 拖到別張卡
    const overCard = cards.find(c => c.id === over.id)
    if (!overCard) return

    if (activeCard.column !== overCard.column) {
      const newCol = overCard.column
      if (TRIGGER_CHAT_COLUMNS.has(newCol)) {
        setPendingDrag({ card: activeCard, fromCol: activeCard.column, toCol: newCol })
        return
      }
      const ts = new Date().toLocaleString('zh-TW', { hour12: false })
      const oldL = COLUMN_BY_ID[activeCard.column]?.label ?? activeCard.column
      const newL = COLUMN_BY_ID[newCol]?.label ?? newCol
      patchCard(active.id, {
        column: newCol,
        order: (overCard.order ?? 0) - 1,
        note: (activeCard.note ?? '') + `\n\n[${ts}] 手動拖曳：${oldL} → ${newL}`,
      })
    } else {
      // 同欄重排（不彈窗、不記錄 note）
      const colCards = cards.filter(c => c.column === activeCard.column).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const oldIdx = colCards.findIndex(c => c.id === active.id)
      const newIdx = colCards.findIndex(c => c.id === over.id)
      if (oldIdx < 0 || newIdx < 0) return
      const newOrder = arrayMove(colCards, oldIdx, newIdx)
      const updates = newOrder.map((c, i) => ({ id: c.id, order: i }))
      setCards(prev => prev.map(p => {
        const u = updates.find(x => x.id === p.id)
        return u ? { ...p, order: u.order } : p
      }))
      reorderCards(updates)
    }
  }

  // 拖曳後 modal：選擇接續方式
  function confirmDragRevert() {
    setPendingDrag(null)
    // 純拖回（其實 column 還沒改，所以什麼都不用做）
  }
  // 純方向 B：選 session 後不立刻 patchCard column
  // 改寫 sessionStorage pending；ChatPanel 真正送出後才 commit
  // 視覺：卡留在 fromCol，但用 ⏳ ring 標示「等送出落實」
  function confirmDragWithSession(sessionId) {
    if (!pendingDrag) return
    const { card, fromCol, toCol } = pendingDrag
    const fromL = COLUMN_BY_ID[fromCol]?.label ?? fromCol
    const toL   = COLUMN_BY_ID[toCol]?.label ?? toCol
    const prefillText = buildPromptForTransition(card, fromCol, toCol)
    try {
      sessionStorage.setItem('tc_pending_todo_transition', JSON.stringify({
        cardId: card.id, fromCol, toCol,
        fromColLabel: fromL, toColLabel: toL,
        sessionId, ts: Date.now(),
        prefillText,  // 重整 / 切 tab 後 ChatPanel 可從這還原 input
      }))
    } catch {}
    setPendingTransition({ cardId: card.id, fromCol, toCol, sessionId, ts: Date.now() })
    if (onTriggerChat) {
      onTriggerChat({ sessionId, prefillText })
    }
    setPendingDrag(null)
  }

  // 只移卡不啟動 Chat（少爺 2026-04-26 需求：避免「input 清空後卡已切階段」狀態不一致）
  function confirmDragMoveOnly() {
    if (!pendingDrag) return
    const { card, fromCol, toCol } = pendingDrag
    const ts = new Date().toLocaleString('zh-TW', { hour12: false })
    const oldL = COLUMN_BY_ID[fromCol]?.label ?? fromCol
    const newL = COLUMN_BY_ID[toCol]?.label ?? toCol
    const noteLine = `\n\n[${ts}] 手動拖曳：${oldL} → ${newL}（只移卡，未啟動 Chat）`
    patchCard(card.id, {
      column: toCol,
      order: Date.now(),
      note: (card.note ?? '') + noteLine,
    })
    setPendingDrag(null)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* P2 階段 1：個人/工作分類 tabs（最頂層） */}
      <div className="shrink-0 px-2 pt-1.5 pb-1 border-b border-[var(--border)] bg-[var(--surface-2)]/50 flex gap-1 overflow-x-auto items-center">
        {categories.map(cat => {
          const active = cat.id === activeCategoryId
          const count = cards.filter(c => (c.categoryId ?? 'cat-personal') === cat.id).length
          return (
            <div key={cat.id} className="shrink-0 flex items-center group/cat">
              <button onClick={() => setActiveCategoryId(cat.id)}
                style={active ? { borderColor: cat.color, color: cat.color, backgroundColor: cat.color + '22' } : undefined}
                className={`px-2.5 py-1 rounded-t text-[10px] font-semibold border-2 border-b-0 transition-colors ${
                  active ? '' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]'
                }`}>
                <span className="mr-1">{cat.icon}</span>{cat.name}
                <span className="ml-1.5 text-[8px] opacity-60">{count}</span>
              </button>
              {!cat.isBuiltIn && (
                <button onClick={() => deleteCategory(cat.id)}
                  className="opacity-0 group-hover/cat:opacity-100 text-[8px] text-red-400 hover:text-red-300 px-1 transition-opacity"
                  title="刪除自訂分類">✕</button>
              )}
            </div>
          )
        })}
        <button onClick={() => {
            const name = window.prompt('新分類名稱（例如「自由接案」「閱讀」）：')
            if (name?.trim()) createCategory(name)
          }}
          title="新增自訂分類"
          className="shrink-0 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] border-2 border-dashed border-[var(--border)] hover:border-[var(--gold-border)]">
          + 新分類
        </button>
        <div className="flex-1" />
        {/* P2 階段 4：協作者管理（owner only） */}
        {isOwner && (
          <button onClick={() => setUsersModalOpen(true)}
            title={`管理協作者（已邀請 ${collaborators.length} 人）`}
            className="shrink-0 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] flex items-center gap-1">
            👥 協作者 {collaborators.length > 0 && <span className="text-[8px] text-[var(--gold)]">{collaborators.length}</span>}
          </button>
        )}
        {currentUser && currentUser.role === 'collaborator' && (
          <span className="shrink-0 text-[9px] text-[var(--text-muted)]">
            👤 {currentUser.name} <span className="text-[var(--gold)]/70">(協作者)</span>
          </span>
        )}
      </div>

      {/* 主題膠囊列 */}
      <div className="shrink-0 px-2 py-2 border-b border-[var(--border)] flex gap-1.5 overflow-x-auto items-center">
        {/* Phase 6: A/B 視圖切換 */}
        <div className="shrink-0 flex border border-[var(--border)] rounded-full overflow-hidden">
          <button onClick={() => setViewMode('A')}
            title="A 聚焦：單一看板 + 主題膠囊（手機友善）"
            className={`px-2 py-0.5 text-[9px] font-semibold transition-colors ${
              viewMode === 'A' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>🎯 聚焦</button>
          <button onClick={() => setViewMode('B')}
            title="B 全景：每主題獨立看板（深度工作）"
            className={`px-2 py-0.5 text-[9px] font-semibold transition-colors ${
              viewMode === 'B' ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>🌐 全景</button>
        </div>

        {/* Phase 3: 搜尋框 */}
        <div className="shrink-0 relative">
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder="🔍 搜尋 title / note / tag"
            className="bg-[var(--surface)] border border-[var(--border)] rounded-full px-3 py-1 text-[10px] outline-none focus:border-[var(--gold-border)] w-44" />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-1">✕</button>
          )}
        </div>
        <button onClick={() => setActiveThemes(new Set())}
          className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
            activeThemes.size === 0
              ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
          }`}>全部</button>
        {themes.map(theme => {
          const active = activeThemes.has(theme.id)
          // Phase 6: B 模式單選 tab；A 模式多選膠囊
          const handleClick = () => setActiveThemes(s => {
            if (viewMode === 'B') {
              // 單選：點當前的清空（=全部）；點其他切換
              return active && s.size === 1 ? new Set() : new Set([theme.id])
            }
            const next = new Set(s)
            if (next.has(theme.id)) next.delete(theme.id); else next.add(theme.id)
            return next
          })
          const className = viewMode === 'B'
            ? `shrink-0 px-3 py-1 text-[11px] font-bold border-b-2 transition-colors ${
                active
                  ? ''
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`
            : `shrink-0 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                active ? '' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`
          const style = active
            ? (viewMode === 'B'
                ? { borderColor: theme.color, color: theme.color, backgroundColor: theme.color + '11' }
                : { borderColor: theme.color, color: theme.color, backgroundColor: theme.color + '22' })
            : undefined
          return (
            <button key={theme.id} onClick={handleClick} style={style} className={className}>
              <span className="mr-1" style={{ color: theme.color }}>●</span>{theme.name}
            </button>
          )
        })}
        <div className="flex-1" />
        {mismatchedCards.length > 0 && (
          <button onClick={applyAllSuggestions}
            title={`一鍵推進 ${mismatchedCards.length} 張紅點卡到建議階段（自動 note 記錄）`}
            className="shrink-0 px-2 py-1 rounded text-[10px] text-yellow-300 hover:text-yellow-200 border border-yellow-600/60 hover:bg-yellow-500/10 animate-pulse font-semibold">
            ⚡ 套用建議 ({mismatchedCards.length})
          </button>
        )}
        <button onClick={() => setTagManagerOpen(true)} title="標籤管理"
          className="shrink-0 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)]">
          🏷
        </button>
        <button onClick={openTrash} title="垃圾桶"
          className="shrink-0 px-2 py-1 rounded text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)]">
          🗑
        </button>
        <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{filteredCards.length} / {cards.length}</span>
      </div>

      {/* 看板 */}
      <DndContext sensors={sensors} collisionDetection={closestCorners}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragCancel={() => handleDragEndCleanup(null)}
                  onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto overflow-y-hidden flex gap-2 p-2 min-h-0">
          {COLUMNS.map(col => {
            let colCards = filteredCards.filter(c => c.column === col.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            // Phase 4: 倉庫獨立搜尋
            if (col.id === 'storage' && storageQuery.trim()) {
              const sq = storageQuery.trim().toLowerCase()
              colCards = colCards.filter(c =>
                (c.title ?? '').toLowerCase().includes(sq) ||
                (c.note ?? '').toLowerCase().includes(sq))
            }
            const visible = col.id === 'storage' && !storageExpanded && !storageQuery.trim() ? colCards.slice(-10) : colCards
            const isOverThisCol = overColumn === col.id
            const isTriggerTarget = isOverThisCol && activeDragCard && activeDragCard.column !== col.id && TRIGGER_CHAT_COLUMNS.has(col.id)
            const isPlainTarget = isOverThisCol && activeDragCard && activeDragCard.column !== col.id && !TRIGGER_CHAT_COLUMNS.has(col.id)
            const isStorage = col.id === 'storage'
            return (
              <Column key={col.id} col={col}
                cards={visible} totalCount={colCards.length}
                tags={tags}
                onCreate={(title) => createCard(col.id, title)}
                onPatch={patchCard} onDelete={deleteCard}
                onOpenDetail={(id) => setActiveCardId(id)}
                expandable={isStorage && colCards.length > 10 && !storageQuery.trim()}
                expanded={storageExpanded}
                onToggleExpand={() => setStorageExpanded(v => !v)}
                isTriggerTarget={isTriggerTarget}
                isPlainTarget={isPlainTarget}
                justSettledCardId={justSettledCardId}
                pendingTransitionCardId={pendingTransition?.cardId ?? null}
                pendingTransitionToCol={pendingTransition?.toCol ?? null}
                storageQuery={isStorage ? storageQuery : null}
                onStorageQueryChange={isStorage ? setStorageQuery : null}
                onBulkDelete={isStorage ? async (ids) => {
                  if (!ids.length) return
                  if (!window.confirm(`刪除 ${ids.length} 張倉庫卡？（可在垃圾桶還原）`)) return
                  for (const id of ids) await deleteCard(id)
                } : null} />
            )
          })}
        </div>
        <DragOverlay dropAnimation={{ duration: 250, easing: 'cubic-bezier(.6,.05,.3,1)' }}>
          {activeDragCard ? <DragGhost card={activeDragCard} tags={tags} /> : null}
        </DragOverlay>
      </DndContext>

      {/* 垃圾桶 modal */}
      {trashOpen && (
        <TrashModal cards={trashCards} tags={tags}
          onClose={() => setTrashOpen(false)}
          onRestore={restoreCard} onPurge={purgeCard} />
      )}

      {/* 卡片詳情抽屜 */}
      {activeCardId && (
        <CardDrawer card={cards.find(c => c.id === activeCardId)} tags={tags} themes={themes}
          categories={categories}
          collaborators={collaborators}
          isOwner={isOwner}
          onShare={shareCard}
          onUnshare={unshareCard}
          sessions={sessions}
          onClose={() => setActiveCardId(null)}
          onPatch={patchCard} onDelete={deleteCard}
          onContinueInChat={(card) => {
            // Phase 8: 回主線 — 跳對應 session + 預填續行 prompt
            const targetSession = card.sessionId ?? '__new__'
            const stageLabel = COLUMN_BY_ID[card.column]?.label ?? card.column
            const prefill = `回到 TODO 卡：${card.title}\n\n## 卡片狀態\n- 階段：${stageLabel}\n- 上次更新：${new Date(card.updatedAt ?? card.createdAt).toLocaleString('zh-TW', { hour12: false })}\n${card.note ? `\n## 卡片內容\n${card.note}\n` : ''}\n## 接續討論`
            onTriggerChat?.({ sessionId: targetSession, prefillText: prefill })
            setActiveCardId(null)
          }} />
      )}

      {/* 拖曳後 modal：選擇接續方式 */}
      {pendingDrag && (
        <DragActionModal
          pending={pendingDrag}
          sessions={sessions}
          onRevert={confirmDragRevert}
          onMoveOnly={confirmDragMoveOnly}
          onSelectSession={confirmDragWithSession} />
      )}

      {/* Tag 管理 modal */}
      {tagManagerOpen && (
        <TagManagerModal
          tags={tags}
          cards={cards}
          onClose={() => setTagManagerOpen(false)}
          onCreate={createTag}
          onPatch={patchTag}
          onDelete={deleteTag} />
      )}

      {/* P2 階段 4：協作者管理 modal（owner only） */}
      {usersModalOpen && isOwner && (
        <UsersModal
          collaborators={collaborators}
          invites={invites}
          onClose={() => setUsersModalOpen(false)}
          onCreateInvite={createInvite}
          onRevokeInvite={revokeInvite}
          onRevokeUser={revokeUser} />
      )}
    </div>
  )
}

function TagManagerModal({ tags, cards, onClose, onCreate, onPatch, onDelete }) {
  const [editing, setEditing] = useState(null)  // { id, name, color, parentId, kind }
  const [creating, setCreating] = useState(null)  // { name, color, parentId, kind }

  const themes = tags.filter(t => t.kind === 'theme')
  const labels = tags.filter(t => t.kind === 'tag')
  const cardCountByTagId = (() => {
    const map = new Map()
    for (const c of cards) {
      if (c.themeId) map.set(c.themeId, (map.get(c.themeId) ?? 0) + 1)
      for (const tid of c.tagIds ?? []) map.set(tid, (map.get(tid) ?? 0) + 1)
    }
    return map
  })()

  // 主題層級樹
  function ThemeNode({ theme, depth }) {
    const children = themes.filter(t => t.parentId === theme.id)
    const count = cardCountByTagId.get(theme.id) ?? 0
    return (
      <div>
        <div className="flex items-center gap-2 py-1.5 hover:bg-[var(--surface-2)] rounded group" style={{ paddingLeft: depth * 16 + 8 }}>
          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: theme.color }} />
          <span className="text-[11px] text-[var(--text)] flex-1">{theme.name}</span>
          <span className="text-[9px] text-[var(--text-muted)]">{count > 0 ? `${count} 卡` : '–'}</span>
          {theme.isBuiltIn && <span className="text-[8px] text-[var(--text-muted)] px-1 border border-[var(--border)] rounded">內建</span>}
          <button onClick={() => setEditing({ ...theme })}
            className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] hidden group-hover:inline px-1">改</button>
          {!theme.isBuiltIn && (
            <button onClick={async () => {
              if (count > 0 && !window.confirm(`此主題有 ${count} 張卡引用，刪除會清掉這些卡的主題標記。確定？`)) return
              if (count === 0 && !window.confirm('刪除此主題？')) return
              await onDelete(theme.id)
            }}
              className="text-[9px] text-[var(--text-muted)] hover:text-red-400 hidden group-hover:inline px-1">刪</button>
          )}
        </div>
        {children.map(c => <ThemeNode key={c.id} theme={c} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[min(680px,95vw)] max-h-[85vh] flex flex-col shadow-2xl">

        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[12px] font-semibold">🏷 標籤管理</span>
          <span className="text-[9px] text-[var(--text-muted)]">{tags.length} 個（{themes.length} 主題 / {labels.length} 標籤）</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-[14px]">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-4">

          {/* 主題（含層級） */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">主題（有層級）</span>
              <button onClick={() => setCreating({ name: '', color: '#9ca3af', parentId: null, kind: 'theme' })}
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] hover:bg-[var(--gold)]/10 ml-auto">+ 新增</button>
            </div>
            <div className="bg-[var(--surface-2)]/40 rounded p-1.5 max-h-[50vh] overflow-y-auto">
              {themes.filter(t => !t.parentId).map(t => <ThemeNode key={t.id} theme={t} depth={0} />)}
            </div>
          </div>

          {/* 標籤（扁平） */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">標籤（扁平）</span>
              <button onClick={() => setCreating({ name: '', color: '#9ca3af', parentId: null, kind: 'tag' })}
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] hover:bg-[var(--gold)]/10 ml-auto">+ 新增</button>
            </div>
            <div className="bg-[var(--surface-2)]/40 rounded p-1.5 max-h-[50vh] overflow-y-auto">
              {labels.map(t => {
                const count = cardCountByTagId.get(t.id) ?? 0
                return (
                  <div key={t.id} className="flex items-center gap-2 py-1.5 px-2 hover:bg-[var(--surface-2)] rounded group">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                    <span className="text-[11px] text-[var(--text)] flex-1">{t.name}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">{count > 0 ? `${count} 卡` : '–'}</span>
                    {t.isBuiltIn && <span className="text-[8px] text-[var(--text-muted)] px-1 border border-[var(--border)] rounded">內建</span>}
                    <button onClick={() => setEditing({ ...t })}
                      className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] hidden group-hover:inline px-1">改</button>
                    {!t.isBuiltIn && (
                      <button onClick={async () => {
                        if (count > 0 && !window.confirm(`此標籤有 ${count} 張卡引用，刪除會清掉這些卡的標籤。確定？`)) return
                        if (count === 0 && !window.confirm('刪除此標籤？')) return
                        await onDelete(t.id)
                      }}
                        className="text-[9px] text-[var(--text-muted)] hover:text-red-400 hidden group-hover:inline px-1">刪</button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 編輯抽屜 */}
        {editing && (
          <TagEditPanel tag={editing} themes={themes}
            onCancel={() => setEditing(null)}
            onSave={async (patch) => { await onPatch(editing.id, patch); setEditing(null) }} />
        )}
        {creating && (
          <TagEditPanel tag={creating} themes={themes}
            isNew
            onCancel={() => setCreating(null)}
            onSave={async (data) => { await onCreate(data); setCreating(null) }} />
        )}

        <div className="px-4 py-2 border-t border-[var(--border)] text-[9px] text-[var(--text-muted)]">
          內建 tag 不可刪（可改名 / 改色）；自訂 tag 刪除會同步清掉所有卡片的引用。
        </div>
      </div>
    </div>
  )
}

function TagEditPanel({ tag, themes, isNew, onCancel, onSave }) {
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const [parentId, setParentId] = useState(tag.parentId ?? '')
  const [kind, setKind] = useState(tag.kind ?? 'tag')

  const PRESET_COLORS = ['#ef4444','#f59e0b','#eab308','#10b981','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#f43f5e','#fb923c','#facc15','#22c55e','#14b8a6','#0ea5e9','#a78bfa','#fb7185']

  return (
    <div className="border-t border-[var(--gold)]/40 bg-[var(--surface-2)] p-3 grid grid-cols-2 gap-3">
      <div>
        <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">名稱</div>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] outline-none focus:border-[var(--gold-border)]" />
      </div>
      <div>
        <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">類型</div>
        <select value={kind} onChange={e => setKind(e.target.value)}
          disabled={!isNew}
          className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] outline-none disabled:opacity-50">
          <option value="tag">標籤（扁平）</option>
          <option value="theme">主題（可有層級）</option>
        </select>
      </div>
      <div className="col-span-2">
        <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">顏色</div>
        <div className="flex gap-1 flex-wrap">
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              style={{ backgroundColor: c, outline: color === c ? '2px solid white' : 'none' }}
              className="w-5 h-5 rounded-full hover:scale-110 transition-transform" />
          ))}
          <input type="color" value={color} onChange={e => setColor(e.target.value)}
            className="w-5 h-5 rounded cursor-pointer" />
        </div>
      </div>
      {kind === 'theme' && (
        <div className="col-span-2">
          <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">父層（選填）</div>
          <select value={parentId} onChange={e => setParentId(e.target.value)}
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] outline-none">
            <option value="">（根層）</option>
            {themes.filter(t => t.id !== tag.id).map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="col-span-2 flex gap-2 justify-end">
        <button onClick={onCancel}
          className="text-[10px] px-3 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] border border-[var(--border)]">取消</button>
        <button onClick={() => onSave({ name: name.trim() || '(untitled)', color, parentId: parentId || null, kind })}
          disabled={!name.trim()}
          className="text-[10px] px-3 py-1 rounded text-[var(--gold)] border border-[var(--gold)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20 disabled:opacity-40">
          {isNew ? '新增' : '儲存'}
        </button>
      </div>
    </div>
  )
}

function DragActionModal({ pending, sessions, onRevert, onMoveOnly, onSelectSession }) {
  const { card, fromCol, toCol } = pending
  const fromL = COLUMN_BY_ID[fromCol]?.label ?? fromCol
  const toL = COLUMN_BY_ID[toCol]?.label ?? toCol
  const fromIcon = COLUMN_BY_ID[fromCol]?.icon ?? ''
  const toIcon = COLUMN_BY_ID[toCol]?.icon ?? ''
  const promptPreview = buildPromptForTransition(card, fromCol, toCol)
  const activeSessions = (sessions ?? []).filter(s => s.status === 'active' || s.status === 'waiting')
  const recentSessions = (sessions ?? []).filter(s => s.status !== 'active' && s.status !== 'waiting').slice(0, 5)

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onRevert}>
      <div onClick={e => e.stopPropagation()}
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[min(560px,95vw)] max-h-[85vh] flex flex-col shadow-2xl">

        {/* Header — 視覺化 from→to 動畫 */}
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">推進卡片</div>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="px-2 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)]">{fromIcon} {fromL}</span>
            <span className="text-[var(--gold)] animate-pulse">→</span>
            <span className="px-2 py-0.5 rounded bg-[var(--gold)]/20 border border-[var(--gold)] text-[var(--gold)] font-semibold">{toIcon} {toL}</span>
          </div>
          <div className="mt-2 text-[12px] text-[var(--text)] font-medium truncate">{card.title}</div>
        </div>

        {/* Prompt 預覽 */}
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface-2)]/30">
          <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">將預填到 Chat 輸入框（可編輯 / 不送出 / 加自由文字）</div>
          <div className="text-[10px] text-[var(--text-muted)] font-mono whitespace-pre-wrap max-h-24 overflow-y-auto leading-relaxed">{promptPreview}</div>
        </div>

        {/* 選項區 */}
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-[10px] text-[var(--text-muted)] font-semibold mb-1">選擇接續方式：</div>

          {/* 只移卡不啟動 Chat（解耦選項：避免 input 清空後狀態不一致） */}
          <button onClick={onMoveOnly}
            className="text-left px-3 py-2.5 rounded border border-stone-500/60 bg-stone-500/10 hover:bg-stone-500/20 transition-colors group">
            <div className="flex items-center gap-2">
              <span className="text-[14px]">📦</span>
              <span className="text-[11px] font-semibold text-stone-300">只移卡，不啟動 Chat</span>
            </div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5 ml-7">純粹推進階段，輸入框不動，之後想討論再點卡片</div>
          </button>

          <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest mt-1">啟動 Chat 並推進</div>

          {/* 新聊天室 */}
          <button onClick={() => onSelectSession('__new__')}
            className="text-left px-3 py-2.5 rounded border border-blue-500/60 bg-blue-500/10 hover:bg-blue-500/20 transition-colors group">
            <div className="flex items-center gap-2">
              <span className="text-[14px]">🆕</span>
              <span className="text-[11px] font-semibold text-blue-300">新聊天室</span>
            </div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5 ml-7">開全新對話，從頭討論這張卡</div>
          </button>

          {/* 進行中 sessions */}
          {activeSessions.length > 0 && (
            <>
              <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest mt-2">進行中 ({activeSessions.length})</div>
              {activeSessions.map(s => (
                <button key={s.id} onClick={() => onSelectSession(s.id)}
                  className="text-left px-3 py-2 rounded border border-[var(--gold)]/40 bg-[var(--gold)]/5 hover:bg-[var(--gold)]/15 transition-colors">
                  <div className="flex items-center gap-2">
                    <StatusDot status={s.status} />
                    <span className="text-[11px] text-[var(--text)] truncate">{s.displayName ?? s.id.slice(0, 8)}</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* 最近 sessions */}
          {recentSessions.length > 0 && (
            <>
              <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest mt-2">最近 ({recentSessions.length})</div>
              {recentSessions.map(s => (
                <button key={s.id} onClick={() => onSelectSession(s.id)}
                  className="text-left px-3 py-2 rounded border border-[var(--border)] hover:border-[var(--gold-border)] hover:bg-[var(--surface-2)] transition-colors">
                  <div className="flex items-center gap-2">
                    <StatusDot status={s.status} />
                    <span className="text-[11px] text-[var(--text-muted)] truncate">{s.displayName ?? s.id.slice(0, 8)}</span>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer — 取消按鈕加紅色強調 + 明確語意 */}
        <div className="px-4 py-2 border-t border-[var(--border)] flex items-center gap-2">
          <button onClick={onRevert}
            className="text-[10px] px-3 py-1.5 rounded text-red-300 hover:text-red-200 hover:bg-red-500/10 border border-red-500/40 font-semibold">
            ✕ 取消（卡片留在原階段）
          </button>
          <div className="flex-1 text-[9px] text-[var(--text-muted)] text-right">卡片現在還沒實際移動，點空白也等同取消</div>
        </div>
      </div>
    </div>
  )
}

// Phase 1: 拖曳期間跟著游標的「飛行版」卡片（DragOverlay 用）
function DragGhost({ card, tags }) {
  const theme = tags.find(t => t.id === card.themeId)
  const cardTags = (card.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean)
  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--gold)] rounded p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.5),0_0_18px_rgba(201,162,39,0.45)] cursor-grabbing rotate-1 scale-105 w-[224px]">
      <div className="flex gap-1 items-start">
        {theme && <div className="w-1 self-stretch rounded-full shrink-0 min-h-[16px]" style={{ backgroundColor: theme.color }} />}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-[var(--text)] leading-tight break-words">{card.title}</div>
          {cardTags.length > 0 && (
            <div className="flex gap-0.5 flex-wrap mt-1">
              {cardTags.map(t => (
                <span key={t.id} className="text-[8px] px-1 rounded border" style={{ color: t.color, borderColor: t.color + '88' }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusDot({ status }) {
  const colors = { active: 'bg-green-500', waiting: 'bg-amber-500', stopped: 'bg-gray-500', completed: 'bg-blue-500' }
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? 'bg-gray-600'}`} />
}

function TrashModal({ cards, tags, onClose, onRestore, onPurge }) {
  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-start justify-center pt-12" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-[var(--surface)] border border-[var(--border)] rounded-lg w-[min(560px,90vw)] max-h-[70vh] flex flex-col shadow-2xl">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[12px] font-semibold">🗑 垃圾桶</span>
          <span className="text-[9px] text-[var(--text-muted)]">{cards.length} 筆</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-[14px]">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
          {cards.length === 0 && <div className="text-[10px] text-[var(--text-muted)] text-center py-4">沒有已刪除卡片</div>}
          {cards.map(card => {
            const theme = tags.find(t => t.id === card.themeId)
            const ago = Math.floor((Date.now() - card.deletedAt) / 60000)
            return (
              <div key={card.id} className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 flex items-center gap-2">
                {theme && <div className="w-1 self-stretch rounded-full" style={{ backgroundColor: theme.color }} />}
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] truncate">{card.title}</div>
                  <div className="text-[8px] text-[var(--text-muted)]">刪除於 {ago < 60 ? `${ago}m` : `${Math.floor(ago/60)}h`} 前</div>
                </div>
                <button onClick={() => onRestore(card.id)} title="還原"
                  className="text-[9px] px-1.5 py-0.5 rounded border border-green-500/50 text-green-400 hover:bg-green-500/10">↑ 還原</button>
                <button onClick={() => onPurge(card.id)} title="永久刪除"
                  className="text-[9px] px-1.5 py-0.5 rounded border border-red-500/50 text-red-400 hover:bg-red-500/10">永久刪</button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// P2 階段 4：CardDrawer 內的分享區塊
function ShareSection({ card, collaborators, onShare, onUnshare }) {
  const [picking, setPicking] = useState(false)
  const sharedIds = new Set(card.sharedWith ?? [])
  const sharedUsers = collaborators.filter(u => sharedIds.has(u.id))
  const unsharedUsers = collaborators.filter(u => !sharedIds.has(u.id))

  return (
    <div className="border-t border-[var(--border)] pt-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">分享給協作者</div>
        <span className="text-[9px] text-[var(--text-muted)]">{sharedUsers.length} 人</span>
        <div className="flex-1" />
        {!picking && unsharedUsers.length > 0 && (
          <button onClick={() => setPicking(true)}
            className="text-[10px] text-[var(--gold)] hover:bg-[var(--gold)]/10 px-2 py-0.5 rounded border border-[var(--gold)]/40">
            + 分享
          </button>
        )}
      </div>

      {/* 已分享名單 */}
      {sharedUsers.length === 0 && !picking && (
        <div className="text-[10px] text-[var(--text-muted)] opacity-60 py-1">尚未分享。協作者會在自己的 dashboard 收到。</div>
      )}
      {sharedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sharedUsers.map(u => (
            <div key={u.id} className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--gold)]/40">
              <span className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold" style={{ backgroundColor: u.color, color: '#000' }}>{u.name[0]?.toUpperCase()}</span>
              <span className="text-[10px] text-[var(--text)]">{u.name}</span>
              <button onClick={() => onUnshare(card.id, u.id)} title="撤回分享" className="text-[10px] text-red-400/70 hover:text-red-400">✕</button>
            </div>
          ))}
        </div>
      )}

      {/* 選擇要分享的人 */}
      {picking && (
        <div className="mt-2 p-2 rounded bg-[var(--surface-2)] border border-[var(--gold)]/30 flex flex-col gap-1">
          {unsharedUsers.length === 0 ? (
            <div className="text-[10px] text-[var(--text-muted)]">沒有可分享的協作者，先去頂部「👥 協作者」邀請。</div>
          ) : (
            unsharedUsers.map(u => (
              <button key={u.id} onClick={() => { onShare(card.id, [u.id]); setPicking(false) }}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--surface)] text-left">
                <span className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: u.color, color: '#000' }}>{u.name[0]?.toUpperCase()}</span>
                <span className="text-[11px] text-[var(--text)]">{u.name}</span>
              </button>
            ))
          )}
          <button onClick={() => setPicking(false)} className="text-[9px] text-[var(--text-muted)] mt-1 hover:text-[var(--text)]">取消</button>
        </div>
      )}
    </div>
  )
}

// P2 階段 4：協作者管理 Modal
function UsersModal({ collaborators, invites, onClose, onCreateInvite, onRevokeInvite, onRevokeUser }) {
  const [newLabel, setNewLabel] = useState('')
  const [latestInvite, setLatestInvite] = useState(null)

  const inviteUrl = (token) => `${window.location.origin}${window.location.pathname}?invite=${token}`

  async function handleCreate() {
    const inv = await onCreateInvite(newLabel || '受邀協作者')
    if (inv) {
      setLatestInvite(inv)
      setNewLabel('')
    }
  }
  function copyLink(token) {
    navigator.clipboard.writeText(inviteUrl(token))
      .then(() => alert('邀請連結已複製，可貼給對方'))
      .catch(() => alert('複製失敗，手動選取下方連結文字'))
  }

  const activeInvites = invites.filter(i => !i.usedByUserId && i.expiresAt > Date.now())

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg w-[min(640px,95vw)] max-h-[85vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[12px] font-semibold tracking-wider">👥 協作者管理</span>
          <span className="text-[9px] text-[var(--text-muted)]">{collaborators.length} 人 / 待用邀請 {activeInvites.length}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-[14px]">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* 已加入的協作者 */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">已加入</div>
            {collaborators.length === 0 ? (
              <div className="text-[10px] text-[var(--text-muted)] opacity-60 py-2">沒有協作者。下方生成邀請連結傳給對方即可加入。</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {collaborators.map(u => (
                  <div key={u.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)]">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ backgroundColor: u.color, color: '#000' }}>{u.name[0]?.toUpperCase()}</span>
                    <span className="text-[11px] text-[var(--text)] flex-1">{u.name}</span>
                    <span className="text-[9px] text-[var(--text-muted)]">加入於 {new Date(u.createdAt).toLocaleDateString('zh-TW')}</span>
                    <button onClick={() => onRevokeUser(u.id)} title="撤銷此協作者"
                      className="text-[9px] px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/40">撤銷</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 生成新邀請 */}
          <div className="border-t border-[var(--border)] pt-3">
            <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">生成邀請連結</div>
            <div className="flex gap-2">
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                placeholder="標籤（記憶用，例如「Alice 設計師」）"
                className="flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] outline-none focus:border-[var(--gold-border)]" />
              <button onClick={handleCreate}
                className="px-3 py-1.5 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/60 text-[var(--gold)] text-[10px] font-semibold hover:bg-[var(--gold)]/30">
                + 生成邀請
              </button>
            </div>
            {latestInvite && (
              <div className="mt-3 p-3 rounded bg-[var(--gold)]/5 border border-[var(--gold)]/40">
                <div className="text-[9px] text-[var(--gold)] mb-1.5 uppercase tracking-widest">✓ 已生成（複製給對方）</div>
                <div className="font-mono text-[9px] text-[var(--text)] break-all bg-[var(--surface-2)] p-1.5 rounded">{inviteUrl(latestInvite.token)}</div>
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={() => copyLink(latestInvite.token)}
                    className="text-[10px] px-2 py-1 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/60 text-[var(--gold)]">📋 複製</button>
                  <span className="text-[8px] text-[var(--text-muted)]">7 天到期 / 一次性</span>
                </div>
              </div>
            )}
          </div>

          {/* 待用邀請列表 */}
          {activeInvites.length > 0 && (
            <div className="border-t border-[var(--border)] pt-3">
              <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">待用邀請（還沒被點過）</div>
              <div className="flex flex-col gap-1">
                {activeInvites.map(inv => (
                  <div key={inv.id} className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)]">
                    <span className="text-[10px] text-[var(--text)] flex-1">{inv.label}</span>
                    <button onClick={() => copyLink(inv.token)}
                      className="text-[9px] text-[var(--gold)] hover:underline">複製連結</button>
                    <span className="text-[8px] text-[var(--text-muted)]">到期 {new Date(inv.expiresAt).toLocaleDateString('zh-TW')}</span>
                    <button onClick={() => onRevokeInvite(inv.id)} title="撤銷此邀請"
                      className="text-[9px] px-1 text-red-400 hover:bg-red-500/10 rounded">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[9px] text-[var(--text-muted)]/70 leading-relaxed border-t border-[var(--border)] pt-2 mt-1">
            <div className="font-semibold text-[var(--text-muted)] mb-1">提醒：</div>
            • 對方點 invite link 後填名字即可進入<br/>
            • 對方**只看得到你分享給他的卡片**，無法存取你的 chat / 規矩 / API key<br/>
            • 對方應該裝自己的 Claude Code 用自己的 API key 接手卡片（見 SETUP_FOR_COLLABORATOR.md）
          </div>
        </div>
      </div>
    </div>
  )
}

function CardDrawer({ card, tags, themes, categories = [], collaborators = [], isOwner = true, onShare, onUnshare, sessions = [], onClose, onPatch, onDelete, onContinueInChat }) {
  const [title, setTitle] = useState(card?.title ?? '')
  const [note, setNote] = useState(card?.note ?? '')
  useEffect(() => { setTitle(card?.title ?? ''); setNote(card?.note ?? '') }, [card?.id])

  if (!card) return null
  const theme = tags.find(t => t.id === card.themeId)
  const cardTags = (card.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean)
  const nonThemeTagIds = new Set(card.tagIds ?? [])
  const allTags = tags.filter(t => t.kind === 'tag')
  const linkedSession = card.sessionId ? sessions.find(s => s.id === card.sessionId) : null

  function commit(patch) { onPatch(card.id, patch) }
  function toggleTag(tagId) {
    const next = nonThemeTagIds.has(tagId)
      ? [...card.tagIds].filter(x => x !== tagId)
      : [...(card.tagIds ?? []), tagId]
    commit({ tagIds: next })
  }

  return (
    <div className="absolute inset-0 z-30 bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="absolute right-0 top-0 bottom-0 w-[min(360px,100vw)] bg-[var(--surface)] border-l border-[var(--border)] flex flex-col shadow-2xl">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">卡片詳情</span>
          <div className="flex-1" />
          {/* Phase 8: 回主線按鈕 */}
          {onContinueInChat && (
            <button onClick={() => onContinueInChat(card)}
              title={linkedSession ? `繼續在原 session 討論（${linkedSession.displayName ?? linkedSession.id.slice(0, 8)}）` : '在新 session 討論這張卡'}
              className="text-[10px] text-[var(--gold)] hover:bg-[var(--gold)]/15 px-2 py-0.5 rounded border border-[var(--gold)]/60 font-semibold">
              💬→ {linkedSession ? '回主線' : '討論'}
            </button>
          )}
          <button onClick={() => { if (window.confirm('刪除這張卡？（可在垃圾桶還原）')) { onDelete(card.id); onClose() } }}
            className="text-[10px] text-red-400/70 hover:text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">刪除</button>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-[14px] ml-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">標題</div>
            <input value={title} onChange={e => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() && title !== card.title) commit({ title: title.trim() }) }}
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[12px] outline-none focus:border-[var(--gold-border)]" />
          </div>

          {/* P2 階段 1：分類（個人/工作） */}
          {categories.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">分類</div>
              <div className="flex flex-wrap gap-1">
                {categories.map(cat => {
                  const cur = (card.categoryId ?? 'cat-personal') === cat.id
                  return (
                    <button key={cat.id} onClick={() => commit({ categoryId: cat.id })}
                      style={cur ? { borderColor: cat.color, color: cat.color, backgroundColor: cat.color + '22' } : undefined}
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${cur ? '' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                      <span className="mr-1">{cat.icon}</span>{cat.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">主題</div>
            <div className="flex flex-wrap gap-1">
              <button onClick={() => commit({ themeId: null })}
                className={`text-[10px] px-2 py-0.5 rounded-full border ${!card.themeId ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>無</button>
              {themes.map(t => (
                <button key={t.id} onClick={() => commit({ themeId: t.id })}
                  style={card.themeId === t.id ? { borderColor: t.color, color: t.color, backgroundColor: t.color + '22' } : undefined}
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${card.themeId === t.id ? '' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                  <span className="mr-1" style={{ color: t.color }}>●</span>{t.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">標籤</div>
            <div className="flex flex-wrap gap-1">
              {allTags.map(t => {
                const on = nonThemeTagIds.has(t.id)
                return (
                  <button key={t.id} onClick={() => toggleTag(t.id)}
                    style={on ? { borderColor: t.color, color: t.color, backgroundColor: t.color + '22' } : undefined}
                    className={`text-[9px] px-1.5 py-0.5 rounded border ${on ? '' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                    {t.name}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">備註</div>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              onBlur={() => { if (note !== card.note) commit({ note }) }}
              placeholder="補充說明、決策紀錄、上次討論摘要..."
              rows={6}
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] outline-none focus:border-[var(--gold-border)] resize-none" />
          </div>

          {/* P2 階段 4：分享給協作者（owner only） */}
          {isOwner && (
            <ShareSection
              card={card}
              collaborators={collaborators}
              onShare={onShare}
              onUnshare={onUnshare} />
          )}

          <div className="border-t border-[var(--border)] pt-2 text-[9px] text-[var(--text-muted)] space-y-0.5 font-mono">
            <div>id: {card.id}</div>
            <div>建立: {new Date(card.createdAt).toLocaleString()}</div>
            <div>更新: {new Date(card.updatedAt).toLocaleString()}</div>
            <div>版本: v{card.version ?? 1}</div>
            {card.parentId && <div>父卡: {card.parentId}</div>}
            {linkedSession ? (
              <div className="text-[var(--gold)]/80">
                session: {linkedSession.displayName ?? card.sessionId.slice(0, 8)} ({linkedSession.status})
              </div>
            ) : card.sessionId ? (
              <div>session: {card.sessionId.slice(0, 8)}...（已關閉）</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function Column({ col, cards, totalCount, tags, onCreate, onPatch, onDelete, onOpenDetail, expandable, expanded, onToggleExpand, isTriggerTarget, isPlainTarget, justSettledCardId, storageQuery, onStorageQueryChange, onBulkDelete, pendingTransitionCardId, pendingTransitionToCol }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}` })
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef(null)
  const [selectedIds, setSelectedIds] = useState(new Set())  // Phase 4: 倉庫批次選

  // Phase 1: 拖曳目標欄高亮（trigger column 用紅金 pulse；其他用淡金邊框）
  const colWrapClass = isTriggerTarget
    ? 'border-[#ffb627] shadow-[0_0_18px_rgba(255,182,39,0.55)] animate-pulse'
    : isPlainTarget
      ? 'border-[var(--gold-border)] shadow-[0_0_10px_rgba(201,162,39,0.30)]'
      : 'border-[var(--border)]'

  return (
    <div className={`shrink-0 w-[240px] flex flex-col bg-[var(--surface-2)] rounded border-2 transition-all duration-150 ${colWrapClass}`}>
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-[var(--border)]">
        <span className={col.color}>{col.icon}</span>
        <span className="text-[10px] font-semibold tracking-widest uppercase">{col.label}</span>
        {isTriggerTarget && <span className="text-[8px] text-[#ffb627] animate-pulse">⚡ 推進</span>}
        <span className="text-[9px] text-[var(--text-muted)] ml-auto">{totalCount}</span>
      </div>

      {/* Phase 4: 倉庫專屬搜尋框 + 批次刪 */}
      {onStorageQueryChange && (
        <div className="px-1.5 py-1 border-b border-[var(--border)]/50 flex flex-col gap-1">
          <input value={storageQuery ?? ''} onChange={e => onStorageQueryChange(e.target.value)}
            placeholder="🔍 倉庫搜尋"
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-1 text-[9px] outline-none focus:border-[var(--gold-border)]" />
          {cards.length > 0 && (storageQuery?.trim() || cards.length > 0) && (
            <button onClick={() => onBulkDelete?.(cards.map(c => c.id))}
              className="text-[8px] px-1.5 py-0.5 rounded border border-red-500/40 text-red-400/70 hover:bg-red-500/10 hover:text-red-400">
              {storageQuery?.trim() ? `批次刪此搜尋結果（${cards.length}）` : `批次刪當前可見（${cards.length}）`}
            </button>
          )}
        </div>
      )}

      <div className="px-1.5 py-1 border-b border-[var(--border)]/50">
        {adding ? (
          <input ref={inputRef} value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onCreate(text); setText(''); setAdding(false) }
              if (e.key === 'Escape') { setAdding(false); setText('') }
            }}
            onBlur={() => { if (text.trim()) onCreate(text); setText(''); setAdding(false) }}
            placeholder="標題（Enter 送出 / Esc 取消）"
            className="w-full bg-[var(--surface)] border border-[var(--gold-border)] rounded px-1.5 py-1 text-[10px] outline-none" />
        ) : (
          <button onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 50) }}
            className="w-full text-left text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] transition-colors py-0.5">
            + 新增卡片
          </button>
        )}
      </div>

      <SortableContext items={cards.map(c => c.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef}
          className={`flex-1 overflow-y-auto p-1.5 flex flex-col gap-1.5 min-h-[120px] transition-colors ${isOver ? 'bg-[var(--gold)]/5' : ''}`}>
          {cards.map(card => (
            <Card key={card.id} card={card} tags={tags}
              onPatch={onPatch} onDelete={onDelete} onOpenDetail={onOpenDetail}
              suggestedColumn={suggestStageForCard(card)}
              justSettled={justSettledCardId === card.id}
              isPendingTransition={pendingTransitionCardId === card.id}
              pendingTransitionToCol={pendingTransitionCardId === card.id ? pendingTransitionToCol : null} />
          ))}
          {cards.length === 0 && (
            <div className={`text-[9px] text-center py-3 transition-colors ${
              isTriggerTarget ? 'text-[#ffb627] opacity-80' : isPlainTarget ? 'text-[var(--gold)] opacity-70' : 'text-[var(--text-muted)] opacity-40'
            }`}>
              {isTriggerTarget ? '⚡ 放開 → 推進' : isPlainTarget ? '↓ 放這' : '空'}
            </div>
          )}
        </div>
      </SortableContext>

      {expandable && (
        <button onClick={onToggleExpand}
          className="shrink-0 px-2 py-1 text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border-t border-[var(--border)]/50">
          {expanded ? '收合' : `展開全部（${totalCount}）`}
        </button>
      )}
    </div>
  )
}

function Card({ card, tags, onPatch, onDelete, onOpenDetail, suggestedColumn, justSettled, isPendingTransition, pendingTransitionToCol }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })
  const theme = tags.find(t => t.id === card.themeId)
  const cardTags = (card.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean)
  const stageMismatch = suggestedColumn && suggestedColumn !== card.column
  const suggestedLabel = suggestedColumn ? COLUMN_BY_ID[suggestedColumn]?.label : null
  // Phase 5: 下一步建議
  const nextStep = nextStepForCard(card)
  const nextLabel = nextStep ? `${COLUMN_BY_ID[nextStep.col]?.icon ?? ''} ${nextStep.label}` : null
  const toneClass = {
    normal: 'border-[var(--gold)]/60 text-[var(--gold)]',
    soft:   'border-[var(--border)] text-[var(--text-muted)]',
    warn:   'border-amber-500/60 text-amber-300',
    cold:   'border-blue-500/40 text-blue-300/80',
  }[nextStep?.tone] ?? ''

  function handleClick(e) {
    if (isDragging) return
    onOpenDetail?.(card.id)
  }

  const settleClass = justSettled ? 'ring-2 ring-[var(--gold)] shadow-[0_0_20px_rgba(201,162,39,0.6)]' : ''
  // 純方向 B：等送出 ring（紫色 pulse + ⏳ icon）
  const pendingClass = isPendingTransition ? 'ring-2 ring-purple-400 shadow-[0_0_18px_rgba(168,85,247,0.5)] animate-pulse' : ''
  const pendingTargetLabel = pendingTransitionToCol ? COLUMN_BY_ID[pendingTransitionToCol]?.label : null

  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 }}
      className={`bg-[var(--surface)] border border-[var(--border)] rounded p-1.5 hover:border-[var(--gold-border)] group relative transition-all duration-300 ${settleClass} ${pendingClass}`}>
      <div className="flex gap-1 items-start">
        {theme && <div className="w-1 self-stretch rounded-full shrink-0 min-h-[16px]" style={{ backgroundColor: theme.color }} />}
        <div className="flex-1 min-w-0" {...attributes} {...listeners}
             onClick={handleClick}
             style={{ touchAction: 'manipulation', cursor: isDragging ? 'grabbing' : 'pointer' }}>
          <div className="text-[10px] text-[var(--text)] leading-tight break-words">{card.title}</div>
          {cardTags.length > 0 && (
            <div className="flex gap-0.5 flex-wrap mt-1">
              {cardTags.map(t => (
                <span key={t.id} className="text-[8px] px-1 rounded border" style={{ color: t.color, borderColor: t.color + '88' }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 純方向 B：pending transition 標記（左下角，不擋紅點） */}
      {isPendingTransition && pendingTargetLabel && (
        <div className="absolute -bottom-1 -left-1 z-10 flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-purple-500/30 border border-purple-400 text-purple-100 text-[8px] font-bold whitespace-nowrap shadow"
             title="Chat 送出後，此卡才會落實移動">
          ⏳ 等送出 → {pendingTargetLabel}
        </div>
      )}

      {/* 階段不符紅點（hover 顯示建議階段） */}
      {stageMismatch && (
        <div className="absolute -top-0.5 -right-0.5 group/dot"
             title={`建議階段：${suggestedLabel}`}>
          <div className="w-2 h-2 rounded-full bg-red-500 ring-2 ring-[var(--surface)] animate-pulse" />
          <div className="hidden group-hover/dot:block absolute right-0 top-3 z-20 px-2 py-1 rounded bg-[var(--surface-2)] border border-red-500/50 text-[9px] text-red-300 whitespace-nowrap shadow-lg">
            建議階段：{suggestedLabel}
          </div>
        </div>
      )}

      {/* Phase 5: 下一步建議（hover 顯示在卡片底部） */}
      {nextStep && !isDragging && (
        <div className={`hidden group-hover:block mt-1 pt-1 border-t border-dashed border-[var(--border)] text-[8px] ${toneClass} flex items-center gap-1`}>
          <span className="opacity-70">下一步：</span>
          <span className="font-semibold">{nextLabel}</span>
          <span className="opacity-50 ml-auto">（拖過去）</span>
        </div>
      )}

      {/* 刪除（hover 顯示，避開紅點區） */}
      <div className={`absolute top-0.5 ${stageMismatch ? 'right-3' : 'right-0.5'} hidden group-hover:flex gap-0.5`}>
        <button onClick={(e) => { e.stopPropagation(); if (window.confirm('刪除這張卡？（可在垃圾桶還原）')) onDelete(card.id) }}
          onPointerDown={(e) => e.stopPropagation()}
          title="刪除（可還原）"
          className="text-[9px] px-1 rounded text-[var(--text-muted)] hover:text-red-400 bg-[var(--surface-2)]/80">✕</button>
      </div>
    </div>
  )
}
