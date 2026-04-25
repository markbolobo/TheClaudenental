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

  // 重新載資料（衝突 / 還原後用）
  async function reloadCards() {
    const d = await fetch('/api/todos').then(r => r.json()).catch(() => ({ cards: [] }))
    setCards(d.cards ?? [])
  }
  async function reloadTags() {
    const d = await fetch('/api/todo-tags').then(r => r.json()).catch(() => ({ tags: [] }))
    setTags(d.tags ?? [])
  }

  useEffect(() => { reloadCards(); reloadTags() }, [])

  const themes = tags.filter(t => t.kind === 'theme' && !t.parentId)

  // 含 hop limit 的循環防護版（前後端對稱）
  function rootThemeOf(themeId) {
    const byId = new Map(tags.map(t => [t.id, t]))
    let cur = byId.get(themeId)
    let hops = 0
    while (cur?.parentId && hops++ < 16) cur = byId.get(cur.parentId)
    return cur
  }

  const filteredCards = activeThemes.size === 0
    ? cards
    : cards.filter(c => {
        if (!c.themeId) return false
        const root = rootThemeOf(c.themeId)
        return root && activeThemes.has(root.id)
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
      body: JSON.stringify({ column, title: title.trim(), themeId }),
    }).then(r => r.json()).catch(() => null)
    if (r?.ok) setCards(c => [...c, r.card])
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
  function confirmDragWithSession(sessionId) {
    if (!pendingDrag) return
    const { card, fromCol, toCol } = pendingDrag
    const ts = new Date().toLocaleString('zh-TW', { hour12: false })
    const oldL = COLUMN_BY_ID[fromCol]?.label ?? fromCol
    const newL = COLUMN_BY_ID[toCol]?.label ?? toCol
    const sessionTag = sessionId === '__new__' ? '新聊天室' : `session ${String(sessionId).slice(0, 8)}`
    const noteLine = `\n\n[${ts}] 手動拖曳：${oldL} → ${newL}（送往 ${sessionTag}）`
    patchCard(card.id, {
      column: toCol,
      order: Date.now(),
      sessionId: sessionId === '__new__' ? null : sessionId,
      note: (card.note ?? '') + noteLine,
    })
    if (onTriggerChat) {
      onTriggerChat({
        sessionId,
        prefillText: buildPromptForTransition(card, fromCol, toCol),
      })
    }
    setPendingDrag(null)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 主題膠囊列 */}
      <div className="shrink-0 px-2 py-2 border-b border-[var(--border)] flex gap-1.5 overflow-x-auto items-center">
        <button onClick={() => setActiveThemes(new Set())}
          className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
            activeThemes.size === 0
              ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
          }`}>全部</button>
        {themes.map(theme => {
          const active = activeThemes.has(theme.id)
          return (
            <button key={theme.id}
              onClick={() => setActiveThemes(s => {
                const next = new Set(s)
                if (next.has(theme.id)) next.delete(theme.id); else next.add(theme.id)
                return next
              })}
              style={active ? { borderColor: theme.color, color: theme.color, backgroundColor: theme.color + '22' } : undefined}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${
                active ? '' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}>
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
            const colCards = filteredCards.filter(c => c.column === col.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            const visible = col.id === 'storage' && !storageExpanded ? colCards.slice(-10) : colCards
            const isOverThisCol = overColumn === col.id
            const isTriggerTarget = isOverThisCol && activeDragCard && activeDragCard.column !== col.id && TRIGGER_CHAT_COLUMNS.has(col.id)
            const isPlainTarget = isOverThisCol && activeDragCard && activeDragCard.column !== col.id && !TRIGGER_CHAT_COLUMNS.has(col.id)
            return (
              <Column key={col.id} col={col}
                cards={visible} totalCount={colCards.length}
                tags={tags}
                onCreate={(title) => createCard(col.id, title)}
                onPatch={patchCard} onDelete={deleteCard}
                onOpenDetail={(id) => setActiveCardId(id)}
                expandable={col.id === 'storage' && colCards.length > 10}
                expanded={storageExpanded}
                onToggleExpand={() => setStorageExpanded(v => !v)}
                isTriggerTarget={isTriggerTarget}
                isPlainTarget={isPlainTarget}
                justSettledCardId={justSettledCardId} />
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
          onClose={() => setActiveCardId(null)}
          onPatch={patchCard} onDelete={deleteCard} />
      )}

      {/* 拖曳後 modal：選擇接續方式 */}
      {pendingDrag && (
        <DragActionModal
          pending={pendingDrag}
          sessions={sessions}
          onRevert={confirmDragRevert}
          onSelectSession={confirmDragWithSession} />
      )}
    </div>
  )
}

function DragActionModal({ pending, sessions, onRevert, onSelectSession }) {
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

        {/* 三選項 */}
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-[10px] text-[var(--text-muted)] font-semibold mb-1">選擇接續方式：</div>

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

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[var(--border)] flex items-center gap-2">
          <button onClick={onRevert}
            className="text-[10px] px-3 py-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] border border-[var(--border)]">
            ↩ 還原（不推進）
          </button>
          <div className="flex-1 text-[9px] text-[var(--text-muted)]">點空白也是還原</div>
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

function CardDrawer({ card, tags, themes, onClose, onPatch, onDelete }) {
  const [title, setTitle] = useState(card?.title ?? '')
  const [note, setNote] = useState(card?.note ?? '')
  useEffect(() => { setTitle(card?.title ?? ''); setNote(card?.note ?? '') }, [card?.id])

  if (!card) return null
  const theme = tags.find(t => t.id === card.themeId)
  const cardTags = (card.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean)
  const nonThemeTagIds = new Set(card.tagIds ?? [])
  const allTags = tags.filter(t => t.kind === 'tag')

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

          <div className="border-t border-[var(--border)] pt-2 text-[9px] text-[var(--text-muted)] space-y-0.5 font-mono">
            <div>id: {card.id}</div>
            <div>建立: {new Date(card.createdAt).toLocaleString()}</div>
            <div>更新: {new Date(card.updatedAt).toLocaleString()}</div>
            <div>版本: v{card.version ?? 1}</div>
            {card.parentId && <div>父卡: {card.parentId}</div>}
            {card.sessionId && <div>session: {card.sessionId.slice(0, 8)}...</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Column({ col, cards, totalCount, tags, onCreate, onPatch, onDelete, onOpenDetail, expandable, expanded, onToggleExpand, isTriggerTarget, isPlainTarget, justSettledCardId }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}` })
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef(null)

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
              justSettled={justSettledCardId === card.id} />
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

function Card({ card, tags, onPatch, onDelete, onOpenDetail, suggestedColumn, justSettled }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })
  const theme = tags.find(t => t.id === card.themeId)
  const cardTags = (card.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean)
  const stageMismatch = suggestedColumn && suggestedColumn !== card.column
  const suggestedLabel = suggestedColumn ? COLUMN_BY_ID[suggestedColumn]?.label : null

  function handleClick(e) {
    if (isDragging) return
    onOpenDetail?.(card.id)
  }

  // Phase 1: 落定微動畫（拖完 600ms 高光）
  const settleClass = justSettled ? 'ring-2 ring-[var(--gold)] shadow-[0_0_20px_rgba(201,162,39,0.6)]' : ''

  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 }}
      className={`bg-[var(--surface)] border border-[var(--border)] rounded p-1.5 hover:border-[var(--gold-border)] group relative transition-all duration-300 ${settleClass}`}>
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
