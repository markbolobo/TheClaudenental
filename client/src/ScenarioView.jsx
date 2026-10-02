import { useMemo, useState } from 'react'
import { scenarioKey, SCENARIO_NEW_KEY, stripSource } from './scenarioPrompt.js'
import { DecisionDeck, DecisionViewToggle, DerivedReview, SudokuSolveButton } from './DecisionDeck.jsx'
import { scenarioDeckItems, scenarioDerivedItems, loadDecisionView, saveDecisionView } from './decisionSupport.js'

// 🎬 情境體驗視圖（Sommelier 第六血肉，少爺 2026-09-15 立）— scenario/S##_*.md：
// 一個情境一張：體驗一句話 / 題目對照（九面向）/ 進入與離開 / 看到聽到 / 能做什麼 / 運作機制 / 節奏 / 故事 / 素材 / 缺口 / 待定奪 / 驗收 / 脈絡 / 討論。
// 事實與提案分筆觸：✅ 已實作 🔬 實作中 📐 定案未實作 💡 提案（待業主定奪）❌ 否決 ➖ 不適用。
// 資料來源 scenario_experience.json（extract_scenario_experience.mjs）；本檔只讀不寫，與 Sommelier.jsx 其他視圖零耦合。
// 非元件共用（購物車 key／結帳 prompt）在 scenarioPrompt.js。

const MARK = {
  '✅': { label: '已實作', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  '🔬': { label: '實作中／未查', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/40' },
  '📐': { label: '定案未實作', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/40' },
  '💡': { label: '提案待定', cls: 'bg-amber-400/15 text-amber-300 border-amber-400/40' },
  '❌': { label: '否決', cls: 'bg-red-500/15 text-red-300 border-red-500/40' },
  '➖': { label: '不適用', cls: 'bg-[var(--surface)] text-[var(--text-muted)] border-[var(--border)]' },
}
const STATUS_META = {
  active: { label: '成立', cls: 'border-emerald-500/40 text-emerald-300' },
  draft: { label: '草稿', cls: 'border-amber-400/40 text-amber-400/80' },
  proposed: { label: '提案', cls: 'border-violet-500/40 text-violet-300' },
  retired: { label: '退役', cls: 'border-[var(--border)] text-[var(--text-muted)]' },
}
function Mark({ m, title }) {
  if (!m) return null
  const meta = MARK[m] ?? MARK['➖']
  return <span title={title ?? meta.label} className={`text-[10px] px-1 rounded border shrink-0 ${meta.cls}`}>{m}</span>
}
function Section({ title, hint, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">{title}{hint && <span className="ml-2 normal-case tracking-normal text-[var(--text-muted)]">{hint}</span>}</div>
      {children}
    </div>
  )
}
// 內文裡的 [[連結]] 變成可點的 chip（S##＝情境、CamelCase＝意圖、其他＝拼圖）；反引號＝code（設計脈絡視圖的待定奪面板也共用）
export function RichText({ text, onJumpToScenario, onJumpToIntent, onJumpToMemory, intentTitle }) {
  const parts = useMemo(() => {
    const out = []
    const re = /\[\[([^\]]+)\]\]|`([^`]+)`/g
    let last = 0, m
    const src = text ?? ''
    while ((m = re.exec(src))) {
      if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) })
      if (m[1]) out.push({ t: 'link', v: m[1].trim() })
      else out.push({ t: 'code', v: m[2] })
      last = re.lastIndex
    }
    if (last < src.length) out.push({ t: 'text', v: src.slice(last) })
    return out
  }, [text])
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        if (p.t === 'text') return <span key={i}>{p.v}</span>
        if (p.t === 'code') return <code key={i} className="text-[10px] text-[var(--gold)]/90">{p.v}</code>
        const l = p.v
        if (/^S\d{2}_/.test(l)) return <button key={i} onClick={() => onJumpToScenario?.(l)} className="text-[10px] px-1 rounded border border-[var(--gold)]/40 text-[var(--gold)] hover:border-[var(--gold)] mx-0.5">🎬 {l}</button>
        if (/^[A-Z][A-Za-z0-9]+$/.test(l)) return <button key={i} onClick={() => onJumpToIntent?.(l)} className="text-[10px] px-1 rounded border border-[var(--gold)]/40 text-[var(--gold)] hover:border-[var(--gold)] mx-0.5">🧭 {intentTitle?.(l) ?? l}</button>
        return <button key={i} onClick={() => onJumpToMemory?.(l)} className="text-[10px] px-1 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50 mx-0.5">📓 {l}</button>
      })}
    </span>
  )
}
function MarkedList({ items, rich }) {
  if (!items?.length) return <div className="text-[10px] text-[var(--text-muted)]">（尚無）</div>
  return (
    <div className="space-y-0.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-1.5 text-[11px] text-[var(--text)]">
          <Mark m={it.marker} title={it.source ? `出處：${it.source}` : undefined} />
          <div className="min-w-0 flex-1">{rich(stripSource(it.text))}{it.source && <span className="ml-1 text-[9px] text-[var(--text-muted)]" title={it.source}>（出處）</span>}</div>
        </div>
      ))}
    </div>
  )
}
function SimpleTable({ header, rows, rich, statusCol }) {
  if (!rows?.length) return <div className="text-[10px] text-[var(--text-muted)]">（尚無）</div>
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] w-full border-collapse">
        <thead><tr>{header.map((h, i) => <th key={i} className="text-left px-1.5 py-0.5 border-b border-[var(--border)] text-[var(--text-muted)] font-normal whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <td key={j} className="px-1.5 py-0.5 border-b border-[var(--border)]/50 text-[var(--text)]">
                  {j === statusCol ? <Mark m={(c ?? '').trim()} /> : rich(stripSource(c))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ScenarioView({ scenario, designIntent, projectId, query, initialId, onJumpToIntent, onJumpToMemory, cartKeys, onToggleScenarioCart, onToggleNewScenarioCart, onGoToChat = null, onReload = null }) {
  const scenarios = useMemo(() => scenario?.scenarios ?? [], [scenario])
  const phases = useMemo(() => scenario?.phases ?? [], [scenario])
  const [sid, setSid] = useState(initialId ?? null)
  const [decisionView, setDecisionView] = useState(loadDecisionView)
  const changeDecisionView = (v) => { setDecisionView(v); saveDecisionView(v) }
  const allDeckItems = useMemo(() => scenarioDeckItems(projectId, scenario?.scenarios), [projectId, scenario])
  const allDerivedItems = useMemo(() => scenarioDerivedItems(projectId, scenario?.scenarios), [projectId, scenario])
  // 連動題可能在另一層：情境就地切換、意圖跳設計脈絡
  const jumpToDecisionSource = (x) => { if (x.layer === 'scenario') setSid(x.sourceId); else onJumpToIntent?.(x.sourceId) }
  // 外部指定條目（設計脈絡頁點「出現在這些情境」）：prop 變了才同步，不用 effect（避免級聯 render）
  const [seenInitialId, setSeenInitialId] = useState(initialId)
  if (initialId !== seenInitialId) {
    setSeenInitialId(initialId)
    if (initialId) setSid(initialId)
  }

  const byId = useMemo(() => new Map(scenarios.map(s => [s.id, s])), [scenarios])
  const intentById = useMemo(() => new Map((designIntent?.intents ?? []).map(i => [i.id, i])), [designIntent])
  const intentTitle = (id) => intentById.get(id)?.title ?? id

  const tokens = useMemo(() => (query ?? '').toLowerCase().split(/\s+/).filter(Boolean), [query])
  const grouped = useMemo(() => {
    const g = new Map()
    for (const s of scenarios) {
      const hay = `${s.id} ${s.title} ${s.oneLiner} ${s.text}`.toLowerCase()
      if (!tokens.every(t => hay.includes(t))) continue
      const ph = s.phase || '(未分類)'
      if (!g.has(ph)) g.set(ph, [])
      g.get(ph).push(s)
    }
    const order = (ph) => { const i = phases.indexOf(ph); return i < 0 ? 999 : i }
    return [...g.entries()].sort((a, b) => order(a[0]) - order(b[0]))
  }, [scenarios, tokens, phases])

  const s = sid ? byId.get(sid) : null
  const detailDeckItems = useMemo(() => allDeckItems.filter(x => x.sourceId === sid), [allDeckItems, sid])
  const detailDerivedItems = useMemo(() => allDerivedItems.filter(x => x.sourceId === sid), [allDerivedItems, sid])
  const rich = (t) => <RichText text={t} onJumpToScenario={setSid} onJumpToIntent={onJumpToIntent} onJumpToMemory={onJumpToMemory} intentTitle={intentTitle} />

  if (!scenarios.length) return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs px-6 text-center">
      尚無情境體驗資料 — 在 sommelier.json 該專案加 scenarioDir（scenario/S##_*.md）並把 extract_scenario_experience.mjs 接進 extractCommand 後跑刷新指令
    </div>
  )

  const totalOpen = scenarios.reduce((n, x) => n + (x.openDecisions ?? []).filter(d => !d.resolved).length, 0)
  const totalGaps = scenarios.reduce((n, x) => n + (x.gaps ?? []).length, 0)
  const newInCart = cartKeys.has(SCENARIO_NEW_KEY(projectId))

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左：phase 分組時間軸 */}
      <div className="w-72 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        <div className="px-1 pb-2 mb-2 border-b border-[var(--border)]">
          <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">🎬 題目</div>
          <div className="text-[10px] text-[var(--text)] leading-snug" title={scenario?.thesis}>{scenario?.thesis}</div>
          <div className="text-[9px] text-[var(--text-muted)] mt-1">{scenarios.length} 個情境 · 補全 {scenario?.stats?.completenessAvg ?? 0}% · 待補 {scenario?.stats?.todo ?? 0} · 💡 缺口 {totalGaps} · ⬜ 待定奪 {totalOpen}</div>
          <div className="text-[9px] text-[var(--text-muted)]">逐漸補全：待補只是下次要補的，不擋任何流程</div>
        </div>
        <button onClick={onToggleNewScenarioCart}
          className={`w-full text-left px-2 py-1 mb-2 rounded border text-[11px] ${newInCart ? 'bg-[var(--gold)]/15 border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--gold)]/30 text-[var(--gold)]/80 hover:bg-[var(--gold)]/10'}`}
          title="結帳時帶「請建新情境骨架並用九面向訪談我」的指令；情境名與階段寫在需求描述裡">
          🆕 開新情境{newInCart ? '（已在購物車）' : ''}
        </button>
        {totalOpen > 0 && (
          <button onClick={() => setSid('__ALL_OPEN__')}
            className={`w-full text-left px-2 py-1 mb-2 rounded border text-[11px] ${sid === '__ALL_OPEN__' ? 'bg-amber-400/15 border-amber-400/60 text-amber-300' : 'border-amber-400/30 text-amber-400/80 hover:bg-amber-400/10'}`}>
            ⬜ 待定奪總覽 <span className="font-bold">{totalOpen}</span> 筆 <span className="text-[9px] opacity-70">· 需要你決策</span>
          </button>
        )}
        {grouped.map(([ph, arr]) => (
          <div key={ph} className="mb-1">
            <div className="px-1 py-0.5 text-[10px] uppercase tracking-widest text-[var(--gold)]/70">🎬 {ph} <span className="text-[8px]">({arr.length})</span></div>
            {arr.map(x => {
              const open = (x.openDecisions ?? []).filter(d => !d.resolved).length
              const st = STATUS_META[x.status] ?? STATUS_META.draft
              return (
                <button key={x.id} onClick={() => setSid(x.id)}
                  className={`w-full text-left pl-3 pr-2 py-0.5 rounded text-[11px] flex items-center gap-1 ${sid === x.id ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                  <span className="text-[9px] text-[var(--text-muted)] shrink-0">{x.id.slice(0, 3)}</span>
                  <span className="truncate flex-1">{x.title.replace(/（.*$/, '')}</span>
                  <span className="text-[8px] text-[var(--text-muted)] shrink-0" title={`補全度 ${x.completeness?.score ?? 0}%（段 ${x.completeness?.sections ?? 0}/${x.completeness?.sectionsTotal ?? 14}・九面向 ${x.completeness?.thesisAnswered ?? 0}/9）· ✅${x.counts?.done ?? 0} 💡${x.counts?.proposal ?? 0}`}>{x.completeness?.score ?? 0}%</span>
                  {open > 0 && <span className="text-[8px] px-1 rounded bg-amber-400/20 text-amber-300 shrink-0" title="待你定奪">⬜{open}</span>}
                  {x.status !== 'active' && <span className={`text-[8px] px-1 rounded border shrink-0 ${st.cls}`}>{st.label}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 右：細節 */}
      <div className="flex-1 overflow-y-auto p-3 min-w-0">
        {sid === '__ALL_OPEN__' ? (
          <div className="max-w-4xl space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-[var(--gold)] text-sm flex-1">⬜ 待定奪總覽 — 情境層需要你決策的開放問題</div>
              <SudokuSolveButton projectId={projectId} onGoToChat={onGoToChat} />
              <DecisionViewToggle view={decisionView} onChange={changeDecisionView} />
            </div>
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">只放<b>我不能自行決定</b>的設計取捨；可自行查證的留在各情境的 🔬 條目，那是我的工作。討論到某個情境時，它的待定奪會在自己頁面出現，順帶答掉就好。</p>
            <DerivedReview items={allDerivedItems} projectId={projectId} rich={rich} onJumpToSource={jumpToDecisionSource} />
            {decisionView === 'deck' ? (
              <DecisionDeck items={allDeckItems} projectId={projectId} rich={rich} onJumpToSource={jumpToDecisionSource} onGoToChat={onGoToChat} onReload={onReload} />
            ) : scenarios.flatMap(x => (x.openDecisions ?? []).filter(d => !d.resolved).map(d => ({ ...d, _s: x }))).map((d, i) => (
              <div key={i} className="border border-amber-400/30 rounded p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300">{d.id}</span>
                  <button onClick={() => setSid(d._s.id)} className="text-[10px] text-[var(--gold)]/70 hover:text-[var(--gold)]">🎬 {d._s.title}</button>
                  {d.raised && <span className="text-[9px] text-[var(--text-muted)]">提出 {d.raised}</span>}
                </div>
                <div className="text-[11px] text-[var(--text)]">{d.title}</div>
                {d.status && <div className="text-[10px] text-[var(--text-muted)]"><b>現況</b>：{rich(d.status)}</div>}
                {d.reason && <div className="text-[10px] text-[var(--text-muted)]"><b>要你定的原因</b>：{d.reason}</div>}
                {d.options && <div className="text-[10px] text-emerald-300/80"><b>選項</b>：{rich(d.options)}</div>}
                {d.affects && <div className="text-[9px] text-[var(--text-muted)]">牽動 {rich(d.affects)}</div>}
              </div>
            ))}
          </div>
        ) : !s ? (
          <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-lg mx-auto mt-10 space-y-2">
            <div className="text-[var(--gold)] text-sm">🎬 情境體驗</div>
            <p>一個情境一張：玩家在這一段<b>看到什麼、聽到什麼、能做什麼</b>、節奏如何、哪些機制在運作、還缺什麼——每張都在答同一道題：<b>「{scenario?.thesis}」</b>。</p>
            <p>每一條都帶標記把事實與提案分開：✅ 已實作（附出處）／🔬 實作中或未查／📐 你定案未實作／💡 我的提案（待你定奪）／❌ 否決。</p>
            <p>點 🛒 把整張情境帶進結帳＝觸發「讀→訪談（≤5 題）→補完→定奪」工作流；「🆕 開新情境」＝建骨架後用九面向訪談你。</p>
            <p><b>逐漸補全</b>：每張都有補全度與待補清單，那是下次要補的，機檢與結案 B8 只提醒、不擋。</p>
            <p className="text-[10px]">來源：<code>scenario/S##_*.md</code>（kickoff 對映、結案 B8 提醒；SOP <code>z_sub_scenario_experience.md</code>）</p>
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">🎬 {s.phase}</span>
              <code className="text-base text-[var(--text)]">{s.title}</code>
              <span className={`text-[8px] px-1 rounded border ${(STATUS_META[s.status] ?? STATUS_META.draft).cls}`}>{(STATUS_META[s.status] ?? STATUS_META.draft).label}</span>
              <button onClick={() => onToggleScenarioCart(s)}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${cartKeys.has(scenarioKey(projectId, s.id)) ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                {cartKeys.has(scenarioKey(projectId, s.id)) ? '🛒✓ 已在購物車' : '🛒 討論這個情境'}
              </button>
            </div>
            <div className="text-[9px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
              <span>流程 <code>{s.flow}</code></span><span>模式 {s.mode}</span><span>地圖 <code>{s.map}</code></span><span>更新 {s.updated}</span>
              {s.prev?.length > 0 && <span>← {s.prev.map(p => <button key={p} onClick={() => setSid(p)} className="text-[var(--gold)]/70 hover:text-[var(--gold)] mr-1">{p}</button>)}</span>}
              {s.next?.length > 0 && <span>→ {s.next.map(p => <button key={p} onClick={() => setSid(p)} className="text-[var(--gold)]/70 hover:text-[var(--gold)] mr-1">{p}</button>)}</span>}
            </div>

            {s.oneLiner && <div className="text-[12px] text-[var(--text)] border-l-2 border-[var(--gold)]/40 pl-2 italic">{s.oneLiner}</div>}

            {s.completeness && (
              <Section title="補全度" hint="逐漸補全——待補是下次要補的，不擋">
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                  <div className="h-1.5 w-40 rounded bg-[var(--surface)] overflow-hidden"><div className="h-full bg-[var(--gold)]/70" style={{ width: `${s.completeness.score}%` }} /></div>
                  <span className="text-[var(--text)]">{s.completeness.score}%</span>
                  <span>段 {s.completeness.sections}/{s.completeness.sectionsTotal}</span>
                  <span>九面向 {s.completeness.thesisAnswered}/{s.completeness.thesisTotal}</span>
                  <span>事實出處 {s.completeness.factSourced}/{s.completeness.factTotal}</span>
                </div>
                {s.completeness.todo?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {s.completeness.todo.map((t, i) => <span key={i} className="text-[9px] px-1.5 py-0.5 rounded border border-dashed border-[var(--border)] text-[var(--text-muted)]">○ {t}</span>)}
                  </div>
                )}
              </Section>
            )}

            <Section title="題目對照" hint="陣型如何在此展現（九面向）">
              <div className="space-y-0.5">
                {(s.thesis ?? []).map(t => (
                  <div key={t.dimension} className="flex items-start gap-1.5 text-[11px]">
                    <span className="w-14 shrink-0 text-[10px] text-[var(--gold)]/80">{t.dimension}</span>
                    <Mark m={t.marker} />
                    <div className="min-w-0 flex-1 text-[var(--text)]">{t.answer ? rich(stripSource(t.answer)) : <span className="text-[var(--text-muted)]">（尚未回答）</span>}</div>
                  </div>
                ))}
              </div>
            </Section>

            {(s.openDecisions ?? []).length > 0 && (
              <Section title="⬜ 待定奪（需要你決策）" hint={<DecisionViewToggle view={decisionView} onChange={changeDecisionView} />}>
                <DerivedReview items={detailDerivedItems} projectId={projectId} rich={rich} onJumpToSource={jumpToDecisionSource} />
                {decisionView === 'deck' && detailDeckItems.length > 0 && (
                  <DecisionDeck items={detailDeckItems} projectId={projectId} rich={rich} showSource={false} onJumpToSource={jumpToDecisionSource} onGoToChat={onGoToChat} onReload={onReload} />
                )}
                {s.openDecisions.filter(d => decisionView === 'list' || (d.resolved && d.resolvedBy !== 'derived')).map(d => (
                  <div key={d.id} className={`border rounded p-2 space-y-1 ${d.resolved ? 'border-[var(--border)] opacity-60' : 'border-amber-400/30'}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${d.resolved ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-400/20 text-amber-300'}`}>{d.resolved ? '✓ 已定' : d.id}</span>
                      <span className="text-[11px] text-[var(--text)]">{d.title}</span>
                    </div>
                    {!d.resolved && d.status && <div className="text-[10px] text-[var(--text-muted)]"><b>現況</b>：{rich(d.status)}</div>}
                    {!d.resolved && d.reason && <div className="text-[10px] text-[var(--text-muted)]"><b>要你定的原因</b>：{d.reason}</div>}
                    {!d.resolved && d.options && <div className="text-[10px] text-emerald-300/80"><b>選項</b>：{rich(d.options)}</div>}
                    {!d.resolved && d.affects && <div className="text-[9px] text-[var(--text-muted)]">牽動 {rich(d.affects)}</div>}
                    {d.resolved && d.resolution && <div className="text-[10px] text-emerald-300/80">{d.resolvedAt} 定案：{d.resolution}</div>}
                  </div>
                ))}
              </Section>
            )}

            {(s.gaps ?? []).length > 0 && (
              <Section title="💡 缺口與補完" hint="我補完的提案，等你定奪">
                {s.gaps.map((g, i) => (
                  <div key={g.id ?? i} className="border border-amber-400/20 rounded p-2 space-y-0.5">
                    <div className="flex items-start gap-1.5 text-[11px] text-[var(--text)]"><Mark m={g.marker} />{g.id && <code className="text-[10px] text-amber-300">{g.id}</code>}<span>{rich(g.text)}</span></div>
                    {g.why && <div className="text-[10px] text-[var(--text-muted)]"><b>為什麼</b>：{g.why}</div>}
                    {g.affects && <div className="text-[10px] text-[var(--text-muted)]"><b>牽動</b>：{rich(g.affects)}</div>}
                    {g.path && <div className="text-[10px] text-[var(--text-muted)]"><b>落實路徑</b>：{rich(g.path)}</div>}
                  </div>
                ))}
              </Section>
            )}

            {s.entryExit && <Section title="進入與離開"><div className="text-[11px] text-[var(--text)]">{rich(s.entryExit)}</div></Section>}

            <Section title="玩家看到／聽到">
              {Object.entries(s.seeHear ?? {}).map(([grp, items]) => (
                <div key={grp} className="mb-1">
                  <div className="text-[10px] text-[var(--text-muted)]">{grp}</div>
                  <MarkedList items={items} rich={rich} />
                </div>
              ))}
            </Section>

            <Section title="玩家能做什麼"><MarkedList items={s.canDo} rich={rich} /></Section>

            <Section title="運作中的機制">
              <SimpleTable header={['機制', '意圖檔', '在此情境的角色', '狀態']} statusCol={3}
                rows={(s.mechanisms ?? []).map(m => [m.mechanism, m.intentId ? `[[${m.intentId}]]` : '', m.role, m.marker ?? ''])} rich={rich} />
            </Section>

            {s.pacing?.beats?.length > 0 && (
              <Section title="節奏"><SimpleTable header={s.pacing.header} rows={s.pacing.beats} rich={rich} statusCol={-1} /></Section>
            )}

            {s.story && <Section title="故事與主題"><div className="text-[11px] text-[var(--text)]">{rich(s.story)}</div></Section>}

            <Section title="素材清單">
              <SimpleTable header={['類型', '素材', '狀態', '出處／備註']} statusCol={2}
                rows={(s.assets ?? []).map(a => [a.type, a.asset, a.marker ?? '', a.note])} rich={rich} />
            </Section>

            {s.acceptance && <Section title="驗收畫面"><div className="text-[11px] text-[var(--text)]">{rich(s.acceptance)}</div></Section>}

            {(s.intentLinks?.length > 0 || s.scenarioLinks?.length > 0 || s.memoryLinks?.length > 0 || s.symbolRefs?.length > 0) && (
              <Section title="引用（點跳）">
                <div className="flex flex-wrap gap-1">
                  {(s.intentLinks ?? []).map(l => (
                    <button key={'i:' + l} onClick={() => onJumpToIntent?.(l)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)] hover:border-[var(--gold)]">🧭 {intentTitle(l)}</button>
                  ))}
                  {(s.scenarioLinks ?? []).filter(l => l !== s.id).map(l => (
                    <button key={'s:' + l} onClick={() => setSid(l)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--gold)]/30 text-[var(--gold)]/80 hover:border-[var(--gold)]">🎬 {byId.get(l)?.title ?? l}</button>
                  ))}
                  {(s.memoryLinks ?? []).map(l => (
                    <button key={'m:' + l} onClick={() => onJumpToMemory?.(l)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold)] hover:text-[var(--gold)]">📓 [[{l}]]</button>
                  ))}
                </div>
              </Section>
            )}

            {(s.discussion ?? []).length > 0 && (
              <Section title="討論紀錄">
                {s.discussion.map((d, i) => (
                  <div key={i} className="text-[11px] text-[var(--text)]"><code className="text-[10px] text-[var(--text-muted)] mr-1">{d.date}</code>{rich(d.text)}</div>
                ))}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
