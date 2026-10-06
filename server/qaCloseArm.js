// 預約結案：少爺表態要結案、但 run 還沒到「已完成」時先記下來，run 一進「已完成」就由 server 代按 ✔ 結案。
//
// 少爺 2026-10-05「如果我說 QA 進入{或是按下}結案，Run 進入已完成的狀態，就會自動補上（替我手按），讓 QA Run 進入已結案」。
// 本模組只放純判斷（留言是不是在表態結案、哪些狀態轉換讓預約作廢），狀態異動與喚醒在 index.js，機檢在 qaCloseArm.check.mjs。

// 否定：「先不要結案」「別急著結案」「還不能結案」——否定詞到「結案」之間最多隔 4 個字、不跨標點
const NEGATION_RE = /(不|別|勿|未|沒|暫不|先別|還不|不要|不用|不能|不必|不可以|別急著)[^，。,.!！?？\n]{0,4}結案/
// 帶否定字的肯定慣用語（「沒問題可以結案」「不錯直接結案」）先拿掉，免得被當成否定
const AFFIRMATIVE_IDIOM_RE = /沒有?問題|沒毛病|沒事了?|不錯|不用改了?/g
// 疑問：「可以結案嗎」「要不要結案？」——問句交給 Claude 回答，不替少爺做決定
const QUESTION_RE = /(嗎|要不要|是否|能不能|可不可以|該不該|好不好|了沒)|[?？]\s*$/
// 整則只有「OK」：與執行中 ✔ 結案鈕同義（鈕的定義＝等同在留言送出「OK」）
const BARE_OK_RE = /^\s*ok(ay)?\s*[!！。.~～]*\s*$/i

/** 這則留言是不是在對整個 run 表態結案。InItemId 非 null＝針對單一項目的留言（「OK」＝該項通過，不是整輪結案） */
export function commentIntendsClose(InText, InItemId = null) {
  if (InItemId !== null && InItemId !== undefined) return false
  const _text = String(InText ?? '').trim()
  if (!_text) return false
  if (BARE_OK_RE.test(_text)) return true
  if (!_text.includes('結案')) return false
  if (NEGATION_RE.test(_text.replace(AFFIRMATIVE_IDIOM_RE, ''))) return false
  if (QUESTION_RE.test(_text)) return false
  return true
}

/** 轉進這些狀態＝預約作廢：待放行／倒數中＝分支迴圈開新一輪（少爺表態的是上一輪），已中止＝這輪不做了 */
export function transitionCancelsArm(InPrevStatus, InNextStatus) {
  if (InPrevStatus === InNextStatus) return false
  return ['announced', 'countdown', 'aborted'].includes(InNextStatus)
}

/** 這個狀態下可以預約（還沒走到已完成的進行中狀態） */
export function canArmInStatus(InStatus) {
  return ['announced', 'countdown', 'running', 'paused'].includes(InStatus)
}
