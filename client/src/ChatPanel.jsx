// ─── ChatPanel（CHAT 分頁對話面板，2026-07-01 自 App.jsx 搬出）──────────────────────────
// 心腹啟動器在 WorkflowLauncher.jsx（與侍酒師結帳區 / QA 留言列共用）、共用工具在 chatSupport.jsx。
import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MODEL_OPTIONS, EFFORT_OPTIONS } from './modelOptions.js'
import { confirmIfLiveInteractive } from './liveSessionGuard.js'
import {
  useChatOutline, OutlineMinimap, mdComponents, normPath, Tooltip,
  PREF_TEXT_KEY, loadRatingsCache, writeRatingsCache, loadRatingById, saveRating, flushPendingSync, extractFeatures, RATING_TAGS,
} from './chatSupport.jsx'
import { WorkflowLauncher } from './WorkflowLauncher.jsx'
import { PresentButton, usePresentation } from './PresentationView.jsx'

// Phase 7: 把訊息變成 TODO 卡（插單機制）
function PinToTodoButton({ text, sessionId }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const inputRef = useRef(null)

  function autoTitle() {
    const stripped = (text ?? '').replace(/[#*`>\-]/g, '').trim()
    const firstLine = stripped.split('\n').find(l => l.trim()) ?? ''
    return firstLine.slice(0, 60)
  }

  async function handleCreate() {
    if (busy) return
    const finalTitle = title.trim() || autoTitle() || '未命名插單'
    setBusy(true)
    try {
      await fetch('/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: finalTitle,
          column: 'idea',
          tagIds: ['tag-idea'],
          sessionId: sessionId ?? null,
          note: `插單來源（從 Chat 訊息建卡）：\n\n${text}\n\n[${new Date().toLocaleString('zh-TW', { hour12: false })}] 從 session ${sessionId?.slice(0, 8) ?? '(none)'} 建立`,
        }),
      })
      setDone(true)
      setTimeout(() => { setOpen(false); setDone(false); setTitle('') }, 1200)
    } catch {}
    finally { setBusy(false) }
  }

  if (done) return (
    <span className="text-[9px] text-green-400 px-1.5 py-0.5 rounded border border-green-500/40 animate-pulse">✓ 已建卡</span>
  )

  if (open) return (
    <span className="inline-flex items-center gap-1">
      <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)} autoFocus
        onKeyDown={e => {
          if (e.key === 'Enter') handleCreate()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder={autoTitle() || '卡片標題'}
        className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-full px-2 py-0.5 text-[10px] outline-none w-48" />
      <button onClick={handleCreate} disabled={busy}
        className="text-[9px] text-[var(--gold)] hover:bg-[var(--gold)]/10 rounded px-1 disabled:opacity-50">建</button>
      <button onClick={() => setOpen(false)}
        className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] rounded px-0.5">✕</button>
    </span>
  )

  return (
    <button onClick={() => setOpen(true)}
      title="把這則回應變成 TODO 卡（插單）"
      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)] hover:text-[var(--gold)] transition-colors opacity-50 hover:opacity-100 select-none">
      📌
    </button>
  )
}

function MessageRating({ id, text, serverRating }) {
  const [phase, setPhase]         = useState('idle') // idle | react | tag
  const [reaction, setReaction]   = useState(null)
  const [selTags, setSelTags]     = useState([])
  const [saved, setSaved]         = useState(() => id ? loadRatingById(id) : null)
  const timerRef                  = useRef(null)

  // 當 server 資料抵達（手機等 localStorage 為空的裝置），補上 saved 狀態
  useEffect(() => {
    if (serverRating && !saved) setSaved(serverRating)
  }, [serverRating])

  useEffect(() => {
    if (!id || saved) return
    timerRef.current = setTimeout(() => {
      const r = { id, ts: Date.now(), explicit: false, reaction: null, tags: [], features: extractFeatures(text) }
      saveRating(r); setSaved(r)
    }, 12000)
    return () => clearTimeout(timerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function pickReaction(r) { clearTimeout(timerRef.current); setReaction(r); setPhase('tag') }
  function toggleTag(t) { setSelTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]) }
  function commit() {
    const r = { id, ts: Date.now(), explicit: true, reaction, tags: selTags, features: extractFeatures(text) }
    saveRating(r); setSaved(r); setPhase('idle'); setSelTags([])
    // passive timer may have been replaced by explicit — saveRating handles server write
  }

  const dot = !saved ? '◦' : saved.explicit ? (saved.reaction === 'up' ? '👍' : saved.reaction === 'down' ? '👎' : '·') : '·'

  if (phase === 'idle') {
    if (saved?.explicit) return (
      <button onClick={() => setPhase('react')} title="重新評分"
        className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--gold)]/40 text-[var(--gold)]/70 hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors ml-1 select-none">
        {saved.reaction === 'up' ? '👍' : '👎'}
        {saved.tags?.[0] && <span className="text-[8px]">{saved.tags[0]}</span>}
      </button>
    )
    return (
      <button onClick={() => setPhase('react')} title="評分這則回應"
        className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)] hover:text-[var(--gold)] transition-colors ml-1 select-none opacity-65 hover:opacity-100">
        <span>★</span><span>評分</span>
      </button>
    )
  }

  if (phase === 'react') return (
    <span className="inline-flex items-center gap-1 ml-1">
      <button onClick={() => pickReaction('up')}   className="text-[12px] hover:scale-110 transition-transform">👍</button>
      <button onClick={() => pickReaction('down')} className="text-[12px] hover:scale-110 transition-transform">👎</button>
      <button onClick={() => setPhase('idle')}     className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] ml-0.5">✕</button>
    </span>
  )

  return (
    <div className="flex flex-wrap gap-1 mt-1 justify-end items-center">
      <span className="text-[10px]">{reaction === 'up' ? '👍' : '👎'}</span>
      {RATING_TAGS.map(tag => (
        <button key={tag} onClick={() => toggleTag(tag)}
          className={`text-[8px] px-1.5 py-0.5 rounded-full border transition-colors ${
            selTags.includes(tag)
              ? 'border-[var(--gold)] text-[var(--gold)] bg-[var(--gold)]/10'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)]'
          }`}>{tag}</button>
      ))}
      <button onClick={commit}
        className="text-[8px] px-2 py-0.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20">
        完成
      </button>
      <button onClick={() => { setPhase('idle'); setSelTags([]); setReaction(null) }}
        title={saved?.explicit ? '取消修改（保留原評分）' : '取消評分'}
        className="text-[8px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--gold-border)]">
        ✕ 取消
      </button>
    </div>
  )
}

function ContinueButton({ handleSend, setShowWorkflow, running }) {
  const [mode, setMode] = useState(null) // null | 'input'
  const [desc, setDesc] = useState('')
  const inputRef = useRef(null)

  function fire(text) {
    setShowWorkflow(false)
    setMode(null)
    setDesc('')
    handleSend(text)
  }

  function handleClick() {
    if (mode === null) {
      setMode('input')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  function handleSendContinue() {
    const trimmed = desc.trim()
    fire(trimmed ? `請繼續\n\n補充說明：${trimmed}` : '請繼續')
  }

  if (mode === 'input') return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full border border-green-500/60 bg-[var(--surface)] text-[9px]">
      <input
        ref={inputRef}
        value={desc}
        onChange={e => setDesc(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleSendContinue()
          if (e.key === 'Escape') { setMode(null); setDesc('') }
        }}
        placeholder="補充說明（選填）"
        className="bg-transparent text-[var(--text)] outline-none w-28 placeholder:text-[var(--text-muted)]"
      />
      <button onClick={handleSendContinue}
        className="text-green-400 font-bold hover:text-green-300 px-1">▶</button>
      <button onClick={() => { setMode(null); setDesc('') }}
        className="text-[var(--text-muted)] hover:text-[var(--text)] px-0.5">✕</button>
    </div>
  )

  return (
    <button
      onClick={handleClick}
      onTouchEnd={e => { e.preventDefault(); handleClick() }}
      disabled={running}
      style={{ touchAction: 'manipulation' }}
      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold tracking-wide border border-green-500/60 text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-40">
      <span>▶</span><span>請繼續</span>
    </button>
  )
}

// React state controlled thinking block — 取代 <details>
// 預設展開；text 為空時 fallback 顯示整個 message 物件（debug 用，定位 thinking 內容缺失原因）
function ThinkingBlock({ text, fullMessage }) {
  const [open, setOpen] = useState(true)
  const hasText = typeof text === 'string' && text.length > 0
  return (
    <div className="border border-purple-700/40 rounded bg-purple-900/10 px-2 py-1">
      <button onClick={() => setOpen(o => !o)}
        className="w-full text-left text-[9px] text-purple-400 cursor-pointer select-none uppercase tracking-widest hover:text-purple-300 flex items-center gap-1">
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        💭 Thinking
        <span className="ml-auto text-[8px] text-purple-400/50 normal-case tracking-normal">
          {hasText ? `${text.length} chars` : '⚠ 無內文（debug 模式）'}
        </span>
      </button>
      {open && (
        <div className="mt-1 text-[10px] text-purple-300/70 font-mono" style={{ whiteSpace: 'pre-wrap' }}>
          {hasText ? text : (
            <div>
              <div className="text-yellow-300 mb-1">⚠ thinking text 為空，dump 完整 message 物件供 debug：</div>
              <pre className="bg-black/40 p-1 rounded overflow-x-auto text-[9px]">
                {JSON.stringify(fullMessage, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChatPanel({ streamEvents, chatInit, selectedId }) {
  const [projectPath, setProjectPath] = useState('C:/Project/RomanPrototype')
  // 少爺 2026-07-14：Chat 可選 AI 模型＋強度（空字串=預設；記憶在 localStorage 跨開啟保留）
  const [chatModel, setChatModel] = useState(() => localStorage.getItem('tc_chat_model') ?? '')
  useEffect(() => { try { localStorage.setItem('tc_chat_model', chatModel) } catch {} }, [chatModel])
  const [chatEffort, setChatEffort] = useState(() => localStorage.getItem('tc_chat_effort') ?? '')
  useEffect(() => { try { localStorage.setItem('tc_chat_effort', chatEffort) } catch {} }, [chatEffort])
  // 少爺 2026-07-14：本次需求是否啟用 QA 流程（一次性勾選——送出後自動關，避免誤觸連發 QA）
  const [qaFlowOnce, setQaFlowOnce] = useState(false)
  // 少爺 2026-07-14「警示＋照送」：已確認過的活 session 不重複警示（取消的不記，下次再問）
  const liveWarnedRef = useRef(new Set())
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [attachments, setAttachments] = useState([])  // [{ name, dataUrl, type }]
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [showWorkflow, setShowWorkflow]     = useState(false)
  const [serverRatingsMap, setServerRatingsMap] = useState({})
  const [injectOnce, setInjectOnce]         = useState(false)  // B機制：單次注入偏好
  // 排隊機制已拿掉（2026-04-27 少爺要求），保留 state 避免大規模 refactor
  // mount 時清掉 localStorage 死資料，防止舊資料復活 flush
  const [pendingQueue, setPendingQueue]     = useState([])
  useEffect(() => {
    try { localStorage.removeItem('tc_pending_queue') } catch {}
  }, [])
  const [fbBuffer, setFbBuffer]             = useState([])     // FB 暫存列表
  const fileInputRef = useRef(null)
  const attachMenuRef = useRef(null)
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  // 互動式簡報（少爺 2026-07-21）：設定 mode=present 時新回覆完成自動演出；config 於 mount 讀一次
  //（分頁切換會 remount → 到規矩改完設定切回來即生效）
  const presentCfgRef = useRef(null)
  useEffect(() => { fetch('/api/present/config').then(r => r.json()).then(d => { presentCfgRef.current = d.config }).catch(() => {}) }, [])
  const lastAssistantTextRef = useRef(null)
  const { present: presentAuto, overlay: presentOverlay } = usePresentation(sessionId)
  // ⚠️ State 永遠完整保留（對應 memory/project_tc_design_alignment_audit.md 鐵律）
  // 不對歷史 messages 動 slice / cap

  // hiddenCount = 上方被隱藏的訊息數（絕對 index）
  // 鎖定「最早可見訊息」的位置，新訊息進來 hiddenCount 不變 → 不會浮動
  const [hiddenCount, setHiddenCount] = useState(0)
  const [showAllMessages, setShowAllMessages] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  // 第一次 messages 從 0 → N（history 載入完）時，預設只顯示最新 150 則
  const initializedRef = useRef(false)
  useEffect(() => {
    if (initializedRef.current) return
    if (messages.length > 150 && !showAllMessages) {
      setHiddenCount(messages.length - 150)
      initializedRef.current = true
    } else if (messages.length > 0 && messages.length <= 150) {
      initializedRef.current = true  // 訊息少不需要隱藏，標 init 完
    }
  }, [messages.length, showAllMessages])
  // 切換 session 時 reset（messages 被清空再重載）
  useEffect(() => {
    initializedRef.current = false
    setHiddenCount(0)
    setShowAllMessages(false)
  }, [sessionId])

  // 展開更多時保持「使用者看著的訊息位置」不變
  // 邏輯：點按鈕前 scrollTop = T（看著的訊息距 container 頂 T px）
  //       點按鈕後 DOM 上方多了 H px → 新 scrollTop = T + H（使用者看著的訊息維持原位置）
  const preserveScrollRef = useRef(null)
  function loadMoreMessages(delta) {
    const el = scrollContainerRef.current
    if (el) preserveScrollRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    setHiddenCount(c => Math.max(0, c - delta))
  }
  function expandAllMessages() {
    const el = scrollContainerRef.current
    if (el) preserveScrollRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    setHiddenCount(0)
    setShowAllMessages(true)
  }
  function collapseToRecent() {
    setShowAllMessages(false)
    setHiddenCount(Math.max(0, messages.length - 150))
  }
  useLayoutEffect(() => {
    if (!preserveScrollRef.current) return
    const el = scrollContainerRef.current
    if (!el) return
    const delta = el.scrollHeight - preserveScrollRef.current.scrollHeight
    el.scrollTop = preserveScrollRef.current.scrollTop + delta
    isNearBottomRef.current = false  // 暫停 smartScroll 拉底部
    preserveScrollRef.current = null
  }, [hiddenCount])
  const bottomRef = useRef(null)
  const scrollContainerRef = useRef(null)
  const isNearBottomRef = useRef(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  // 少爺 2026-07-16：對話大綱 minimap（條目=少爺留言；搜尋模式下停用，避免錨點對不上 filter 結果）
  const chatOutline = useChatOutline(scrollContainerRef, messages, 'chatmsg', !!chatSearchQuery.trim())

  // 點大綱條目 → 捲到該留言；目標還在「載入更早」隱藏區時，先展開到該則再捲
  function jumpToOutline(entry) {
    isNearBottomRef.current = false
    if (entry.absIdx < hiddenCount) {
      setHiddenCount(entry.absIdx)
      setTimeout(() => document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
      return
    }
    document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const prevChatInitRef = useRef(null)
  // Live streaming block (rAF-batched to avoid per-token re-renders)
  const liveBlockRef = useRef(null)  // { type: 'thinking'|'text', text: string } | null
  const [, setLiveTick] = useState(0)
  const rafRef = useRef(null)
  function scheduleLiveUpdate() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; setLiveTick(t => t + 1) })
  }

  // Tracks whether web-initiated stream events are active (skip session_live appends during run)
  const runningRef = useRef(false)
  // Guards against processing the same streamEvent twice (useEffect re-runs on dep change)
  const lastEvTsRef = useRef(0)
  // 少爺 2026-07-15 修 Chat 重複：跨來源內容指紋（claude_stream 與 session_live 對同句話各推一次、
  // 或監看重播時，第二次直接丟棄）。上限 400 筆滾動清理。
  const seenFpRef = useRef(new Set())
  const fpOf = (m) => `${m.role}|${m.toolId ?? ''}|${(m.text ?? m.output ?? '').trim().slice(0, 160)}`
  const markFp = (m) => {
    const _fp = fpOf(m)
    seenFpRef.current.add(_fp)
    if (seenFpRef.current.size > 400) {
      const _it = seenFpRef.current.values()
      for (let i = 0; i < 100; i++) seenFpRef.current.delete(_it.next().value)
    }
    return _fp
  }

  // Apply chatInit when it changes (from History "Continue in Chat" / session click / TODO drag-trigger)
  // 用 localStorage 持久化已消費的 ts，避免 ChatPanel mount/unmount/F5 後重複預填
  useEffect(() => {
    if (!chatInit) return
    if (chatInit === prevChatInitRef.current) return
    const incomingTs = chatInit.ts ?? 0
    const consumedTs = Number(localStorage.getItem('tc_consumed_chatinit_ts')) || 0
    if (incomingTs && incomingTs <= consumedTs) {
      // 此 chatInit 已被消費過（之前 mount 時處理過）— 切 tab/F5 回來不再重新預填
      prevChatInitRef.current = chatInit
      return
    }
    prevChatInitRef.current = chatInit
    if (chatInit.projectPath) setProjectPath(chatInit.projectPath)
    setSessionId(chatInit.sessionId)
    // 預填輸入框（TODO 拖卡帶來的 prompt 模板）
    if (chatInit.prefillText) setInput(chatInit.prefillText)
    // 標記已消費
    if (incomingTs) localStorage.setItem('tc_consumed_chatinit_ts', String(incomingTs))
    // 純方向 B：開始 polling pending transition（commit 後讓 ring 消失）
    // 不需在這做，pendingTransition 由 TodoBoard 自己 polling
    // 新 session（從 TODO 拖卡選「新聊天室」）— 不 load history
    if (!chatInit.sessionId) {
      setMessages([])
      return
    }
    setMessages([{ role: 'system', text: '載入歷史紀錄…', ts: Date.now() }])
    fetch('/api/session/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: chatInit.sessionId }),
    }).catch(() => {})
    fetch(`/api/history/${chatInit.sessionId}`)
      .then(r => r.json())
      .then(d => {
        const hist = (d.messages ?? []).map(m => ({ ...m, historical: true }))
        setMessages(prev => {
          const newStream = prev.filter(m => !m.historical && m.role !== 'system')
          return [...hist, { role: 'system', text: '─── 以上為歷史紀錄，從此繼續 ───', ts: Date.now() }, ...newStream]
        })
      })
      .catch(() => setMessages([{ role: 'system', text: '歷史紀錄載入失敗', ts: Date.now() }]))
  }, [chatInit])

  // 純方向 B：mount 時若有 pending todo transition 但 input 為空 → 從 sessionStorage 還原預填
  // 防止「F5 / 切 tab 回來，看到卡有 ⏳ ring 但 input 空白」的不一致
  useEffect(() => {
    // 若 chatInit 待消費，由上面那個 useEffect 處理
    const incomingTs = chatInit?.ts ?? 0
    const consumedTs = Number(localStorage.getItem('tc_consumed_chatinit_ts')) || 0
    if (chatInit && incomingTs > consumedTs) return
    // 沒待消費 chatInit + 有 pending transition → 還原 input
    try {
      const raw = sessionStorage.getItem('tc_pending_todo_transition')
      if (!raw) return
      const t = JSON.parse(raw)
      if (t?.prefillText) setInput(prev => prev || t.prefillText)
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On mount: flush pending ratings → merge server data into cache → build id map
  useEffect(() => {
    flushPendingSync()   // 補送上次刷新前沒送到的評分
    fetch('/api/ratings').then(r => r.json()).then(d => {
      const serverAll = d.ratings ?? []
      // Merge：server 資料更新/補充 localStorage，不刪除本地還沒同步的項目
      const local = loadRatingsCache()
      const merged = [...local]
      for (const r of serverAll) {
        const idx = merged.findIndex(x => x.id === r.id)
        if (idx >= 0) merged[idx] = { ...r, _pendingSync: false }
        else merged.push({ ...r, _pendingSync: false })
      }
      writeRatingsCache(merged)
      const map = {}
      for (const r of merged) map[r.id] = r
      setServerRatingsMap(map)
    }).catch(() => {})
  }, [])

  // On mount: mark all existing streamEvents as already-processed so a tab-switch remount
  // doesn't replay the full 200-event buffer and cause massive duplicates.
  useEffect(() => {
    const maxTs = streamEvents.reduce((m, e) => Math.max(m, e._arrivalTs ?? 0), 0)
    lastEvTsRef.current = maxTs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty — runs once on mount only

  // Process incoming stream events — loop over ALL new events to avoid React 18 batching issue
  // (processing only the last event caused content_block_stop to swallow preceding deltas,
  //  so live thinking text never appeared before the block was cleared)
  useEffect(() => {
    if (!streamEvents.length) return

    // Find all events not yet processed (arrival timestamp > last processed)
    const startIdx = streamEvents.findIndex(ev => (ev._arrivalTs ?? 0) > lastEvTsRef.current)
    if (startIdx < 0) return
    const newEvts = streamEvents.slice(startIdx)
    lastEvTsRef.current = newEvts[newEvts.length - 1]._arrivalTs ?? lastEvTsRef.current

    let liveUpdated = false

    for (const ev of newEvts) {
      // ── session_live: VS Code live tail (incremental only) ───────────────
      if (ev.type === 'session_live' && ev.sessionId === sessionId) {
        if (runningRef.current) continue  // web run active — claude_stream is source of truth
        // 內容指紋去重（少爺 2026-07-15）：claude_stream 已顯示過或監看重播的同句話直接略過
        const fresh = (ev.messages ?? []).filter(m => !seenFpRef.current.has(fpOf(m)))
        if (!fresh.length) continue
        for (const m of fresh) markFp(m)
        setMessages(prev => {
          const existingToolKeys = new Set(prev.filter(m => m.toolId).map(m => `${m.role}:${m.toolId}`))
          let next = [...prev]
          for (const m of fresh) {
            const msg = { ...m, live: true }
            if (msg.toolId) {
              const key = `${msg.role}:${msg.toolId}`
              if (existingToolKeys.has(key)) continue
              existingToolKeys.add(key)
            }
            if (msg.role === 'tool_result') {
              const idx = next.map(x => x.toolId).lastIndexOf(msg.toolId)
              if (idx >= 0) { next = [...next.slice(0, idx + 1), msg, ...next.slice(idx + 1)]; continue }
            }
            next = [...next, msg]
          }
          return next
        })
        continue
      }

      // ── claude_stream: real-time subprocess events ─────────────────────────
      if (ev.type !== 'claude_stream') continue
      if (normPath(ev.projectPath) !== normPath(projectPath)) continue
      // Reject events from a different subprocess session (same projectPath, different session)
      if (ev.sessionId && sessionId && ev.sessionId !== sessionId) continue
      const { event } = ev

      if (event.type === 'system' && event.subtype === 'init') {
        // Only adopt new sessionId when THIS tab initiated the run (runningRef=true).
        // Other tabs' init events arrive with ev.sessionId=null (bypassing the sessionId filter)
        // and must not hijack this panel's session context.
        if (runningRef.current) setSessionId(event.session_id)
      } else if (event.type === 'system' && event.subtype === 'spawn_config') {
        // 少爺 2026-07-14：顯示本次子進程實際帶的模型/強度（effort 在別處無任何可觀察痕跡）
        setMessages(m => [...m, { role: 'result', text: `🚀 啟動參數：模型 ${event.model ?? '預設'}｜強度 ${event.effort ?? '預設'}`, ts: Date.now() }])
      } else if (event.type === 'content_block_start') {
        const t = event.content_block?.type
        if (t === 'thinking') { liveBlockRef.current = { type: 'thinking', text: '' }; liveUpdated = true }
        else if (t === 'text')    { liveBlockRef.current = { type: 'text', text: '' };    liveUpdated = true }
        else                      { liveBlockRef.current = null;                           liveUpdated = true }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta
        if (liveBlockRef.current && (d?.type === 'thinking_delta' || d?.type === 'text_delta')) {
          liveBlockRef.current = { ...liveBlockRef.current, text: liveBlockRef.current.text + (d.thinking ?? d.text ?? '') }
          liveUpdated = true
        }
      } else if (event.type === 'content_block_stop') {
        liveBlockRef.current = null; liveUpdated = true
      } else if (event.type === 'assistant') {
        liveBlockRef.current = null; liveUpdated = true
        const blocks = event.message?.content ?? []
        const newMsgs = []
        for (const b of blocks) {
          if (b.type === 'thinking')
            newMsgs.push({ role: 'thinking', text: b.thinking, ts: Date.now() })
          else if (b.type === 'text' && b.text.trim())
            newMsgs.push({ role: 'assistant', text: b.text, ts: Date.now() })
          else if (b.type === 'tool_use')
            newMsgs.push({ role: 'tool_use', toolName: b.name, input: b.input, toolId: b.id, ts: Date.now() })
        }
        // 自動演出用：記住本輪最後一則 assistant 文字
        const _lastA = [...newMsgs].reverse().find(x => x.role === 'assistant')
        if (_lastA) lastAssistantTextRef.current = _lastA.text
        // 登記指紋：session_live 之後對同內容的重播（監看 tail）會被濾掉（少爺 2026-07-15）
        for (const m of newMsgs) markFp(m)
        if (newMsgs.length) setMessages(m => [...m, ...newMsgs])
      } else if (event.type === 'user') {
        const blocks = event.message?.content ?? []
        setMessages(prev => {
          let next = [...prev]
          for (const b of blocks) {
            if (b.type !== 'tool_result') continue
            const output = Array.isArray(b.content)
              ? b.content.filter(x => x.type === 'text').map(x => x.text).join('').slice(0, 300)
              : String(b.content ?? '').slice(0, 300)
            if (!output.trim()) continue
            const resultMsg = { role: 'tool_result', toolId: b.tool_use_id, output, ts: Date.now() }
            markFp(resultMsg)
            const idx = next.map(m => m.toolId).lastIndexOf(b.tool_use_id)
            if (idx >= 0) next = [...next.slice(0, idx + 1), resultMsg, ...next.slice(idx + 1)]
            else next = [...next, resultMsg]
          }
          return next
        })
      } else if (event.type === 'result') {
        setRunning(false)
        const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''
        setMessages(m => [...m, { role: 'result', text: `完成${cost}`, ts: Date.now() }])
        // 自動演出（少爺 2026-07-21：設定 mode=present）：run 完成後演出最後一則 assistant 回覆
        if (presentCfgRef.current?.mode === 'present' && lastAssistantTextRef.current) presentAuto(lastAssistantTextRef.current)
        // Hold runningRef for 700ms to absorb any trailing session_live fires
        // (file watcher or Stop hook may broadcast already-shown messages from claude_stream)
        setTimeout(() => { runningRef.current = false }, 700)
      } else if (event.type === 'done') {
        setRunning(false)
        setTimeout(() => { runningRef.current = false }, 700)
      }
    }

    if (liveUpdated) scheduleLiveUpdate()
  }, [streamEvents, projectPath, sessionId])

  useEffect(() => {
    if (!isNearBottomRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleChatScroll() {
    const el = scrollContainerRef.current
    if (!el) return
    const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 80
    isNearBottomRef.current = nearBottom
    setShowJumpToLatest(!nearBottom)
    chatOutline.update()  // 大綱高亮跟著捲動位置同步（Notion 式）
  }

  function jumpToLatest() {
    isNearBottomRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setShowJumpToLatest(false)
  }

  // 純方向 B：把 TODO 卡的 column 切換延遲到 Chat 真正送出後才落實
  // sessionStorage key 由 TodoBoard 寫入，doActualSend 成功送出後 commit
  function commitPendingTodoTransition() {
    try {
      const raw = sessionStorage.getItem('tc_pending_todo_transition')
      if (!raw) return
      const t = JSON.parse(raw)
      if (!t?.cardId || !t?.toCol) return
      sessionStorage.removeItem('tc_pending_todo_transition')
      const ts = new Date().toLocaleString('zh-TW', { hour12: false })
      const fromL = t.fromColLabel ?? t.fromCol
      const toL   = t.toColLabel   ?? t.toCol
      const sessionTag = t.sessionId === '__new__' ? '新聊天室' : (t.sessionId ? `session ${String(t.sessionId).slice(0, 8)}` : '新聊天室')
      const noteAppend = `\n\n[${ts}] 卡片落實移動：${fromL} → ${toL}（Chat 已送出 ${sessionTag}）`
      fetch(`/api/todos/${t.cardId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          column: t.toCol,
          order: Date.now(),
          sessionId: t.sessionId === '__new__' ? null : t.sessionId,
          noteAppend,
        }),
      }).catch(() => {})
    } catch {}
  }

  async function doActualSend(text, atts) {
    // 少爺 2026-07-14「警示＋照送」：續聊目標是 VS Code 活 session → 每 session 首次送出前確認（取消則下次再問）
    if (sessionId && !liveWarnedRef.current.has(sessionId)) {
      if (!(await confirmIfLiveInteractive(sessionId, '續聊'))) return
      liveWarnedRef.current.add(sessionId)
    }
    const rawPrompt = text || (atts.length ? '請查看附件' : '')
    const prefText  = localStorage.getItem(PREF_TEXT_KEY) || ''
    const prompt    = (injectOnce && prefText)
      ? `[使用者回應偏好（本次請遵循）：\n${prefText}]\n\n${rawPrompt}`
      : rawPrompt
    if (injectOnce) setInjectOnce(false)
    runningRef.current = true
    setRunning(true)
    const displayText = prompt + (atts.length ? `\n${atts.map(a => `[${a.name}]`).join(' ')}` : '')
    setMessages(m => [...m, { role: 'user', text: displayText, attachments: atts, ts: Date.now() }])
    try {
      const res = await fetch('/api/claude/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, prompt, sessionId, attachments: atts, model: chatModel || null, effort: chatEffort || null, qaFlow: qaFlowOnce }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setRunning(false); runningRef.current = false
        const reason = data.error ?? `HTTP ${res.status}`
        setMessages(m => [...m, { role: 'result', text: `發送失敗：${reason}`, ts: Date.now() }])
      } else {
        // ✅ Chat 真正送出 → 落實 pending todo transition（純方向 B 核心）
        commitPendingTodoTransition()
        // QA 流程勾選是一次性的——成功送出即歸位
        if (qaFlowOnce) setQaFlowOnce(false)
      }
    } catch (err) {
      setRunning(false); runningRef.current = false
      setMessages(m => [...m, { role: 'result', text: `發送失敗：${err.message}`, ts: Date.now() }])
    }
  }

  async function handleSend(overrideText) {
    const text = (overrideText ?? input).trim()
    const atts = overrideText ? [] : [...attachments]
    if (!text && atts.length === 0) return
    // 思考中送出 → 直接送（少爺 2026-04-27 報排隊機制不好用）
    // server / Claude Code CLI 自己處理同 session 重疊請求
    if (!overrideText) { setInput(''); setAttachments([]) }
    await doActualSend(text, atts)
  }

  // 思考結束後從佇列取出下一筆送出（FIFO，一次一筆，送完再取下一筆）
  useEffect(() => {
    if (!running && pendingQueue.length > 0) {
      const [next, ...rest] = pendingQueue
      setPendingQueue(rest)
      const t = setTimeout(() => { doActualSend(next.text, next.attachments) }, 300)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, pendingQueue])

  // pendingQueue 同步到 localStorage（HMR / F5 後可復原；附件不序列化）
  useEffect(() => {
    try {
      const slim = pendingQueue.map(({ text, ts }) => ({ text, ts }))
      localStorage.setItem('tc_pending_queue', JSON.stringify(slim))
    } catch {}
  }, [pendingQueue])

  function handleStop() {
    fetch('/api/claude/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    })
    runningRef.current = false
    setRunning(false)
  }


  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgItem = items.find(i => i.type.startsWith('image/'))
    if (!imgItem) return
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setAttachments(prev => [...prev, { name: file.name || 'image.png', dataUrl: ev.target.result, type: file.type }])
    reader.readAsDataURL(file)
  }

  function handleFileChange(e) {
    const files = Array.from(e.target.files ?? [])
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = ev => setAttachments(prev => [...prev, { name: file.name, dataUrl: ev.target.result, type: file.type }])
      reader.readAsDataURL(file)
    })
    e.target.value = ''
    setShowAttachMenu(false)
  }

  // Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return
    function handler(e) { if (!attachMenuRef.current?.contains(e.target)) setShowAttachMenu(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAttachMenu])

  function clearChat() { setMessages([]); setSessionId(null) }

  return (
    <div className="flex flex-col h-full">
      {presentOverlay}

      {/* Project path bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-widest shrink-0">Project</span>
        <input
          value={projectPath}
          onChange={e => { setProjectPath(e.target.value); setSessionId(null); setMessages([]) }}
          className="flex-1 bg-transparent text-base md:text-[10px] text-[var(--text)] font-mono outline-none border-b border-[var(--border)] pb-0.5"
        />
        <select value={chatModel} onChange={e => setChatModel(e.target.value)} title="這個聊天室送出時使用的 AI 模型"
          className="shrink-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]">
          {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={chatEffort} onChange={e => setChatEffort(e.target.value)} title="模型強度（claude --effort）"
          className="shrink-0 bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]">
          {EFFORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label title="下一則訊息附掛 Mode C QA 流程指令（送出後自動取消勾選）"
          className={`shrink-0 flex items-center gap-1 text-[9px] cursor-pointer select-none px-1.5 py-0.5 rounded border ${qaFlowOnce ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
          <input type="checkbox" checked={qaFlowOnce} onChange={e => setQaFlowOnce(e.target.checked)} className="accent-[var(--gold)] w-3 h-3" />
          🧪 QA 流程
        </label>
        {sessionId && (
          <span className="text-[9px] text-[var(--text-muted)] font-mono shrink-0">{sessionId.slice(0,8)}</span>
        )}
        <button onClick={clearChat} className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] shrink-0">✕ clear</button>
      </div>

      {/* Chat 搜尋框（對話內全文搜尋；有輸入時 render 全部 filter 結果） */}
      {messages.length > 30 && (
        <div className="shrink-0 px-3 py-1 border-b border-[var(--border)]/50 bg-[var(--surface-2)]/30 flex items-center gap-2">
          <input
            value={chatSearchQuery}
            onChange={e => setChatSearchQuery(e.target.value)}
            placeholder={`🔍 搜尋此對話內容（${messages.length} 則）`}
            className="flex-1 bg-transparent text-[10px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {chatSearchQuery && (
            <button onClick={() => setChatSearchQuery('')}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-1">✕</button>
          )}
        </div>
      )}

      {/* Messages（外層 relative wrapper：大綱 minimap 疊在右緣、不隨內容捲動） */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollContainerRef} onScroll={handleChatScroll}
           className="h-full overflow-y-auto px-3 py-2 space-y-2 relative">
        {messages.length === 0 && (
          <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">
            輸入訊息開始對話，不需要 VS Code 介面
          </div>
        )}

        {/* 載入更早歷史按鈕（沒搜尋時 + 還有更早可載入）
            點擊後使用者看著的訊息位置不變、上方多出更早內容 */}
        {!chatSearchQuery.trim() && hiddenCount > 0 && (
          <div className="text-center py-2">
            <button onClick={() => loadMoreMessages(100)}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--gold-border)]">
              ↑ 載入更早 100 則（還有 {hiddenCount} 則隱藏）
            </button>
            <button onClick={expandAllMessages}
              className="ml-2 text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] px-2 py-1">
              展開全部
            </button>
          </div>
        )}
        {!chatSearchQuery.trim() && showAllMessages && messages.length > 150 && (
          <div className="text-center py-2">
            <button onClick={collapseToRecent}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--gold)] px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--gold-border)]">
              ⇣ 收合到最近 150 則（目前展開全 {messages.length} 則）
            </button>
          </div>
        )}

        {(() => {
          const q = chatSearchQuery.trim().toLowerCase()
          const renderMessages = q
            ? messages.filter(m => {
                if ((m.text ?? '').toLowerCase().includes(q)) return true
                if ((m.toolName ?? '').toLowerCase().includes(q)) return true
                const inputStr = m.input ? JSON.stringify(m.input).toLowerCase() : ''
                if (inputStr.includes(q)) return true
                if (Array.isArray(m.attachments) && m.attachments.some(a => (a.name ?? '').toLowerCase().includes(q))) return true
                return false
              })
            : messages.slice(hiddenCount)  // hiddenCount 鎖定「最早可見」絕對位置

          if (q && renderMessages.length === 0) return (
            <div className="text-[10px] text-[var(--text-muted)] text-center py-4 opacity-60">
              「{chatSearchQuery}」沒有命中任何訊息
            </div>
          )

          return renderMessages.map((m, i) => (
          <div key={i} id={m.role === 'user' && !q ? `chatmsg-${hiddenCount + i}` : undefined}
            className={`text-[11px] leading-relaxed ${m.historical ? 'opacity-75' : ''}`}>
            {/* System / divider */}
            {m.role === 'system' && (
              <div className="text-[9px] text-[var(--text-muted)] text-center py-1 border-t border-[var(--border)] mt-1">{m.text}</div>
            )}
            {/* User message */}
            {m.role === 'user' && (
              <div className="text-[var(--gold)]">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="opacity-50 mr-1">›</span>
                    <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                  </div>
                  {m.ts && (
                    <span className="shrink-0 text-[8px] text-[var(--gold)]/30 tabular-nums font-mono leading-tight pt-0.5 text-right">
                      {new Date(m.ts).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                    </span>
                  )}
                </div>
                {m.attachments?.filter(a => a.type?.startsWith('image/')).map((a, ai) => (
                  <img key={ai} src={a.dataUrl} alt={a.name}
                    className="mt-1 max-h-32 max-w-full rounded border border-[var(--border)] block" />
                ))}
              </div>
            )}
            {/* Assistant text */}
            {m.role === 'assistant' && (
              <div>
                <div className="md-body text-[var(--text)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.text || ''}</ReactMarkdown>
                </div>
                <div className="flex justify-end items-center gap-1 mt-0.5">
                  {/* 🎬 演出（少爺 2026-07-21）：這則回覆單獨套用互動簡報回放 */}
                  <PresentButton sessionId={sessionId} text={m.text || ''} />
                  {/* Phase 7: 📌 插單建卡按鈕 */}
                  <PinToTodoButton text={m.text || ''} sessionId={sessionId} />
                  <MessageRating id={sessionId && m.ts ? `${sessionId}_${m.ts}` : null} text={m.text || ''}
                    serverRating={sessionId && m.ts ? serverRatingsMap[`${sessionId}_${m.ts}`] : undefined} />
                </div>
              </div>
            )}
            {/* Thinking block — React state controlled，避免原生 details 在某些環境不展開 */}
            {m.role === 'thinking' && <ThinkingBlock text={m.text} fullMessage={m} />}
            {/* Tool use */}
            {m.role === 'tool_use' && (
              <details className="border border-sky-700/40 rounded bg-sky-900/10 px-2 py-1">
                <summary className="text-[9px] text-sky-400 cursor-pointer select-none">
                  <span className="uppercase tracking-widest">⚙ {m.toolName}</span>
                  <span className="ml-2 text-sky-500/60 font-mono">{Object.values(m.input)[0]?.toString().slice(0, 60) ?? ''}</span>
                </summary>
                <pre className="mt-1 text-[10px] text-sky-300/70 overflow-x-auto">{JSON.stringify(m.input, null, 2)}</pre>
              </details>
            )}
            {/* Tool result */}
            {m.role === 'tool_result' && (
              <details className="border border-emerald-700/40 rounded bg-emerald-900/10 px-2 py-1">
                <summary className="text-[9px] text-emerald-400 cursor-pointer select-none uppercase tracking-widest">↩ Result</summary>
                <pre className="mt-1 text-[10px] text-emerald-300/70 overflow-x-auto">{m.output}</pre>
              </details>
            )}
            {/* Completion */}
            {m.role === 'result' && (
              <div className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] pt-1 mt-1">{m.text}</div>
            )}
          </div>
          ))
        })()}
        {/* Live streaming block */}
        {liveBlockRef.current && (
          <div className={`text-[11px] leading-relaxed ${liveBlockRef.current.type === 'thinking' ? '' : ''}`}>
            {liveBlockRef.current.type === 'thinking' ? (
              <details open className="border border-purple-700/40 rounded bg-purple-900/10 px-2 py-1">
                <summary className="text-[9px] text-purple-400 cursor-pointer select-none uppercase tracking-widest">💭 Thinking…</summary>
                <div className="mt-1 text-[10px] text-purple-300/70 font-mono" style={{ whiteSpace: 'pre-wrap' }}>
                  {liveBlockRef.current.text}<span className="animate-pulse">▍</span>
                </div>
              </details>
            ) : (
              <div className="text-[var(--text)]" style={{ whiteSpace: 'pre-wrap' }}>
                {liveBlockRef.current.text}<span className="animate-pulse">▍</span>
              </div>
            )}
          </div>
        )}
        {running && !liveBlockRef.current && (
          <div className="text-[10px] text-[var(--text-muted)] animate-pulse">Claude 思考中…</div>
        )}

        <div ref={bottomRef} />
        {showJumpToLatest && (
          <button onClick={jumpToLatest}
            onTouchEnd={e => { e.preventDefault(); jumpToLatest() }}
            style={{ touchAction: 'manipulation' }}
            className="sticky bottom-2 ml-auto mr-1 shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-[10px] font-semibold bg-[var(--gold)]/20 border border-[var(--gold)]/60 text-[var(--gold)] hover:bg-[var(--gold)]/30 backdrop-blur-sm self-end w-fit">
            ▼ 回到最新
          </button>
        )}
      </div>
      <OutlineMinimap entries={chatOutline.entries} activeId={chatOutline.activeId} onJump={jumpToOutline} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)]">

        {/* Workflow Launcher（心腹啟動器）— 抽出為 WorkflowLauncher.jsx 與侍酒師結帳區 / QA 留言列共用；
            CHAT 專屬的 請繼續 / FB 暫存 / 人脈盤查 pills 以 extraPills 傳入 */}
        {showWorkflow && (
          <WorkflowLauncher running={running}
            onLaunch={prompt => { setShowWorkflow(false); handleSend(prompt) }}
            extraPills={<>
              {/* 請繼續 — 快速續行，可選填補充說明 */}
              <Tooltip content={'請繼續（可選填補充說明）\nClaude 自動接續未完成的工作'}>
                <ContinueButton handleSend={handleSend} setShowWorkflow={setShowWorkflow} running={running} />
              </Tooltip>
              {/* 📋 FB 暫存 — 帶入 bookmarklet 送來的 FB 內容 */}
              <Tooltip content={'FB 暫存\n帶入 Edge bookmarklet 送來的 FB 貼文內容\n自動做協作模式提煉 + 查證 + 差距分析'}>
              <button
                onClick={async () => {
                  const d = await fetch('/api/fb-push/latest').then(r => r.json()).catch(() => null)
                  if (!d?.content) {
                    alert('沒有 FB 暫存內容。\n請先在 Edge 打開 FB 貼文，點書籤欄的「📤 送到 Claude」。')
                    return
                  }
                  const prompt =
`我分享一個別人與 AI 協作的案例（從 FB 暫存帶入），請分析並找出我們可以借鏡的地方：

## 貼文來源
${d.url}

## 作者
${d.author || '（未識別）'}

## 內文
${d.content}

${d.comments?.length ? `## 留言（${d.comments.length} 則）\n${d.comments.join('\n---\n')}\n` : ''}
${d.links?.length    ? `## 內含外部連結\n${d.links.join('\n')}\n`                 : ''}

---

請依以下步驟處理：
1. **提煉協作模式**：他們用了什麼方法、工具、提示詞結構，與我們的做法有何不同
2. **查證含金量**：作者姓名 + 內文提到的 GitHub / 技術，用 WebSearch 或 WebFetch 交叉驗證
3. **差距分析**：他們做到了我們還沒做到的是什麼？我們有沒有比他們更好的地方？
4. **改進建議**：具體列出 1~3 個可以直接套用或調整到我們協作中的做法
5. 若值得長期參考：更新 memory/feedback_*.md 或 preferences.md

請用我們平常的討論方式來聊，不只是列清單。`
                  setShowWorkflow(false)
                  handleSend(prompt)
                }}
                onTouchEnd={async e => {
                  e.preventDefault()
                  const d = await fetch('/api/fb-push/latest').then(r => r.json()).catch(() => null)
                  if (!d?.content) { alert('沒有 FB 暫存內容。請先在 Edge 用書籤送過來。'); return }
                  const prompt =
`我分享一個別人與 AI 協作的案例（從 FB 暫存帶入），請分析：

## 貼文來源
${d.url}

## 作者
${d.author || '（未識別）'}

## 內文
${d.content}

${d.comments?.length ? `## 留言\n${d.comments.join('\n---\n')}\n` : ''}
${d.links?.length    ? `## 內含外部連結\n${d.links.join('\n')}\n`  : ''}

請分析提煉協作模式 + 查證 + 差距分析 + 改進建議。`
                  setShowWorkflow(false)
                  handleSend(prompt)
                }}
                title="帶入最新一筆由 bookmarklet 送來的 FB 內容"
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold tracking-wide border border-blue-500/60 text-blue-400 hover:bg-blue-500/10 transition-colors"
                style={{ touchAction: 'manipulation' }}>
                <span>📋</span><span>FB 暫存</span>
              </button>
              </Tooltip>
              {/* 人脈盤查 — 審查近期工作模式，評估是否需要擴充心腹陣容 */}
              <Tooltip content={'人脈盤查\n審查近期工作模式，找出可成為新心腹的重複流程\n回顧 last_session_state + 跨 session 模式'}>
              <button
                onClick={() => {
                  const prompt =
`人脈盤查 — 請審查近期的工作模式，評估是否需要擴充心腹陣容：

1. 回顧 .agent/last_session_state.md 以及最近幾個 session 的工作紀錄（若有）
2. 找出重複出現、目的一致、步驟固定的工作流程，特別是跨 session 都有出現的模式
3. 評估這些流程是否符合「目標明確 + 重複性高 + 有固定步驟」的心腹條件
4. 用我們稍早討論新增工作流的方式提出建議：這個流程是什麼、為什麼值得成為心腹、附上 prompt 模板草稿
5. 若現有心腹有可以優化的，也一起提出
6. 等我確認後再實際加入心腹系統

請用我們平常討論事情的方式來聊，不只是列清單。`
                  setShowWorkflow(false)
                  handleSend(prompt)
                }}
                onTouchEnd={e => {
                  e.preventDefault()
                  const prompt =
`人脈盤查 — 請審查近期的工作模式，評估是否需要擴充心腹陣容：

1. 回顧 .agent/last_session_state.md 以及最近幾個 session 的工作紀錄（若有）
2. 找出重複出現、目的一致、步驟固定的工作流程，特別是跨 session 都有出現的模式
3. 評估這些流程是否符合「目標明確 + 重複性高 + 有固定步驟」的心腹條件
4. 用我們稍早討論新增工作流的方式提出建議：這個流程是什麼、為什麼值得成為心腹、附上 prompt 模板草稿
5. 若現有心腹有可以優化的，也一起提出
6. 等我確認後再實際加入心腹系統

請用我們平常討論事情的方式來聊，不只是列清單。`
                  setShowWorkflow(false)
                  handleSend(prompt)
                }}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold tracking-wide border border-[var(--gold)]/60 text-[var(--gold)]/80 hover:bg-[var(--gold)]/10 hover:text-[var(--gold)] transition-colors"
                style={{ touchAction: 'manipulation' }}>
                <span>🕵</span><span>人脈盤查</span>
              </button>
              </Tooltip>
            </>} />
        )}

        {/* 排隊機制已拿掉（少爺 2026-04-27），思考中送出直接送 */}
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative group">
                {a.type.startsWith('image/') ? (
                  <img src={a.dataUrl} alt={a.name}
                    className="h-12 w-12 object-cover rounded border border-[var(--border)]" />
                ) : (
                  <div className="h-12 px-2 flex items-center rounded border border-[var(--border)] bg-[var(--surface-2)] text-[9px] text-[var(--text-muted)] max-w-[80px] truncate">
                    {a.name}
                  </div>
                )}
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 flex w-4 h-4 rounded-full bg-red-700/90 text-white text-[8px] items-center justify-center">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="p-2 flex gap-2 items-end">
          {/* ✦ Inject preference (B機制) */}
          <button
            onClick={() => setInjectOnce(v => !v)}
            title={injectOnce ? '偏好注入：開（送出後自動關閉）' : '偏好注入：關（點擊啟用單次注入）'}
            className={`w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded border text-xs transition-colors shrink-0 touch-manipulation ${
              injectOnce
                ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'
            }`}>✦</button>
          {/* ⚡ Workflow toggle */}
          <button
            onClick={() => setShowWorkflow(v => !v)}
            title="心腹"
            className={`w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded border text-xs transition-colors shrink-0 touch-manipulation ${
              showWorkflow
                ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'
            }`}>⚡</button>
          {/* + button */}
          <div className="relative" ref={attachMenuRef}>
            <button
              onClick={() => setShowAttachMenu(v => !v)}
              disabled={running}
              className="w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)] transition-colors text-sm disabled:opacity-40 touch-manipulation"
              title="附加檔案">+</button>
            {showAttachMenu && (
              <div className="absolute bottom-full left-0 mb-1 w-44 bg-[var(--surface-2)] border border-[var(--border)] rounded shadow-lg z-20 overflow-hidden">
                <button onClick={() => { fileInputRef.current?.click() }}
                  className="w-full text-left px-3 py-2 text-[10px] text-[var(--text)] hover:bg-[var(--surface)] flex items-center gap-2">
                  <span>⬆</span> Upload from computer
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv"
              className="hidden" onChange={handleFileChange} />
          </div>

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={running ? '思考中可繼續送出（直接送，不再排隊）…' : '輸入訊息…'}
            rows={2}
            className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-base md:text-[11px] text-[var(--text)] resize-none outline-none placeholder:text-[var(--text-muted)]"
          />
          <div className="flex flex-col gap-1 shrink-0">
            <button
              onClick={() => handleSend()}
              onTouchEnd={e => { e.preventDefault(); handleSend() }}
              disabled={!input.trim() && attachments.length === 0}
              className={`px-4 py-3 md:px-3 md:py-1.5 rounded border text-[11px] md:text-[10px] active:opacity-80 disabled:opacity-40 select-none min-w-[52px] ${
                running
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/25'
                  : 'bg-[var(--gold)]/20 border-[var(--gold)]/50 text-[var(--gold)] hover:bg-[var(--gold)]/30'
              }`}
              style={{ touchAction: 'manipulation' }}
            >送出</button>
            {running && (
              <button onClick={handleStop}
                onTouchEnd={e => { e.preventDefault(); handleStop() }}
                className="px-4 py-3 md:px-3 md:py-1.5 rounded bg-red-900/30 border border-red-700/50 text-red-300 text-[11px] md:text-[10px] hover:bg-red-800/50"
                style={{ touchAction: 'manipulation' }}>
                停止
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export { ChatPanel }
