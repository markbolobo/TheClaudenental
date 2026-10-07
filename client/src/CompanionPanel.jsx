// 🗣 陪聊面板（少爺 2026-10-04）——QA run 與侍酒師共用
// 「QA Run 中有個按鈕(對應不同的QA)，會讓TC有個陪聊功能(陪我腦力激盪)，會將我的想法整理並實作，也會即時回應我」
// 「仕酒師負責的是更前期的部分(加入購物車…我可以知道你將我哪些想法加入購物車)」
// 「語音功能算是附加的(第二套做法)…原本的文字互動依舊保留」
// 文字為本：輸入框永遠可用；🎙 語音＝附加層（外放：朗讀時暫停收音／耳機：全雙工、開口即打斷朗讀）。
// 伺服器端：/api/companion/*（server/index.js「陪聊」段）；ws：companion_update／companion_delta（App 轉成 window 事件）。
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRecognition, useSpeaker, voiceSupport, takeSpeakable, HANDOFF_RE, DISMISS_RE } from './companionVoice.js'

const STATUS_META = {
  off:      { label: '未啟動', dot: 'bg-[var(--text-muted)]' },
  starting: { label: '啟動中…', dot: 'bg-amber-400 animate-pulse' },
  idle:     { label: '待命', dot: 'bg-green-400' },
  thinking: { label: '思考中…', dot: 'bg-blue-400 animate-pulse' },
  tool:     { label: '查資料中…', dot: 'bg-purple-400 animate-pulse' },
}
const IDEA_META = {
  draft:     { label: '草稿', cls: 'text-[var(--text-muted)] border-[var(--border)]' },
  confirmed: { label: '已確認', cls: 'text-green-400 border-green-500/40' },
  carted:    { label: '已入車', cls: 'text-[var(--gold)] border-[var(--gold)]/50' },
  handed:    { label: '已交付', cls: 'text-blue-400 border-blue-500/40' },
}
const VOICE_MODES = [
  { value: 'off', label: '🎙 語音：關' },
  { value: 'speaker', label: '🎙 外放（朗讀時暫停收音）' },
  { value: 'duplex', label: '🎧 耳機（全雙工、可插話）' },
]

async function postJson(InUrl, InBody) {
  try {
    const _r = await fetch(InUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(InBody ?? {}) })
    return await _r.json()
  } catch { return { ok: false, error: '連不到 TC 伺服器' } }
}

/**
 * @param scope 'qa' | 'som'
 * @param refId QA run id 或侍酒師專案 id
 * @param cartKeyOf 侍酒師用：(companionKey, ideaId) → 購物車條目 key（判斷是否還在購物車）
 * @param cartKeys 侍酒師用：目前購物車的 key 集合
 * @param onCartToggle 侍酒師用：(companionKey, entry, putBack) → 從面板放回／拿掉陪聊想法
 * @param refInfo 侍酒師用：(ref) → { icon, title, inCart } | null（目錄條目在購物車的狀態）
 * @param onRefToggle 侍酒師用：(companionKey, ref, putBack) → 從面板放回／拿掉目錄條目
 * @param onStateLoaded 侍酒師用：開面板拿到狀態時呼叫（補回漏接的購物車選件）
 * @param onGoToCart 侍酒師用：轉跳購物車（接著開新聊天室）
 */
export function CompanionPanel({ scope, refId, subtitle = '', onClose, cartKeyOf = null, cartKeys = null, onCartToggle = null,
  refInfo = null, onRefToggle = null, onStateLoaded = null, cartCount = 0, onGoToCart = null }) {
  const [state, setState] = useState(null)
  const [streaming, setStreaming] = useState(null)   // { msgId, text }
  const [input, setInput] = useState('')
  const [notice, setNotice] = useState('')
  const [voiceMode, setVoiceMode] = useState(() => localStorage.getItem('tc_companion_voice_mode') || 'off')
  const [ttsOn, setTtsOn] = useState(() => localStorage.getItem('tc_companion_tts') !== '0')
  const [interim, setInterim] = useState('')
  const [editId, setEditId] = useState(null)
  const [editText, setEditText] = useState('')
  const [newIdea, setNewIdea] = useState('')
  const keyRef = useRef(null)
  const listRef = useRef(null)
  const spokenRef = useRef({ msgId: null, upTo: 0 })
  const streamingRef = useRef(null)
  const openedAtRef = useRef(0)   // 開面板的時間：之前的訊息不朗讀（開面板 effect 內設定）
  const onStateLoadedRef = useRef(onStateLoaded)
  useEffect(() => { onStateLoadedRef.current = onStateLoaded })

  useEffect(() => { try { localStorage.setItem('tc_companion_voice_mode', voiceMode) } catch { /* 無痕模式 */ } }, [voiceMode])
  useEffect(() => { try { localStorage.setItem('tc_companion_tts', ttsOn ? '1' : '0') } catch { /* 無痕模式 */ } }, [ttsOn])

  const flash = useCallback((InMsg, InMs = 4000) => {
    setNotice(InMsg)
    setTimeout(() => setNotice(n => (n === InMsg ? '' : n)), InMs)
  }, [])

  const { speak, cancel, speaking } = useSpeaker({ enabled: ttsOn })

  // 開面板：建立／取回陪聊並預熱常駐進程（換對象時父層以 key 重掛本元件，狀態自然歸零）
  useEffect(() => {
    let _alive = true
    openedAtRef.current = Date.now()
    postJson('/api/companion/open', { scope, refId }).then(d => {
      if (!_alive) return
      if (d.ok) { keyRef.current = d.key; setState(d.state); onStateLoadedRef.current?.(d.state) }
      else flash(d.error ?? '開啟陪聊失敗（TC 伺服器可能還沒重啟到新版）', 8000)
    })
    return () => { _alive = false }
  }, [scope, refId, flash])

  // ws：整體狀態＋串流文字；串流中先念完整的句子，回合結束念剩下的
  useEffect(() => {
    const _onUpdate = (e) => {
      if (e.detail?.key !== keyRef.current || !e.detail.state) return
      const _st = e.detail.state
      setState(_st)
      const _s = streamingRef.current
      const _final = _s ? _st.messages.find(m => m.id === _s.msgId) : null
      if (!_final) return
      if (spokenRef.current.msgId === _s.msgId && _final.ts >= openedAtRef.current) {
        const _rest = _final.text.slice(spokenRef.current.upTo)
        if (_rest.trim()) speak(_rest)
      }
      spokenRef.current = { msgId: null, upTo: 0 }
      streamingRef.current = null
      setStreaming(null)
    }
    const _onDelta = (e) => {
      if (e.detail?.key !== keyRef.current) return
      const { msgId, text } = e.detail
      streamingRef.current = { msgId, text }
      setStreaming({ msgId, text })
      if (spokenRef.current.msgId !== msgId) spokenRef.current = { msgId, upTo: 0 }
      const [_say, _upTo] = takeSpeakable(text, spokenRef.current.upTo)
      if (_say.trim()) { speak(_say); spokenRef.current.upTo = _upTo }
    }
    window.addEventListener('tc-companion-update', _onUpdate)
    window.addEventListener('tc-companion-delta', _onDelta)
    return () => {
      window.removeEventListener('tc-companion-update', _onUpdate)
      window.removeEventListener('tc-companion-delta', _onDelta)
    }
  }, [speak])

  // 新訊息自動捲到底
  useEffect(() => {
    const _el = listRef.current
    if (_el) _el.scrollTop = _el.scrollHeight
  }, [state?.messages?.length, streaming?.text])

  const handoff = useCallback(async (InVia = 'button') => {
    if (!keyRef.current) return
    const d = await postJson('/api/companion/handoff', { key: keyRef.current, via: InVia })
    if (d.ok) { flash('📤 已交付給實作聊天室——它會先列計畫，請到 QA 分頁審查', 6000); speak('已交付給實作聊天室。') }
    else flash(d.error ?? '交付失敗', 6000)
  }, [flash, speak])

  const dismissHandoff = useCallback(() => {
    if (keyRef.current) postJson('/api/companion/dismiss-handoff', { key: keyRef.current })
  }, [])

  const send = useCallback(async (InText, InVia = 'text') => {
    const _t = String(InText ?? '').trim()
    if (!_t || !keyRef.current) return
    // 交付／擱置只認固定口令（程式判定）；提議交付時才生效
    if (state?.pendingHandoff && HANDOFF_RE.test(_t)) { setInput(''); await handoff(InVia); return }
    if (state?.pendingHandoff && DISMISS_RE.test(_t)) { setInput(''); dismissHandoff(); return }
    if (InVia === 'text') setInput('')
    const d = await postJson('/api/companion/say', { key: keyRef.current, text: _t, via: InVia })
    if (!d.ok) flash(d.error ?? '送出失敗', 6000)
  }, [state?.pendingHandoff, handoff, dismissHandoff, flash])

  // 語音附加層：外放模式朗讀時暫停收音（防回音）；耳機模式開口即打斷朗讀
  const _support = voiceSupport()
  const _voiceOn = voiceMode !== 'off' && _support.ok
  const { listening, error: voiceError } = useRecognition({
    active: _voiceOn && !(voiceMode === 'speaker' && speaking),
    onFinal: (InText) => { setInterim(''); send(InText, 'voice') },
    onInterim: setInterim,
    onSpeechStart: () => { if (voiceMode === 'duplex' && speaking) cancel() },
  })

  const boardOp = useCallback((InOp, InId, InText) => {
    if (keyRef.current) postJson('/api/companion/board', { key: keyRef.current, op: InOp, id: InId, text: InText })
  }, [])

  const reset = useCallback(async () => {
    if (!keyRef.current || !confirm('清空這段陪聊（對話與想法板）重新開始？')) return
    cancel()
    await postJson('/api/companion/reset', { key: keyRef.current })
  }, [cancel])

  // Esc 關閉
  useEffect(() => {
    const _onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', _onKey)
    return () => window.removeEventListener('keydown', _onKey)
  }, [onClose])

  // 關面板時停朗讀
  useEffect(() => () => { try { window.speechSynthesis?.cancel() } catch { /* 無朗讀 */ } }, [])

  const _status = STATUS_META[state?.status ?? 'off'] ?? STATUS_META.off
  const _messages = state?.messages ?? []
  const _ideas = (state?.ideas ?? []).filter(i => i.status !== 'handed')
  const _handed = (state?.ideas ?? []).filter(i => i.status === 'handed')
  const _cartLog = (state?.cartLog ?? []).filter(c => !c.checkedOut)
  const _cartRefs = (state?.cartRefs ?? []).filter(c => !c.checkedOut)
  const _checkedOutCount = [...(state?.cartLog ?? []), ...(state?.cartRefs ?? [])].filter(c => c.checkedOut).length
  const _contextRefs = state?.contextRefs ?? []
  const _streamingShown = streaming && !_messages.some(m => m.id === streaming.msgId) ? streaming : null

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex justify-end" onClick={onClose}>
      <div className="w-[780px] max-w-[96vw] h-full bg-[var(--surface)] border-l border-[var(--gold)]/30 shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* 標頭 */}
        <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 flex-wrap">
          <span className="text-[var(--gold)] text-xs font-semibold">🗣 陪聊</span>
          <span className="text-[11px] text-[var(--text)] truncate max-w-[280px]" title={state?.title ?? ''}>{state?.title ?? subtitle}</span>
          <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]" title={state?.model ? `模型：${state.model}` : ''}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${_status.dot}`} />{_status.label}
          </span>
          <div className="flex-1" />
          {onGoToCart && (
            <button onClick={onGoToCart} title="轉跳購物車——檢查選件、寫描述，接著按「➕ 開新聊天室」"
              className={`text-[10px] px-2 py-0.5 rounded border ${cartCount ? 'border-[var(--gold)]/70 text-[var(--gold)] bg-[var(--gold)]/10' : 'border-[var(--border)] text-[var(--text-muted)]'} hover:bg-[var(--gold)]/20`}>
              🛒 前往購物車{cartCount ? `（${cartCount}）` : ''} →
            </button>
          )}
          <select value={voiceMode} onChange={e => { setVoiceMode(e.target.value); setInterim('') }}
            title={_support.ok ? '語音（附加的第二套做法）：外放＝朗讀時暫停收音防回音；耳機＝全雙工，開口就能打斷朗讀' : _support.reason}
            className="bg-transparent border border-[var(--border)] rounded px-1 py-0.5 text-[10px] text-[var(--text)]">
            {VOICE_MODES.map(o => <option key={o.value} value={o.value} disabled={o.value !== 'off' && !_support.ok}>{o.label}</option>)}
          </select>
          <button onClick={() => { if (ttsOn) cancel(); setTtsOn(v => !v) }} title="朗讀陪聊的回覆"
            className={`text-[10px] px-1.5 py-0.5 rounded border ${ttsOn ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
            {ttsOn ? '🔈 朗讀' : '🔇 不朗讀'}
          </button>
          <button onClick={reset} title="清空這段陪聊重新開始"
            className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-red-400">↺</button>
          <button onClick={onClose} title="關閉（Esc）——陪聊會保留，閒置一段時間後自動休息"
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">✕</button>
        </div>
        {(notice || voiceError || (voiceMode !== 'off' && !_support.ok)) && (
          <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--gold)] bg-[var(--gold)]/10 border-b border-[var(--gold)]/20">
            {notice || voiceError || _support.reason}
          </div>
        )}

        <div className="flex-1 flex min-h-0">
          {/* 對話 */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
              {!_messages.length && !_streamingShown && (
                <div className="text-[11px] text-[var(--text-muted)] text-center mt-8 leading-relaxed">
                  {scope === 'qa'
                    ? <>說說你對這個 QA 的想法——我會邊聊邊整理到右邊的想法板，<br />你確認後按「📤 交付實作」或說「交付」，就送進綁定的聊天室動工。</>
                    : <>說說你的議題——我會邊查侍酒師的設計脈絡與情境邊跟你對齊，<br />把議題和相關條目放進購物車（跟你手動 🛒 加入的一樣），右邊看得到放了哪些；<br />聊完按「🛒 前往購物車」接著開新聊天室。</>}
                </div>
              )}
              {_messages.map(m => (
                m.role === 'system'
                  ? <div key={m.id} className="text-center text-[10px] text-[var(--text-muted)]">— {m.text} —</div>
                  : (
                    <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded px-2.5 py-1.5 text-[12px] whitespace-pre-wrap break-words ${
                        m.role === 'user' ? 'bg-[var(--gold)]/15 text-[var(--text)] border border-[var(--gold)]/30' : 'bg-white/5 text-[var(--text)] border border-[var(--border)]'}`}>
                        {m.via === 'voice' && <span className="text-[9px] text-[var(--text-muted)] mr-1">🎙</span>}
                        {m.text}
                      </div>
                    </div>
                  )
              ))}
              {_streamingShown && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded px-2.5 py-1.5 text-[12px] whitespace-pre-wrap break-words bg-white/5 text-[var(--text)] border border-blue-500/30">
                    {_streamingShown.text || '…'}
                  </div>
                </div>
              )}
            </div>
            {/* 語音收音中的未定稿文字 */}
            {_voiceOn && (
              <div className="shrink-0 px-3 py-1 text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${listening ? 'bg-red-400 animate-pulse' : 'bg-[var(--text-muted)]'}`} />
                {listening ? (interim ? <span className="text-[var(--text)]">{interim}</span> : '聆聽中…') : (speaking && voiceMode === 'speaker' ? '朗讀中（暫停收音）…' : '麥克風待機')}
              </div>
            )}
            {/* 文字輸入（永遠可用） */}
            <div className="shrink-0 p-2 border-t border-[var(--border)] flex items-end gap-2">
              <textarea value={input} onChange={e => setInput(e.target.value)} rows={2}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input) } }}
                placeholder="打字也可以——Enter 送出、Shift+Enter 換行"
                className="flex-1 bg-transparent border border-[var(--border)] focus:border-[var(--gold)]/60 rounded px-2 py-1.5 text-[12px] text-[var(--text)] outline-none resize-none" />
              <button onClick={() => send(input)} disabled={!input.trim()}
                className="shrink-0 px-3 py-1.5 rounded border border-[var(--gold)]/60 text-[var(--gold)] text-[11px] hover:bg-[var(--gold)]/10 disabled:opacity-40">送出</button>
            </div>
          </div>

          {/* 想法板 */}
          <div className="w-64 shrink-0 border-l border-[var(--border)] flex flex-col min-h-0">
            <div className="shrink-0 px-3 py-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)] border-b border-[var(--border)]">
              💡 想法板（{_ideas.length}）
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {/* QA：陪聊提議交付 */}
              {scope === 'qa' && state?.pendingHandoff && (
                <div className="rounded border border-amber-400/50 bg-amber-400/5 p-2 space-y-1.5">
                  <div className="text-[10px] text-amber-300">陪聊提議交付——按下或說「交付」才會送出</div>
                  <div className="text-[10px] text-[var(--text)] whitespace-pre-wrap max-h-32 overflow-y-auto">{state.pendingHandoff.summary}</div>
                  <div className="flex gap-1">
                    <button onClick={() => handoff('button')}
                      className="flex-1 py-1 rounded border border-green-500/50 text-green-400 text-[10px] hover:bg-green-500/10">📤 交付實作</button>
                    <button onClick={dismissHandoff}
                      className="px-2 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] text-[10px] hover:text-[var(--text)]">再想想</button>
                  </div>
                </div>
              )}
              {!_ideas.length && <div className="text-[10px] text-[var(--text-muted)]">還沒有想法——聊著聊著就會長出來。</div>}
              {_ideas.map(i => {
                const _meta = IDEA_META[i.status] ?? IDEA_META.draft
                return (
                  <div key={i.id} className="rounded border border-[var(--border)] px-2 py-1.5 group">
                    {editId === i.id ? (
                      <div className="space-y-1">
                        <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3}
                          className="w-full bg-transparent border border-[var(--border)] rounded px-1 py-0.5 text-[11px] text-[var(--text)] outline-none" />
                        <div className="flex gap-1">
                          <button onClick={() => { boardOp('edit', i.id, editText); setEditId(null) }} className="text-[9px] text-green-400">儲存</button>
                          <button onClick={() => setEditId(null)} className="text-[9px] text-[var(--text-muted)]">取消</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-[11px] text-[var(--text)] break-words">{i.text}</div>
                        <div className="flex items-center gap-1 mt-1">
                          <span className={`text-[9px] px-1 rounded border ${_meta.cls}`}>{_meta.label}</span>
                          <div className="flex-1" />
                          {i.status === 'draft' && scope === 'qa' && (
                            <button onClick={() => boardOp('confirm', i.id)} title="確認這個想法" className="text-[9px] text-[var(--text-muted)] hover:text-green-400 opacity-0 group-hover:opacity-100">✓</button>
                          )}
                          <button onClick={() => { setEditId(i.id); setEditText(i.text) }} title="改字" className="text-[9px] text-[var(--text-muted)] hover:text-[var(--gold)] opacity-0 group-hover:opacity-100">✎</button>
                          <button onClick={() => boardOp('remove', i.id)} title="刪掉" className="text-[9px] text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100">✕</button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
              <div className="flex gap-1">
                <input value={newIdea} onChange={e => setNewIdea(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && newIdea.trim()) { boardOp('add', null, newIdea); setNewIdea('') } }}
                  placeholder="自己加一條…" className="flex-1 min-w-0 bg-transparent border border-[var(--border)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text)] outline-none" />
              </div>

              {/* 侍酒師：放進購物車的清單（看得到加了哪些、可拿掉／放回） */}
              {scope === 'som' && (
                <div className="pt-2 mt-2 border-t border-[var(--border)] space-y-1">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--gold)]/80">🛒 我放進購物車的（{_cartLog.filter(c => !c.removed).length + _cartRefs.filter(c => !c.removed).length}）</div>
                  {!_cartLog.length && !_cartRefs.length && <div className="text-[10px] text-[var(--text-muted)]">還沒有——聊到議題時，我會查侍酒師的脈絡與情境，把議題和相關條目放進去並告訴你。</div>}
                  {/* 目錄條目：與手動 🛒 加入相同的選件（設計脈絡／情境／符號／藍圖／拼圖／架構節點） */}
                  {_cartRefs.map(c => {
                    const _info = refInfo?.(c.ref)
                    const _inCart = !!_info?.inCart
                    return (
                      <div key={c.ref} className={`rounded border px-2 py-1 ${_inCart ? 'border-[var(--gold)]/40' : 'border-[var(--border)] opacity-60'}`}>
                        <div className="text-[10px] text-[var(--text)] break-words">{_info?.icon ?? c.icon ?? '·'} {_info?.title ?? c.title}</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-[9px] text-[var(--text-muted)]">{!_info ? '侍酒師資料裡找不到（可能已改名）' : _inCart ? '✓ 在購物車' : '已拿掉'}</span>
                          <div className="flex-1" />
                          {onRefToggle && _info && (
                            <button onClick={() => onRefToggle(state?.key, c.ref, !_inCart)}
                              className={`text-[9px] ${_inCart ? 'text-[var(--text-muted)] hover:text-red-400' : 'text-[var(--gold)] hover:underline'}`}>
                              {_inCart ? '拿掉' : '＋放回'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {_cartLog.map(c => {
                    const _inCart = !!(cartKeyOf && cartKeys?.has(cartKeyOf(state?.key, c.id)))
                    return (
                      <div key={c.id} className={`rounded border px-2 py-1 ${_inCart ? 'border-[var(--gold)]/40' : 'border-[var(--border)] opacity-60'}`}>
                        <div className="text-[10px] text-[var(--text)] break-words">{c.text}</div>
                        {c.anchors?.length > 0 && <div className="text-[9px] text-[var(--text-muted)] truncate">相關：{c.anchors.join('、')}</div>}
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-[9px] text-[var(--text-muted)]">{_inCart ? '✓ 在購物車' : '已拿掉'}</span>
                          <div className="flex-1" />
                          {onCartToggle && (
                            <button onClick={() => onCartToggle(state?.key, c, !_inCart)}
                              className={`text-[9px] ${_inCart ? 'text-[var(--text-muted)] hover:text-red-400' : 'text-[var(--gold)] hover:underline'}`}>
                              {_inCart ? '拿掉' : '＋放回'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {_checkedOutCount > 0 && <div className="text-[9px] text-[var(--text-muted)]">（另有 {_checkedOutCount} 項已結帳帶去聊天室）</div>}
                </div>
              )}

              {/* QA：陪聊查到的相關脈絡（交付時一併附給實作聊天室） */}
              {scope === 'qa' && _contextRefs.length > 0 && (
                <div className="pt-2 mt-2 border-t border-[var(--border)] space-y-1">
                  <div className="text-[10px] uppercase tracking-widest text-[var(--gold)]/80">🔗 相關脈絡（交付時附上）</div>
                  {_contextRefs.map(r => <div key={r.ref} className="text-[10px] text-[var(--text-muted)] break-words" title={r.ref}>{r.icon ?? '·'} {r.title}</div>)}
                </div>
              )}

              {/* QA：已交付紀錄 */}
              {scope === 'qa' && _handed.length > 0 && (
                <div className="pt-2 mt-2 border-t border-[var(--border)] space-y-1">
                  <div className="text-[10px] uppercase tracking-widest text-blue-400/80">📤 已交付（{_handed.length}）</div>
                  {_handed.map(i => <div key={i.id} className="text-[10px] text-[var(--text-muted)] break-words">· {i.text}</div>)}
                </div>
              )}
            </div>
            {scope === 'som' && onGoToCart && (
              <div className="shrink-0 p-2 border-t border-[var(--border)]">
                <button onClick={onGoToCart}
                  className="w-full py-1.5 rounded border border-green-500/50 text-green-400 text-[11px] hover:bg-green-500/10">
                  🛒 前往購物車{cartCount ? `（${cartCount}）` : ''} → 開新聊天室
                </button>
              </div>
            )}
            {scope === 'qa' && (
              <div className="shrink-0 p-2 border-t border-[var(--border)]">
                <button onClick={() => { if (confirm(`把想法板上 ${_ideas.length} 個想法交付給實作聊天室？（它會先列計畫給你審）`)) handoff('button') }}
                  disabled={!_ideas.length && !state?.pendingHandoff}
                  className="w-full py-1.5 rounded border border-green-500/50 text-green-400 text-[11px] hover:bg-green-500/10 disabled:opacity-40">
                  📤 交付實作
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
