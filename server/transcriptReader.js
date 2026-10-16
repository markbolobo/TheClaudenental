// 逐字稿增量讀取（純邏輯，無副作用；機檢 transcriptReader.check.mjs）
//
// 少爺 2026-10-12「TC 的侍酒師還有 QA 載入過慢」實測：server 每 30 秒卡死 8 秒以上（用量熱度整批重讀 7 天內
// 76 份逐字稿 703MB，且逐筆查價）、每 8 秒卡約 0.7 秒（掃描器整份重讀非活躍逐字稿）、被監看的聊天室每次變動也整份重讀。
// 這裡提供「記住讀到哪、只讀新增完整行」的讀取器，以及用量熱度／掃描器各自的逐行累積規則。

import fs from 'fs'

/**
 * 從 InFromByte 讀到最後一個完整換行為止（每次最多約 InMaxBytes；單行超過上限時延伸讀到該行結束）。
 * 回傳完整行 lines、下一次的起點 nextByte、檔案變短（被改寫）時從頭重讀的 reset、後面是否還有沒讀完的完整行 more。
 * 換行位元組不會出現在 UTF-8 多位元組字元中間，所以依 0x0A 切段不會切壞中文。
 */
export function readTranscriptLines(InFilePath, InFromByte = 0, InMaxBytes = Infinity) {
  const _fd = fs.openSync(InFilePath, 'r')
  try {
    const _size = fs.fstatSync(_fd).size
    const _reset = _size < InFromByte
    const _from = _reset ? 0 : InFromByte
    let _want = Math.min(_size - _from, InMaxBytes)
    while (_want > 0) {
      const _buf = Buffer.allocUnsafe(_want)
      const _read = fs.readSync(_fd, _buf, 0, _want, _from)
      const _end = _read > 0 ? _buf.lastIndexOf(0x0a, _read - 1) : -1
      if (_end >= 0) {
        return { lines: _buf.toString('utf-8', 0, _end).split('\n').filter(Boolean), nextByte: _from + _end + 1, reset: _reset, more: _from + _read < _size }
      }
      if (_from + _read >= _size) break   // 讀到檔尾仍沒有換行＝最後一行還沒寫完
      _want = Math.min(_size - _from, _want * 2)
    }
    return { lines: [], nextByte: _from, reset: _reset, more: false }
  } finally { fs.closeSync(_fd) }
}

/** 目前最後一個完整行的結尾位置：開始監看時從這裡接著讀，只讀檔尾不讀整份 */
export function transcriptLineEnd(InFilePath) {
  const _fd = fs.openSync(InFilePath, 'r')
  try {
    const _size = fs.fstatSync(_fd).size
    for (let _len = Math.min(_size, 64 * 1024); _len > 0; _len = Math.min(_size, _len * 4)) {
      const _buf = Buffer.allocUnsafe(_len)
      fs.readSync(_fd, _buf, 0, _len, _size - _len)
      const _end = _buf.lastIndexOf(0x0a)
      if (_end >= 0) return _size - _len + _end + 1
      if (_len === _size) break
    }
    return 0
  } finally { fs.closeSync(_fd) }
}

/**
 * 用量熱度的一筆：有產出 token 的助手訊息 → [時間戳, 模型, 四種 token 數]；其他行回 null。
 * 先比對字串再解析：助手行只佔逐字稿約 15%，其餘不必 JSON.parse（Claude Code 寫入為緊湊 JSON）。
 */
export function heatEntryFromLine(InLine) {
  if (!InLine.includes('"type":"assistant"')) return null
  try {
    const obj = JSON.parse(InLine)
    if (obj.type !== 'assistant') return null
    const msg = obj.message
    if (!msg?.usage?.output_tokens) return null   // skip non-generating turns
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
    if (!ts) return null
    const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = msg.usage
    return [ts, msg.model ?? '', { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }]
  } catch { return null }
}

/** 掃描器摘要的初始值 */
export function newScanSummary() {
  return { byteOffset: 0, cwd: null, aiTitle: null, firstUser: null, hasActivity: false, lastMsgTs: 0, lastType: null }
}

/** 掃描器摘要逐行累積（cwd／標題／首句提問／有無回覆／最後真實對話時間／最後一行類型），可分段呼叫 */
export function accumulateScanSummary(InSummary, InLines) {
  for (const l of InLines) {
    let _type = null
    try {
      const o = JSON.parse(l)
      _type = o.type ?? null
      if (!InSummary.cwd && o.cwd) InSummary.cwd = o.cwd
      if (o.type === 'ai-title' && o.aiTitle) InSummary.aiTitle = o.aiTitle
      if (o.type === 'user' && !InSummary.firstUser) {
        const c = o.message?.content
        const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('') : '')
        const clean = t.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
        if (clean) InSummary.firstUser = clean.slice(0, 60)
      }
      if (o.type === 'assistant') InSummary.hasActivity = true
      // 最後一句「真實對話」（user/assistant）的時間——metadata 行（last-prompt 等）不算
      if ((o.type === 'user' || o.type === 'assistant') && o.timestamp) {
        const _t = Date.parse(o.timestamp)
        if (_t > InSummary.lastMsgTs) InSummary.lastMsgTs = _t
      }
    } catch {}
    InSummary.lastType = _type
  }
  return InSummary
}
