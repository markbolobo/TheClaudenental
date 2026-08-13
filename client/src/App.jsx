import { useState, useEffect, useRef, useCallback } from 'react'
import { useCostEngine, BountyOverlay, BountyToast, ContractModal, fmtCost, computeDeltaCost } from './BountySystem.jsx'
import { TodoBoard } from './TodoBoard.jsx'
import { MetricsDashboard } from './MetricsDashboard.jsx'
import { SommelierPanel } from './Sommelier.jsx'
import { QAMonitorPanel } from './QAMonitor.jsx'
import BountySettings from './BountySettings.jsx'
import MarkerPanel from './MarkerPanel.jsx'
import CellarPanel from './CellarPanel.jsx'
import { ChatPanel } from './ChatPanel.jsx'
import { PresentButton } from './PresentationView.jsx'
import { MODEL_OPTIONS } from './modelOptions.js'
import { useChatOutline, OutlineMinimap, openInVSCode, normPath, RATING_KEY, PREF_TEXT_KEY, loadRatingsCache, loadRatings } from './chatSupport.jsx'

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = `ws://${location.host}/ws`

const STATUS_ICON = {
  active:   '●',
  sleeping: '◌',
  waiting:  '◐',
  error:    '✕',
  done:     '✓',
}

// ─── (mock data removed — sessions come from server via WebSocket) ───────────

// ─── Utility ──────────────────────────────────────────────────────────────────

function elapsed(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function fmtHour(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status }) {
  const cls = {
    active:   'text-green-400',
    sleeping: 'text-gray-600 shimmer',
    waiting:  'text-amber-400 pulse-amber',
    error:    'text-red-400',
    done:     'text-blue-400',
  }[status] ?? 'text-gray-500'
  return <span className={`text-xs ${cls}`}>{STATUS_ICON[status] ?? '?'}</span>
}

// ─── Activity Heat ────────────────────────────────────────────────────────────
// Heat thresholds (USD) — colour shifts cold→warm→hot→critical
const HEAT_MAX_5H  = 10   // $10 in 5h  = full bar
const HEAT_MAX_7D  = 50   // $50 in 7d  = full bar

function heatColor(ratio) {
  if (ratio < 0.25) return { bar: '#22d3ee', glow: 'rgba(34,211,238,0.4)' }   // cyan — cold
  if (ratio < 0.55) return { bar: '#c9a227', glow: 'rgba(201,162,39,0.45)' }   // gold — warm
  if (ratio < 0.80) return { bar: '#f97316', glow: 'rgba(249,115,22,0.50)' }   // orange — hot
  return                  { bar: '#ef4444', glow: 'rgba(239,68,68,0.60)' }       // red — critical
}

function ActivityHeat() {
  const [heat, setHeat] = useState(null)

  useEffect(() => {
    function load() {
      fetch('/api/usage/heat')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.session5h && d?.weekly7d) setHeat(d) })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  if (!heat) return null
  const { session5h, weekly7d } = heat

  function HeatBar({ label, window, cost, max }) {
    const ratio = Math.min(cost / max, 1)
    const pct   = (ratio * 100).toFixed(0)
    const c     = heatColor(ratio)
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="text-[8px] tracking-[0.18em] uppercase"
            style={{ color: c.bar }}>{label}</span>
          <span className="text-[8px] tabular-nums font-mono"
            style={{ color: c.bar }}>{fmtCost(cost) ?? '$0.00'}</span>
        </div>
        <div className="h-[3px] rounded-full bg-[var(--border)] overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, background: c.bar, boxShadow: `0 0 6px ${c.glow}` }} />
        </div>
        <div className="text-[7px] text-[var(--text-muted)] tracking-wider">{window}</div>
      </div>
    )
  }

  return (
    <div className="mx-2 mt-2 mb-1 px-2.5 py-2 rounded-sm border border-[var(--border)]
      bg-[var(--surface-2)]">
      <div className="text-[7px] text-[var(--text-muted)] tracking-[0.3em] uppercase mb-2 text-center">
        ── Activity Heat ──
      </div>
      <div className="space-y-2">
        <HeatBar label="Session"  window="5 hr window" cost={session5h.cost} max={HEAT_MAX_5H} />
        <HeatBar label="Profile"  window="7 day window" cost={weekly7d.cost}  max={HEAT_MAX_7D} />
      </div>
    </div>
  )
}

function SessionItem({ session, isSelected, onClick, onDoubleClick, onCostClick, autoResumeArmed, autoResumeFireAt, onToggleAutoResume, hitLimit, isChatSession, chatStage = 1, chatRunning = 0, chatLastDelta = null, chatBaseline = 0, onPermissionResponse, showChatPermission = false }) {
  const base = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-all'
  const selectedCls = isSelected
    ? 'bg-[var(--surface-2)] session-active-glow'
    : 'hover:bg-[var(--surface-2)]'

  // ── Cost delta animation ─────────────────────────────────────────────────
  const rawCost = session.costUsd ?? null
  const [displayedCost, setDisplayedCost] = useState(rawCost)
  const [deltaAmt, setDeltaAmt]           = useState(null)   // number | null
  const [deltaPhase, setDeltaPhase]       = useState('idle') // 'idle'|'show'|'fade'
  const prevRawRef = useRef(rawCost)
  const t1Ref = useRef(null)
  const t2Ref = useRef(null)

  useEffect(() => {
    if (rawCost == null) { setDisplayedCost(null); prevRawRef.current = null; return }
    const prev = prevRawRef.current
    prevRawRef.current = rawCost

    if (prev == null || rawCost - prev <= 0.000001) {
      setDisplayedCost(rawCost)
      return
    }

    const d = rawCost - prev
    // Phase 2: keep showing OLD cost + "+delta" for 0.2 s
    setDeltaAmt(d)
    setDeltaPhase('show')

    clearTimeout(t1Ref.current)
    clearTimeout(t2Ref.current)

    t1Ref.current = setTimeout(() => {
      // Phase 3: switch to new total, delta fades out
      setDisplayedCost(rawCost)
      setDeltaPhase('fade')
      t2Ref.current = setTimeout(() => { setDeltaAmt(null); setDeltaPhase('idle') }, 550)
    }, 200)

    return () => { clearTimeout(t1Ref.current); clearTimeout(t2Ref.current) }
  }, [rawCost])

  return (
    <div className={`${base} ${selectedCls}`} onClick={onClick} onDoubleClick={onDoubleClick}>
      <StatusDot status={session.status} />
      <div className="flex-1 min-w-0">
        {/* Row 1: session name */}
        <div className="truncate text-[var(--text-h)] text-xs leading-tight mb-0.5">
          {session.origin === 'tc' && <span title="TC 開的聊天室（仕酒師/QA 喚醒）" className="mr-1">🍷</span>}
          {session.displayName}
        </div>
        {/* Row 2: time */}
        <div className="text-[10px] text-[var(--text-muted)]">
          {elapsed(session.startedAt)} ago
        </div>
        {/* Row 3: cost + auto-resume toggle */}
        <div className="flex items-center gap-1 mt-0.5">
          {/* Cost display — 5-stage for active chat, simple badge otherwise */}
          {isChatSession && (chatStage === 2 || chatStage === 3) ? (
            // Stage 2: baseline(gray) | running(gold) | +delta(green)
            // Stage 3: baseline(gray) | running(gold)
            <button onClick={e => { e.stopPropagation(); onCostClick?.() }}
              className="flex items-center gap-1 tabular-nums text-[9px] font-mono">
              <span className={`transition-colors duration-700 ${chatStage === 2 ? 'text-gray-600' : 'text-gray-500'}`}>
                {fmtCost(chatBaseline)}
              </span>
              <span className="text-[var(--gold)]">{fmtCost(chatRunning)}</span>
              {chatStage === 2 && chatLastDelta != null && (
                <span className="text-green-400">+{fmtCost(chatLastDelta)}</span>
              )}
            </button>
          ) : displayedCost != null ? (
            // Stage 1 / 4 / 5 (or non-chat session): single total badge
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); onCostClick?.() }}
                className="tabular-nums text-[var(--gold)]/80 hover:text-[var(--gold)] transition-colors
                  border-b border-[var(--gold)]/20 hover:border-[var(--gold)]/60 leading-tight text-[9px]">
                {fmtCost(displayedCost)}
              </button>
              {deltaAmt != null && (
                <span
                  className={`absolute left-full pl-1 top-0 tabular-nums text-green-400 text-[9px] whitespace-nowrap pointer-events-none transition-opacity duration-500 ${
                    deltaPhase === 'fade' ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  +{fmtCost(deltaAmt)}
                </span>
              )}
            </div>
          ) : null}

          {/* Auto-resume toggle — visible when sleeping OR when usage limit hit */}
          {(session.status === 'sleeping' || hitLimit) && (
            <button
              onClick={e => { e.stopPropagation(); onToggleAutoResume?.() }}
              title={autoResumeArmed ? '自動繼續 ON — 點擊取消（無頭續跑：VS Code 分頁不會即時顯示，之後重開分頁可見）' : '設定整點自動繼續（無頭續跑：VS Code 分頁不會即時顯示，之後重開分頁可見）'}
              className={`flex items-center gap-0.5 text-[9px] px-1 leading-none rounded border transition-colors ${
                autoResumeArmed
                  ? 'border-amber-500/80 text-amber-400 pulse-amber'
                  : 'border-gray-600/40 text-gray-600 hover:border-gray-500 hover:text-gray-400'
              }`}
            >
              <span>⏰</span>
              <span>{autoResumeArmed ? `${fmtHour(autoResumeFireAt) || '?'} 自動發送訊息` : '尚未預約'}</span>
            </button>
          )}
        </div>
        {/* Row 4: pending permission — chat session 的權限卡桌面端由右側欄顯示；手機端無右側欄，呼叫端開 showChatPermission 在列表內補上 */}
        {session.pendingPermission && (!isChatSession || showChatPermission) && (
          <div className="mt-1 rounded border border-amber-600/40 bg-amber-900/10 px-1.5 py-1">
            <div className="text-[8px] text-amber-400 font-semibold tracking-wide mb-0.5">⚠ 需要授權</div>
            <div className="text-[9px] text-[var(--text)] font-mono truncate mb-1">{session.pendingPermission.toolName}</div>
            <div className="flex gap-1">
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'approve') }}
                className="flex-1 py-0.5 rounded bg-green-900/40 border border-green-700 text-green-300 text-[8px]"
              >✓</button>
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'allow_always') }}
                className="flex-1 py-0.5 rounded bg-yellow-900/40 border border-yellow-600 text-yellow-300 text-[8px]"
              >⭐</button>
              <button
                onClick={e => { e.stopPropagation(); onPermissionResponse?.(session.pendingPermission.permissionId, 'block') }}
                className="flex-1 py-0.5 rounded bg-red-900/40 border border-red-700 text-red-300 text-[8px]"
              >✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const SESSION_LIMIT_MS = 5 * 60 * 60 * 1000 // 5 hours

// 冷卻到期後，下一個整點 :00:01 (瀏覽器本地時區)
function nextWholeHourAfter(ms) {
  const d = new Date(ms)
  d.setMinutes(0, 1, 0)
  if (d.getTime() <= ms) d.setHours(d.getHours() + 1)
  return d.getTime()
}

// ─── WebSocket hook ───────────────────────────────────────────────────────────

function useWebSocket(url, onMessage) {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let ws
    let retryTimer

    function connect() {
      ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        retryTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = e => {
        try { onMessage(JSON.parse(e.data)) } catch {}
      }
    }

    connect()
    return () => {
      clearTimeout(retryTimer)
      ws?.close()
    }
  }, [url])  // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(data => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(data))
  }, [])

  return { connected, send }
}

// ─── Tab panels ──────────────────────────────────────────────────────────────

const HISTORY_PREVIEW_LEN = 300

function HistoryMessage({ message: m, sessionId = null }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = m.text.length > HISTORY_PREVIEW_LEN
  const displayed = expanded || !isLong ? m.text : m.text.slice(0, HISTORY_PREVIEW_LEN) + '…'
  return (
    <div className={`text-[11px] rounded px-2 py-1 ${m.role === 'user' ? 'bg-[var(--surface-2)] text-[var(--gold)]' : 'text-[var(--text-muted)]'}`}>
      <div className="font-semibold text-[9px] uppercase mb-0.5 opacity-60 flex items-center gap-2">
        <span className="flex-1">{m.role}</span>
        {/* 🎬 演出（少爺 2026-07-21）：HISTORY 內每則 assistant 回覆可單獨套用互動簡報回放 */}
        {m.role === 'assistant' && sessionId && <PresentButton sessionId={sessionId} text={m.text} />}
      </div>
      <div className="whitespace-pre-wrap break-words">{displayed}</div>
      {isLong && (
        <button
          onClick={() => setExpanded(x => !x)}
          className="mt-1 text-[9px] text-[var(--gold)]/70 hover:text-[var(--gold)] underline"
        >
          {expanded ? '▲ 收起' : '▼ 展開全文'}
        </button>
      )}
    </div>
  )
}



function HistoryPanel({ onContinue }) {
  const [list, setList] = useState([])
  const [active, setActive] = useState(null)
  // 少爺 2026-07-16：點 tag 過濾聊天室（跨室檢索——「哪幾個聊天室都在打野蠻人」）
  const [tagFilter, setTagFilter] = useState(null)
  const [messages, setMessages] = useState([])
  const [activeCost, setActiveCost] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/history').then(r => r.json()).then(d => setList(d.sessions ?? []))
  }, [])

  // 少爺 2026-07-16 Phase2：LLM tag 是背景排隊產生的 → 列表顯示期間輪詢快取端點合併
  // （輕量端點只讀 in-memory cache，不重掃 transcript）
  useEffect(() => {
    if (active) return
    const _iv = setInterval(() => {
      fetch('/api/history/tags').then(r => r.json()).then(d => {
        if (!d?.tags) return
        setList(prev => prev.map(s => d.tags[s.sessionId]
          ? { ...s, tags: d.tags[s.sessionId].tags, summary: d.tags[s.sessionId].summary, knowledge: d.tags[s.sessionId].knowledge, llm: true }
          : s))
      }).catch(() => {})
    }, 15000)
    return () => clearInterval(_iv)
  }, [active])

  // 少爺 2026-07-16：History 詳閱頁也掛大綱 minimap（條目=少爺留言）
  const histScrollRef = useRef(null)
  const outline = useChatOutline(histScrollRef, messages, 'histmsg')

  function jumpToOutline(entry) {
    document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 少爺 2026-07-16：tag/summary 校正（新增=重標必保留、移除=重標不再回來、少爺的話蓋過 LLM）
  const [tagDraft, setTagDraft] = useState('')
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState('')

  async function patchTags(body) {
    if (!active) return
    const d = await fetch(`/api/history/${active.sessionId}/tags`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null)
    if (!d?.ok) return
    setActive(a => ({ ...a, tags: d.tags, summary: d.summary, knowledge: d.knowledge, llm: true }))
    setList(prev => prev.map(s => s.sessionId === active.sessionId
      ? { ...s, tags: d.tags, summary: d.summary, knowledge: d.knowledge, llm: true } : s))
  }

  async function open(s) {
    setActive(s); setLoading(true); setActiveCost(null)
    const d = await fetch(`/api/history/${s.sessionId}`).then(r => r.json())
    setMessages(d.messages ?? [])
    setActiveCost(d.costUsd ?? s.costUsd ?? null)
    setLoading(false)
  }

  if (active) return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <button onClick={() => { setActive(null); setMessages([]) }} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs">← Back</button>
        <span className="flex-1 text-xs text-[var(--text-h)] truncate">{active.title}</span>
        {activeCost != null && (
          <span className="shrink-0 text-[10px] text-[var(--gold)]/80">{fmtCost(activeCost)}</span>
        )}
        {active.cwd && (
          <button
            onClick={() => onContinue({ sessionId: active.sessionId, projectPath: active.cwd })}
            className="shrink-0 px-2 py-1 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/50 text-[var(--gold)] text-[9px] hover:bg-[var(--gold)]/30"
          >
            ▶ Continue in Chat
          </button>
        )}
      </div>
      {/* LLM 語意摘要 + 標籤校正 + 相關拼圖（Phase2：少爺可編輯——校正 LLM 認知，校正必勝重標） */}
      <div className="px-3 py-1.5 border-b border-[var(--border)]/60 bg-[var(--surface-2)]/40 shrink-0 space-y-1">
        {editingSummary ? (
          <input autoFocus value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { patchTags({ summary: summaryDraft }); setEditingSummary(false) }
              if (e.key === 'Escape') setEditingSummary(false)
            }}
            className="w-full bg-[var(--surface-2)] border border-[var(--gold-border)] rounded px-2 py-0.5 text-[10px] text-[var(--text-h)] focus:outline-none" />
        ) : (
          <div className="text-[10px] text-[var(--text)] flex items-center gap-1">
            <span className="flex-1">📎 {active.summary || '（尚無 LLM 摘要——排隊標記中）'}</span>
            <button onClick={() => { setSummaryDraft(active.summary ?? ''); setEditingSummary(true) }}
              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--gold)]" title="校正摘要">✏</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {(active.tags ?? []).map((t, i) => (
            <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full border border-[var(--gold-border)] bg-[var(--gold-dim)] text-[var(--text)]">
              <span className="text-[var(--gold)]/70">#</span>{t}
              <button onClick={() => patchTags({ removeTag: t })} title="移除（LLM 重標不會再加回）"
                className="ml-1 text-[var(--text-muted)] hover:text-[var(--red)]">✕</button>
            </span>
          ))}
          <input value={tagDraft} onChange={e => setTagDraft(e.target.value)} placeholder="＋新增標籤"
            onKeyDown={e => { if (e.key === 'Enter' && tagDraft.trim()) { patchTags({ addTag: tagDraft.trim() }); setTagDraft('') } }}
            className="w-24 bg-transparent border border-[var(--border)] rounded-full px-2 py-0.5 text-[9px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]" />
        </div>
        {(active.knowledge ?? []).some(k => k.docs?.length) && (
          <div className="flex flex-wrap gap-1">
            {active.knowledge.filter(k => k.docs?.length).map((k, i) => (
              <button key={i} title={`${k.docs.join('\n')}\n（點擊在 VSCode 開第一份拼圖）`}
                onClick={() => openInVSCode(k.docs[0])}
                className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold-border)] text-[var(--gold)]/80 hover:bg-[var(--gold-dim)] hover:text-[var(--gold)] cursor-pointer">
                🧩 {k.term}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* relative wrapper：讓大綱 minimap 疊在捲動區右緣、不隨內容捲動 */}
      <div className="relative flex-1 min-h-0">
        <div ref={histScrollRef} onScroll={outline.update} className="h-full overflow-y-auto px-3 py-2 space-y-2">
          {loading && <div className="text-[var(--text-muted)] text-xs">Loading…</div>}
          {messages.map((m, i) => (
            m.role === 'user'
              ? <div key={i} id={`histmsg-${i}`}><HistoryMessage message={m} sessionId={active.sessionId} /></div>
              : <HistoryMessage key={i} message={m} sessionId={active.sessionId} />
          ))}
        </div>
        <OutlineMinimap entries={outline.entries} activeId={outline.activeId} onJump={jumpToOutline} />
      </div>
    </div>
  )

  const shownList = tagFilter ? list.filter(s => (s.tags ?? []).includes(tagFilter)) : list

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2">
      {/* tag 過濾列（點列表任一 tag 進入；✕ 清除） */}
      {tagFilter && (
        <div className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded border border-[var(--gold-border)] bg-[var(--gold-dim)]">
          <span className="text-[10px] text-[var(--gold)]">
            <span className="opacity-70">#</span>{tagFilter}
          </span>
          <span className="text-[9px] text-[var(--text-muted)]">{shownList.length} 個聊天室</span>
          <button onClick={() => setTagFilter(null)}
            className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">✕ 清除過濾</button>
        </div>
      )}
      {shownList.length === 0 && (
        <div className="text-[var(--text-muted)] text-xs text-center mt-8">
          {tagFilter ? `沒有聊天室帶 #${tagFilter}` : 'No history'}
        </div>
      )}
      {shownList.map(s => (
        <div key={s.sessionId} onClick={() => open(s)} title={s.summary || undefined}
          className="flex items-start gap-2 px-3 py-2 rounded hover:bg-[var(--surface-2)] cursor-pointer mb-1">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-[var(--text-h)] truncate">{s.title}</div>
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
              <span className="truncate">{s.project.replace('c--', '').replace(/-/g,'/')} · {new Date(s.mtime).toLocaleDateString()}</span>
              {s.costUsd != null && <span className="shrink-0 text-[var(--gold)]/70">{fmtCost(s.costUsd)}</span>}
            </div>
          </div>
          {/* 少爺 2026-07-16：聊天室重點 hashtag（LLM 語意 tag=金框；點 tag 過濾同主題聊天室） */}
          {Array.isArray(s.tags) && s.tags.length > 0 && (
            <div className="shrink-0 max-w-[45%] flex flex-wrap gap-1 justify-end pt-0.5">
              {s.tags.map((t, ti) => (
                <span key={ti}
                  onClick={e => { e.stopPropagation(); setTagFilter(t) }}
                  title={`${s.llm ? (s.summary || 'LLM 語意標籤') : '暫用詞頻墊檔——LLM 語意標籤排隊中，標完自動變金框'}\n（點擊過濾 #${t}）`}
                  className={`text-[9px] leading-tight px-1.5 py-0.5 rounded-full border whitespace-nowrap cursor-pointer hover:border-[var(--gold)] ${s.llm
                    ? 'border-[var(--gold-border)] bg-[var(--gold-dim)] text-[var(--text)]'
                    : 'border-[var(--border-2)] bg-[var(--surface-2)]/70 text-[var(--text-muted)]'}`}>
                  <span className="text-[var(--gold)]/70">#</span>{t}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}



function analyzeRatings(ratings) {
  if (!ratings || ratings.length < 3) return null
  const explicit = ratings.filter(r => r.explicit)
  const ups      = explicit.filter(r => r.reaction === 'up')
  const downs    = explicit.filter(r => r.reaction === 'down')
  const passive  = ratings.filter(r => !r.explicit)
  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null
  const avgUpLen   = avg(ups.map(r => r.features?.len).filter(Boolean))
  const avgDownLen = avg(downs.map(r => r.features?.len).filter(Boolean))
  const avgPassLen = avg(passive.map(r => r.features?.len).filter(Boolean))
  const fRate = (list, f) => list.length ? list.filter(r => r.features?.[f]).length / list.length : 0
  const feats = {}
  for (const f of ['hasCode', 'hasList', 'hasHeaders']) {
    feats[f] = { up: fRate(ups, f), down: fRate(downs, f), pass: fRate(passive, f) }
  }
  const tagMap = {}
  for (const r of explicit) {
    for (const tag of r.tags || []) {
      if (!tagMap[tag]) tagMap[tag] = { up: 0, down: 0 }
      tagMap[tag][r.reaction || 'up']++
    }
  }

  // ── 方向偵測（第二層）────────────────────────────────────────────────────
  const wrongDir        = explicit.filter(r => r.tags?.includes('方向偏了'))
  const wrongDirRatio   = explicit.length > 0 ? wrongDir.length / explicit.length : 0
  // 近10筆趨勢
  const recent10        = explicit.slice(-10)
  const recentWrongDir  = recent10.filter(r => r.tags?.includes('方向偏了'))
  const recentRatio     = recent10.length > 0 ? recentWrongDir.length / recent10.length : 0
  // 特徵相關：哪類回應容易方向偏
  const wdFeats = {}
  for (const f of ['hasCode', 'hasList', 'hasHeaders']) {
    const wdWithF  = wrongDir.filter(r => r.features?.[f]).length
    const allWithF = explicit.filter(r => r.features?.[f]).length
    wdFeats[f] = allWithF > 0 ? wdWithF / allWithF : 0
  }
  const wdLong = wrongDir.filter(r => (r.features?.len || 0) > 500).length
  const allLong = explicit.filter(r => (r.features?.len || 0) > 500).length
  wdFeats.longMsg = allLong > 0 ? wdLong / allLong : 0
  // 警示等級
  const wdLevel = recentRatio >= 0.3 ? 'high' : recentRatio >= 0.15 ? 'mid' : wrongDirRatio >= 0.15 ? 'low' : 'ok'

  return { total: ratings.length, explicit: explicit.length, ups: ups.length, downs: downs.length,
           passive: passive.length, avgUpLen, avgDownLen, avgPassLen, feats, tagMap,
           wrongDir: { count: wrongDir.length, ratio: wrongDirRatio, recentRatio, wdFeats, level: wdLevel } }
}

function generatePrefText(a) {
  if (!a) return ''
  const lines = []
  if (a.avgUpLen && a.avgDownLen) {
    if (a.avgUpLen < a.avgDownLen - 100)
      lines.push(`回應長度：偏短（約 ${a.avgUpLen} 字為佳，超過會顯冗長）`)
    else
      lines.push(`回應長度：約 ${a.avgUpLen} 字左右即可`)
  } else if (a.avgPassLen) {
    lines.push(`回應長度：目前接受約 ${a.avgPassLen} 字`)
  }
  const { hasCode, hasList, hasHeaders } = a.feats
  if (hasList?.up > 0.6)    lines.push('結構：偏好條列式，少用大段落')
  if (hasList?.down > 0.6)  lines.push('結構：偏好段落式，避免大量條列')
  if (hasCode?.up > 0.5)    lines.push('程式碼區塊：歡迎適度使用')
  if (hasHeaders?.down > 0.5) lines.push('標題層級：避免過多，保持輕量')
  const topDown = Object.entries(a.tagMap).filter(([,v]) => v.down > 0).sort((x,y) => y[1].down - x[1].down).slice(0,3).map(([k]) => k)
  if (topDown.includes('太長'))    lines.push('給出答案後不要繼續延伸，直接停')
  if (topDown.includes('太囉嗦'))  lines.push('不要重述問題或做開場白，直接進入正題')
  if (topDown.includes('太短') || topDown.includes('需要更多細節')) lines.push('回答請充分展開，不要點到為止')
  // 方向偵測注入
  const wd = a.wrongDir
  if (wd?.level === 'high')
    lines.push(`⚠️ 方向確認（高頻）：近期 ${Math.round(wd.recentRatio*100)}% 回應方向偏了，不確定時必須先提案確認再動手`)
  else if (wd?.level === 'mid')
    lines.push(`⚠️ 方向確認：近期出現方向偏離訊號（${Math.round(wd.recentRatio*100)}%），複雜任務請先確認理解方向`)
  else if (wd?.level === 'low')
    lines.push(`方向確認：偶有方向偏離（${Math.round(wd.ratio*100)}%），複雜需求可先說明理解再執行`)
  if (!lines.length) lines.push('暫無明確偏好，維持現有風格')
  return lines.join('\n')
}



// ─── Preferences Panel ────────────────────────────────────────────────────────

// ── Snapshot helpers ──────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const d = await fetch('/api/ratings/history').then(r => r.json())
    return d.history ?? []
  } catch { return [] }
}

function saveSnapshot(analysis, text, note = '') {
  if (!analysis) return
  const snapshot = {
    ts: Date.now(), text, note,
    stats: {
      total:               analysis.total,
      explicit:            analysis.explicit,
      ups:                 analysis.ups,
      downs:               analysis.downs,
      upRatio:             analysis.explicit > 0 ? analysis.ups / analysis.explicit : 0,
      wrongDirRatio:       analysis.wrongDir?.ratio ?? 0,
      recentWrongDirRatio: analysis.wrongDir?.recentRatio ?? 0,
      wdLevel:             analysis.wrongDir?.level ?? 'ok',
      avgUpLen:            analysis.avgUpLen ?? null,
    },
  }
  fetch('/api/ratings/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  }).catch(() => {})
  return snapshot
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ data, color = 'var(--gold)', width = 120, height = 28, label }) {
  if (!data || data.length < 2) return <span className="text-[8px] text-[var(--text-muted)]">資料不足</span>
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 0.001
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - 2 - ((v - min) / range) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const lastY = height - 2 - ((data[data.length - 1] - min) / range) * (height - 4)
  const lastVal = data[data.length - 1]
  const prevVal = data[data.length - 2]
  const trend = lastVal > prevVal + 0.01 ? '↑' : lastVal < prevVal - 0.01 ? '↓' : '→'
  const trendColor = color === 'var(--gold)' ? 'text-[var(--gold)]'
    : lastVal > prevVal + 0.01 ? 'text-green-400' : lastVal < prevVal - 0.01 ? 'text-red-400' : 'text-[var(--text-muted)]'
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[8px] text-[var(--text-muted)] w-14 shrink-0">{label}</span>}
      <svg width={width} height={height} className="overflow-visible shrink-0">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />
        <circle cx={(data.length - 1) / (data.length - 1) * width} cy={lastY} r="2.5" fill={color} />
      </svg>
      <span className={`text-[9px] font-mono ${trendColor} shrink-0`}>
        {(lastVal * 100).toFixed(0)}% {trend}
      </span>
    </div>
  )
}

// 回應風格設定（少爺 2026-07-21：官方文字 vs 互動簡報濾鏡；跨裝置存 server present.json）
function PresentStylePanel() {
  const [cfg, setCfg] = useState(null)
  useEffect(() => {
    fetch('/api/present/config').then(r => r.json()).then(d => setCfg(d.config)).catch(() => {})
  }, [])
  function save(patch) {
    setCfg(c => ({ ...c, ...patch }))
    fetch('/api/present/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }
  if (!cfg) return null
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--gold-border)] rounded p-2.5">
      <div className="text-[10px] uppercase tracking-widest text-[var(--gold)] mb-1.5">🎬 回應風格</div>
      <div className="flex flex-col gap-1.5">
        {[
          { v: 'official', label: '官方文字', desc: '現行 markdown 呈現；每則回覆仍可手動 🎬 演出' },
          { v: 'present', label: '互動簡報', desc: 'CHAT 新回覆完成後自動轉譯成卡片流演出（原文永遠保留）' },
        ].map(o => (
          <label key={o.v} className="flex items-start gap-2 cursor-pointer select-none">
            <input type="radio" name="present-mode" checked={cfg.mode === o.v}
              onChange={() => save({ mode: o.v })} className="accent-[var(--gold)] mt-0.5" />
            <span className="text-[11px] text-[var(--text)]">{o.label}
              <span className="block text-[9px] text-[var(--text-muted)]">{o.desc}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[9px] text-[var(--text-muted)] shrink-0">轉譯模型</span>
          <select value={cfg.model ?? ''} onChange={e => save({ model: e.target.value })}
            className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]">
            <option value="claude-haiku-4-5-20251001">Haiku（快，預設）</option>
            {MODEL_OPTIONS.filter(o => o.value).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="text-[8px] text-[var(--text-muted)]/70">
          演出上的 👍👎 與快速回饋會累積注入之後的轉譯——這個工具會跟著我們的合作愈調愈準。
        </div>
      </div>
    </div>
  )
}

function PreferencesPanel() {
  const [ratings, setRatings]   = useState(() => loadRatingsCache())  // init from cache, then fetch
  const [prefText, setPrefText] = useState(() => localStorage.getItem(PREF_TEXT_KEY) || '')
  const [syncing, setSyncing]   = useState(false)
  const [copied, setCopied]     = useState(false)
  const [history, setHistory]   = useState([])
  const [histOpen, setHistOpen] = useState(false)
  const [snapNote, setSnapNote] = useState('')

  // On mount: pull from server (cross-device source of truth)
  useEffect(() => {
    setSyncing(true)
    loadRatings().then(all => { setRatings(all); setSyncing(false) })
    fetch('/api/ratings/prefs').then(r => r.json()).then(d => {
      if (d.text) { setPrefText(d.text); localStorage.setItem(PREF_TEXT_KEY, d.text) }
    }).catch(() => {})
    loadHistory().then(setHistory)
  }, [])

  const analysis = analyzeRatings(ratings)

  function refresh() {
    setSyncing(true)
    loadRatings().then(all => { setRatings(all); setSyncing(false) })
  }

  function runAnalysis() {
    const text = generatePrefText(analysis)
    setPrefText(text)
    localStorage.setItem(PREF_TEXT_KEY, text)
    fetch('/api/ratings/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {})
    // 儲存快照
    const snap = saveSnapshot(analysis, text, snapNote)
    if (snap) { setHistory(h => [...h, snap]); setSnapNote('') }
  }

  function updatePrefText(v) {
    setPrefText(v)
    localStorage.setItem(PREF_TEXT_KEY, v)
    fetch('/api/ratings/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: v }),
    }).catch(() => {})
  }

  function clearAll() {
    if (!window.confirm('確認清除所有評分紀錄？')) return
    localStorage.removeItem(RATING_KEY)
    fetch('/api/ratings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: { id: '__clear__', __clearAll: true } }),
    }).catch(() => {})
    setRatings([])
  }

  async function copyPref() {
    await navigator.clipboard.writeText(prefText).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  const ups   = ratings.filter(r => r.reaction === 'up').length
  const downs = ratings.filter(r => r.reaction === 'down').length
  const expl  = ratings.filter(r => r.explicit).length
  const passv = ratings.filter(r => !r.explicit).length

  // Tag frequency from explicit ratings
  const tagFreq = {}
  for (const r of ratings.filter(r => r.explicit)) {
    for (const t of r.tags || []) { tagFreq[t] = (tagFreq[t] || 0) + 1 }
  }
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 6)

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">

      {/* Left: stats + history */}
      <div className="flex flex-col md:w-1/2 min-h-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">規矩 · The Rules</span>
          {syncing && <span className="text-[8px] text-[var(--text-muted)] animate-pulse">同步中…</span>}
          <div className="flex-1" />
          <button onClick={refresh} className={`text-[9px] text-[var(--text-muted)] hover:text-[var(--text)] ${syncing ? 'animate-spin' : ''}`}>↺</button>
          <button onClick={clearAll} className="text-[9px] text-[var(--text-muted)] hover:text-red-400 border border-[var(--border)] rounded px-1.5 py-0.5">清除</button>
        </div>
        <div className="p-3 flex flex-col gap-4">

          {/* 回應風格（少爺 2026-07-21：互動簡報濾鏡） */}
          <PresentStylePanel />

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: '總收集', value: ratings.length, sub: '訊號' },
              { label: '主動評分', value: expl, sub: `${ups}👍 ${downs}👎`, gold: true },
              { label: '被動接受', value: passv, sub: '沒評 = 可接受' },
              { label: '資料充足', value: ratings.length >= 10 ? '✓' : `${ratings.length}/10`, sub: '分析需 10 筆' },
            ].map(s => (
              <div key={s.label} className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2">
                <div className={`text-xl font-bold ${s.gold ? 'text-[var(--gold)]' : 'text-[var(--text-h)]'}`}>{s.value}</div>
                <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-wide">{s.label}</div>
                <div className="text-[8px] text-[var(--text-muted)]/70 mt-0.5">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* 方向偵測警示 */}
          {(() => {
            const wd = analysis?.wrongDir
            if (!wd || wd.level === 'ok') return null
            const cfg = {
              high: { bg: 'bg-red-900/20',    border: 'border-red-600/50',    text: 'text-red-400',    icon: '🚨', title: '方向偏離：高頻警示' },
              mid:  { bg: 'bg-amber-900/15',  border: 'border-amber-600/50',  text: 'text-amber-400',  icon: '⚠️', title: '方向偏離：偵測到訊號' },
              low:  { bg: 'bg-yellow-900/10', border: 'border-yellow-700/40', text: 'text-yellow-500', icon: '💡', title: '方向偏離：輕微訊號' },
            }[wd.level]
            const topFeat = Object.entries(wd.wdFeats)
              .filter(([,v]) => v > 0.4)
              .sort((a,b) => b[1]-a[1])
              .map(([k]) => ({ hasCode: '含程式碼', hasList: '含條列', hasHeaders: '含標題', longMsg: '長回應' }[k]))
              .filter(Boolean)
            return (
              <div className={`rounded border ${cfg.border} ${cfg.bg} p-2.5`}>
                <div className={`text-[9px] font-semibold uppercase tracking-wider ${cfg.text} mb-1`}>
                  {cfg.icon} {cfg.title}
                </div>
                <div className="text-[9px] text-[var(--text)] mb-1.5">
                  全部 <span className={cfg.text}>{Math.round(wd.ratio*100)}%</span> 的評分帶有「方向偏了」tag，
                  近 10 筆為 <span className={cfg.text}>{Math.round(wd.recentRatio*100)}%</span>
                  {wd.recentRatio > wd.ratio + 0.1 ? '（趨勢上升）' : ''}
                </div>
                {topFeat.length > 0 && (
                  <div className="text-[9px] text-[var(--text-muted)] mb-1.5">
                    常見於：{topFeat.join('、')}的回應
                  </div>
                )}
                <div className={`text-[9px] ${cfg.text} font-medium`}>
                  → 建議：這類任務先說明理解方向再執行（提案確認模式）
                </div>
                <div className="mt-1.5 text-[8px] text-[var(--text-muted)]/60">
                  此訊號在「重新分析」時會自動注入偏好文字
                </div>
              </div>
            )
          })()}

          {/* Top tags */}
          {topTags.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">常見評語</div>
              <div className="flex flex-wrap gap-1.5">
                {topTags.map(([tag, count]) => (
                  <span key={tag} className="text-[9px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)]">
                    {tag} <span className="text-[var(--gold)]">×{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Rating history */}
          {ratings.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">最近紀錄</div>
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
                {[...ratings].reverse().slice(0, 60).map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-[9px] border-b border-[var(--border)]/30 pb-0.5">
                    <span className="w-4 text-center shrink-0">
                      {r.explicit ? (r.reaction === 'up' ? '👍' : r.reaction === 'down' ? '👎' : '·') : '·'}
                    </span>
                    <span className={`shrink-0 ${r.explicit ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                      {r.explicit ? '主動' : '被動'}
                    </span>
                    <span className="text-[var(--text-muted)] truncate flex-1">{r.tags?.join(' ') || '—'}</span>
                    <span className="shrink-0 font-mono text-[var(--text-muted)]">{r.features?.len ?? 0}字</span>
                    <span className="shrink-0 font-mono text-[var(--text-muted)]/50">
                      {new Date(r.ts).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {ratings.length === 0 && (
            <div className="text-[10px] text-[var(--text-muted)] text-center mt-4">
              還沒有評分紀錄。<br/>每則 Claude 回應右下角有 ◦ 可以評分，<br/>不評分 12 秒後自動記為「被動接受」。
            </div>
          )}
        </div>
      </div>

      {/* Right: preference text + history */}
      <div className="flex flex-col md:w-1/2 min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">偏好文字</span>
          <div className="flex-1" />
          <button onClick={() => setHistOpen(v => !v)}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
              histOpen ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>
            📈 歷史{history.length > 0 ? ` (${history.length})` : ''}
          </button>
          <button onClick={runAnalysis} disabled={!analysis}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)] disabled:opacity-30">
            ⚡ 分析並存檔
          </button>
          <button onClick={copyPref} disabled={!prefText}
            className={`text-[9px] px-2 py-0.5 rounded border transition-colors disabled:opacity-30 ${
              copied ? 'border-green-500 text-green-400' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>
            {copied ? '✓' : '複製'}
          </button>
        </div>

        {/* History view */}
        {histOpen ? (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">

            {/* Sparkline charts */}
            {history.length >= 2 && (
              <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-3 flex flex-col gap-2">
                <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-1">調教曲線</div>
                <Sparkline
                  label="滿意度"
                  data={history.map(s => s.stats.upRatio)}
                  color="#4ade80"
                  width={130} height={30}
                />
                <Sparkline
                  label="方向偏離"
                  data={history.map(s => s.stats.wrongDirRatio)}
                  color="#f87171"
                  width={130} height={30}
                />
                <Sparkline
                  label="評分數量"
                  data={history.map(s => s.stats.total / Math.max(...history.map(x => x.stats.total), 1))}
                  color="var(--gold)"
                  width={130} height={30}
                />
                <div className="text-[8px] text-[var(--text-muted)] mt-0.5">
                  共 {history.length} 次快照 · 最早 {new Date(history[0].ts).toLocaleDateString('zh-TW')} · 最近 {new Date(history[history.length-1].ts).toLocaleDateString('zh-TW')}
                </div>
              </div>
            )}

            {/* Snapshot timeline */}
            {history.length === 0 && (
              <div className="text-[10px] text-[var(--text-muted)] text-center mt-4">
                還沒有歷史快照。<br/>點「⚡ 分析並存檔」建立第一筆。
              </div>
            )}
            {[...history].reverse().map((snap, i) => {
              const prev = history[history.length - 1 - i - 1]
              const upDiff  = prev ? ((snap.stats.upRatio  - prev.stats.upRatio)  * 100).toFixed(0) : null
              const wdDiff  = prev ? ((snap.stats.wrongDirRatio - prev.stats.wrongDirRatio) * 100).toFixed(0) : null
              const isLatest = i === 0
              return (
                <div key={snap.ts} className={`border rounded p-2.5 flex flex-col gap-1.5 ${isLatest ? 'border-[var(--gold)]/50 bg-[var(--gold)]/5' : 'border-[var(--border)] bg-[var(--surface-2)]'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] font-mono ${isLatest ? 'text-[var(--gold)]' : 'text-[var(--text-muted)]'}`}>
                      {new Date(snap.ts).toLocaleString('zh-TW', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
                    </span>
                    {isLatest && <span className="text-[7px] px-1 rounded bg-[var(--gold)]/20 text-[var(--gold)] uppercase tracking-wide">最新</span>}
                    {snap.note && <span className="text-[9px] text-[var(--text-muted)] italic">{snap.note}</span>}
                    <div className="flex-1" />
                    <button onClick={() => { updatePrefText(snap.text); setHistOpen(false) }}
                      className="text-[8px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]">
                      套用
                    </button>
                  </div>
                  <div className="flex gap-3 text-[9px]">
                    <span>
                      滿意度 <span className={`font-mono ${snap.stats.upRatio > 0.6 ? 'text-green-400' : snap.stats.upRatio < 0.4 ? 'text-red-400' : 'text-[var(--text)]'}`}>
                        {(snap.stats.upRatio * 100).toFixed(0)}%
                      </span>
                      {upDiff !== null && <span className={`ml-0.5 text-[8px] ${upDiff > 0 ? 'text-green-400' : upDiff < 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                        {upDiff > 0 ? `+${upDiff}` : upDiff}%
                      </span>}
                    </span>
                    <span>
                      方向偏 <span className={`font-mono ${snap.stats.wrongDirRatio > 0.25 ? 'text-red-400' : 'text-green-400'}`}>
                        {(snap.stats.wrongDirRatio * 100).toFixed(0)}%
                      </span>
                      {wdDiff !== null && <span className={`ml-0.5 text-[8px] ${wdDiff < 0 ? 'text-green-400' : wdDiff > 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                        {wdDiff > 0 ? `+${wdDiff}` : wdDiff}%
                      </span>}
                    </span>
                    <span className="text-[var(--text-muted)]">{snap.stats.total} 筆</span>
                  </div>
                  {snap.text && (
                    <div className="text-[8px] text-[var(--text-muted)] font-mono line-clamp-2 mt-0.5 leading-relaxed">
                      {snap.text.split('\n')[0]}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex-1 p-3 flex flex-col gap-3 overflow-y-auto">
            <div className="text-[9px] text-[var(--text-muted)] leading-relaxed">
              這段文字是從評分資料推導出你的規矩，可以手動修改。<br/>
              「⚡ 分析並存檔」會同時更新偏好文字並儲存一筆歷史快照。
            </div>
            <input value={snapNote} onChange={e => setSnapNote(e.target.value)}
              placeholder="快照備註（選填，例：調整方向偏離問題後）"
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[10px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]" />
            <textarea value={prefText} onChange={e => updatePrefText(e.target.value)}
              rows={8}
              placeholder={ratings.length < 3 ? '評分資料不足（需至少 3 筆）' : '點擊「⚡ 分析並存檔」產生偏好描述'}
              className="flex-1 min-h-[150px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] resize-y font-mono leading-relaxed" />
            <div className="text-[9px] text-[var(--text-muted)] border border-[var(--border)] rounded p-2 bg-[var(--surface-2)]">
              <span className="text-[var(--gold)] font-semibold">A 機制</span>：定期把偏好貼進 <code className="text-[9px]">.agent/preferences.md</code>，Claude 下次啟動時讀到。<br/>
              <span className="text-[var(--gold)] font-semibold">B 機制</span>：點 Chat 輸入框的 <span className="text-[var(--gold)]">✦</span>，單次注入這則訊息。
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

// ─── Prompt Studio ────────────────────────────────────────────────────────────
// 本機模板工具，不走 LLM、不耗 Token。把零散想法組成結構化 prompt，
// 複製支援純文字（Markdown）與保留格式（HTML，貼到 Word / Notion 會變排版）。

const PROMPT_PRESETS = {
  none: { label: '— 無預設 —', role: '' },
  ue:   { label: 'Unreal Engine 開發者', role: '你是一位資深 Unreal Engine 5 遊戲開發者，熟悉 C++、Blueprint、Animation Blueprint、Mover 與 GASP。' },
  code: { label: '資深軟體工程師',        role: '你是一位資深軟體工程師，重視程式碼品質、可讀性與可維護性。' },
  writer:{label: '寫作助理',              role: '你是一位中文寫作編輯，擅長把口語化內容改寫為條理清楚、語氣專業的文字。' },
  teach:{ label: '教學助教',              role: '你是一位耐心的教學助教，會用類比與範例把概念講清楚。' },
  review:{label: '程式碼審查員',          role: '你是一位嚴謹的程式碼審查員，會指出潛在 bug、效能問題與可讀性缺陷。' },
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function buildPrompt({ raw, role, context, task, constraints, output, modifiers }) {
  const md = []
  const html = []
  function section(title, body) {
    if (!body?.trim()) return
    md.push(`## ${title}\n${body.trim()}\n`)
    html.push(`<h3 style="margin:12px 0 4px;font-size:14px;color:#c9a227">${escHtml(title)}</h3><div style="white-space:pre-wrap;line-height:1.55">${escHtml(body.trim())}</div>`)
  }
  function xmlSection(tag, body) {
    if (!body?.trim()) return
    md.push(`<${tag}>\n${body.trim()}\n</${tag}>\n`)
    html.push(`<p style="margin:10px 0 2px;font-family:ui-monospace,monospace;color:#888">&lt;${escHtml(tag)}&gt;</p><div style="white-space:pre-wrap;line-height:1.55;padding-left:10px;border-left:2px solid #333">${escHtml(body.trim())}</div><p style="margin:2px 0 10px;font-family:ui-monospace,monospace;color:#888">&lt;/${escHtml(tag)}&gt;</p>`)
  }
  const S = modifiers.useXmlTags ? xmlSection : section

  if (role?.trim())        S('role', role)
  if (context?.trim())     S('context', context)
  if (task?.trim() || raw?.trim()) S('task', task?.trim() ? task : raw)
  if (constraints?.trim()) S('constraints', constraints)
  if (output?.trim())      S('output_format', output)

  const directives = []
  // 通用
  if (modifiers.clarifyFirst)  directives.push('開始前，若有資訊不足或需要確認的地方，請先提出澄清問題，不要憑空假設。')
  if (modifiers.stepByStep)    directives.push('請一步一步思考，再給出最終答案。')
  if (modifiers.concise)       directives.push('回答請簡潔直接，不要無謂客套或重述已知資訊。')
  if (modifiers.withExamples)  directives.push('若有助於理解，請附上具體範例。')
  if (modifiers.chineseReply)  directives.push('請以繁體中文回答。')
  // 羅馬工作流程
  if (modifiers.deriveFromKnowledge) directives.push('實作請優先查 .agent/knowledge/ 既有分析與截圖/memory，從中推導；不要自行發明實作或參數。')
  if (modifiers.updateNotes)         directives.push('任務結束後請更新對應的 memory / knowledge 筆記，保留關鍵發現（檔案路徑、決策、踩坑）。')
  if (modifiers.planFirst)           directives.push('動手前先列出步驟、影響範圍與需驗證的路徑，確認後再執行。')
  if (modifiers.stackNotBreak)       directives.push('改動前先用 git diff/show 確認舊穩定版本的做法；改完驗證已知正常路徑仍正常。')
  if (modifiers.isolateDebug)        directives.push('除錯時採變數隔離＋基準比較，不直接猜原因。')
  if (modifiers.noPreemptive)        directives.push('只處理明確觸發條件，不要預防性加保護代碼或額外功能。')
  if (modifiers.verifyRefs)          directives.push('引用檔案/符號前先用 grep/glob 驗證仍存在，不信任舊記憶。')
  if (modifiers.sudokuReasoning)     directives.push('從我的訊息推導完整意圖，主動預見下游問題並提出解法，不要只解字面需求。')
  if (modifiers.dualBuild)           directives.push('C++ 改動後請跑 Development + DebugGame 雙版本編譯，兩邊都過才算完成。')
  if (modifiers.codingStyle)         directives.push('遵守專案編碼風格：單行 if 不加大括號且同一行、Allman 風格、/** */ 函式註解、區域變數 _ 前綴、參數 In/Out 前綴。')
  if (modifiers.tempFiles)           directives.push('暫存或中間檔案請放 AI_Utils/，任務結束自行評估清理。')
  if (modifiers.noGitAuto)           directives.push('不要自作主張 git add/commit；需要 commit 前先列出要包含的檔案並等我確認。')
  if (directives.length) {
    S('directives', directives.map((d, i) => `${i + 1}. ${d}`).join('\n'))
  }

  const fallback = md.length === 0 && raw?.trim()
  if (fallback) {
    md.push(raw.trim())
    html.push(`<div style="white-space:pre-wrap;line-height:1.55">${escHtml(raw.trim())}</div>`)
  }

  return {
    markdown: md.join('\n').trim(),
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;color:#e6e6e6;background:#111;padding:12px;border-radius:6px">${html.join('')}</div>`,
  }
}

function PromptStudioPanel() {
  const [raw, setRaw]                 = useState('')
  const [preset, setPreset]           = useState('none')
  const [role, setRole]               = useState('')
  const [context, setContext]         = useState('')
  const [task, setTask]               = useState('')
  const [constraints, setConstraints] = useState('')
  const [output, setOutput]           = useState('')
  const [modifiers, setModifiers]     = useState({
    // 通用
    useXmlTags: true, clarifyFirst: false, stepByStep: false,
    concise: true, withExamples: false, chineseReply: true,
    // 羅馬工作流程
    deriveFromKnowledge: false, updateNotes: false, planFirst: false,
    stackNotBreak: false, isolateDebug: false, noPreemptive: false,
    verifyRefs: false, sudokuReasoning: false, dualBuild: false,
    codingStyle: false, tempFiles: false, noGitAuto: false,
  })
  const [copied, setCopied] = useState(null)

  function applyPreset(key) {
    setPreset(key)
    const p = PROMPT_PRESETS[key]
    if (p && p.role) setRole(p.role)
    else if (key === 'none') setRole('')
  }

  const { markdown, html } = buildPrompt({ raw, role, context, task, constraints, output, modifiers })

  async function copyPlain() {
    try { await navigator.clipboard.writeText(markdown); setCopied('plain'); setTimeout(() => setCopied(null), 1500) }
    catch (e) { setCopied('fail'); setTimeout(() => setCopied(null), 1500) }
  }
  async function copyRich() {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          'text/html':  new Blob([html],     { type: 'text/html' }),
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
        })
        await navigator.clipboard.write([item])
      } else {
        await navigator.clipboard.writeText(markdown)
      }
      setCopied('rich'); setTimeout(() => setCopied(null), 1500)
    } catch (e) { setCopied('fail'); setTimeout(() => setCopied(null), 1500) }
  }

  function clearAll() {
    setRaw(''); setRole(''); setContext(''); setTask(''); setConstraints(''); setOutput(''); setPreset('none')
  }

  const toggleRow = (key, label) => (
    <label className="flex items-center gap-2 text-[10px] text-[var(--text)] cursor-pointer select-none">
      <input type="checkbox" checked={!!modifiers[key]}
        onChange={e => setModifiers(m => ({ ...m, [key]: e.target.checked }))}
        className="accent-[var(--gold)]"
      />
      <span>{label}</span>
    </label>
  )

  const field = (label, value, setValue, placeholder, rows = 2) => (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">{label}</span>
      <textarea value={value} onChange={e => setValue(e.target.value)} rows={rows} placeholder={placeholder}
        className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] resize-y font-mono" />
    </div>
  )

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      {/* Left: Input */}
      <div className="flex flex-col md:w-1/2 min-h-0 md:border-r border-[var(--border)] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">Prompt Studio</span>
          <span className="text-[8px] text-[var(--text-muted)]">本機模板 · 不耗 Token</span>
          <div className="flex-1" />
          <button onClick={clearAll}
            className="text-[9px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400 hover:border-red-500/50">
            清空
          </button>
        </div>
        <div className="px-3 py-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">角色預設</span>
            <select value={preset} onChange={e => applyPreset(e.target.value)}
              className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]">
              {Object.entries(PROMPT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          {field('角色 (role)', role, setRole, '例：你是一位 UE5 資深開發者…', 2)}
          {field('背景 (context)', context, setContext, '例：目前在做羅馬士兵的 ABP，已經完成 Mover 遷移…', 3)}
          {field('任務 (task)', task, setTask, '例：幫我規劃 ABP 狀態機的 state 與 transition…', 4)}
          {field('限制 (constraints)', constraints, setConstraints, '例：不用 ACF、保留現有編碼風格…', 2)}
          {field('輸出格式 (output)', output, setOutput, '例：用繁中條列、每條不超過兩行…', 2)}
          {field('或直接貼入零散想法 (fallback → 會放到 task)', raw, setRaw, '沒填上面欄位的話，這段會變成 task 內容', 3)}

          <div className="border-t border-[var(--border)] pt-2 mt-1">
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] mb-2">通用修飾</div>
            <div className="grid grid-cols-2 gap-1.5">
              {toggleRow('useXmlTags',   '用 XML tags 包裝（Claude 偏好）')}
              {toggleRow('clarifyFirst', '先提澄清問題再動手')}
              {toggleRow('stepByStep',   '逐步思考再回答')}
              {toggleRow('concise',      '回答簡潔直接')}
              {toggleRow('withExamples', '附範例說明')}
              {toggleRow('chineseReply', '用繁體中文回答')}
            </div>
          </div>
          <div className="border-t border-[var(--border)] pt-2 mt-1">
            <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/80 mb-2">羅馬工作流程（常用需求）</div>
            <div className="grid grid-cols-1 gap-1.5">
              {toggleRow('deriveFromKnowledge', '從 knowledge/ 與截圖推導，不自行發明實作')}
              {toggleRow('updateNotes',         '完成後更新 memory / knowledge 話題筆記')}
              {toggleRow('planFirst',           '動手前先列步驟與影響範圍再執行')}
              {toggleRow('stackNotBreak',       '疊加不破壞：改前 git diff 舊穩定版本')}
              {toggleRow('isolateDebug',        '除錯用變數隔離＋基準比較，不直接猜')}
              {toggleRow('noPreemptive',        '不做超前防護，只處理明確觸發條件')}
              {toggleRow('verifyRefs',          '引用檔案/符號前先 grep/glob 驗證仍存在')}
              {toggleRow('sudokuReasoning',     '預見下游問題，在我問之前主動提出解法')}
              {toggleRow('dualBuild',           'C++ 改動跑 Development + DebugGame 雙版本')}
              {toggleRow('codingStyle',         '遵守編碼風格（單行 if / Allman / _ 前綴…）')}
              {toggleRow('tempFiles',           '暫存檔放 AI_Utils/，任務結束評估清理')}
              {toggleRow('noGitAuto',           '不自作主張 git add/commit，先確認再動手')}
            </div>
          </div>
        </div>
      </div>

      {/* Right: Preview */}
      <div className="flex flex-col md:w-1/2 min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">預覽 / 複製</span>
          <div className="flex-1" />
          <button onClick={copyPlain} disabled={!markdown}
            className={`text-[9px] px-2 py-1 rounded border transition-colors ${
              copied === 'plain' ? 'border-green-500 text-green-400'
                : 'border-[var(--border)] text-[var(--text)] hover:border-[var(--gold-border)] hover:text-[var(--gold)]'
            } ${!markdown ? 'opacity-40 cursor-not-allowed' : ''}`}>
            {copied === 'plain' ? '✓ 已複製' : '複製 Markdown'}
          </button>
          <button onClick={copyRich} disabled={!markdown}
            className={`text-[9px] px-2 py-1 rounded border transition-colors ${
              copied === 'rich' ? 'border-green-500 text-green-400'
                : 'border-[var(--gold)] text-[var(--gold)] hover:bg-[var(--gold)]/10'
            } ${!markdown ? 'opacity-40 cursor-not-allowed' : ''}`}>
            {copied === 'rich' ? '✓ 已複製' : '複製（含格式）'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {markdown
            ? (
              <pre className="text-[11px] leading-5 whitespace-pre-wrap break-words font-mono text-[var(--text)] bg-[var(--surface-2)] border border-[var(--border)] rounded p-3">
                {markdown}
              </pre>
            )
            : (
              <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">
                填入左邊任一欄位，這裡會即時組出結構化 prompt。
              </div>
            )
          }
          {copied === 'fail' && (
            <div className="mt-2 text-[10px] text-red-400">複製失敗（瀏覽器可能阻擋 Clipboard API，請改用純文字複製）</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 高桌會（The High Table）：分館（專案）認可管理 ─────────────────────────
// 認可的分館出現在仕酒師與 QA 的下拉選單；除聖（Deconsecrated）只從介面移除，資料與設定永久保留。
// 專案庫 SSOT = ~/.claude/tc_user_config/sommelier.json（工具乾淨化：專案資料不進 TC repo）
function HighTableModal({ onClose, onChanged }) {
  const [list, setList] = useState(null)   // null = 載入中
  const [picked, setPicked] = useState(null)   // { path, name, candidates }：選好的專案資料夾（path/name 皆可改）
  const [err, setErr] = useState('')
  const reload = useCallback(() => {
    fetch('/api/projects/registry').then(r => r.json())
      .then(d => { if (d.ok) setList(d.projects ?? []); else setErr(d.error ?? '讀取失敗') })
      .catch(e => setErr(String(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  async function toggle(p) {
    await fetch(`/api/projects/registry/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !p.enabled }) }).catch(() => {})
    reload(); onChanged?.()
  }
  // 開館 Step 1：瀏覽器原生選資料夾（同 CHAT「Upload from computer」族的 Windows 選擇視窗）
  // → 資料夾名稱自動成為暫定顯示名稱（可改）；瀏覽器不給絕對路徑 → server 按名稱在 project_roots 反查
  async function browse() {
    setErr('')
    if (!window.showDirectoryPicker) { setPicked({ path: '', name: '', candidates: [] }); return }  // 手機/非安全來源不支援 → 手動填
    let _handle = null
    try { _handle = await window.showDirectoryPicker() } catch { return }  // 使用者取消選擇
    const name = _handle.name
    const r = await fetch('/api/projects/resolve-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      .then(x => x.json()).catch(() => ({ ok: false }))
    const matches = r.ok ? (r.matches ?? []) : []
    setPicked({ path: matches[0] ?? '', name, candidates: matches })
    if (!matches.length) setErr(`在 project_roots 找不到「${name}」的路徑，請手動填入完整路徑`)
  }
  // 開館 Step 2：套用 → server 自動建立仕酒師資料層 + 背景首次萃取；QA 綁 id 即用
  async function add() {
    if (!picked?.path?.trim()) { setErr('請先確認專案完整路徑'); return }
    const name = picked.name.trim() || picked.path.trim().split(/[\\/]/).filter(Boolean).pop()
    const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '') || `proj${Date.now()}`
    const r = await fetch('/api/projects/registry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, projectPath: picked.path.trim() }) })
      .then(x => x.json()).catch(e => ({ ok: false, error: String(e) }))
    if (!r.ok) { setErr(r.error ?? '開館失敗'); return }
    setPicked(null); setErr('')
    reload(); onChanged?.()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="w-[26rem] max-h-[70vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[var(--gold)] text-xs tracking-widest uppercase">🏛 高桌會 The High Table</div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-sm leading-none">✕</button>
        </div>
        <div className="text-[10px] text-[var(--text-muted)] mb-3">分館（專案）認可管理 — 認可的分館出現在仕酒師與 QA；除聖（Deconsecrated）僅從介面移除，資料永久保留</div>
        {!list && !err && <div className="text-[10px] text-[var(--text-muted)]">讀取中…</div>}
        {list?.map(p => (
          <div key={p.id} className="flex items-center justify-between py-1.5 border-b border-[var(--border)]/50">
            <div className="min-w-0 mr-2">
              <div className={`text-[11px] truncate ${p.enabled ? '' : 'text-[var(--text-muted)] line-through'}`}>{p.name}</div>
              <div className="text-[9px] text-[var(--text-muted)] truncate">{p.id}{p.dataDir ? ` · ${p.dataDir}` : ''}</div>
            </div>
            <button onClick={() => toggle(p)} title={p.enabled ? '除聖：從仕酒師/QA 下拉移除（資料保留）' : '重新認可：回到仕酒師/QA 下拉'}
              className={`shrink-0 text-[9px] px-2 py-0.5 rounded border ${p.enabled ? 'border-[var(--gold)]/60 text-[var(--gold)] hover:border-red-500/50 hover:text-red-400' : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold)]/50 hover:text-[var(--gold)]'}`}>
              {p.enabled ? '✓ 認可中' : '已除聖'}
            </button>
          </div>
        ))}
        <div className="mt-3">
          {!picked && (
            <button onClick={browse}
              className="w-full text-[10px] px-2 py-1.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] hover:bg-[var(--gold)]/10">
              📂 選擇專案資料夾開館
            </button>
          )}
          {picked && (
            <div className="border border-[var(--border)] rounded p-2">
              <input value={picked.path} onChange={e => setPicked({ ...picked, path: e.target.value })} placeholder="專案完整路徑（自動反查，可改）"
                className="w-full bg-transparent border border-[var(--border)] rounded text-[9px] px-1.5 py-1 text-[var(--text)]" />
              {picked.candidates?.length > 1 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {picked.candidates.map(c => (
                    <button key={c} onClick={() => setPicked({ ...picked, path: c })} title={c}
                      className={`text-[9px] px-1.5 py-0.5 rounded border truncate max-w-full ${picked.path === c ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)]'}`}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-1 mt-1">
                <input value={picked.name} onChange={e => setPicked({ ...picked, name: e.target.value })} placeholder="顯示名稱（自動帶資料夾名，可改）"
                  className="flex-1 min-w-0 bg-transparent border border-[var(--border)] rounded text-[10px] px-1.5 py-1 text-[var(--text)]" />
                <button onClick={add} className="shrink-0 text-[10px] px-2 rounded border border-[var(--gold)]/60 text-[var(--gold)] hover:bg-[var(--gold)]/10">開館</button>
                <button onClick={() => setPicked(null)} className="shrink-0 text-[10px] px-2 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">取消</button>
              </div>
            </div>
          )}
        </div>
        {err && <div className="mt-1 text-[9px] text-red-400">{err}</div>}
        <div className="mt-2 text-[9px] text-[var(--text-muted)]">開館即自動建立該分館的仕酒師資料層並背景首次萃取；QA 隨 id 即用。進階欄位（dataDir / extractCommand）在 ~/.claude/tc_user_config/sommelier.json</div>
      </div>
    </div>
  )
}

// ─── TC 總設定（少爺 2026-08-07 立）────────────────────────────────────────────
// 跨功能使用者偏好：schema-driven——未來功能的偏好項只需在此加一條 schema，server key-value 池（/api/settings）與 UI 自動支援。
const TC_SETTINGS_SCHEMA = [
  {
    group: 'QA',
    key: 'qa.newRunCountdownSecs',
    label: '新 QA Run 開跑模式',
    type: 'select',
    options: [
      { value: null, label: '跟隨 Claude 判斷（Mode C 待放行、自主 QA 倒數）' },
      { value: 30,   label: '一律倒數 30 秒——沒攔就自動開跑' },
      { value: -1,   label: '一律待放行——等我按 ▶' },
      { value: 0,    label: '一律立即開跑' },
    ],
    hint: '強制態：設定後蓋過 Claude 建 run 時帶的模式；「跟隨」= 交回 Claude 依 run 性質決定',
  },
]

function TcSettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings).catch(() => setSettings({}))
  }, [])

  // 即改即存（少爺「隨時要能調整」）；value=null 送出即清除該鍵回「未設定」
  const patch = useCallback(async (key, value) => {
    setSettings(s => {
      const next = { ...(s ?? {}) }
      if (value === null) delete next[key]; else next[key] = value
      return next
    })
    try {
      await fetch('/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
    } catch {}
  }, [])

  const _groups = [...new Set(TC_SETTINGS_SCHEMA.map(s => s.group))]
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="w-[440px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] uppercase tracking-widest text-[var(--gold)]">⚙ 總設定 · Preferences</span>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs">✕</button>
        </div>
        {settings === null ? (
          <div className="text-[10px] text-[var(--text-muted)]">載入中…</div>
        ) : _groups.map(g => (
          <div key={g} className="mb-4">
            <div className="text-[9px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] pb-1 mb-2">{g}</div>
            {TC_SETTINGS_SCHEMA.filter(s => s.group === g).map(s => (
              <div key={s.key} className="mb-3">
                <div className="text-[11px] text-[var(--text)] mb-1">{s.label}</div>
                {s.type === 'select' && (
                  <select
                    value={settings[s.key] === undefined ? '__unset__' : String(settings[s.key])}
                    onChange={e => patch(s.key, e.target.value === '__unset__' ? null : JSON.parse(e.target.value))}
                    className="w-full text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)]">
                    {s.options.map(o => (
                      <option key={String(o.value)} value={o.value === null ? '__unset__' : String(o.value)}>{o.label}</option>
                    ))}
                  </select>
                )}
                {s.hint && <div className="text-[9px] text-[var(--text-muted)] mt-1">{s.hint}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const TABS = [
  { id: 'chat',      label: 'Chat' },
  { id: 'sommelier', label: '🍷 侍酒師' },
  { id: 'qa',        label: '🧪 QA' },
  { id: 'todos',     label: '待辦' },
  { id: 'metrics',   label: '📊 儀表板' },
  { id: 'history',   label: 'History' },
  { id: 'prefs',     label: '規矩' },
  { id: 'prompt',    label: 'Prompt' },
]

// P2 階段 4c：協作者只能看到分享給他們的卡片，所有個人功能都隱藏
const COLLABORATOR_TABS = [
  { id: 'todos',     label: '📥 收到的卡' },
]

const MOBILE_TABS = [
  { id: 'sessions',  label: 'SESSIONS',  icon: '◈' },
  { id: 'chat',      label: 'CHAT',      icon: '◻' },
  { id: 'sommelier', label: 'SOMMELIER', icon: '🍷' },
  { id: 'qa',        label: 'QA',        icon: '🧪' },
  { id: 'history',   label: 'HISTORY',   icon: '◷' },
  { id: 'more',      label: 'MORE',      icon: '⋯' },
]

const COLLABORATOR_MOBILE_TABS = [
  { id: 'todos',    label: 'INBOX', icon: '📥' },
]

// localStorage / URL 可能殘留已移除分頁的 tab id，採用前須驗證
const VALID_TAB_IDS = new Set([...TABS, ...COLLABORATOR_TABS, ...MOBILE_TABS, ...COLLABORATOR_MOBILE_TABS].map(t => t.id))

// ─── Mobile components ────────────────────────────────────────────────────────

function MobileSessionBar({ sessions, selectedId, setActiveTab, connected, onBountySettings }) {
  const sel = sessions.find(s => s.id === selectedId)
  return (
    <div className="flex md:hidden items-center gap-2 px-3 h-10 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
      {/* App title + connection dot */}
      <span className="text-[var(--gold)] font-semibold tracking-widest text-[9px] uppercase shrink-0">
        THE CLAUDENENTAL
      </span>
      <span className={`text-[8px] shrink-0 ${connected ? 'text-green-400' : 'text-red-400 pulse-amber'}`}>●</span>
      {/* Active session name */}
      {sel ? (
        <span className="flex items-center gap-1 flex-1 min-w-0">
          <StatusDot status={sel.status} />
          <span className="text-[10px] text-[var(--text-h)] truncate">{sel.displayName}</span>
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {/* Sessions switcher */}
      <button
        onClick={() => setActiveTab('sessions')}
        className="text-[9px] px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)] shrink-0"
      >◈</button>
      {/* Bounty settings */}
      <button
        onClick={onBountySettings}
        className="text-[var(--text-muted)] hover:text-[var(--gold)] text-xs shrink-0 px-1"
        title="Bounty Settings"
      >⚙</button>
      {/* Open claude.ai */}
      <a
        href="https://claude.ai"
        target="_blank"
        rel="noopener noreferrer"
        title="開啟 Claude.ai"
        className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] shrink-0 px-1 no-underline"
      >↗</a>
    </div>
  )
}

function MobileTabBar({ activeTab, setActiveTab, currentUser }) {
  const tabs = currentUser?.role === 'collaborator' ? COLLABORATOR_MOBILE_TABS : MOBILE_TABS
  return (
    <nav className="md:hidden shrink-0 flex items-center px-3 pt-2 bg-[var(--surface)] border-t border-[var(--border)]" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
      <div className="flex flex-1 h-[52px] bg-[var(--surface-2)] rounded-full border border-[var(--border)] p-1">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 rounded-full text-center transition-colors ${
              activeTab === t.id
                ? 'bg-[var(--gold)] text-[var(--bg)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <span className="text-[11px] leading-none">{t.icon}</span>
            <span className="text-[7px] font-semibold tracking-wide leading-none">{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function MobileSessionsPanel({ sessions, selectedId, setSelectedId, setActiveTab, onContinue, autoResumeMap, onToggleAutoResume, hitLimitSessions, historyCosts, onCostClick, onPermissionResponse, chatStage, chatRunning, chatLastDelta, chatBaseline }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        Sessions
      </div>
      <ActivityHeat />
      <div className="flex-1 overflow-y-auto py-1 px-1">
        {sessions.map(s => (
          <SessionItem
            key={s.id}
            session={{ ...s, costUsd: historyCosts?.[s.id] ?? s.costUsd ?? null }}
            isSelected={s.id === selectedId}
            onClick={() => {
              setSelectedId(s.id)
              setActiveTab('chat')
              if (s.cwd) onContinue?.({ sessionId: s.id, projectPath: s.cwd })
            }}
            onDoubleClick={() => {}}
            onCostClick={() => onCostClick?.(s)}
            autoResumeArmed={autoResumeMap?.[s.id]?.enabled === true}
            autoResumeFireAt={autoResumeMap?.[s.id]?.fireAt ?? null}
            onToggleAutoResume={() => onToggleAutoResume?.(s.id)}
            hitLimit={hitLimitSessions?.has(s.id) ?? false}
            isChatSession={s.id === selectedId}
            chatStage={s.id === selectedId ? chatStage : 1}
            chatRunning={s.id === selectedId ? chatRunning : 0}
            chatLastDelta={s.id === selectedId ? chatLastDelta : null}
            chatBaseline={s.id === selectedId ? chatBaseline : 0}
            onPermissionResponse={onPermissionResponse}
            showChatPermission
          />
        ))}
        {sessions.length === 0 && <div className="text-[10px] text-[var(--text-muted)] text-center mt-8">No sessions yet</div>}
      </div>
    </div>
  )
}

// 與桌面端 TABS 對齊：底部功能列沒有的分頁收進 MORE
function MobileMorePanel({ sessions, onTriggerChat }) {
  const [sub, setSub] = useState('todos')
  const SUB = [
    { id: 'todos',   label: 'TODO' },
    { id: 'metrics', label: 'DASHBOARD' },
    { id: 'prefs',   label: 'PREFS' },
    { id: 'prompt',  label: 'PROMPT' },
  ]
  return (
    <div className="flex flex-col h-full">
      <div className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        {SUB.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)}
            className={`px-3 py-2 text-[9px] uppercase tracking-wider shrink-0 border-b-2 transition-colors ${
              sub === t.id ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-transparent text-[var(--text-muted)]'
            }`}>{t.label}</button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {sub === 'todos'   && <TodoBoard sessions={sessions} onTriggerChat={onTriggerChat} />}
        {sub === 'metrics' && <MetricsDashboard />}
        {sub === 'prefs'   && <PreferencesPanel />}
        {sub === 'prompt'  && <PromptStudioPanel />}
      </div>
    </div>
  )
}

// ─── Stage 4 full-screen summary overlay ─────────────────────────────────────

function Stage4Anim({ baseline, chatRunning, onDone }) {
  const newTotal = baseline + chatRunning
  const [phase, setPhase] = useState(0)
  // phase 0→1: chat total 金→綠 (0.8s)
  // phase 1→2: baseline 灰→金 (1.8s)
  // phase 2→3: show merged total (3.0s)
  // auto-dismiss after 5s
  useEffect(() => {
    const T = [
      setTimeout(() => setPhase(1), 800),
      setTimeout(() => setPhase(2), 1800),
      setTimeout(() => setPhase(3), 3000),
      setTimeout(() => onDone?.(), 5000),
    ]
    return () => T.forEach(clearTimeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="flex flex-col items-center gap-3 text-center px-6">
      <div className="flex items-baseline gap-3">
        <span className={`text-4xl font-bold tabular-nums transition-colors duration-700 ${
          phase >= 1 ? 'text-green-400' : 'text-[var(--gold)]'
        }`}>+{fmtCost(chatRunning)}</span>
        <span className="text-[var(--text-muted)] text-xl">+</span>
        <span className={`text-2xl tabular-nums transition-colors duration-700 ${
          phase >= 2 ? 'text-[var(--gold)]' : 'text-gray-600'
        }`}>{fmtCost(baseline)}</span>
      </div>
      {phase >= 3 && (
        <>
          <div className="text-[8px] text-[var(--gold)]/50 tracking-[0.3em] uppercase mt-2">New Session Total</div>
          <div className="text-5xl font-bold text-[var(--gold)] tabular-nums">{fmtCost(newTotal)}</div>
        </>
      )}
      <button onClick={onDone}
        className="mt-4 text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] tracking-[0.2em] uppercase
          border-b border-transparent hover:border-[var(--gold)]/50 transition-colors">
        Dismiss
      </button>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

// Server health 顯示（連線數 + 記憶體）— 每 15 秒 polling
function HealthIndicator() {
  const [h, setH] = useState(null)
  useEffect(() => {
    let alive = true
    function load() {
      fetch('/api/health').then(r => r.json()).then(d => alive && setH(d)).catch(() => {})
    }
    load()
    const id = setInterval(load, 15000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  if (!h) return null
  const conns = h.connections ?? 0
  const max = h.maxConnections ?? 100
  const ratio = conns / max
  const tone = ratio >= 0.9 ? 'text-red-400' : ratio >= 0.5 ? 'text-amber-400' : 'text-[var(--text-muted)]'
  return (
    <span className={`text-[10px] ${tone}`}
      title={`server uptime ${Math.round(h.uptimeSec/60)}m · heap ${h.memoryMB}MB · rss ${h.memoryRssMB}MB`}>
      👥 {conns}/{max} · {h.memoryMB}MB
    </span>
  )
}

// P2 階段 4：全域 fetch wrapper，自動帶 tc_session token + Authorization header
// 已有的 fetch 不用改，瀏覽器會自動帶 cookie；這個 helper 給未來 collaborator 從不同 host 接的情境
const tcAuthToken = () => {
  try { return localStorage.getItem('tc_session_token') } catch { return null }
}
const _origFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : null
if (typeof window !== 'undefined' && !window.__tcFetchPatched) {
  window.fetch = (input, init = {}) => {
    const t = tcAuthToken()
    if (t) {
      const headers = new Headers(init.headers || {})
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${t}`)
      init = { ...init, headers, credentials: 'include' }
    } else if (!init.credentials) {
      init = { ...init, credentials: 'include' }
    }
    return _origFetch(input, init)
  }
  window.__tcFetchPatched = true
}

export default function App() {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(() => {
    try { return localStorage.getItem('tc_selected_session') || null } catch { return null }
  })
  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem('tc_selected_session', selectedId)
      else localStorage.removeItem('tc_selected_session')
    } catch {}
  }, [selectedId])
  const [renamingId, setRenamingId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [activeTab, setActiveTab] = useState(() => {
    try {
      // ?tab=qa 深連結（Edge app-mode 視窗用）優先於記憶的 tab
      const urlTab = new URL(window.location.href).searchParams.get('tab')
      if (urlTab && VALID_TAB_IDS.has(urlTab)) return urlTab
      const saved = localStorage.getItem('tc_active_tab')
      if (saved && VALID_TAB_IDS.has(saved)) return saved
    } catch {}
    return window.innerWidth < 768 ? 'sessions' : 'chat'
  })
  useEffect(() => {
    try { localStorage.setItem('tc_active_tab', activeTab) } catch {}
  }, [activeTab])
  // 跨專案切換（仕酒師 / QA 綁專案、共用同一 active 專案；任一邊切換兩邊受惠）
  const [tcProjects, setTcProjects] = useState([])
  const [activeProjectId, setActiveProjectId] = useState(() => {
    try { return localStorage.getItem('tc_active_project') || null } catch { return null }
  })
  const [showHighTable, setShowHighTable] = useState(false)  // 高桌會：分館（專案）認可管理
  const reloadTcProjects = useCallback(() => {
    fetch('/api/sommelier/projects').then(r => r.json()).then(d => {
      const list = d.projects ?? []
      setTcProjects(list)
      setActiveProjectId(prev => (prev && list.some(p => p.id === prev)) ? prev : (list[0]?.id ?? null))
    }).catch(() => {})
  }, [])
  useEffect(() => { reloadTcProjects() }, [reloadTcProjects])
  useEffect(() => {
    try { if (activeProjectId) localStorage.setItem('tc_active_project', activeProjectId) } catch {}
  }, [activeProjectId])
  const [streamEvents, setStreamEvents] = useState([])
  const [chatInit, setChatInit] = useState(null)
  // Ref tracking current chat projectPath for stream watcher (avoids stale sessions lookup)
  const chatProjectPathRef = useRef('')

  // P2 階段 4：當前登入身份（owner / collaborator / null）
  const [currentUser, setCurrentUser] = useState(null)  // null = 載入中
  const [acceptingInvite, setAcceptingInvite] = useState(null)  // { token } 接受邀請流程
  const [inviteName, setInviteName] = useState('')

  useEffect(() => {
    // 處理 ?invite=xxx URL（被邀請者打開時）
    try {
      const url = new URL(window.location.href)
      const inviteToken = url.searchParams.get('invite')
      if (inviteToken) {
        setAcceptingInvite({ token: inviteToken })
        url.searchParams.delete('invite')
        window.history.replaceState({}, '', url.toString())
        return  // 不 fetch whoami，等接受完
      }
    } catch {}
    // 沒邀請 token → 拿當前身份
    fetch('/api/auth/whoami')
      .then(r => r.json())
      .then(d => {
        if (d.ok) setCurrentUser(d.user)
        else setCurrentUser({ id: 'u-owner', name: 'Mark', role: 'owner' })  // fallback
      })
      .catch(() => setCurrentUser({ id: 'u-owner', name: 'Mark', role: 'owner' }))
  }, [])

  async function acceptInvite() {
    if (!acceptingInvite?.token || !inviteName.trim()) return
    try {
      const res = await fetch('/api/auth/accept-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: acceptingInvite.token, name: inviteName.trim() }),
      })
      const data = await res.json()
      if (!data.ok) {
        alert(`接受邀請失敗：${data.error ?? '未知錯誤'}`)
        return
      }
      // 持久化 session token（對方瀏覽器永遠帶）
      try { localStorage.setItem('tc_session_token', data.sessionToken) } catch {}
      setCurrentUser(data.user)
      setAcceptingInvite(null)
      setInviteName('')
    } catch (e) {
      alert(`網路錯誤：${e.message}`)
    }
  }

  async function logout() {
    if (!window.confirm('確認登出？')) return
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    try { localStorage.removeItem('tc_session_token') } catch {}
    setCurrentUser(null)
    window.location.reload()
  }

  // Collaborator 一進來自動切到 todos（他們唯一能看到的 tab）
  useEffect(() => {
    if (currentUser?.role === 'collaborator') setActiveTab('todos')
  }, [currentUser?.role])

  // ── Bounty system ────────────────────────────────────────────────────────
  const [bountySettings, setBountySettings]     = useState({})
  const [animQueue, setAnimQueue]               = useState([])
  const [currentAnim, setCurrentAnim]           = useState(null)
  const [showBountySettings, setShowBountySettings] = useState(false)
  const [showTcSettings, setShowTcSettings] = useState(false)     // 總設定（少爺 2026-08-07）：跨功能使用者偏好 modal
  const [showMarkers, setShowMarkers] = useState(false)
  const [showCellar, setShowCellar] = useState(false)
  const [contractModal, setContractModal]       = useState(null)
  const [historyCosts, setHistoryCosts]         = useState({})   // { [sessionId]: costUsd }
  const [chatBaseline, setChatBaseline]         = useState(0)    // historyCosts snapshot when chatInit last fired
  // ── 5-Stage chat cost display (lives in SessionItem Row 3) ──────────────
  const [chatStage, setChatStage]       = useState(1)   // 1=idle 2=flash 3=running 4=done
  const [chatRunning, setChatRunning]   = useState(0)   // cost accumulated this chat
  const [chatLastDelta, setChatLastDelta] = useState(null)


  // Track which session is currently open in Chat (for animation gating)
  const activeChatSessionRef  = useRef(null)
  const activeTabRef           = useRef('chat')
  // Timestamp of last session switch — used to skip session_live replay batches
  const sessionLiveStartRef    = useRef(0)

  useEffect(() => { activeChatSessionRef.current = selectedId }, [selectedId])
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  // Load bounty settings + seed historyCosts from history API once
  useEffect(() => {
    fetch('/api/bounty/settings').then(r => r.json()).then(setBountySettings).catch(() => {})
    fetch('/api/history').then(r => r.json()).then(d => {
      const map = {}
      for (const s of d.sessions ?? []) {
        if (s.costUsd != null) map[s.sessionId] = s.costUsd
      }
      setHistoryCosts(map)
    }).catch(() => {})
  }, [])

  // ── Auto-resume per-session state ────────────────────────────────────────
  // { [sessionId]: { enabled, message, fireAt } }
  const [autoResumeMap, setAutoResumeMap] = useState({})
  // Sessions where usage limit was hit (shows ⏰ even if status != sleeping)
  const [hitLimitSessions, setHitLimitSessions] = useState(new Set())

  // Global timer: fire any armed resumes when cooldown expires
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      setAutoResumeMap(prev => {
        let changed = false
        const next = { ...prev }
        for (const [sid, ar] of Object.entries(prev)) {
          if (!ar.enabled || !ar.fireAt) continue
          if (now < ar.fireAt) continue
          // Time to fire — find session cwd
          const sess = sessions.find(s => s.id === sid)
          if (sess?.cwd && (sess.status === 'sleeping' || hitLimitSessions.has(sid))) {
            fetch('/api/claude/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectPath: sess.cwd, prompt: ar.message || '請繼續', sessionId: sid }),
            }).catch(() => {})
          }
          next[sid] = { ...ar, enabled: false, fired: true }
          changed = true
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  function toggleAutoResume(sessionId) {
    setAutoResumeMap(prev => {
      const cur = prev[sessionId]
      if (cur?.enabled) {
        // Disarm
        const next = { ...prev }
        delete next[sessionId]
        return next
      }
      // Arm: compute 整點 fire time
      const sess = sessions.find(s => s.id === sessionId)
      const cooldownExpiry = (sess?.sleepingAt ?? Date.now()) + SESSION_LIMIT_MS
      const fireAt = nextWholeHourAfter(cooldownExpiry)
      return { ...prev, [sessionId]: { enabled: true, message: '請繼續', fireAt } }
    })
  }

  // Cost engine — receives stream events and fires animation triggers
  const costSnap = useCostEngine(streamEvents, (anim) => {
    const { key, delta } = anim
    // Resolve session from key
    const sessById  = key.startsWith('session:') ? sessions.find(s => s.id === key.slice(8)) : null
    const sessByCwd = !sessById ? sessions.find(s => normPath(s.cwd) === key) : null
    const sess = sessById ?? sessByCwd

    // ADD delta to historyCosts baseline for live subprocess runs only.
    // session_live events are historical replays already captured in the API baseline — skip them.
    const trueTotal = (historyCosts[sess?.id] ?? 0) + delta
    if (sess && !key.startsWith('session:')) {
      setHistoryCosts(prev => ({ ...prev, [sess.id]: (prev[sess.id] ?? 0) + delta }))
    }

    // Fire animation only when Chat tab is active AND this is the currently open session
    const activeSid = activeChatSessionRef.current
    const isCurrentChat = sess
      ? sess.id === activeSid
      : key === normPath('') // fallback: never match
    if (activeTabRef.current === 'chat' && isCurrentChat) {
      setAnimQueue(q => [...q, { ...anim, total: trueTotal, sessionName: sess?.displayName ?? '' }])
    }
  })

  // Drain animation queue one at a time
  useEffect(() => {
    if (currentAnim || animQueue.length === 0) return
    const [next, ...rest] = animQueue
    setAnimQueue(rest)
    setCurrentAnim(next)
  }, [animQueue, currentAnim])

  function handleAnimDone() { setCurrentAnim(null) }

  // Determine anim component type
  const animTier  = currentAnim?.tier
  const animLevel = currentAnim?.level
  const isPreview = !!currentAnim?._uid
  // L3/L4 = toast; L1/L2 = badge-only (preview exception: show as toast)
  const isToast   = animTier === 'L' && ((animLevel === 3 || animLevel === 4) || (animLevel <= 2 && isPreview))
  // H/S/C always overlay; L tiers never overlay
  const isOverlay = animTier != null && animTier !== 'L'

  function handleContinueInChat({ sessionId, projectPath }) {
    chatProjectPathRef.current = projectPath ?? ''
    setSelectedId(sessionId)   // sync selected session so name + cost animations match chat
    setChatBaseline(historyCosts[sessionId] ?? 0)
    setChatRunning(0)
    setChatLastDelta(null)
    setChatStage(1)
    setChatInit({ sessionId, projectPath })
    setActiveTab('chat')
  }

  // TODO 卡「去聊天室」：桌面待辦分頁與手機 MORE > TODO 共用
  function handleTodoTriggerChat({ sessionId, prefillText }) {
    if (sessionId === '__new__') {
      setSelectedId(null)
      setChatInit({ sessionId: null, projectPath: 'C:/Project/RomanPrototype', prefillText, ts: Date.now() })
    } else {
      setSelectedId(sessionId)
      setChatInit({ sessionId, projectPath: 'C:/Project/RomanPrototype', prefillText, ts: Date.now() })
    }
    setActiveTab('chat')
  }

  // Reset stage state whenever the selected session changes
  useEffect(() => {
    if (!selectedId) return
    setChatBaseline(historyCosts[selectedId] ?? 0)
    setChatRunning(0)
    setChatLastDelta(null)
    setChatStage(1)
    // Give replays 3s to flush before we start processing session_live cost events
    sessionLiveStartRef.current = Date.now() + 3000
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Keep chatBaseline in sync when historyCosts loads (covers async API + auto-selected sessions)
  const selectedCost = selectedId ? (historyCosts[selectedId] ?? 0) : 0
  useEffect(() => {
    if (selectedId && chatStage === 1) setChatBaseline(selectedCost)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCost])

  // Stage 2 → 3 auto-transition (2.5s after first token)
  useEffect(() => {
    if (chatStage !== 2) return
    const t = setTimeout(() => setChatStage(3), 2500)
    return () => clearTimeout(t)
  }, [chatStage])

  // Watch streamEvents to drive chat cost stages (both dashboard chat and external VS Code)
  useEffect(() => {
    if (!streamEvents.length || !selectedId) return
    const ev = streamEvents[streamEvents.length - 1]

    // ── claude_stream: subprocess events from dashboard ChatPanel ─────────
    if (ev.type === 'claude_stream') {
      // Match against chatProjectPathRef (reliable) OR active session cwd (fallback)
      const chatPath = chatProjectPathRef.current
      const activeSession = sessions.find(s => s.id === selectedId)
      const expectedPath = chatPath || activeSession?.cwd || ''
      if (!expectedPath || normPath(ev.projectPath) !== normPath(expectedPath)) return
      const { event } = ev
      if (event?.type === 'system' && event?.subtype === 'init') {
        // New run starting — reset stage so Stage 2 can fire again
        setChatStage(1)
      } else if (event?.type === 'assistant' && event.message?.usage) {
        const d = computeDeltaCost(event.message?.model ?? '', event.message.usage)
        setChatRunning(r => r + d)
        setChatLastDelta(d)
        setChatStage(s => s === 1 ? 2 : s)
      } else if (event?.type === 'result') {
        if (!hitLimitSessions.has(selectedId)) {
          setChatStage(s => (s === 2 || s === 3) ? 4 : s)
        }
      }
      return
    }

    // ── session_live: VS Code external session live tail ─────────────────
    if (ev.type === 'session_live' && ev.sessionId === selectedId) {
      // Skip replay batches arriving within 3s of session switch
      if ((ev._arrivalTs ?? 0) < sessionLiveStartRef.current) return
      for (const msg of ev.messages ?? []) {
        if (msg.type === 'assistant' && msg.message?.usage) {
          const d = computeDeltaCost(msg.message?.model ?? '', msg.message.usage)
          setChatRunning(r => r + d)
          setChatLastDelta(d)
          setChatStage(s => s === 1 ? 2 : s)
        }
        if (msg.type === 'result') {
          if (!hitLimitSessions.has(selectedId)) {
            setChatStage(s => (s === 2 || s === 3) ? 4 : s)
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEvents])
  // Auto-watch active sessions so session_live events flow into cost engine
  const watchedRef = useRef(new Set())
  function autoWatch(sessionId) {
    if (!sessionId || watchedRef.current.has(sessionId)) return
    watchedRef.current.add(sessionId)
    fetch('/api/session/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }

  const { connected, send } = useWebSocket(WS_URL, msg => {
    if (msg.type === 'state') {
      setSessions(msg.sessions)
      setSelectedId(prev => prev ?? msg.sessions[0]?.id ?? null)
      // Auto-watch all active sessions on reconnect
      for (const s of msg.sessions ?? []) {
        if (s.status === 'active') autoWatch(s.id)
      }
    }
    // AutoQA Monitor：轉發給 QAMonitorPanel（decoupled，不佔 App state）
    if (msg.type === 'qa_run_update') {
      try { window.dispatchEvent(new CustomEvent('tc-qa-run-update', { detail: msg.run })) } catch {}
    }
    // 打包進度：同樣轉發給 QAMonitorPanel（少爺 2026-08-04 打包控制列）
    if (msg.type === 'package_update') {
      try { window.dispatchEvent(new CustomEvent('tc-package-update', { detail: msg.job })) } catch {}
    }
    // 版控草稿（少爺 2026-08-14）：Claude 推 commit 訊息草稿 → 轉發給 QAMonitorPanel 的版控區塊
    if (msg.type === 'git_draft_update') {
      try { window.dispatchEvent(new CustomEvent('tc-git-draft', { detail: msg.drafts })) } catch {}
    }
    if (msg.type === 'session') {
      // Auto-watch when a session becomes active
      if (msg.session?.status === 'active') autoWatch(msg.session.id)
      // Cancel armed auto-resume if session woke up on its own (credits added / account switched)
      if (msg.session?.status !== 'sleeping') {
        setAutoResumeMap(prev => {
          if (!prev[msg.session.id]?.enabled) return prev
          const next = { ...prev }
          delete next[msg.session.id]
          return next
        })
        // Clear hit-limit flag once session becomes active again
        if (msg.session?.status === 'active') {
          setHitLimitSessions(prev => { const s = new Set(prev); s.delete(msg.session.id); return s })
        }
      }
      // When session finishes, pull final cost from server (covers externally-ended sessions)
      if (msg.session?.status === 'done') {
        fetch(`/api/history/${msg.session.id}`).then(r => r.json()).then(d => {
          if (d.costUsd != null)
            setHistoryCosts(prev => ({ ...prev, [msg.session.id]: d.costUsd }))
        }).catch(() => {})
      }
      setSessions(prev => {
        const exists = prev.some(s => s.id === msg.session.id)
        const next = exists
          ? prev.map(s => s.id === msg.session.id ? msg.session : s)
          : [...prev, msg.session]
        return next
      })
      setSelectedId(prev => prev ?? msg.session.id)
    }
    if (msg.type === 'session_remove') {
      setSessions(prev => prev.filter(s => s.id !== msg.sessionId))
      // 少爺設計原則：CHAT 介面除非主動切換 Session / 從 History 切換聊天室，否則留著。
      // 故不清 selectedId — 讓使用者繼續看歷史內容，即便該 session 被 server 從 active 清單移除。
    }
    if (msg.type === 'claude_stream' || msg.type === 'session_live') {
      setStreamEvents(prev => [...prev.slice(-200), { ...msg, _arrivalTs: Date.now() }])

      // Detect usage limit hit — auto-arm ⏰ button
      const isLimit = (() => {
        if (msg.type === 'session_live') {
          return (msg.messages ?? []).some(m =>
            typeof m.text === 'string' && m.text.includes("hit your limit")
          )
        }
        if (msg.type === 'claude_stream') {
          const ev = msg.event ?? msg
          return typeof ev.text === 'string' && ev.text.includes("hit your limit")
        }
        return false
      })()

      if (isLimit) {
        const sid = msg.sessionId
        if (sid) {
          setHitLimitSessions(prev => { const s = new Set(prev); s.add(sid); return s })
          // Auto-arm auto-resume at next whole hour
          setAutoResumeMap(prev => {
            if (prev[sid]?.enabled) return prev  // already armed
            const fireAt = nextWholeHourAfter(Date.now())
            return { ...prev, [sid]: { enabled: true, message: '請繼續', fireAt, autoArmed: true } }
          })
        }
      }
    }
  })

  const selected = sessions.find(s => s.id === selectedId)

  // P2 階段 4：邀請接受頁（先擋掉主畫面，受邀者看到的第一個視覺）
  if (acceptingInvite) {
    return (
      <div className="flex flex-col h-full bg-[var(--bg)] text-[var(--text)] items-center justify-center p-4">
        <div className="bg-[var(--surface)] border border-[var(--gold-border)] rounded-lg p-6 w-[min(420px,90vw)] flex flex-col gap-4 shadow-2xl">
          <div className="text-[9px] uppercase tracking-[0.3em] text-[var(--gold)]/60">— The Continental —</div>
          <h2 className="text-xl text-[var(--gold)] font-bold tracking-wider">受邀協作</h2>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            你被邀請成為 TheClaudenental 的協作者。<br/>
            填入你的名字後即可進入，看到主人分享給你的卡片。
          </p>
          <input
            value={inviteName}
            onChange={e => setInviteName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') acceptInvite() }}
            autoFocus
            placeholder="你的名字"
            className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-3 py-2 text-[12px] text-[var(--text)] outline-none focus:border-[var(--gold-border)]"
          />
          <button onClick={acceptInvite} disabled={!inviteName.trim()}
            className="px-4 py-2 rounded bg-[var(--gold)]/20 border border-[var(--gold)] text-[var(--gold)] font-semibold tracking-wider text-[11px] hover:bg-[var(--gold)]/30 disabled:opacity-40">
            接受邀請進入
          </button>
          <div className="text-[9px] text-[var(--text-muted)]/70 leading-relaxed border-t border-[var(--border)] pt-3">
            進入後你只會看到主人**特別分享給你**的卡片，無法存取其他資料。<br/>
            session token 會存在你的瀏覽器 30 天。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg)] text-[var(--text)]">

      {/* ── Bounty overlays ── */}
      {isToast && currentAnim && (
        <BountyToast key={currentAnim._uid ?? 'toast'} anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {isOverlay && currentAnim && (
        <BountyOverlay key={currentAnim._uid ?? 'overlay'} anim={currentAnim} settings={bountySettings} onDone={handleAnimDone} />
      )}
      {/* Stage 4 — full-screen chat session summary */}
      {chatStage === 4 && (
        <div className="fixed inset-0 z-[75] flex flex-col items-center justify-center gap-4 overlay-in"
          style={{ background: 'rgba(0,0,0,0.96)' }}>
          <div className="text-[7px] text-[var(--gold)]/40 tracking-[0.35em] uppercase">─── The Continental ───</div>
          <div className="text-[10px] text-[var(--gold)]/70 tracking-widest uppercase mb-2">Chat Session Settled</div>
          <Stage4Anim baseline={chatBaseline} chatRunning={chatRunning}
            onDone={() => setChatStage(1)} />
        </div>
      )}
      {contractModal && (
        <ContractModal
          sessionName={contractModal.sessionName}
          costData={contractModal.costData}
          onClose={() => setContractModal(null)}
        />
      )}
      {showHighTable && (
        <HighTableModal onClose={() => setShowHighTable(false)} onChanged={reloadTcProjects} />
      )}
      {showMarkers && <MarkerPanel onClose={() => setShowMarkers(false)} />}
      {showCellar && <CellarPanel onClose={() => setShowCellar(false)} />}
      {showTcSettings && <TcSettingsModal onClose={() => setShowTcSettings(false)} />}
      {showBountySettings && (
        <BountySettings
          onClose={() => setShowBountySettings(false)}
          onPreview={tierStr => {
            setShowBountySettings(false)
            const t = tierStr === 'C' ? 'C' : tierStr[0]
            const l = tierStr === 'C' ? null : parseInt(tierStr[1])
            // _uid forces BountyOverlay/BountyToast to remount even if same tier
            setCurrentAnim({ tier: t, level: l, delta: 0.18, total: 2.34, sessionName: 'Preview', _uid: Date.now() })
          }}
        />
      )}

      {/* ── Top bar — desktop only ── */}
      <header className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        <span className="text-[var(--gold)] font-semibold tracking-widest text-xs uppercase">
          The Claudenental
        </span>
        <span className="text-[var(--border-2)]">|</span>
        <span className={`text-[10px] flex items-center gap-1 ${connected ? 'text-green-400' : 'text-red-400'}`}>
          <span className={connected ? '' : 'pulse-amber'}>{connected ? '●' : '◌'}</span>
          {connected ? 'Connected' : 'Reconnecting…'}
        </span>
        <div className="flex-1" />
        <HealthIndicator />
        <span className="text-[10px] text-[var(--text-muted)]">
          {sessions.filter(s => s.status === 'active').length} active · {sessions.length} sessions
        </span>
        <button
          onClick={() => setShowCellar(true)}
          title="Cellar 酒窖 — 開發工具箱（點擊執行／填表）"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase">
          🍷 Cellar
        </button>
        <button
          onClick={() => setShowMarkers(true)}
          title="Marker — 你委託 Claude 定期履行的任務（誓約）"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase">
          ⧗ Marker
        </button>
        <button
          onClick={() => setShowBountySettings(true)}
          title="Bounty Announcement Settings"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase">
          ⚙ Bounty
        </button>
        <a
          href="https://claude.ai"
          target="_blank"
          rel="noopener noreferrer"
          title="開啟 Claude.ai"
          className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] border border-[var(--border)] hover:border-[var(--gold-border)] rounded-sm px-1.5 py-0.5 transition-colors tracking-wide uppercase no-underline">
          ↗ Claude
        </a>
      </header>

      {/* ── Main layout ── */}
      <div className="flex flex-1 min-h-0">

        {/* Left: Sessions list — desktop only */}
        <aside className="hidden md:flex w-52 shrink-0 border-r border-[var(--border)] flex-col bg-[var(--surface)] overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)] flex items-center">
            <span className="flex-1">Sessions</span>
            <button
              onClick={() => fetch('/api/sessions/clear-inactive', { method: 'POST' })}
              title="清除已完成的 sessions"
              className="text-[var(--text-muted)] hover:text-red-400 transition-colors text-[11px] leading-none"
            >
              ✕
            </button>
          </div>
          <ActivityHeat />
          <div className="flex-1 overflow-y-auto py-1 px-1">
            {sessions.map(s => (
              renamingId === s.id
                ? (
                  <div key={s.id} className="px-2 py-1">
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={e => setRenameVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          send({ type: 'rename', sessionId: s.id, name: renameVal.trim() || s.displayName })
                          setRenamingId(null)
                        }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      onBlur={() => setRenamingId(null)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--gold-border)] rounded px-2 py-1 text-[11px] text-[var(--text-h)] focus:outline-none"
                    />
                  </div>
                )
                : (
                  <SessionItem
                    key={s.id}
                    session={{ ...s, costUsd: historyCosts[s.id] ?? s.costUsd ?? null }}
                    isSelected={s.id === selectedId}
                    onClick={() => {
                      setSelectedId(s.id)
                      if (s.cwd) handleContinueInChat({ sessionId: s.id, projectPath: s.cwd })
                    }}
                    onDoubleClick={() => { setRenamingId(s.id); setRenameVal(s.displayName) }}
                    onCostClick={async () => {
                      const live = costSnap[`session:${s.id}`] ?? costSnap[normPath(s.cwd)]
                      const d = await fetch(`/api/history/${s.id}`).then(r => r.json()).catch(() => ({}))
                      const total = historyCosts[s.id] ?? live?.total ?? d.costUsd ?? 0
                      setContractModal({
                        sessionName: s.displayName,
                        costData: { total, byType: live?.byType ?? d.byType ?? {}, byModel: live?.byModel ?? d.byModel ?? {} },
                      })
                    }}
                    autoResumeArmed={autoResumeMap[s.id]?.enabled === true}
                    autoResumeFireAt={autoResumeMap[s.id]?.fireAt ?? null}
                    onToggleAutoResume={() => toggleAutoResume(s.id)}
                    hitLimit={hitLimitSessions.has(s.id)}
                    isChatSession={s.id === selectedId}
                    chatStage={s.id === selectedId ? chatStage : 1}
                    chatRunning={s.id === selectedId ? chatRunning : 0}
                    chatLastDelta={s.id === selectedId ? chatLastDelta : null}
                    chatBaseline={s.id === selectedId ? chatBaseline : 0}
                    onPermissionResponse={(permId, action) => send({ type: 'permission_response', permissionId: permId, action })}
                    showChatPermission
                  />
                )
            ))}
            {sessions.length === 0 && (
              <div className="px-3 py-4 text-[10px] text-[var(--text-muted)] text-center">
                No sessions yet
              </div>
            )}
          </div>
        </aside>

        {/* Center: Tab panel */}
        <main className="flex-1 flex flex-col min-w-0">

          {/* Mobile: session indicator */}
          <MobileSessionBar sessions={sessions} selectedId={selectedId} setActiveTab={setActiveTab} connected={connected} onBountySettings={() => setShowBountySettings(true)} />

          {/* Tab bar — desktop only；collaborator 只看到 inbox */}
          <div className="hidden md:flex items-center border-b border-[var(--border)] bg-[var(--surface)] shrink-0 overflow-x-auto">
            {(currentUser?.role === 'collaborator' ? COLLABORATOR_TABS : TABS).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-[10px] uppercase tracking-widest shrink-0 border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-[var(--gold)] text-[var(--gold)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}>
                {tab.label}
                {tab.id === 'tasks' && selected && (
                  <span className="ml-1 text-[var(--border-2)]">/ {selected.displayName}</span>
                )}
              </button>
            ))}
            {selected && <StatusDot status={selected.status} />}
            <div className="flex-1" />
            {/* 總設定（少爺 2026-08-07）：任何分頁可開、隨時調偏好 */}
            {currentUser?.role !== 'collaborator' && (
              <button onClick={() => setShowTcSettings(true)} title="總設定：使用者偏好"
                className="px-2 py-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--gold)] transition-colors shrink-0">⚙</button>
            )}
            {/* P2 階段 4c：身份指示 + logout */}
            {currentUser?.role === 'collaborator' && (
              <div className="flex items-center gap-2 px-3">
                <span className="text-[10px] text-[var(--gold)]/80">👤 {currentUser.name}</span>
                <span className="text-[8px] text-[var(--text-muted)] uppercase tracking-widest">協作者</span>
                <button onClick={logout}
                  className="text-[9px] px-2 py-0.5 rounded text-[var(--text-muted)] hover:text-red-400 border border-[var(--border)] hover:border-red-500/40">
                  登出
                </button>
              </div>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {activeTab === 'chat' && (
              <ChatPanel streamEvents={streamEvents} chatInit={chatInit} selectedId={selectedId} />
            )}
            {activeTab === 'todos' && (
              <TodoBoard sessions={sessions} onTriggerChat={handleTodoTriggerChat} />
            )}
            {activeTab === 'qa'      && <QAMonitorPanel selectedSessionId={selectedId} onGoToChat={handleContinueInChat} projects={tcProjects} activeProjectId={activeProjectId} onSelectProject={setActiveProjectId} onManageProjects={() => setShowHighTable(true)} />}
            {activeTab === 'metrics' && <MetricsDashboard />}
            {activeTab === 'sommelier' && <SommelierPanel onGoToChat={handleContinueInChat} projects={tcProjects} activeProjectId={activeProjectId} onSelectProject={setActiveProjectId} onManageProjects={() => setShowHighTable(true)} />}
            {activeTab === 'history'   && <HistoryPanel onContinue={handleContinueInChat} />}
            {activeTab === 'prompt'    && <PromptStudioPanel />}
            {activeTab === 'prefs'     && <PreferencesPanel />}
            {/* Mobile-only tabs */}
            {activeTab === 'sessions'  && <MobileSessionsPanel sessions={sessions} selectedId={selectedId} setSelectedId={setSelectedId} setActiveTab={setActiveTab} onContinue={handleContinueInChat} autoResumeMap={autoResumeMap} onToggleAutoResume={toggleAutoResume} hitLimitSessions={hitLimitSessions} historyCosts={historyCosts}
              onCostClick={async s => {
                const live = costSnap[`session:${s.id}`] ?? costSnap[normPath(s.cwd)]
                const d = await fetch(`/api/history/${s.id}`).then(r => r.json()).catch(() => ({}))
                const total = historyCosts[s.id] ?? live?.total ?? d.costUsd ?? 0
                setContractModal({ sessionName: s.displayName, costData: { total, byType: live?.byType ?? d.byType ?? {}, byModel: live?.byModel ?? d.byModel ?? {} } })
              }}
              onPermissionResponse={(permId, action) => send({ type: 'permission_response', permissionId: permId, action })}
              chatStage={chatStage} chatRunning={chatRunning} chatLastDelta={chatLastDelta} chatBaseline={chatBaseline}
            />}
            {activeTab === 'more'      && <MobileMorePanel sessions={sessions} onTriggerChat={handleTodoTriggerChat} />}
          </div>

        </main>

      </div>

      {/* Mobile bottom tab bar */}
      <MobileTabBar activeTab={activeTab} setActiveTab={setActiveTab} currentUser={currentUser} />
    </div>
  )
}
