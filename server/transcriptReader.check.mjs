// 逐字稿增量讀取機檢：`node transcriptReader.check.mjs`（或 `npm run check:transcripts`）
//
// 少爺 2026-10-12「TC 的侍酒師還有 QA 載入過慢」：server 被三處「整份重讀逐字稿」卡住（用量熱度每 30 秒約 8 秒、
// 掃描器每 8 秒約 0.7 秒、監看每次變動），QA 分頁另被 git status 的 spawnSync 擋住。釘成回歸測試：
//   [1] 讀取器邊界：分段、半行、中文跨段、單行超過上限、檔案變短、檔尾定位
//   [2] 真實逐字稿快照：新（增量＋字串預篩）與舊（整份逐行 JSON.parse）的用量熱度筆數與掃描摘要逐筆相同
//   [3] 監看接續讀：從檔尾開始、逐段追加（含半行）→ 收到的行與追加內容完全一致、不漏不重
//   [4] 掃 index.js／QAMonitor.jsx：上述路徑不得改回整份重讀／同步 git，QA 清單走摘要

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { readTranscriptLines, transcriptLineEnd, heatEntryFromLine, newScanSummary, accumulateScanSummary } from './transcriptReader.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-check-'))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 讀取器還有內容卻沒有前進＝會讓呼叫端無限迴圈，直接判失敗並中止機檢 */
function assertAdvance(InR, InPrev) {
  if (InR.more && !InR.reset && InR.nextByte <= InPrev) {
    console.log(`  ❌ 讀取器沒有前進（起點 ${InPrev} → ${InR.nextByte}，more=true）：呼叫端會無限迴圈`)
    throw new Error('reader-stalled')
  }
}

/** 分段讀完整份（模擬增量）：回傳所有完整行 */
function readAllInChunks(InFile, InMaxBytes) {
  const _lines = []
  let _off = 0
  for (;;) {
    const _r = readTranscriptLines(InFile, _off, InMaxBytes)
    assertAdvance(_r, _off)
    _lines.push(..._r.lines)
    _off = _r.nextByte
    if (!_r.more) break
  }
  return { lines: _lines, offset: _off }
}

try {
  console.log('\n[1] 讀取器邊界')
  {
    const _f = path.join(TMP, 'a.jsonl')
    const _full = ['{"type":"user","text":"中文跨段測試一二三"}', '{"type":"assistant","x":1}', '{"type":"user","text":"' + '長'.repeat(500) + '"}']
    fs.writeFileSync(_f, _full.join('\n') + '\n' + '{"type":"半行')
    let _r = readTranscriptLines(_f, 0)
    ok(same(_r.lines, _full), '一次讀：只回完整行、半行不回')
    ok(_r.nextByte === Buffer.byteLength(_full.join('\n') + '\n'), '下一次起點停在最後一個換行之後（半行留待下次）')
    ok(!_r.more && !_r.reset, '讀到檔尾 more=false、未變短 reset=false')
    const _chunked = readAllInChunks(_f, 7)
    ok(same(_chunked.lines, _full), '每次只讀 7 位元組（中文 3 位元組會被切開、單行超過上限）→ 結果與一次讀相同')
    fs.appendFileSync(_f, '補完"}\n')
    _r = readTranscriptLines(_f, _chunked.offset)
    ok(same(_r.lines, ['{"type":"半行補完"}']), '半行寫完後下次讀到完整的那一行')
    fs.writeFileSync(_f, _full[0] + '\n')
    _r = readTranscriptLines(_f, _chunked.offset)
    ok(_r.reset && same(_r.lines, [_full[0]]), '檔案變短（被改寫）→ reset=true 並從頭讀')
    ok(same(readTranscriptLines(_f, Buffer.byteLength(_full[0] + '\n')).lines, []), '沒有新內容 → 空陣列')

    const _g = path.join(TMP, 'b.jsonl')
    fs.writeFileSync(_g, '')
    ok(transcriptLineEnd(_g) === 0, '空檔 → 檔尾位置 0')
    fs.writeFileSync(_g, 'no newline yet')
    ok(transcriptLineEnd(_g) === 0, '整份沒有換行 → 0')
    fs.writeFileSync(_g, 'a\nb\npartial')
    ok(transcriptLineEnd(_g) === 4, '有半行 → 停在最後一個換行之後')
    const _long = 'x'.repeat(300 * 1024)
    fs.writeFileSync(_g, 'head\n' + _long)
    ok(transcriptLineEnd(_g) === 5, '最後一行超過 64KB → 往回延伸找到換行')
    fs.writeFileSync(_g, 'head\n' + _long + '\n')
    ok(transcriptLineEnd(_g) === fs.statSync(_g).size, '結尾是換行 → 檔案大小')
  }

  console.log('\n[2] 真實逐字稿快照：新舊演算法逐筆相同')
  {
    const _projects = path.join(os.homedir(), '.claude', 'projects')
    const _now = Date.now()
    const _cand = []
    for (const _d of fs.existsSync(_projects) ? fs.readdirSync(_projects) : []) {
      const _dir = path.join(_projects, _d)
      try { if (!fs.statSync(_dir).isDirectory()) continue } catch { continue }
      for (const _f of fs.readdirSync(_dir)) {
        if (!_f.endsWith('.jsonl')) continue
        const _p = path.join(_dir, _f)
        const _st = fs.statSync(_p)
        if (_now - _st.mtimeMs <= 7 * 24 * 3600 * 1000) _cand.push({ p: _p, size: _st.size, mtime: _st.mtimeMs })
      }
    }
    // 取樣：最大 3 份＋最近 6 份（同時涵蓋大檔與正在寫的檔），總量上限約 200MB
    const _pick = new Map()
    for (const c of [..._cand].sort((a, b) => b.size - a.size).slice(0, 3)) _pick.set(c.p, c)
    for (const c of [..._cand].sort((a, b) => b.mtime - a.mtime).slice(0, 6)) _pick.set(c.p, c)
    let _budget = 200 * 1024 * 1024
    const _snaps = []
    for (const c of _pick.values()) {
      if (c.size > _budget) continue
      _budget -= c.size
      const _s = path.join(TMP, `snap_${_snaps.length}.jsonl`)
      fs.copyFileSync(c.p, _s)
      fs.truncateSync(_s, transcriptLineEnd(_s))   // 快照收在完整行上，新舊兩邊讀同一份
      _snaps.push(_s)
    }
    if (_snaps.length === 0) console.log('  （本機沒有 7 天內的逐字稿，略過）')
    let _totalMB = 0, _oldMs = 0, _newMs = 0, _entries = 0
    for (const _s of _snaps) {
      _totalMB += fs.statSync(_s).size / 1048576
      // 舊：整份讀、逐行 JSON.parse（照 2026-10-12 前的 /api/usage/heat 與 scanJsonlSessions 原文）
      let _t = Date.now()
      const _oldHeat = []
      const _text = fs.readFileSync(_s, 'utf-8')
      for (const line of _text.split('\n')) {
        try {
          const obj = JSON.parse(line)
          if (obj.type !== 'assistant') continue
          const msg = obj.message
          if (!msg?.usage?.output_tokens) continue
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
          if (!ts) continue
          const u = msg.usage
          _oldHeat.push([ts, msg.model ?? '', u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens])
        } catch {}
      }
      const lines = _text.split('\n').filter(Boolean)
      let cwd = null, aiTitle = null, firstUser = null, hasActivity = false, lastMsgTs = 0
      for (const l of lines) {
        try {
          const o = JSON.parse(l)
          if (!cwd && o.cwd) cwd = o.cwd
          if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle
          if (o.type === 'user' && !firstUser) {
            const c = o.message?.content
            const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x=>x.type==='text').map(x=>x.text).join('') : '')
            const clean = t.replace(/^(\s*<[^>]+>[\s\S]*?<\/[^>]+>\s*)+/, '').trim()
            if (clean) firstUser = clean.slice(0, 60)
          }
          if (o.type === 'assistant') hasActivity = true
          if ((o.type === 'user' || o.type === 'assistant') && o.timestamp) {
            const _ts = Date.parse(o.timestamp)
            if (_ts > lastMsgTs) lastMsgTs = _ts
          }
        } catch {}
      }
      let lastType = null
      try { lastType = JSON.parse(lines[lines.length - 1] ?? '').type } catch {}
      const _oldScan = { cwd, aiTitle, firstUser, hasActivity, lastMsgTs, lastType: lastType ?? null }
      _oldMs += Date.now() - _t

      // 新：分段增量（1MB 一段，刻意切在行中間）＋字串預篩
      _t = Date.now()
      const _newHeat = []
      const _sum = newScanSummary()
      let _off = 0
      for (;;) {
        const _r = readTranscriptLines(_s, _off, 1024 * 1024)
        assertAdvance(_r, _off)
        for (const l of _r.lines) {
          const _e = heatEntryFromLine(l)
          if (_e) _newHeat.push([_e[0], _e[1], _e[2].input_tokens, _e[2].output_tokens, _e[2].cache_read_input_tokens, _e[2].cache_creation_input_tokens])
        }
        accumulateScanSummary(_sum, _r.lines)
        _off = _r.nextByte
        if (!_r.more) break
      }
      _newMs += Date.now() - _t
      _entries += _newHeat.length
      const _name = path.basename(_s)
      ok(same(_newHeat, _oldHeat), `${_name}：用量熱度 ${_newHeat.length} 筆與舊算法逐筆相同`, `舊 ${_oldHeat.length} 筆`)
      const { byteOffset, ..._newScan } = _sum
      ok(same(_newScan, _oldScan), `${_name}：掃描摘要與舊算法相同`, `\n     新 ${JSON.stringify(_newScan).slice(0, 200)}\n     舊 ${JSON.stringify(_oldScan).slice(0, 200)}`)
      ok(byteOffset === 0 && _off === fs.statSync(_s).size, `${_name}：分段讀完的位置＝檔案結尾`)
    }
    if (_snaps.length) console.log(`  ℹ️ 快照 ${_snaps.length} 份共 ${_totalMB.toFixed(0)}MB、${_entries} 筆用量：舊算法 ${_oldMs}ms／新算法（首次全讀）${_newMs}ms；之後每次只讀新增部分`)
  }

  console.log('\n[3] 監看接續讀：從檔尾開始、逐段追加不漏不重')
  {
    const _src = fs.readdirSync(TMP).filter(f => f.startsWith('snap_')).map(f => path.join(TMP, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    const _body = _src ? fs.readFileSync(_src).subarray(0, 8 * 1024 * 1024) : Buffer.from(Array.from({ length: 2000 }, (_, i) => `{"type":"user","i":${i},"t":"中文${i}"}\n`).join(''))
    const _f = path.join(TMP, 'tail.jsonl')
    // 起點故意切在行中間：開始監看時最後一行還沒寫完
    const _cut = Math.floor(_body.length * 0.4)
    fs.writeFileSync(_f, _body.subarray(0, _cut))
    let _cursor = transcriptLineEnd(_f)
    const _expected = _body.subarray(_cursor).toString('utf-8').split('\n').filter(Boolean)
    const _got = []
    let _pos = _cut, _seed = 12345
    while (_pos < _body.length) {
      _seed = (_seed * 1103515245 + 12345) % 2147483648
      const _n = 1 + (_seed % 40000)   // 1～40000 位元組一段，必然切在行中間與中文中間
      fs.appendFileSync(_f, _body.subarray(_pos, Math.min(_body.length, _pos + _n)))
      _pos += _n
      const _r = readTranscriptLines(_f, _cursor)
      _got.push(..._r.lines)
      _cursor = _r.nextByte
    }
    const _tailLine = _body.toString('utf-8').endsWith('\n') ? [] : [_body.toString('utf-8').split('\n').pop()]
    ok(same(_got, _expected.slice(0, _expected.length - _tailLine.filter(Boolean).length)), `追加 ${(_body.length - _cut) / 1024 | 0}KB（亂數分段）→ 收到 ${_got.length} 行，與追加內容逐行一致`)
  }

  console.log('\n[4] 掃描：熱路徑不得改回整份重讀／同步 git，QA 清單走摘要')
  {
    const _src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf-8')
    const _body = (InStart) => {
      const i = _src.indexOf(InStart)
      if (i < 0) return null
      const j = _src.indexOf('\n}', i)
      return _src.slice(i, j < 0 ? undefined : j)
    }
    for (const [_sig, _label] of [
      ['async function computeUsageHeat(', '用量熱度'],
      ['function parseNewLines(', '監看新增行'],
      ['function startTranscriptWatch(', '開始監看'],
      ['function scanTranscriptSummary(', '掃描摘要'],
      ['function scanJsonlSessions(', '掃描器'],
    ]) {
      const _b = _body(_sig)
      ok(_b !== null && !/readFileSync\(/.test(_b), `${_label}（${_sig.trim()}）不整份讀檔`, _b === null ? '找不到函式' : '出現 readFileSync')
    }
    const _price = _body('function priceOf(')
    ok(_price !== null && /priceCache\.get/.test(_price), '查價有快取（priceFor 每次重掃擴充套件資料夾，用量熱度／聊天室花費逐筆查＝數萬次約 15 秒）')
    const _scan = _body('function scanJsonlSessions(')
    ok(_scan !== null && /_scanKey\(s\) !== _before\) broadcast/.test(_scan), '掃描器沒變就不廣播（否則前端每 8 秒對每個已完成聊天室重抓整份 /api/history）')
    const _route = _body("app.get('/api/usage/heat'")
    ok(_route !== null && /usageHeatPending/.test(_route), '用量熱度同時多個請求共用同一次計算')
    const _git = _body("app.get('/api/git/status'")
    ok(_git !== null && !/spawnSync\(/.test(_git) && /execFile\(/.test(_git), 'git status 走非同步 execFile、不用 spawnSync')
    const _qa = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'QAMonitor.jsx'), 'utf-8')
    ok(/\/api\/qa\/runs\?limit=\d+&summary=1/.test(_qa), 'QA 分頁清單只抓摘要（summary=1）')
    ok(/fetch\(`\/api\/qa\/runs\/\$\{InRunId\}`\)/.test(_qa), 'QA 分頁選中 run 時才抓完整內容')
    ok(/runs\.map\(qaRunSummary\)/.test(_src), 'server 支援 ?summary=1（預設仍回完整內容給腳本）')
  }
} catch (e) {
  if (e?.message !== 'reader-stalled') throw e
  fail++
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 逐字稿增量讀取機檢：${pass} 通過、${fail} 失敗`)
process.exit(fail === 0 ? 0 : 1)
