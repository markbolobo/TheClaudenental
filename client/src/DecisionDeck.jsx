import { useEffect, useMemo, useRef, useState } from 'react'
import { useModelOptions, EFFORT_OPTIONS } from './modelOptions.js'
import { confirmIfLiveInteractive, fetchLiveInteractiveIds } from './liveSessionGuard.js'
import { loadDecisionDrafts, saveDecisionDrafts, isDraftAnswered, relationsOf } from './decisionSupport.js'

// ⬜ 待定奪面板（少爺 2026-09-29「待我定奪的項目都照 VS Code 這樣（原生的方式）」）
// 仿 Claude Code 的 AskUserQuestion：上方分頁切題、選項＝標題＋說明、數字鍵直選、「其他」＝自由回覆想法。
// 每題「💬 進一步說明」＝原文脈絡＋Claude 讀原檔與牽動檔整理的白話說明（server 快取，題目內容變了才重算）。
// 送出＝server 把決定寫回原 md（harness 層）＋建待辦卡＋派子任務（資料維護＋後續實作，實作走 QA 閘門）。
// API：/api/decisions/state｜explain｜submit（server/index.js「待定奪面板」段）；非元件共用在 decisionSupport.js。

const plain = (t) => <span className="whitespace-pre-wrap">{t}</span>
const shortChip = (t) => { const s = String(t ?? '').replace(/[`*]/g, '').trim(); return s.length > 12 ? `${s.slice(0, 12)}…` : s }
const fmtTime = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// 原文「建議」欄的理由（只對應同一個選項）
const recommendReasonOf = (d, key) => (d.recommend?.key === key ? d.recommend.reason : '') ?? ''
const NAV_BTN = 'w-6 h-6 shrink-0 rounded text-[12px] text-[var(--text-muted)] hover:text-[var(--gold)] hover:bg-white/5'
const SMALL_SELECT = 'bg-transparent border border-[var(--border)] rounded px-1 py-0.5 text-[10px] text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold)]/60'

function Radio({ on }) {
  return (
    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? 'border-[var(--gold)]' : 'border-[var(--text-muted)]/50'}`}>
      {on && <span className="w-2 h-2 rounded-full bg-[var(--gold)]" />}
    </span>
  )
}

// rec＝{ tag, reason }：原文標的建議＝「建議」、進一步說明裡 Claude 的建議＝「Claude 建議」
function OptionRow({ index, on, label, desc, extra, rec = null, onPick }) {
  return (
    <div role="radio" aria-checked={on} tabIndex={0} onClick={onPick}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onPick() } }}
      className={`flex items-start gap-3 px-3 py-2 rounded-lg border cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[var(--gold)]/60 ${on ? 'border-[var(--gold)]/60 bg-[var(--gold)]/10' : 'border-transparent hover:bg-white/5'}`}>
      <Radio on={on} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-[var(--text)] leading-snug">
          {label}
          {rec && <span className="ml-1.5 text-[10px] text-[var(--gold)]" title={rec.reason || undefined}>（{rec.tag}）</span>}
        </div>
        {desc && <div className="text-[11px] text-teal-300/80 leading-snug mt-0.5">{desc}</div>}
        {extra}
      </div>
      <span className="text-[9px] text-[var(--text-muted)] shrink-0 mt-0.5">{index}</span>
    </div>
  )
}

function Sec({ icon, title, children }) {
  return (
    <div>
      <div className="text-[10px] text-sky-300/80 mb-0.5">{icon} {title}</div>
      <div className="text-[var(--text)] leading-relaxed">{children}</div>
    </div>
  )
}

// 💬 進一步說明：上半＝條目原文脈絡（即時），下半＝Claude 整理的完整情境（按需產生、server 快取）
function ExplainPanel({ d, exp, busy, err, onRequest, rich }) {
  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-[11px]">
      {d.reason && <div><span className="text-[var(--text-muted)]">要你定的原因：</span>{rich(d.reason)}</div>}
      {d.affects && <div><span className="text-[var(--text-muted)]">牽動：</span>{rich(d.affects)}</div>}
      {d.optionsNote && <div><span className="text-[var(--text-muted)]">附帶：</span>{rich(d.optionsNote)}</div>}
      <div className={(d.reason || d.affects || d.optionsNote) ? 'border-t border-sky-500/20 pt-2' : ''}>
        {busy ? (
          <div className="text-sky-300/90 animate-pulse">⏳ Claude 正在讀原檔與牽動的機制、情境，整理完整情境與脈絡（約 30–60 秒）…</div>
        ) : err ? (
          <div className="text-red-300">⚠ {err} <button onClick={() => onRequest(false)} className="ml-1 underline">再試一次</button></div>
        ) : !exp ? (
          <button onClick={() => onRequest(false)} className="px-2 py-1 rounded border border-sky-500/40 text-sky-300 hover:bg-sky-500/10">✨ 讓 Claude 整理這題的完整情境與脈絡</button>
        ) : (
          <div className="space-y-2">
            {exp.stale && <div className="text-amber-300/90">這題在說明產生後改過了 <button onClick={() => onRequest(true)} className="underline">↻ 重新說明</button></div>}
            {exp.scene && <Sec icon="🎬" title="玩家此刻的情境">{rich(exp.scene)}</Sec>}
            {exp.question && <Sec icon="❓" title="這題白話在問">{rich(exp.question)}</Sec>}
            {exp.whyNow && <Sec icon="⏳" title="為什麼現在要你定">{rich(exp.whyNow)}</Sec>}
            {exp.options?.length > 0 && (
              <Sec icon="⚖" title="各選項的後果">
                {exp.options.map(o => (
                  <div key={o.key} className="mt-1">
                    <div><b>{o.key}. {o.label}</b>{exp.recommend?.key === o.key && <span className="ml-1 text-[10px] text-[var(--gold)]">（Claude 建議）</span>}</div>
                    {o.experience && <div className="text-teal-300/85">🎮 {rich(o.experience)}</div>}
                    {o.cost && <div className="text-[var(--text-muted)]">🛠 {rich(o.cost)}</div>}
                    {o.risk && <div className="text-amber-300/80">⚠ {rich(o.risk)}</div>}
                  </div>
                ))}
              </Sec>
            )}
            {exp.recommend && (
              <Sec icon="💡" title={`Claude 建議 ${exp.recommend.key}`}>{rich(exp.recommend.reason)}<span className="text-[var(--text-muted)]">（只是建議，決定權在你）</span></Sec>
            )}
            {exp.context?.length > 0 && <Sec icon="🧭" title="相關脈絡"><ul className="list-disc pl-4 space-y-0.5">{exp.context.map((c, i) => <li key={i}>{rich(c)}</li>)}</ul></Sec>}
            {exp.glossary?.length > 0 && (
              <Sec icon="📖" title="術語">{exp.glossary.map((g, i) => <div key={i}><b>{g.term}</b>：{g.meaning}</div>)}</Sec>
            )}
            <div className="text-[9px] text-[var(--text-muted)] flex items-center gap-2">
              <span>{exp.model} · {fmtTime(exp.generatedAt)}{exp.ms ? ` · ${Math.round(exp.ms / 1000)} 秒` : ''}</span>
              <button onClick={() => onRequest(true)} className="hover:text-sky-300">↻ 重新說明</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// 🧾 原文：條目在 md 裡的欄位原樣
function RawPanel({ d, rich }) {
  const rows = [['現況', d.status], ['要你定的原因', d.reason], ['選項', d.options], ['建議', d.recommend ? `${d.recommend.key}${d.recommend.reason ? `（${d.recommend.reason}）` : ''}` : ''], ['牽動', d.affects], ['提出', d.raised]]
  return (
    <div className="rounded-lg border border-[var(--border)] p-2.5 space-y-0.5 text-[10px]">
      {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><span className="text-[var(--text-muted)]">{k}：</span>{rich(v)}</div>)}
    </div>
  )
}

// 連動題 chip：○ 未定／✓ 你定的／🧩 推導定
function RelChips({ nodes, onJump }) {
  return nodes.map(n => (
    <button key={n.key} onClick={() => onJump(n)}
      title={`${n.sourceTitle} · ${n.openId} ${n.question}${n.resolved ? `\n${n.resolvedBy === 'derived' ? '推導定' : '已定'}：${n.resolution}` : ''}`}
      className={`text-[10px] px-1.5 py-0.5 rounded border ${n.resolved ? 'border-emerald-500/40 text-emerald-300/90' : 'border-[var(--border)] text-[var(--text)] hover:border-[var(--gold)]/60'}`}>
      {n.resolved ? (n.resolvedBy === 'derived' ? '🧩' : '✓') : '○'} {n.layer === 'intent' ? '🧭' : '🎬'} {shortChip(n.question)}
    </button>
  ))
}

/** 🧩 數獨推導：開子任務把整張待定奪盤面當數獨解（消去已有答案的題／合併重複／縮小選項／找關鍵意圖），結果寫成可推翻的推導定 */
export function SudokuSolveButton({ projectId, onGoToChat = null }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const run = async () => {
    if (busy) return
    if (!window.confirm('🧩 數獨推導：開一個子任務把全部待定奪當數獨解——消去已被其他定案、品味或現況回答的題、合併重複題、縮小選項、找出關鍵意圖。\n結果寫成「推導定」並附依據，你可以逐筆同意或推翻。要開始嗎？')) return
    setBusy(true)
    setRes(null)
    const _pref = (k) => { try { return localStorage.getItem(k) || null } catch { return null } }
    try {
      const r = await fetch('/api/decisions/solve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, dispatch: { target: 'new', model: _pref('tc_decision_model'), effort: _pref('tc_decision_effort') } }),
      }).then(x => x.json())
      setRes(r)
    } catch (e) { setRes({ ok: false, error: String(e) }) }
    finally { setBusy(false) }
  }
  return (
    <span className="inline-flex items-center gap-2 shrink-0">
      <button onClick={run} disabled={busy} title="定一題會連帶回答、縮小或消去其他題；有時只缺少數幾個關鍵意圖——讓 Claude 先把能推的推完"
        className="text-[10px] px-2 py-0.5 rounded border border-sky-500/40 text-sky-300 hover:bg-sky-500/10">{busy ? '派工中…' : '🧩 數獨推導'}</button>
      {res && (res.ok && res.dispatched
        ? <span className="text-[10px] text-emerald-300">已派子任務（{res.card?.title ?? '待辦卡'}）{onGoToChat && <button onClick={() => onGoToChat({ sessionId: null, projectPath: res.projectRoot || null })} className="underline ml-1">到 Chat 看</button>}</span>
        : <span className="text-[10px] text-amber-300">⚠ {res.error ?? res.dispatchError ?? '派工失敗'}</span>)}
    </span>
  )
}

/** 🧩 推導定待確認：Claude 依其他定案／品味／現況推出的答案，逐筆同意（改成你定的）或推翻（回到待定奪重答） */
export function DerivedReview({ items, projectId, rich = plain, onJumpToSource = null }) {
  const [hidden, setHidden] = useState(() => new Set())
  const [seenItems, setSeenItems] = useState(items)
  if (items !== seenItems) { setSeenItems(items); setHidden(new Set()) }
  // 筆數多時預設收合：下方的定奪面板（🔑 關鍵意圖在最前）才是主要動線
  const [open, setOpen] = useState(() => items.length <= 3)
  const [rejectFor, setRejectFor] = useState(null)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const list = items.filter(x => !hidden.has(x.key))
  if (!list.length && !msg) return null
  const review = async (InArr, InAction, InText = '') => {
    setBusy(true)
    setMsg('')
    try {
      const r = await fetch('/api/decisions/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, items: InArr.map(x => ({ key: x.key, layer: x.layer, file: x.file, openId: x.d.id, action: InAction, text: InText })) }),
      }).then(res => res.json())
      const _ok = new Set((r.results ?? []).filter(x => x.ok).map(x => x.key))
      const _bad = (r.results ?? []).filter(x => !x.ok)
      setHidden(h => new Set([...h, ..._ok]))
      setMsg(_bad.length ? `⚠ ${_bad.map(b => b.error).join('；')}`
        : InAction === 'confirm' ? `✅ 已確認 ${_ok.size} 筆（改成你定的，依據保留）` : '↩ 已推翻：這題回到待定奪，重新作答即可')
      setRejectFor(null)
      setWhy('')
    } catch (e) { setMsg(String(e)) }
    finally { setBusy(false) }
  }
  return (
    <div className="rounded-xl border border-sky-500/35 bg-sky-500/5">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen(v => !v)} className="text-[11px] text-sky-300 text-left">{open ? '⌄' : '›'} 🧩 Claude 依脈絡推出答案、待你確認 <b>{list.length}</b> 筆</button>
        <span className="flex-1" />
        {list.length > 1 && <button disabled={busy} onClick={() => review(list, 'confirm')} className="text-[10px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">✓ 全部同意</button>}
      </div>
      {open && (
        <div className="px-3 pb-2 space-y-1.5">
          <div className="text-[10px] text-[var(--text-muted)]">遊戲環環相扣：這些題已被其他定案、你的品味或專案現況回答，所以不再當成待定奪問你。同意＝改成你定的；推翻＝回到待定奪重新作答。</div>
          {list.map(x => (
            <div key={x.key} className="rounded border border-sky-500/20 px-2 py-1.5 text-[11px] space-y-0.5">
              <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--text-muted)]">
                <button onClick={() => onJumpToSource?.(x)} className="text-[var(--gold)]/80 hover:text-[var(--gold)]">{x.layer === 'intent' ? '🧭' : '🎬'} {x.sourceTitle}</button>
                <span className="px-1 rounded bg-sky-500/20 text-sky-300">{x.d.id}</span>
                {x.d.resolvedAt && <span>推導於 {x.d.resolvedAt}</span>}
              </div>
              <div className="text-[var(--text)]">{rich(x.d.question ?? x.d.title)}</div>
              <div className="text-emerald-300/90">⇒ {rich(x.d.resolution)}</div>
              {x.d.basis && <div className="text-[10px] text-[var(--text-muted)]">依據：{rich(x.d.basis)}</div>}
              {rejectFor === x.key ? (
                <div className="flex items-center gap-1.5">
                  <input autoFocus value={why} onChange={e => setWhy(e.target.value)} placeholder="哪裡不對（選填，會記在題目下）"
                    className="flex-1 bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-0.5 text-[10px] text-[var(--text)] outline-none" />
                  <button disabled={busy} onClick={() => review([x], 'reject', why)} className="text-[10px] px-2 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10">確定推翻</button>
                  <button onClick={() => setRejectFor(null)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">取消</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button disabled={busy} onClick={() => review([x], 'confirm')} className="text-[10px] px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">✓ 同意</button>
                  <button onClick={() => { setRejectFor(x.key); setWhy('') }} className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-300 hover:border-red-500/40">✗ 推翻…</button>
                </div>
              )}
            </div>
          ))}
          {msg && <div className="text-[10px] text-sky-200">{msg}</div>}
        </div>
      )}
    </div>
  )
}

/** 待定奪兩種檢視切換：🗳 定奪面板（預設）／📋 清單（舊的全欄位清單，保留） */
export function DecisionViewToggle({ view, onChange }) {
  const _btn = (v, label) => (
    <button onClick={() => onChange(v)}
      className={`px-2 py-0.5 ${view === v ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>{label}</button>
  )
  return <div className="inline-flex rounded border border-[var(--border)] overflow-hidden text-[10px] shrink-0">{_btn('deck', '🗳 定奪面板')}{_btn('list', '📋 清單')}</div>
}

export function DecisionDeck({ items, projectId, rich = plain, onJumpToSource = null, onGoToChat = null, onReload = null, showSource = true }) {
  const MODEL_OPTIONS = useModelOptions()
  const [idx, setIdx] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [drafts, setDrafts] = useState(loadDecisionDrafts)
  // 送出後、侍酒師刷新前的樂觀狀態（key → { kind, text }）：選項定奪先藏起來、回覆先顯示在對話串；新資料一到就歸零
  const [sent, setSent] = useState({})
  const [seenItems, setSeenItems] = useState(items)
  if (items !== seenItems) { setSeenItems(items); setSent({}) }
  const [deckState, setDeckState] = useState({ explanations: {}, dispatches: {}, explainModel: '' })
  const [reloadTick, setReloadTick] = useState(0)
  const [explainOpen, setExplainOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [busy, setBusy] = useState({})
  const [errs, setErrs] = useState({})
  const [sending, setSending] = useState(false)
  const [banner, setBanner] = useState(null)
  const [dispatchOn, setDispatchOn] = useState(true)
  const [qaForImpl, setQaForImpl] = useState(true)
  const [target, setTarget] = useState('new')
  const [targetSid, setTargetSid] = useState('')
  const [sessions, setSessions] = useState([])
  const [liveIds, setLiveIds] = useState(() => new Set())
  const [model, setModel] = useState(() => localStorage.getItem('tc_decision_model') ?? '')
  const [effort, setEffort] = useState(() => localStorage.getItem('tc_decision_effort') ?? '')
  const stripRef = useRef(null)
  const replyRef = useRef(null)

  useEffect(() => { saveDecisionDrafts(drafts) }, [drafts])
  useEffect(() => { try { localStorage.setItem('tc_decision_model', model) } catch { /* 無痕視窗 */ } }, [model])
  useEffect(() => { try { localStorage.setItem('tc_decision_effort', effort) } catch { /* 無痕視窗 */ } }, [effort])

  // 面板狀態（說明快取＋每題最近派出的子任務）：開啟時抓一次；子任務綁定／侍酒師刷新時重抓
  useEffect(() => {
    if (!projectId) return
    let alive = true
    fetch(`/api/decisions/state/${projectId}`).then(r => r.json())
      .then(d => { if (alive && d.ok) setDeckState({ explanations: d.explanations ?? {}, dispatches: d.dispatches ?? {}, explainModel: d.explainModel ?? '', graph: d.graph ?? null }) })
      .catch(() => {})
    return () => { alive = false }
  }, [projectId, reloadTick])
  useEffect(() => {
    const onEvt = (e) => { if (!e.detail?.projectId || e.detail.projectId === projectId) setReloadTick(t => t + 1) }
    window.addEventListener('tc-decision-dispatch-update', onEvt)
    window.addEventListener('tc-sommelier-refreshed', onEvt)
    return () => {
      window.removeEventListener('tc-decision-dispatch-update', onEvt)
      window.removeEventListener('tc-sommelier-refreshed', onEvt)
    }
  }, [projectId])

  // 數獨盤面（server 從 md 的引用／取決於／解鎖建出）：🔑 關鍵意圖排最前（答了能推一群），⛓ 取決於未定上游的排最後
  const graph = deckState.graph
  const rel = (key) => relationsOf(graph, key)
  const visible = useMemo(() => {
    const _rank = (x) => { const r = relationsOf(graph, x.key); return r.downOpen.length ? 0 : r.upOpen.length ? 2 : 1 }
    return items.filter(x => sent[x.key]?.kind !== 'choose')
      .map((x, i) => ({ x, i, r: _rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map(o => o.x)
  }, [items, sent, graph])
  const cur = visible[Math.min(idx, Math.max(0, visible.length - 1))] ?? null
  const curIdx = cur ? visible.indexOf(cur) : 0
  useEffect(() => {
    stripRef.current?.querySelector(`[data-idx="${curIdx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [curIdx])

  const choicesOf = (it) => {
    if (it.d.choices?.length) return it.d.choices
    // 原文沒列選項：用「進一步說明」整理出的方案當選項
    return (deckState.explanations[it.key]?.options ?? []).map(o => ({ key: o.key, label: o.label, text: o.label, desc: '', derived: true }))
  }
  const exp = cur ? deckState.explanations[cur.key] ?? null : null
  const expOpt = (k) => exp?.options?.find(o => o.key === k) ?? null
  const choices = cur ? choicesOf(cur) : []
  const draft = cur ? drafts[cur.key] ?? null : null
  const answeredItems = visible.filter(x => !sent[x.key] && isDraftAnswered(drafts[x.key]))
  const disp = cur ? deckState.dispatches[cur.key] ?? null : null
  const lastDispatchSid = Object.values(deckState.dispatches).filter(x => x.sessionId).sort((a, b) => b.ts - a.ts)[0]?.sessionId ?? null

  const patchDraft = (key, patch) => setDrafts(p => ({ ...p, [key]: { ...(p[key] ?? {}), ...patch, ts: Date.now() } }))
  const clearDraft = (key) => setDrafts(p => { const n = { ...p }; delete n[key]; return n })
  const go = (delta) => { if (visible.length) setIdx((curIdx + delta + visible.length) % visible.length) }
  const pick = (c) => { if (cur) patchDraft(cur.key, { kind: 'choose', choiceKey: c.key }) }
  const pickOther = () => {
    if (!cur) return
    patchDraft(cur.key, { kind: 'reply' })
    setTimeout(() => replyRef.current?.focus(), 0)
  }

  const requestExplain = async (it, force) => {
    if (!it || busy[it.key]) return
    setBusy(b => ({ ...b, [it.key]: true }))
    setErrs(m => ({ ...m, [it.key]: null }))
    try {
      const r = await fetch('/api/decisions/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, layer: it.layer, sourceId: it.sourceId, file: it.file, openId: it.d.id, force: !!force }),
      }).then(res => res.json())
      if (r.ok) setDeckState(s => ({ ...s, explanations: { ...s.explanations, [it.key]: r.explanation } }))
      else setErrs(m => ({ ...m, [it.key]: r.error ?? '說明產生失敗' }))
    } catch (e) { setErrs(m => ({ ...m, [it.key]: String(e) })) }
    finally { setBusy(b => { const n = { ...b }; delete n[it.key]; return n }) }
  }
  const toggleExplain = () => {
    const _next = !explainOpen
    setExplainOpen(_next)
    if (_next && cur && (!exp || exp.stale)) requestExplain(cur, false)
  }

  const chooseTarget = async (v) => {
    setTarget(v)
    if (v !== 'session' || sessions.length) return
    const [h, live] = await Promise.all([fetch('/api/history').then(r => r.json()).catch(() => null), fetchLiveInteractiveIds()])
    setSessions((h?.sessions ?? []).slice(0, 30))
    setLiveIds(live)
  }

  const submit = async () => {
    if (!answeredItems.length || sending) return
    if (dispatchOn && target === 'session') {
      if (!targetSid) { setBanner({ ok: false, error: '先選要送入的聊天室' }); return }
      // 目標分頁的監看活著＝原地聯動投遞（不會雙寫）；沒掛才需要「活分頁無頭送入」的警示
      const _alive = await fetch(`/api/qa/monitor-status?session=${targetSid}`).then(r => r.json()).then(d => !!d.alive).catch(() => false)
      if (!_alive && !(await confirmIfLiveInteractive(targetSid, '送入'))) return
    }
    setSending(true)
    setBanner(null)
    const answers = answeredItems.map(it => {
      const dr = drafts[it.key]
      const base = { key: it.key, layer: it.layer, sourceId: it.sourceId, sourceTitle: it.sourceTitle, file: it.file, openId: it.d.id, title: it.d.title }
      if (dr.kind === 'choose') {
        const c = choicesOf(it).find(x => x.key === dr.choiceKey)
        return { ...base, kind: 'choose', choiceKey: dr.choiceKey, choiceText: c?.text || c?.label || '', note: dr.note ?? '' }
      }
      return { ...base, kind: 'reply', text: dr.text }
    })
    try {
      const r = await fetch('/api/decisions/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, answers, dispatch: { enabled: dispatchOn, target, sessionId: target === 'session' ? targetSid : null, model: model || null, effort: effort || null, qaForImpl } }),
      }).then(res => res.json())
      const _okKeys = new Set((r.results ?? []).filter(x => x.ok).map(x => x.key))
      const _bad = (r.results ?? []).filter(x => !x.ok)
      if (_okKeys.size) {
        setSent(s => { const n = { ...s }; for (const a of answers) if (_okKeys.has(a.key)) n[a.key] = { kind: a.kind, text: a.text ?? '' }; return n })
        setDrafts(p => { const n = { ...p }; for (const k of _okKeys) delete n[k]; return n })
      }
      setBanner({
        ok: !!r.ok && !_bad.length && !r.dispatchError, written: r.written ?? 0, dispatched: !!r.dispatched, card: r.card ?? null,
        run: r.run ?? null, projectRoot: r.projectRoot ?? '', firstKey: answers.find(a => _okKeys.has(a.key))?.key ?? null,
        errors: _bad.map(b => `${b.openId}（${b.file}）：${b.error}`), stale: _bad.some(b => b.stale),
        error: r.ok ? (r.dispatchError ?? null) : (r.error ?? '送出失敗'),
      })
    } catch (e) { setBanner({ ok: false, error: String(e) }) }
    finally { setSending(false) }
  }

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); return }
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
    else if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1
      if (n < choices.length) pick(choices[n])
      else if (n === choices.length) pickOther()
    } else if (e.key === 'e' || e.key === 'E') toggleExplain()
  }

  const dotOf = (it) => (sent[it.key]?.kind === 'reply' || it.d.awaiting === 'claude') ? '⏳'
    : isDraftAnswered(drafts[it.key]) ? '●'
    : it.d.thread?.at(-1)?.who === 'claude' ? '💬' : '○'
  const keyMarkOf = (it) => { const r = rel(it.key); return r.downOpen.length ? '🔑' : r.upOpen.length ? '⛓' : '' }
  // 連動題 chip：在本面板裡就切過去，不在就跳到它所在的頁面
  const jumpTo = (InNode) => {
    const _i = visible.findIndex(x => x.key === InNode.key)
    if (_i >= 0) setIdx(_i)
    else onJumpToSource?.(InNode)
  }
  const curRel = cur ? rel(cur.key) : null
  const thread = cur ? [...(cur.d.thread ?? []), ...(sent[cur.key]?.kind === 'reply' ? [{ who: 'owner', at: '剛剛', text: sent[cur.key].text }] : [])] : []
  const awaitingClaude = !!cur && (cur.d.awaiting === 'claude' || sent[cur.key]?.kind === 'reply')
  const goChat = (InSid) => onGoToChat?.({ sessionId: InSid ?? null, projectPath: banner?.projectRoot || 'C:/Project/RomanPrototype' })

  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} className="rounded-xl border border-[var(--gold)]/35 bg-[var(--surface)] shadow-lg outline-none">
      {/* 分頁列：每題一個短標（仿 AskUserQuestion 的 header chip）；● 已答 ⏳ 等 Claude 💬 Claude 追問了 ○ 未答 */}
      <div className="flex items-center gap-0.5 border-b border-[var(--border)] pl-2 pr-1">
        <div ref={stripRef} className="flex-1 min-w-0 flex overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          {visible.map((it, i) => (
            <button key={it.key} data-idx={i} onClick={() => setIdx(i)} title={`${it.sourceTitle} · ${it.d.id} ${it.d.question ?? it.d.title}`}
              className={`shrink-0 px-2.5 py-2 text-[11px] border-b-2 -mb-px whitespace-nowrap ${i === curIdx ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              <span className="mr-1 text-[9px]">{dotOf(it)}</span>{keyMarkOf(it) && <span className="mr-0.5">{keyMarkOf(it)}</span>}{shortChip(it.d.question ?? it.d.title)}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--text-muted)] shrink-0 px-1">{visible.length ? `${curIdx + 1} / ${visible.length}` : '0 / 0'}</span>
        <button onClick={() => go(-1)} title="上一題（←）" className={NAV_BTN}>‹</button>
        <button onClick={() => go(1)} title="下一題（→）" className={NAV_BTN}>›</button>
        {onReload && <button onClick={onReload} title="重新整理題目（重抓侍酒師資料）" className={NAV_BTN}>↻</button>}
        <button onClick={() => setCollapsed(v => !v)} title={collapsed ? '展開' : '收合'} className={NAV_BTN}>{collapsed ? '⌃' : '⌄'}</button>
      </div>

      {!collapsed && (cur ? (
        <div className="px-4 pt-3 pb-2 space-y-3">
          <div className="flex items-center gap-2 flex-wrap text-[10px] text-[var(--text-muted)]">
            {showSource && (onJumpToSource
              ? <button onClick={() => onJumpToSource(cur)} className="text-[var(--gold)]/80 hover:text-[var(--gold)]" title="到這題所在的頁面">{cur.layer === 'intent' ? '🧭' : '🎬'} {cur.sourceTitle}</button>
              : <span>{cur.layer === 'intent' ? '🧭' : '🎬'} {cur.sourceTitle}</span>)}
            <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300">{cur.d.id}</span>
            {cur.d.raised && <span>提出 {cur.d.raised}</span>}
            {disp && (
              <button onClick={() => goChat(disp.sessionId)} title={disp.cardId ? `待辦卡 ${disp.cardId}` : undefined}
                className={`px-1.5 py-0.5 rounded border ${disp.running ? 'border-sky-500/50 text-sky-300 animate-pulse' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)]'}`}>
                🛠 子任務{disp.running ? '處理中' : '已派出'} · {fmtTime(disp.ts)}
              </button>
            )}
          </div>

          <div className="text-[15px] leading-snug text-[var(--text)]">{rich(cur.d.question ?? cur.d.title)}</div>
          {cur.d.status && <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">現況：{rich(cur.d.status)}</div>}

          {/* 🧩 數獨盤面：關鍵意圖／取決於／連動題／推導縮小 */}
          {curRel?.down.length > 0 && (
            <div className="rounded-lg border border-[var(--gold)]/40 bg-[var(--gold)]/5 px-2.5 py-1.5 text-[11px] space-y-1">
              <div className="text-[var(--gold)]">🔑 關鍵意圖——答了這題，下面 {curRel.downOpen.length} 題可望直接推導出來（不必再一題一題問）</div>
              <div className="flex flex-wrap gap-1"><RelChips nodes={curRel.down} onJump={jumpTo} /></div>
            </div>
          )}
          {curRel?.upOpen.length > 0 && (
            <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 px-2.5 py-1.5 text-[11px] space-y-1">
              <div className="text-violet-300">⛓ 取決於上游關鍵題——先答那題，這題多半能自動推導；想直接答也可以</div>
              <div className="flex flex-wrap gap-1"><RelChips nodes={curRel.upOpen} onJump={jumpTo} /></div>
            </div>
          )}
          {curRel?.refs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
              <span className="text-[var(--text-muted)]">🧩 連動題</span><RelChips nodes={curRel.refs} onJump={jumpTo} />
            </div>
          )}
          {cur.d.notes?.length > 0 && (
            <div className="space-y-0.5">
              {cur.d.notes.map((n, i) => <div key={i} className="text-[10px] text-sky-300/85">🧩 推導：{rich(n)}</div>)}
            </div>
          )}

          {/* 對話串：你的回覆 ↔ Claude 的說明／追問（md 裡的 **少爺回覆**／**Claude 回覆** 子項） */}
          {thread.length > 0 && (
            <div className="space-y-1">
              {thread.map((t, i) => (
                <div key={i} className={`text-[11px] rounded-lg px-2.5 py-1.5 max-w-[88%] border ${t.who === 'owner' ? 'ml-auto bg-[var(--gold)]/10 border-[var(--gold)]/30' : 'bg-sky-500/10 border-sky-500/30'}`}>
                  <div className="text-[9px] text-[var(--text-muted)] mb-0.5">{t.who === 'owner' ? '你' : 'Claude'}{t.at ? ` · ${t.at}` : ''}</div>
                  <div className="text-[var(--text)]">{rich(t.text)}</div>
                </div>
              ))}
              {awaitingClaude && <div className="text-[10px] text-amber-300/80">⏳ 你的回覆已送出，等 Claude 子任務處理——處理完會直接定案，或在這裡回覆／追問你</div>}
            </div>
          )}

          <div role="radiogroup" className="space-y-0.5">
            {choices.map((c, i) => {
              const _exp = explainOpen ? expOpt(c.key) : null
              const _claudeRec = explainOpen && exp?.recommend?.key === c.key ? exp.recommend.reason : null
              const _rec = c.recommended ? { tag: '建議', reason: _claudeRec ?? recommendReasonOf(cur.d, c.key) }
                : _claudeRec !== null ? { tag: 'Claude 建議', reason: _claudeRec } : null
              return (
                <OptionRow key={c.key} index={i + 1} on={draft?.kind === 'choose' && draft.choiceKey === c.key}
                  label={<><span className="text-[var(--text-muted)] mr-1">{c.key}.</span>{rich(c.label)}</>}
                  desc={c.desc ? rich(c.desc) : null}
                  extra={_exp?.experience ? <div className="text-[10px] text-sky-300/80 mt-0.5">🎮 {rich(_exp.experience)}</div> : null}
                  rec={_rec} onPick={() => pick(c)} />
              )
            })}
            {choices.length === 0 && (
              <div className="text-[10px] text-[var(--text-muted)] px-3 py-1">這題沒有列選項——按「💬 進一步說明」讓 Claude 整理可選方案，或直接在「其他」寫下你的想法。</div>
            )}
            <OptionRow index={choices.length + 1} on={draft?.kind === 'reply'} label="其他——寫下你的想法"
              desc="不必從選項挑；送出後 Claude 會判斷能不能直接定案，不夠就在這題下回覆或追問你" onPick={pickOther} />
          </div>
          {draft?.kind === 'reply' && (
            <textarea ref={replyRef} value={draft.text ?? ''} onChange={e => patchDraft(cur.key, { text: e.target.value })} rows={3}
              placeholder="例：我想要軟壓力，但不要看得到的倒數；巡邏隊先只在樹林地圖出現"
              className="w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1.5 text-[11px] text-[var(--text)] outline-none resize-y" />
          )}
          {draft?.kind === 'choose' && (
            <input value={draft.note ?? ''} onChange={e => patchDraft(cur.key, { note: e.target.value })}
              placeholder="補充說明（選填）——會一起寫進定案"
              className="w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1 text-[11px] text-[var(--text)] outline-none" />
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={toggleExplain} title="E"
              className={`text-[11px] px-2.5 py-1 rounded border ${explainOpen ? 'border-sky-500/60 text-sky-300 bg-sky-500/10' : 'border-sky-500/30 text-sky-300/80 hover:bg-sky-500/10'}`}>
              💬 進一步說明{exp && !exp.stale ? ' ✓' : ''}
            </button>
            <button onClick={() => setRawOpen(v => !v)}
              className={`text-[11px] px-2.5 py-1 rounded border ${rawOpen ? 'border-[var(--gold)]/50 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>🧾 原文</button>
            {draft && <button onClick={() => clearDraft(cur.key)} className="text-[10px] text-[var(--text-muted)] hover:text-red-300">清除作答</button>}
          </div>
          {explainOpen && <ExplainPanel d={cur.d} exp={exp} busy={!!busy[cur.key]} err={errs[cur.key]} onRequest={(force) => requestExplain(cur, force)} rich={rich} />}
          {rawOpen && <RawPanel d={cur.d} rich={rich} />}
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-[11px] text-[var(--text-muted)]">這裡的待定奪都答完了 🎉</div>
      ))}

      {!collapsed && (
        <div className="border-t border-[var(--border)] px-4 py-2.5 space-y-2 rounded-b-xl bg-black/10">
          <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[10px] text-[var(--text-muted)]">
            <label className="flex items-center gap-1 cursor-pointer select-none" title="TC 先把決定寫回原檔；勾選時再開一個 Claude 子任務做後續：落成不變量／情境標記、牽動檔同步、機檢、需要時實作">
              <input type="checkbox" checked={dispatchOn} onChange={e => setDispatchOn(e.target.checked)} className="accent-[var(--gold)] w-3 h-3" />
              送出後派子任務處理後續（資料維護＋實作）
            </label>
            {dispatchOn && (
              <>
                <label className="flex items-center gap-1 cursor-pointer select-none" title="有實作的項目開 Mode C QA Run、計畫等你確認才編譯；沒勾＝實作前先在聊天室回報計畫">
                  <input type="checkbox" checked={qaForImpl} onChange={e => setQaForImpl(e.target.checked)} className="accent-[var(--gold)] w-3 h-3" />
                  🧪 實作走 QA
                </label>
                <select value={target} onChange={e => chooseTarget(e.target.value)} className={SMALL_SELECT} title="子任務在哪個聊天室處理">
                  <option value="new">➕ 開新聊天室</option>
                  <option value="session">📨 送入既有聊天室…</option>
                </select>
                {target === 'session' && (
                  <select value={targetSid} onChange={e => setTargetSid(e.target.value)} className={`${SMALL_SELECT} max-w-[260px]`}>
                    <option value="">— 選聊天室 —</option>
                    {lastDispatchSid && <option value={lastDispatchSid}>🛠 上一個定奪子任務（{lastDispatchSid.slice(0, 8)}）</option>}
                    {sessions.filter(s => s.sessionId !== lastDispatchSid).map(s => (
                      <option key={s.sessionId} value={s.sessionId}>{liveIds.has(s.sessionId) ? '🟢 ' : ''}{String(s.title ?? s.sessionId).slice(0, 40)}</option>
                    ))}
                  </select>
                )}
                <select value={model} onChange={e => setModel(e.target.value)} className={SMALL_SELECT} title="子任務使用的 AI 模型">
                  {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value} title={o.title} disabled={o.disabled}>{o.label}</option>)}
                </select>
                <select value={effort} onChange={e => setEffort(e.target.value)} className={SMALL_SELECT} title="模型強度">
                  {EFFORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={submit} disabled={!answeredItems.length || sending}
              className={`px-4 py-1.5 rounded-lg border text-[12px] ${answeredItems.length && !sending ? 'border-[var(--gold)]/70 text-[var(--gold)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20' : 'border-[var(--border)] text-[var(--text-muted)] cursor-not-allowed'}`}>
              {sending ? '送出中…' : `✅ 送出 ${answeredItems.length} 筆定奪`}
            </button>
            <span className="text-[10px] text-[var(--text-muted)]">已答 {answeredItems.length} / {visible.length}</span>
            <span className="flex-1" />
            <span className="text-[9px] text-[var(--text-muted)] hidden md:inline">←→ 換題 · 1–9 選 · E 說明 · Ctrl+Enter 送出</span>
          </div>
          {banner && (
            <div className={`text-[11px] rounded px-2.5 py-1.5 border space-y-0.5 ${banner.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-100'}`}>
              {banner.written > 0 && (
                <div>✅ 已寫回 {banner.written} 筆到原檔{banner.dispatched ? `，子任務已派出${banner.card ? `（待辦卡「${banner.card.title}」）` : ''}` : '（沒有派子任務）'}；侍酒師正在重新萃取。</div>
              )}
              {banner.errors?.map((e, i) => <div key={i}>⚠ {e}</div>)}
              {banner.error && <div>⚠ {banner.error}</div>}
              <div className="flex gap-3">
                {banner.dispatched && onGoToChat && (
                  <button onClick={() => goChat(banner.run?.sessionId ?? deckState.dispatches[banner.firstKey]?.sessionId ?? null)} className="underline">👀 到 Chat 看子任務</button>
                )}
                {banner.stale && onReload && <button onClick={onReload} className="underline">↻ 重新整理題目</button>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
