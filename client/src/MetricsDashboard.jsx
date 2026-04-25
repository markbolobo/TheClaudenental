import { useState, useEffect } from 'react'

const COLUMN_META = {
  idea:       { label: '想到了',  icon: '💡', color: '#facc15' },
  discussing: { label: '討論中',  icon: '🗣', color: '#60a5fa' },
  doing:      { label: '實作中',  icon: '🔨', color: '#fb923c' },
  verifying:  { label: '驗證中',  icon: '🧪', color: '#a78bfa' },
  done:       { label: '完成',    icon: '✅', color: '#4ade80' },
  paused:     { label: '擱置',    icon: '⏸',  color: '#9ca3af' },
  storage:    { label: '倉庫',    icon: '📦', color: '#a8a29e' },
}

function dateKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function lastNDates(n) {
  const out = []
  const today = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push(dateKey(d))
  }
  return out
}

export function MetricsDashboard() {
  const [events, setEvents] = useState([])
  const [cards, setCards] = useState([])
  const [tags, setTags] = useState([])
  const [windowDays, setWindowDays] = useState(7)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch('/api/metrics/events').then(r => r.json()).catch(() => ({ events: [] })),
      fetch('/api/todos').then(r => r.json()).catch(() => ({ cards: [] })),
      fetch('/api/todo-tags').then(r => r.json()).catch(() => ({ tags: [] })),
    ]).then(([ev, td, tg]) => {
      setEvents(ev.events ?? [])
      setCards(td.cards ?? [])
      setTags(tg.tags ?? [])
      setLoading(false)
    })
  }, [])

  const cutoff = Date.now() - windowDays * 86400000
  const eventsInWindow = events.filter(e => e.ts >= cutoff)

  // ── 各種統計 ────────────────────────────────────────────

  // 每日活動（events 按日數）
  const dates = lastNDates(windowDays)
  const dailyCount = new Map(dates.map(d => [d, 0]))
  for (const e of eventsInWindow) {
    const k = dateKey(e.ts)
    if (dailyCount.has(k)) dailyCount.set(k, dailyCount.get(k) + 1)
  }

  // events 按 kind
  const kindCount = new Map()
  for (const e of eventsInWindow) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1)
  const topKinds = [...kindCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

  // 當前 column 分布
  const columnCount = new Map()
  for (const c of cards) columnCount.set(c.column, (columnCount.get(c.column) ?? 0) + 1)

  // 主題分布
  const themeCount = new Map()
  for (const c of cards) {
    if (c.themeId) themeCount.set(c.themeId, (themeCount.get(c.themeId) ?? 0) + 1)
  }
  const themes = tags.filter(t => t.kind === 'theme')

  // 過去 N 天 column.move 流向（卡片從哪到哪）
  const moveFlow = new Map()
  for (const e of eventsInWindow) {
    if (e.kind !== 'card.move') continue
    const key = `${e.data.from}→${e.data.to}`
    moveFlow.set(key, (moveFlow.get(key) ?? 0) + 1)
  }
  const topMoves = [...moveFlow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

  // 高手禮遇粗略指標
  const cardsTouched = new Set(eventsInWindow.filter(e => e.data?.id).map(e => e.data.id)).size
  const cardsCompleted = eventsInWindow.filter(e => e.kind === 'card.move' && e.data.to === 'done').length
  const cardsCreated = eventsInWindow.filter(e => e.kind === 'card.create').length

  const maxDaily = Math.max(1, ...dailyCount.values())

  if (loading) return <div className="p-6 text-[var(--text-muted)] text-xs">載入中…</div>

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3 gap-3">
      {/* 頂部窗口切換 */}
      <div className="shrink-0 flex items-center gap-2">
        <span className="text-[14px] font-bold">📊 服務儀表板</span>
        <span className="text-[9px] text-[var(--text-muted)]">events log 視覺化（高手禮遇後台基礎版）</span>
        <div className="flex-1" />
        {[7, 14, 30].map(n => (
          <button key={n} onClick={() => setWindowDays(n)}
            className={`text-[10px] px-2 py-0.5 rounded border ${windowDays === n
              ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
            過去 {n} 天
          </button>
        ))}
      </div>

      {/* 概要卡片 */}
      <div className="shrink-0 grid grid-cols-4 gap-2">
        <StatCard label="events 累計" value={events.length} sub={`過去 ${windowDays} 天 ${eventsInWindow.length}`} />
        <StatCard label="動過的卡" value={cardsTouched} sub="本窗口" />
        <StatCard label="新建卡" value={cardsCreated} sub={`過去 ${windowDays} 天`} />
        <StatCard label="結案" value={cardsCompleted} sub={`過去 ${windowDays} 天`} gold />
      </div>

      {/* 每日活動長條圖 */}
      <Section title="每日活動">
        <div className="flex items-end gap-1 h-32">
          {dates.map(d => {
            const count = dailyCount.get(d) ?? 0
            const h = (count / maxDaily) * 100
            const short = d.slice(5)
            return (
              <div key={d} className="flex-1 flex flex-col items-center gap-1 group">
                <div className="text-[8px] text-[var(--text-muted)] group-hover:text-[var(--gold)]">{count || ''}</div>
                <div className="w-full bg-[var(--gold)]/30 hover:bg-[var(--gold)]/60 rounded-t transition-colors"
                     style={{ height: `${h}%`, minHeight: count > 0 ? '4px' : '0' }} />
                <div className="text-[8px] text-[var(--text-muted)]">{short}</div>
              </div>
            )
          })}
        </div>
      </Section>

      {/* 卡片 column 分布 */}
      <Section title="卡片當前分布">
        <div className="flex gap-1 h-6 rounded overflow-hidden">
          {Object.keys(COLUMN_META).map(col => {
            const count = columnCount.get(col) ?? 0
            const total = cards.length || 1
            const pct = (count / total) * 100
            const meta = COLUMN_META[col]
            if (count === 0) return null
            return (
              <div key={col} title={`${meta.icon} ${meta.label}: ${count} 張`}
                style={{ width: `${pct}%`, backgroundColor: meta.color, minWidth: '2px' }}
                className="flex items-center justify-center text-[8px] text-black/70 font-bold">
                {pct > 6 ? `${count}` : ''}
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(COLUMN_META).map(([col, meta]) => (
            <div key={col} className="flex items-center gap-1 text-[9px]">
              <span style={{ backgroundColor: meta.color }} className="w-2.5 h-2.5 rounded-sm" />
              <span className="text-[var(--text-muted)]">{meta.icon} {meta.label}</span>
              <span className="text-[var(--text)] font-semibold">{columnCount.get(col) ?? 0}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 雙欄 */}
      <div className="grid grid-cols-2 gap-3">
        {/* 主題分布 */}
        <Section title="主題分布（卡片）">
          <div className="flex flex-col gap-1">
            {themes.map(t => {
              const count = themeCount.get(t.id) ?? 0
              const max = Math.max(1, ...themeCount.values())
              const pct = (count / max) * 100
              if (count === 0) return null
              return (
                <div key={t.id} className="flex items-center gap-2 text-[10px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                  <span className="w-20 shrink-0 truncate text-[var(--text-muted)]">{t.name}</span>
                  <div className="flex-1 h-2 bg-[var(--surface-2)] rounded overflow-hidden">
                    <div style={{ width: `${pct}%`, backgroundColor: t.color }} className="h-full" />
                  </div>
                  <span className="w-6 text-right text-[var(--text)]">{count}</span>
                </div>
              )
            })}
            {themes.every(t => (themeCount.get(t.id) ?? 0) === 0) && (
              <div className="text-[10px] text-[var(--text-muted)] italic">尚無主題卡</div>
            )}
          </div>
        </Section>

        {/* 階段流向 */}
        <Section title="階段流向（過去窗口）">
          {topMoves.length === 0 ? (
            <div className="text-[10px] text-[var(--text-muted)] italic">本窗口無拖卡紀錄</div>
          ) : (
            <div className="flex flex-col gap-1">
              {topMoves.map(([key, count]) => {
                const [from, to] = key.split('→')
                const fromMeta = COLUMN_META[from] ?? {}
                const toMeta = COLUMN_META[to] ?? {}
                return (
                  <div key={key} className="flex items-center gap-2 text-[10px]">
                    <span className="w-16 shrink-0">{fromMeta.icon} {fromMeta.label}</span>
                    <span className="text-[var(--gold)]">→</span>
                    <span className="w-16 shrink-0">{toMeta.icon} {toMeta.label}</span>
                    <div className="flex-1" />
                    <span className="text-[var(--text)] font-semibold">{count}</span>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      </div>

      {/* events kind 排行 */}
      <Section title="事件類型排行">
        <div className="flex flex-col gap-1">
          {topKinds.map(([kind, count]) => {
            const max = Math.max(1, ...kindCount.values())
            const pct = (count / max) * 100
            return (
              <div key={kind} className="flex items-center gap-2 text-[10px]">
                <span className="w-32 shrink-0 text-[var(--text-muted)] font-mono">{kind}</span>
                <div className="flex-1 h-2 bg-[var(--surface-2)] rounded overflow-hidden">
                  <div style={{ width: `${pct}%` }} className="h-full bg-[var(--gold)]/60" />
                </div>
                <span className="w-8 text-right text-[var(--text)]">{count}</span>
              </div>
            )
          })}
        </div>
      </Section>

      {/* 最近事件 */}
      <Section title="最近 30 筆事件">
        <div className="flex flex-col gap-0.5 font-mono text-[9px] max-h-48 overflow-y-auto">
          {[...eventsInWindow].slice(-30).reverse().map((e, i) => (
            <div key={i} className="flex gap-2 py-0.5 border-b border-[var(--border)]/30">
              <span className="text-[var(--text-muted)]">{new Date(e.ts).toLocaleTimeString('zh-TW', { hour12: false })}</span>
              <span className="text-[var(--gold)]/80 w-24 truncate">{e.kind}</span>
              <span className="flex-1 text-[var(--text)] truncate">{JSON.stringify(e.data ?? {})}</span>
            </div>
          ))}
          {eventsInWindow.length === 0 && (
            <div className="text-[var(--text-muted)] italic">本窗口無事件</div>
          )}
        </div>
      </Section>

      <div className="text-[9px] text-[var(--text-muted)] italic pt-2">
        基礎版：純資料視覺化。Phase 4 擴充版會加禮遇 6 維度雷達圖、AI 自我評估、每週反思。
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, gold }) {
  return (
    <div className={`px-3 py-2 rounded border bg-[var(--surface-2)]/60 ${gold ? 'border-[var(--gold)]/50' : 'border-[var(--border)]'}`}>
      <div className="text-[8px] uppercase tracking-widest text-[var(--text-muted)]">{label}</div>
      <div className={`text-[20px] font-bold ${gold ? 'text-[var(--gold)]' : 'text-[var(--text)]'}`}>{value}</div>
      <div className="text-[8px] text-[var(--text-muted)]">{sub}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/30 p-2">
      <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-2">{title}</div>
      {children}
    </div>
  )
}
