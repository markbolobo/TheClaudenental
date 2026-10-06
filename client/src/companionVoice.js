// 陪聊的語音附加層（少爺 2026-10-04「語音功能算是附加的(第二套做法)，不是必備的Workflow」）
// 瀏覽器內建：語音辨識（Edge／Chrome 的 SpeechRecognition）＋朗讀（speechSynthesis），不需金鑰、不另計費。
// ⚠️ 兩者都要安全連線（localhost 或 https）；手機走 Tailscale 的 http 網址時麥克風會被瀏覽器擋下。
import { useState, useEffect, useRef, useCallback } from 'react'

export function getRecognitionCtor() {
  return typeof window === 'undefined' ? null : (window.SpeechRecognition || window.webkitSpeechRecognition || null)
}

/** 這台瀏覽器能不能用語音：{ ok, reason } */
export function voiceSupport() {
  if (typeof window === 'undefined') return { ok: false, reason: '' }
  if (!window.isSecureContext) return { ok: false, reason: '語音需要安全連線（localhost 或 https）；從 Tailscale 網址開時瀏覽器會擋下麥克風' }
  if (!getRecognitionCtor()) return { ok: false, reason: '這個瀏覽器不支援語音辨識（建議 Edge 或 Chrome）' }
  return { ok: true, reason: '' }
}

/** 連續語音辨識：active 期間持續收音、結束自動重啟；最終句交給 onFinal、未定稿交給 onInterim */
export function useRecognition({ active, lang = 'zh-TW', onFinal, onInterim, onSpeechStart }) {
  const recRef = useRef(null)
  const activeRef = useRef(active)
  const cbRef = useRef({ onFinal, onInterim, onSpeechStart })
  useEffect(() => { cbRef.current = { onFinal, onInterim, onSpeechStart } })
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    activeRef.current = active
    const Ctor = getRecognitionCtor()
    if (!active || !Ctor) return undefined
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onstart = () => { setListening(true); setError('') }
    rec.onspeechstart = () => cbRef.current.onSpeechStart?.()
    rec.onresult = (InEv) => {
      let _interim = ''
      for (let i = InEv.resultIndex; i < InEv.results.length; i++) {
        const _r = InEv.results[i]
        if (_r.isFinal) {
          const _t = _r[0]?.transcript?.trim()
          if (_t) cbRef.current.onFinal?.(_t)
        } else _interim += _r[0]?.transcript ?? ''
      }
      cbRef.current.onInterim?.(_interim)
      if (_interim) cbRef.current.onSpeechStart?.()
    }
    rec.onerror = (InEv) => {
      if (InEv.error === 'not-allowed' || InEv.error === 'service-not-allowed') {
        activeRef.current = false
        setError('麥克風權限被拒——請在瀏覽器網址列允許麥克風後再開一次')
      } else if (InEv.error !== 'no-speech' && InEv.error !== 'aborted') setError(`語音辨識錯誤：${InEv.error}`)
    }
    rec.onend = () => {
      setListening(false)
      // 瀏覽器會在靜默或一段時間後自己結束 → 還在收音狀態就稍等重開（避免錯誤時連續重啟）
      if (activeRef.current && recRef.current === rec) setTimeout(() => {
        if (activeRef.current && recRef.current === rec) { try { rec.start() } catch { /* 已在收音 */ } }
      }, 300)
    }
    recRef.current = rec
    try { rec.start() } catch { /* 已在收音 */ }
    return () => {
      recRef.current = null
      try { rec.abort() } catch { /* 已停止 */ }
    }
  }, [active, lang])

  return { listening: listening && !!active, error }
}

/** 朗讀：挑繁中語音（優先 Edge 的自然語音），佇列播放；cancel＝立即停（插話打斷用） */
export function useSpeaker({ enabled, rate = 1.05 }) {
  const [speaking, setSpeaking] = useState(false)
  const pendingRef = useRef(0)
  const voiceRef = useRef(null)

  useEffect(() => {
    const _synth = typeof window !== 'undefined' ? window.speechSynthesis : null
    if (!_synth) return undefined
    const _pick = () => {
      const _vs = _synth.getVoices?.() ?? []
      voiceRef.current = _vs.find(v => /zh-TW/i.test(v.lang) && /Natural|Online/i.test(v.name))
        ?? _vs.find(v => /zh-TW/i.test(v.lang))
        ?? _vs.find(v => /^zh/i.test(v.lang))
        ?? null
    }
    _pick()
    _synth.addEventListener?.('voiceschanged', _pick)
    return () => _synth.removeEventListener?.('voiceschanged', _pick)
  }, [])

  const cancel = useCallback(() => {
    try { window.speechSynthesis?.cancel() } catch { /* 無朗讀 */ }
    pendingRef.current = 0
    setSpeaking(false)
  }, [])

  const speak = useCallback((InText) => {
    const _text = String(InText ?? '').trim()
    if (!enabled || !_text || typeof window === 'undefined' || !window.speechSynthesis) return
    const _u = new SpeechSynthesisUtterance(_text)
    if (voiceRef.current) _u.voice = voiceRef.current
    _u.lang = voiceRef.current?.lang ?? 'zh-TW'
    _u.rate = rate
    pendingRef.current += 1
    setSpeaking(true)
    const _done = () => {
      pendingRef.current = Math.max(0, pendingRef.current - 1)
      if (!pendingRef.current) setSpeaking(false)
    }
    _u.onend = _done
    _u.onerror = _done
    window.speechSynthesis.speak(_u)
  }, [enabled, rate])

  return { speak, cancel, speaking }
}

/** 串流中可以先念的部分：回傳 [要念的句子, 新的已念位置]（以句末標點切） */
export function takeSpeakable(InText, InFrom) {
  const _text = String(InText ?? '')
  const _rest = _text.slice(InFrom)
  let _cut = -1
  for (let i = _rest.length - 1; i >= 0; i--) {
    if ('。！？!?；;\n'.includes(_rest[i])) { _cut = i; break }
  }
  if (_cut < 0) return ['', InFrom]
  return [_rest.slice(0, _cut + 1), InFrom + _cut + 1]
}

/** 交付口令（程式判定，不交給模型——口頭說「好」不算同意） */
export const HANDOFF_RE = /^(好[的啊吧]?[，,\s]*)?(確認)?(交付|開始實作|送出去)(吧|囉|喔)?[。！!.．]*$/
export const DISMISS_RE = /^(再想想|先不要|等一下)[。！!.．]*$/
