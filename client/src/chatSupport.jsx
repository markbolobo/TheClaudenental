// ─── Chat 共用支援層（2026-07-20 自 App.jsx 搬出，App / ChatPanel / 分頁內嵌對話共用）─────
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ─── Outline minimap（少爺 2026-07-16：ChatGPT/Notion 式對話大綱）──────────────
// 條目=少爺的留言。平常收合成右緣 tick 簡圖，hover/點擊展開成清單；
// 點條目捲動聊天室到該留言；聊天室捲動位置反向同步高亮條目（Notion 進度同步）。

const OUTLINE_MAX_TICKS = 48

/** 從訊息列表抽大綱條目 + 追蹤捲動位置對應的 active 條目（Chat / History 共用） */
function useChatOutline(containerRef, messages, prefix, disabled = false) {
  const [activeId, setActiveId] = useState(null)
  const entries = useMemo(() => {
    if (disabled) return []
    const _list = []
    messages.forEach((m, idx) => {
      if (m.role !== 'user') return
      const _raw = (m.text ?? '').trim()
      // 系統產物不進大綱（compact 續傳摘要 / skill 展開文 / caveat）——大綱只放少爺親手打的留言
      if (!_raw || _raw.startsWith('Caveat:') || _raw.startsWith('Base directory for this skill') || _raw.includes('This session is being continued')) return
      const _label = _raw.split('\n')[0].replace(/^[>›\s]+/, '').slice(0, 80)
      if (_label) _list.push({ id: `${prefix}-${idx}`, absIdx: idx, label: _label })
    })
    return _list
  }, [messages, prefix, disabled])
  // active = 「捲動視窗上緣 30% 線」以上最後一個條目（Notion 式「目前所在區塊」）
  const update = useCallback(() => {
    const _el = containerRef.current
    if (!_el || !entries.length) { setActiveId(null); return }
    const _threshold = _el.scrollTop + _el.clientHeight * 0.3
    let _current = entries[0].id
    for (const e of entries) {
      const _node = document.getElementById(e.id)
      if (!_node) continue
      if (_node.offsetTop <= _threshold) _current = e.id
      else break
    }
    setActiveId(_current)
  }, [entries, containerRef])
  useEffect(() => { update() }, [update, messages])
  return { entries, activeId, update }
}

function OutlineMinimap({ entries, activeId, onJump }) {
  const [expanded, setExpanded] = useState(false)
  const panelRef = useRef(null)

  // 展開時讓 active 條目維持在面板可視範圍（跟著聊天室捲動走）
  useEffect(() => {
    if (!expanded || !activeId) return
    panelRef.current?.querySelector(`[data-oid="${activeId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [expanded, activeId])

  if (entries.length < 2) return null

  // tick 過多時等距抽樣（active 條目永遠保留，確保高亮不消失）
  let ticks = entries
  if (entries.length > OUTLINE_MAX_TICKS) {
    const _step = entries.length / OUTLINE_MAX_TICKS
    const _picked = []
    for (let i = 0; i < OUTLINE_MAX_TICKS; i++) _picked.push(entries[Math.floor(i * _step)])
    if (activeId && !_picked.some(e => e.id === activeId)) {
      const _act = entries.find(e => e.id === activeId)
      if (_act) _picked.splice(_picked.findIndex(e => e.absIdx > _act.absIdx), 0, _act)
    }
    ticks = _picked
  }

  return (
    <div
      className="absolute inset-y-0 right-1 z-20 flex items-stretch"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {expanded ? (
        <div ref={panelRef}
          className="self-center max-h-[92%] my-2 w-[240px] max-w-[70vw] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-sm shadow-xl py-1">
          {entries.map(e => (
            <button key={e.id} data-oid={e.id}
              onClick={() => { onJump(e); setExpanded(false) }}
              className={`block w-full text-left px-2.5 py-[5px] text-[10px] leading-snug truncate border-l-2 ${
                e.id === activeId
                  ? 'text-[var(--gold)] bg-[var(--gold)]/10 border-[var(--gold)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] border-transparent'
              }`}>
              {e.label}
            </button>
          ))}
        </div>
      ) : (
        <div
          onClick={() => setExpanded(true)}
          className="flex w-6 cursor-pointer flex-col items-end justify-center gap-[5px] overflow-hidden py-4">
          {ticks.map(e => (
            <div key={e.id}
              className={`h-[2px] rounded-full transition-all ${
                e.id === activeId ? 'w-4 bg-[var(--gold)]' : 'w-2.5 bg-[var(--text-muted)]/40'
              }`} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Facebook link interceptor ────────────────────────────────────────────────
// Chrome 可能有擴充元件導致 FB 頁面無法顯示，FB 網域連結改走 Edge
const FB_DOMAINS = /^(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.com|fb\.me|messenger\.com)$/i

function isFacebookUrl(href) {
  try { return FB_DOMAINS.test(new URL(href).hostname) } catch { return false }
}

function openInEdge(url) {
  fetch('/api/open-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, browser: 'edge' }),
  }).catch(() => {})
}

// ReactMarkdown component override: 攔截 FB 連結走 Edge、檔案連結走 VSCode
// 對應 docs/customization/project_roots_schema.md

const FILE_LINK_EXT_PATTERN = /\.(md|txt|cpp|h|hpp|c|inl|cs|java|kt|swift|go|rs|js|jsx|ts|tsx|vue|py|rb|php|json|yaml|yml|toml|ini|html|css|scss|less|uasset|umap|uproject|uplugin|canvas|sql|graphql|proto|sh|bash|bat|ps1)(#L\d+)?$/i

function isFileLink(href) {
  if (!href) return false
  if (/^https?:\/\//i.test(href)) return false
  if (/^vscode:\/\//i.test(href)) return false
  if (/^mailto:/i.test(href)) return false
  if (href.startsWith('#')) return false
  return FILE_LINK_EXT_PATTERN.test(href)
}

function showTcToast(msg, level = 'info') {
  const div = document.createElement('div')
  div.textContent = msg
  const bg = level === 'error' ? '#dc2626' : level === 'warn' ? '#f59e0b' : '#10b981'
  div.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:6px;background:${bg};color:white;font-size:14px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;max-width:90vw;`
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 2400)
}

async function openInVSCode(href) {
  // Parse: foo/bar.md#L42 → relativePath="foo/bar.md", line=42
  const m = href.match(/^(.+?)(?:#L(\d+))?$/i)
  if (!m) return
  const relativePath = m[1]
  const line = m[2] ? parseInt(m[2], 10) : null

  try {
    const res = await fetch('/api/open-in-vscode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath, line }),
    })
    if (res.status === 403) {
      showTcToast('只有 owner 能開檔', 'warn')
      return
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      showTcToast(`開檔失敗：${j.error || res.status}`, 'error')
      return
    }
    showTcToast('已通知 PC VSCode 開檔')
  } catch (e) {
    showTcToast(`開檔失敗：${e.message}`, 'error')
  }
}

const mdComponents = {
  a({ href, children, ...rest }) {
    if (href && isFacebookUrl(href)) {
      return (
        <a href={href}
          onClick={e => { e.preventDefault(); openInEdge(href) }}
          onTouchEnd={e => { e.preventDefault(); openInEdge(href) }}
          title="用 Edge 開啟（避開 Chrome 擴充衝突）"
          style={{ touchAction: 'manipulation' }}
          {...rest}>
          {children} <span style={{ fontSize: '0.85em', opacity: 0.7 }}>🌐</span>
        </a>
      )
    }
    if (href && isFileLink(href)) {
      return (
        <a href={href}
          onClick={e => { e.preventDefault(); openInVSCode(href) }}
          onTouchEnd={e => { e.preventDefault(); openInVSCode(href) }}
          title="點擊在 PC VSCode 開檔（僅 owner）"
          style={{ touchAction: 'manipulation' }}
          {...rest}>
          {children} <span style={{ fontSize: '0.85em', opacity: 0.7 }}>📂</span>
        </a>
      )
    }
    return <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
  },
}

// ─── Rating System ────────────────────────────────────────────────────────────
// 被動訊號（不評分）= 可接受，低權重；主動訊號（明確評分）= 高權重。
// 兩者共同描繪「規矩」（好球帶），定期分析後寫入偏好文字。

const RATING_KEY    = 'tc_ratings_v1'   // localStorage cache key
const PREF_TEXT_KEY = 'tc_pref_text'    // localStorage cache key

// ── localStorage helpers (cache layer) ──
function loadRatingsCache() {
  try { return JSON.parse(localStorage.getItem(RATING_KEY) || '[]') } catch { return [] }
}
function writeRatingsCache(all) {
  localStorage.setItem(RATING_KEY, JSON.stringify(all.slice(-1000)))
}
function loadRatingById(id) { return loadRatingsCache().find(r => r.id === id) || null }

// ── Server helpers (source of truth) ──
async function fetchRatingsFromServer() {
  try {
    const d = await fetch('/api/ratings').then(r => r.json())
    const all = d.ratings ?? []
    writeRatingsCache(all)   // keep cache in sync
    return all
  } catch { return loadRatingsCache() }  // offline fallback
}

function saveRating(r) {
  // 1. 立即寫入 localStorage（帶 _pendingSync 標記）
  const entry = { ...r, _pendingSync: true }
  const all = loadRatingsCache()
  const idx = all.findIndex(x => x.id === r.id)
  if (idx >= 0) all[idx] = entry; else all.push(entry)
  writeRatingsCache(all)
  // 2. 送上 server，成功後清除 _pendingSync
  fetch('/api/ratings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: r }),
  }).then(res => {
    if (res.ok) {
      const fresh = loadRatingsCache()
      const i2 = fresh.findIndex(x => x.id === r.id)
      if (i2 >= 0) { fresh[i2] = { ...fresh[i2], _pendingSync: false }; writeRatingsCache(fresh) }
    }
  }).catch(() => {}) // 保留 _pendingSync:true，等下次載頁重送
}

// 頁面載入時，把上次沒送到的評分補送
function flushPendingSync() {
  const all = loadRatingsCache()
  const pending = all.filter(r => r._pendingSync)
  for (const r of pending) {
    const clean = { ...r }; delete clean._pendingSync
    fetch('/api/ratings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: clean }),
    }).then(res => {
      if (res.ok) {
        const fresh = loadRatingsCache()
        const i = fresh.findIndex(x => x.id === r.id)
        if (i >= 0) { fresh[i] = { ...fresh[i], _pendingSync: false }; writeRatingsCache(fresh) }
      }
    }).catch(() => {})
  }
}

// loadRatings used by PreferencesPanel — pulls from server for fresh cross-device data
async function loadRatings() { return fetchRatingsFromServer() }

function extractFeatures(text) {
  if (!text) return {}
  return {
    len:        text.length,
    hasCode:    /```/.test(text),
    hasList:    /^[\-\*\d]\.?\s/m.test(text),
    hasHeaders: /^#{1,3}\s/m.test(text),
    paraCount:  (text.match(/\n\n+/g) || []).length + 1,
  }
}

const RATING_TAGS = ['太長', '太短', '方向對了', '方向偏了', '需要更多細節', '太囉嗦', '需要例子', '完美']

function normPath(p) { return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') }

// 共用 tooltip：滑鼠常駐時顯示說明（全站可用，不影響 drag/click）
function Tooltip({ content, placement = 'top', maxWidth = 260, children, disabled = false }) {
  const [show, setShow] = useState(false)
  if (!content || disabled) return children
  const posClass = placement === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1'
  return (
    <span className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}>
      {children}
      {show && (
        <span
          role="tooltip"
          style={{ maxWidth }}
          className={`absolute z-50 ${posClass} left-1/2 -translate-x-1/2 whitespace-pre-wrap px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--gold-border)] text-[10px] leading-relaxed text-[var(--text)] shadow-lg pointer-events-none`}>
          {content}
        </span>
      )}
    </span>
  )
}

export {
  OUTLINE_MAX_TICKS, useChatOutline, OutlineMinimap,
  isFacebookUrl, openInEdge, isFileLink, showTcToast, openInVSCode, mdComponents,
  RATING_KEY, PREF_TEXT_KEY, loadRatingsCache, writeRatingsCache, loadRatingById, saveRating, flushPendingSync, loadRatings, extractFeatures, RATING_TAGS,
  normPath, Tooltip,
}
