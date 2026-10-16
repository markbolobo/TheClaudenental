// ❓ 提問面板（少爺 2026-10-08「我要TC的Chat也能像是VS Code顯示這些問題還有選項，並且TC此時要多一個陪聊，另闢子進程，
// 讓我快速聚焦，理解討論的內容，我可以選擇是直接操作原本的選項，或是讓陪聊把內容填入其他選項」）
// 左＝仿 VS Code 的 AskUserQuestion：分頁切題、選項直選（1–9）、「其他」＝自由回覆、補充說明、送出（TC 扣著 hook 連線時才送得出）。
// 右＝提問陪聊（獨立的常駐子進程，不是聊天室本身）：提問一出現就自動先講白話重點；少爺請它寫「其他」時，草稿直接填進該題的其他欄，看過再送。
// 伺服器：/api/ask/state｜answer（server/index.js「提問中繼」段）、/api/companion/*（scope 'ask'）；ws：ask_update→tc-ask-update。
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

const DRAFTS_KEY = 'tc_ask_drafts_v1'
const DRAFTS_KEEP = 30
const NAV_BTN = 'w-6 h-6 shrink-0 rounded text-[12px] text-[var(--text-muted)] hover:text-[var(--gold)] hover:bg-white/5'
const COMPANION_STATUS = {
  off:      { label: '未啟動', dot: 'bg-[var(--text-muted)]' },
  idle:     { label: '待命', dot: 'bg-green-400' },
  thinking: { label: '思考中…', dot: 'bg-blue-400 animate-pulse' },
  tool:     { label: '查資料中…', dot: 'bg-purple-400 animate-pulse' },
}

async function postJson(InUrl, InBody) {
  try {
    const _r = await fetch(InUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(InBody ?? {}) })
    return await _r.json()
  } catch { return { ok: false, error: '連不到 TC 伺服器' } }
}

function loadDrafts(InKey) {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}')[InKey]?.byQ ?? {} } catch { return {} }
}
function saveDrafts(InKey, InByQ) {
  try {
    const _all = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}')
    _all[InKey] = { ts: Date.now(), byQ: InByQ }
    const _keys = Object.keys(_all).sort((a, b) => (_all[b].ts ?? 0) - (_all[a].ts ?? 0))
    for (const _k of _keys.slice(DRAFTS_KEEP)) delete _all[_k]
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(_all))
  } catch { /* 無痕視窗 */ }
}

/** 陪聊建議的選項對不對得上：陪聊常把「（建議）」「(Recommended)」字尾省掉（實測），去掉括號註記與空白再比 */
function sameLabel(InA, InB) {
  const _n = (s) => String(s ?? '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '')
  return !!_n(InA) && _n(InA) === _n(InB)
}

/** 這題作答了沒（面板分頁的圓點、送出鈕的題數） */
function isAnswered(InQ, InD) {
  if (!InD) return false
  if (InQ.kind === 'text' || InQ.kind === 'number') return String(InD.other ?? '').trim() !== ''
  if (InD.otherOn && String(InD.other ?? '').trim()) return true
  return InQ.multiSelect ? (InD.picks ?? []).length > 0 : !!InD.pick
}

/** 作答 → /api/ask/answer 的 answers／notes（題目原文為鍵） */
function buildPayload(InQuestions, InByQ) {
  const answers = {}
  const notes = {}
  InQuestions.forEach((q, i) => {
    const d = InByQ[i]
    if (!d) return
    const _other = String(d.other ?? '').trim()
    if (q.kind === 'text' || q.kind === 'number') { if (_other) answers[q.question] = _other }
    else if (q.multiSelect) {
      const _list = [...(d.picks ?? []), ...(d.otherOn && _other ? [_other] : [])]
      if (_list.length) answers[q.question] = _list
    } else if (d.otherOn && _other) answers[q.question] = _other
    else if (d.pick) answers[q.question] = d.pick
    if (String(d.note ?? '').trim()) notes[q.question] = d.note.trim()
  })
  return { answers, notes }
}

function Mark({ on, multi }) {
  return (
    <span className={`mt-0.5 w-4 h-4 ${multi ? 'rounded' : 'rounded-full'} border-2 shrink-0 flex items-center justify-center ${on ? 'border-[var(--gold)]' : 'border-[var(--text-muted)]/50'}`}>
      {on && <span className={`w-2 h-2 ${multi ? 'rounded-sm' : 'rounded-full'} bg-[var(--gold)]`} />}
    </span>
  )
}

function OptionRow({ index, on, multi, label, desc, tag, onPick }) {
  return (
    <div role={multi ? 'checkbox' : 'radio'} aria-checked={on} tabIndex={0} onClick={onPick}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onPick() } }}
      className={`flex items-start gap-3 px-3 py-2 rounded-lg border cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[var(--gold)]/60 ${on ? 'border-[var(--gold)]/60 bg-[var(--gold)]/10' : 'border-transparent hover:bg-white/5'}`}>
      <Mark on={on} multi={multi} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-[var(--text)] leading-snug">
          {label}
          {tag && <span className="ml-1.5 text-[10px] text-sky-300" title={tag.why || undefined}>（{tag.text}）</span>}
        </div>
        {desc && <div className="text-[11px] text-teal-300/80 leading-snug mt-0.5 whitespace-pre-wrap">{desc}</div>}
      </div>
      <span className="text-[9px] text-[var(--text-muted)] shrink-0 mt-0.5">{index}</span>
    </div>
  )
}

/** 對話列裡的 AskUserQuestion 呼叫：顯示成題目卡（取代原本的 JSON 摺疊） */
export function AskToolUseCard({ input }) {
  const _qs = Array.isArray(input?.questions) ? input.questions : []
  return (
    <details className="border border-[var(--gold)]/30 rounded bg-[var(--gold)]/5 px-2 py-1">
      <summary className="text-[10px] text-[var(--gold)] cursor-pointer select-none">
        ❓ 提問 {_qs.length} 題：{_qs.map(q => q.header || String(q.question ?? '').slice(0, 12)).join('／')}
      </summary>
      <div className="mt-1 space-y-1.5">
        {_qs.map((q, i) => (
          <div key={i} className="text-[10px]">
            <div className="text-[var(--text)]">{i + 1}. {q.question}{q.multiSelect ? '（可複選）' : ''}</div>
            {(q.options ?? []).map((o, j) => <div key={j} className="pl-3 text-[var(--text-muted)]">· {o.label}{o.description ? `——${o.description}` : ''}</div>)}
          </div>
        ))}
      </div>
    </details>
  )
}

/** 右欄：提問陪聊（獨立常駐子進程）。InOnState＝陪聊狀態更新時通知左欄（每題重點、代填草稿） */
function AskCompanion({ askKey, qCount, curQ, onState }) {
  const [state, setState] = useState(null)
  const [streaming, setStreaming] = useState(null)
  const [input, setInput] = useState('')
  const [err, setErr] = useState('')
  const keyRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const onStateRef = useRef(onState)
  useEffect(() => { onStateRef.current = onState })

  // 開面板＝開陪聊；提問一出現就自動請它先講白話重點（伺服器只在還沒對話時開場，總設定可關）
  useEffect(() => {
    let _alive = true
    postJson('/api/companion/open', { scope: 'ask', refId: askKey, autoBrief: true }).then(d => {
      if (!_alive) return
      if (d.ok) { keyRef.current = d.key; setState(d.state); onStateRef.current?.(d.state) }
      else setErr(d.error ?? '開啟陪聊失敗（TC 伺服器可能還沒重啟到新版）')
    })
    return () => { _alive = false }
  }, [askKey])

  useEffect(() => {
    const _onUpdate = (e) => {
      if (e.detail?.key !== keyRef.current || !e.detail.state) return
      setState(e.detail.state)
      onStateRef.current?.(e.detail.state)
      setStreaming(s => (s && e.detail.state.messages.some(m => m.id === s.msgId) ? null : s))
    }
    const _onDelta = (e) => {
      if (e.detail?.key !== keyRef.current) return
      setStreaming({ msgId: e.detail.msgId, text: e.detail.text })
    }
    window.addEventListener('tc-companion-update', _onUpdate)
    window.addEventListener('tc-companion-delta', _onDelta)
    return () => {
      window.removeEventListener('tc-companion-update', _onUpdate)
      window.removeEventListener('tc-companion-delta', _onDelta)
    }
  }, [])

  useEffect(() => {
    const _el = listRef.current
    if (_el) _el.scrollTop = _el.scrollHeight
  }, [state?.messages?.length, streaming?.text])

  const send = useCallback(async (InText) => {
    const _t = String(InText ?? '').trim()
    if (!_t || !keyRef.current) return
    setInput('')
    const d = await postJson('/api/companion/say', { key: keyRef.current, text: _t, via: 'text' })
    if (!d.ok) { setErr(d.error ?? '送出失敗'); setInput(_t) }
  }, [])

  const reset = useCallback(async () => {
    if (!keyRef.current || !confirm('清空這段提問陪聊重新開始？（會再自動開場一次）')) return
    await postJson('/api/companion/reset', { key: keyRef.current })
    const d = await postJson('/api/companion/open', { scope: 'ask', refId: askKey, autoBrief: true })
    if (d.ok) setState(d.state)
  }, [askKey])

  const _messages = state?.messages ?? []
  const _status = COMPANION_STATUS[state?.status ?? 'off'] ?? COMPANION_STATUS.off
  const _streamShown = streaming && !_messages.some(m => m.id === streaming.msgId) ? streaming : null
  const _quick = [
    { label: '🔎 白話重講這題', text: `請再用白話講一次第 ${curQ + 1} 題：它在問什麼、每個選項玩家會感受到什麼差別，舉個例子。` },
    { label: '⚖ 你會選哪個', text: `第 ${curQ + 1} 題你會選哪個？理由與代價各一句。` },
  ]
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-2 py-1.5 border-b border-[var(--border)] flex items-center gap-1.5">
        <span className="text-[11px] text-[var(--gold)] font-semibold">🗣 提問陪聊</span>
        <span className="flex items-center gap-1 text-[9px] text-[var(--text-muted)]" title={state?.model ? `模型：${state.model}` : ''}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${_status.dot}`} />{_status.label}
        </span>
        {state?.cost?.turns > 0 && <span className="text-[9px] text-[var(--text-muted)] font-mono" title="這個陪聊自己的進程花費（牌價等價），不含聊天室本身">💲{state.cost.usd.toFixed(3)}</span>}
        <span className="flex-1" />
        <button onClick={reset} title="清空這段陪聊重新開始" className="text-[10px] text-[var(--text-muted)] hover:text-red-400">↺</button>
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {err && <div className="text-[10px] text-amber-300">⚠ {err}</div>}
        {!_messages.length && !_streamShown && !err && (
          <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">陪聊正在讀這幾題與聊天室的脈絡，馬上幫你整理重點…</div>
        )}
        {_messages.map(m => (
          m.role === 'system' ? <div key={m.id} className="text-center text-[9px] text-[var(--text-muted)]">— {m.text} —</div>
          : m.via === 'auto' ? <div key={m.id} className="text-center text-[9px] text-[var(--text-muted)]">— TC 已請陪聊先幫你整理這 {qCount} 題 —</div>
          : (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[92%] rounded px-2 py-1 text-[11px] whitespace-pre-wrap break-words ${m.role === 'user' ? 'bg-[var(--gold)]/15 border border-[var(--gold)]/30' : 'bg-white/5 border border-[var(--border)]'} text-[var(--text)]`}>{m.text}</div>
            </div>
          )
        ))}
        {_streamShown && (
          <div className="flex justify-start">
            <div className="max-w-[92%] rounded px-2 py-1 text-[11px] whitespace-pre-wrap break-words bg-white/5 border border-blue-500/30 text-[var(--text)]">{_streamShown.text || '…'}</div>
          </div>
        )}
      </div>
      <div className="shrink-0 px-2 pt-1 flex flex-wrap gap-1">
        {_quick.map(x => (
          <button key={x.label} onClick={() => send(x.text)} className="text-[9px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50">{x.label}</button>
        ))}
        <button onClick={() => { setInput(`幫我把這個想法寫成第 ${curQ + 1} 題的「其他」回覆：`); setTimeout(() => inputRef.current?.focus(), 0) }}
          title="說出你的想法，陪聊會寫成完整的回覆並直接填進左邊這題的「其他」，你看過再送"
          className="text-[9px] px-1.5 py-0.5 rounded-full border border-sky-500/40 text-sky-300 hover:bg-sky-500/10">✍ 幫我寫進「其他」</button>
      </div>
      <div className="shrink-0 p-2 flex items-end gap-1.5">
        <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input) } }}
          placeholder="問陪聊這幾題在討論什麼，或說出你的想法請它幫你填「其他」"
          className="flex-1 bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1 text-[11px] text-[var(--text)] outline-none resize-none" />
        <button onClick={() => send(input)} disabled={!input.trim()}
          className="shrink-0 px-2 py-1 rounded border border-[var(--gold)]/60 text-[var(--gold)] text-[10px] hover:bg-[var(--gold)]/10 disabled:opacity-40">送出</button>
      </div>
    </div>
  )
}

/** 一次提問的作答面板 */
function AskDeck({ ask }) {
  const questions = useMemo(() => ask.questions ?? [], [ask.questions])
  const [idx, setIdx] = useState(0)
  const [byQ, setByQ] = useState(() => loadDrafts(ask.key))
  const [collapsed, setCollapsed] = useState(false)
  const [showCompanion, setShowCompanion] = useState(true)
  const [leadOpen, setLeadOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [banner, setBanner] = useState(null)
  const [companion, setCompanion] = useState(null)   // 陪聊狀態：focus／drafts
  const [suggest, setSuggest] = useState({})        // 題號 → 陪聊草稿（其他欄已有少爺自己寫的字時，不覆蓋，改成建議）
  const appliedRevRef = useRef({})
  const otherRef = useRef(null)
  const byQRef = useRef(byQ)
  const cur = Math.min(idx, Math.max(0, questions.length - 1))
  const q = questions[cur] ?? null
  const d = byQ[cur] ?? {}

  useEffect(() => { byQRef.current = byQ; saveDrafts(ask.key, byQ) }, [ask.key, byQ])

  const patch = useCallback((InI, InPatch) => setByQ(p => ({ ...p, [InI]: { ...(p[InI] ?? {}), ...InPatch } })), [])

  // 陪聊代填「其他」：其他欄空的、或還是上一次陪聊填的字＝直接填進去並選「其他」；少爺自己改過＝改成建議，按了才換
  const onCompanionState = useCallback((InState) => {
    setCompanion(InState)
    let _jump = null
    for (const _dr of InState?.drafts ?? []) {
      const _i = _dr.q - 1
      const _cur = byQRef.current[_i] ?? {}
      if (Math.max(appliedRevRef.current[_i] ?? 0, _cur.appliedRev ?? 0) >= _dr.rev) continue
      appliedRevRef.current[_i] = _dr.rev
      const _mine = String(_cur.other ?? '').trim() !== '' && _cur.other !== _cur.autoText
      if (_mine) {
        setSuggest(s => ({ ...s, [_i]: _dr.text }))
        patch(_i, { appliedRev: _dr.rev })
      } else patch(_i, { other: _dr.text, autoText: _dr.text, otherOn: true, ...(questions[_i]?.multiSelect ? {} : { pick: null }), appliedRev: _dr.rev })
      _jump = _i
    }
    if (_jump !== null) setIdx(_jump)
  }, [questions, patch])

  const pick = (InLabel) => {
    if (!q) return
    if (q.multiSelect) {
      const _picks = d.picks ?? []
      patch(cur, { picks: _picks.includes(InLabel) ? _picks.filter(x => x !== InLabel) : [..._picks, InLabel] })
    } else patch(cur, { pick: InLabel, otherOn: false })
  }
  const pickOther = () => {
    if (!q) return
    patch(cur, q.multiSelect ? { otherOn: !d.otherOn } : { otherOn: true, pick: null })
    setTimeout(() => otherRef.current?.focus(), 0)
  }
  const go = (InDelta) => { if (questions.length) setIdx((cur + InDelta + questions.length) % questions.length) }
  const answeredCount = questions.filter((x, i) => isAnswered(x, byQ[i])).length

  const submit = async () => {
    if (sending || !answeredCount) return
    if (answeredCount < questions.length && !confirm(`還有 ${questions.length - answeredCount} 題沒答，沒答的會當作「沒有選擇」送出。確定送出嗎？`)) return
    setSending(true)
    setBanner(null)
    const r = await postJson('/api/ask/answer', { key: ask.key, ...buildPayload(questions, byQ) })
    setSending(false)
    if (r.ok) setBanner({ ok: true, text: `✅ 已送出 ${r.answered} 題，VS Code 那邊的提問會自動收掉、聊天室帶著答案繼續` })
    else setBanner({ ok: false, text: `⚠ ${r.error ?? '送出失敗'}` })
  }

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); return }
    if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) || !q) return
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
    else if (/^[1-9]$/.test(e.key) && q.kind === 'choice') {
      const _n = Number(e.key) - 1
      if (_n < q.options.length) pick(q.options[_n].label)
      else if (_n === q.options.length) pickOther()
    }
  }

  const focus = (companion?.focus ?? []).find(f => f.q === cur + 1) ?? null
  const preview = q?.options?.find(o => o.label === d.pick && o.preview)?.preview ?? null
  const otherText = String(d.other ?? '')

  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} className="m-2 rounded-xl border border-[var(--gold)]/45 bg-[var(--surface)] shadow-lg outline-none flex flex-col max-h-[62vh]">
      {/* 標頭：分頁切題（仿 AskUserQuestion 的短標）＋狀態 */}
      <div className="shrink-0 flex items-center gap-0.5 border-b border-[var(--border)] pl-2 pr-1">
        <span className="shrink-0 text-[11px] text-[var(--gold)] font-semibold mr-1" title={ask.title ?? ''}>❓ Claude 在問你</span>
        <div className="flex-1 min-w-0 flex overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          {questions.map((x, i) => (
            <button key={i} onClick={() => setIdx(i)} title={x.question}
              className={`shrink-0 px-2.5 py-2 text-[11px] border-b-2 -mb-px whitespace-nowrap ${i === cur ? 'border-[var(--gold)] text-[var(--gold)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
              <span className="mr-1 text-[9px]">{isAnswered(x, byQ[i]) ? '●' : '○'}</span>{x.header || `第 ${i + 1} 題`}
            </button>
          ))}
        </div>
        <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${ask.answerable ? 'border-green-500/40 text-green-300' : 'border-amber-500/40 text-amber-300'}`}
          title={ask.answerable ? 'TC 扣著這題的 hook 連線，送出就會直接回答 VS Code 分頁' : 'hook 已收掉、TC 重啟過或 hook 還沒送到——可以先看、先跟陪聊討論、先填好，送出要到 VS Code 分頁'}>
          {ask.answerable ? '可從 TC 作答' : '只能看（到 VS Code 作答）'}
        </span>
        <button onClick={() => setShowCompanion(v => !v)} title="提問陪聊：獨立的子進程，幫你快速聚焦這幾題在討論什麼，也能幫你寫「其他」"
          className={`shrink-0 ml-1 text-[10px] px-1.5 py-0.5 rounded border ${showCompanion ? 'border-[var(--gold)]/60 text-[var(--gold)] bg-[var(--gold)]/10' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>🗣 陪聊</button>
        <button onClick={() => go(-1)} title="上一題（←）" className={NAV_BTN}>‹</button>
        <button onClick={() => go(1)} title="下一題（→）" className={NAV_BTN}>›</button>
        <button onClick={() => setCollapsed(v => !v)} title={collapsed ? '展開' : '收合'} className={NAV_BTN}>{collapsed ? '⌃' : '⌄'}</button>
      </div>

      {!collapsed && q && (
        <div className={`flex-1 min-h-0 grid ${showCompanion ? 'md:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
          <div className="min-h-0 overflow-y-auto px-4 pt-3 pb-2 space-y-2.5">
            {ask.lead && (
              <div className="text-[10px] text-[var(--text-muted)]">
                <button onClick={() => setLeadOpen(v => !v)} className="hover:text-[var(--text)]">{leadOpen ? '⌄' : '›'} 聊天室提問前說的話</button>
                {leadOpen && <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] p-2 text-[var(--text)]">{ask.lead}</div>}
              </div>
            )}
            <div className="text-[14px] leading-snug text-[var(--text)]">{q.question}{q.multiSelect && <span className="ml-1 text-[10px] text-[var(--text-muted)]">（可複選）</span>}</div>
            {q.description && <div className="text-[11px] text-[var(--text-muted)]">{q.description}</div>}
            {focus && (focus.gist || focus.why) && (
              <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5 text-[11px] space-y-0.5">
                {focus.gist && <div><span className="text-sky-300">🗣 白話：</span><span className="text-[var(--text)]">{focus.gist}</span></div>}
                {focus.lean && <div><span className="text-sky-300">陪聊會選：</span><span className="text-[var(--text)]">{focus.lean}</span>{focus.why && <span className="text-[var(--text-muted)]">——{focus.why}</span>}</div>}
              </div>
            )}

            {q.kind === 'text' || q.kind === 'number' ? (
              <div className="space-y-1">
                {q.kind === 'number'
                  ? <input type="number" min={q.min} max={q.max} step={q.step ?? 'any'} value={otherText} onChange={e => patch(cur, { other: e.target.value })}
                      placeholder={`${q.min ?? ''} ～ ${q.max ?? ''}${q.unit ? ` ${q.unit}` : ''}`}
                      className="w-40 bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1 text-[12px] text-[var(--text)] outline-none" />
                  : <textarea ref={otherRef} value={otherText} onChange={e => patch(cur, { other: e.target.value })} rows={3} placeholder={q.placeholder ?? '寫下你的回答'}
                      className="w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1.5 text-[11px] text-[var(--text)] outline-none resize-y" />}
              </div>
            ) : (
              <div role={q.multiSelect ? 'group' : 'radiogroup'} className="space-y-0.5">
                {q.options.map((o, i) => (
                  <OptionRow key={o.label} index={i + 1} multi={q.multiSelect}
                    on={q.multiSelect ? (d.picks ?? []).includes(o.label) : (!d.otherOn && d.pick === o.label)}
                    label={o.label} desc={o.description}
                    tag={focus?.lean && sameLabel(focus.lean, o.label) ? { text: '陪聊建議', why: focus.why } : null}
                    onPick={() => pick(o.label)} />
                ))}
                <OptionRow index={q.options.length + 1} multi={q.multiSelect} on={!!d.otherOn} label="其他——寫下你的想法"
                  desc={d.autoText && d.other === d.autoText ? '陪聊已依你的想法填好，看過再送' : '不必從選項挑；也可以請右邊的陪聊幫你寫'} onPick={pickOther} />
              </div>
            )}
            {q.kind === 'choice' && d.otherOn && (
              <textarea ref={otherRef} value={otherText} onChange={e => patch(cur, { other: e.target.value })} rows={3}
                placeholder="例：只有首領能被處決，一般野蠻人直接擊倒；處決演出要短"
                className={`w-full bg-transparent border rounded px-2 py-1.5 text-[11px] text-[var(--text)] outline-none resize-y ${d.autoText && d.other === d.autoText ? 'border-sky-500/50' : 'border-[var(--border)] focus:border-[var(--gold)]/60'}`} />
            )}
            {suggest[cur] && suggest[cur] !== otherText && (
              <div className="rounded border border-sky-500/40 bg-sky-500/5 p-2 text-[11px] space-y-1">
                <div className="text-sky-300 text-[10px]">陪聊寫了一版「其他」（你已自己寫過，所以沒有直接覆蓋）</div>
                <div className="text-[var(--text)] whitespace-pre-wrap">{suggest[cur]}</div>
                <div className="flex gap-2">
                  <button onClick={() => { patch(cur, { other: suggest[cur], autoText: suggest[cur], otherOn: true, pick: q.multiSelect ? d.pick : null }); setSuggest(s => { const n = { ...s }; delete n[cur]; return n }) }}
                    className="text-[10px] px-2 py-0.5 rounded border border-sky-500/50 text-sky-300 hover:bg-sky-500/10">用陪聊這版</button>
                  <button onClick={() => setSuggest(s => { const n = { ...s }; delete n[cur]; return n })} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]">不用</button>
                </div>
              </div>
            )}
            {preview && <pre className="text-[10px] text-[var(--text-muted)] bg-black/20 rounded p-2 overflow-x-auto whitespace-pre-wrap">{preview}</pre>}
            <input value={d.note ?? ''} onChange={e => patch(cur, { note: e.target.value })}
              placeholder="補充說明（選填）——會跟答案一起交給聊天室"
              className="w-full bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1 text-[11px] text-[var(--text)] outline-none" />
          </div>
          {showCompanion && (
            <div className="min-h-[220px] md:min-h-0 border-t md:border-t-0 md:border-l border-[var(--border)]">
              <AskCompanion askKey={ask.key} qCount={questions.length} curQ={cur} onState={onCompanionState} />
            </div>
          )}
        </div>
      )}

      {!collapsed && (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2 flex items-center gap-3 flex-wrap rounded-b-xl bg-black/10">
          <button onClick={submit} disabled={!answeredCount || sending || !ask.answerable}
            title={ask.answerable ? 'Ctrl+Enter' : '這題目前不在 TC 手上，請到 VS Code 分頁作答（TC 重啟後 hook 會重連，恢復後就能從這裡送）'}
            className={`px-4 py-1.5 rounded-lg border text-[12px] ${answeredCount && !sending && ask.answerable ? 'border-[var(--gold)]/70 text-[var(--gold)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20' : 'border-[var(--border)] text-[var(--text-muted)] cursor-not-allowed'}`}>
            {sending ? '送出中…' : `✅ 送出作答（${answeredCount}/${questions.length}）`}
          </button>
          {!ask.answerable && <span className="text-[10px] text-amber-300">這題目前只能在 VS Code 分頁送出；先在這裡想好、跟陪聊討論都可以</span>}
          {banner && <span className={`text-[10px] ${banner.ok ? 'text-emerald-300' : 'text-amber-300'}`}>{banner.text}</span>}
          <span className="flex-1" />
          <span className="text-[9px] text-[var(--text-muted)] hidden md:inline">←→ 換題 · 1–9 選 · Ctrl+Enter 送出</span>
        </div>
      )}
    </div>
  )
}

/** Chat 用：這個聊天室有待答的提問就顯示面板（沒有就不佔位）；剛答完的留一行結果 */
export function AskPanel({ sessionId }) {
  const [asks, setAsks] = useState([])
  const [tick, setTick] = useState(0)
  const [done, setDone] = useState(null)   // 剛答完的那題：留一行結果兩分鐘

  // 換聊天室時父層以 key 重掛，這裡不必清狀態
  useEffect(() => {
    if (!sessionId) return
    let _alive = true
    fetch(`/api/ask/state?session=${encodeURIComponent(sessionId)}`).then(r => r.json())
      .then(d => { if (_alive && d.ok) setAsks(d.asks ?? []) }).catch(() => {})
    return () => { _alive = false }
  }, [sessionId, tick])

  useEffect(() => {
    let _doneTimer = null
    const _onAsk = (e) => {
      const _a = e.detail?.ask
      if (!_a || _a.sessionId !== sessionId) return
      setAsks(prev => [...prev.filter(x => x.key !== _a.key), _a].sort((a, b) => a.ts - b.ts))
      if (_a.status === 'answered') {
        setDone(_a)
        clearTimeout(_doneTimer)
        _doneTimer = setTimeout(() => setDone(null), 2 * 60 * 1000)
      }
    }
    window.addEventListener('tc-ask-update', _onAsk)
    // 分頁先答、TC 沒收到 hook 的情況靠輪詢補（每 15 秒；伺服器端也會比對對話紀錄）
    const _poll = setInterval(() => setTick(t => t + 1), 15000)
    return () => { window.removeEventListener('tc-ask-update', _onAsk); clearInterval(_poll); clearTimeout(_doneTimer); setDone(null) }
  }, [sessionId])

  const active = asks.filter(a => a.status === 'pending').at(-1) ?? null
  if (active) return <AskDeck key={active.key} ask={active} />
  if (!done) return null
  return (
    <div className="m-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-[10px] text-emerald-200">
      ✅ 提問已{done.answeredVia === 'tc' ? '從 TC' : '在 VS Code 分頁'}作答{done.answers ? `：${Object.values(done.answers).map(v => String(v).slice(0, 30)).join('／')}` : ''}
    </div>
  )
}
