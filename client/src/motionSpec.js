// 動態示意規格（少爺 2026-10-10「我想要 TC 在問我速度方面的問題時，搭配這種動圖（更能看出速度感）」）。
// 待定奪條目的 ```motion 區塊 → 每條軌道的數值（0＝起點、1＝目標）隨時間變化；面板畫成「曲線＋播放頭＋移動的點」循環播放。
// 純邏輯、零依賴：前端 MotionPreview、server 進一步說明的驗證、機檢（server/qaDecisions.check.mjs）共用這一份。
//
// 格式（一行一項，# 之後是註解）：
//   標題 進度（0＝原方向、1＝新方向）        ← 選填
//   秒 0.6                                    ← 時間軸長度；不寫＝依曲線自動
//   鏡頭: 即時
//   陣型: 半衰期 0.05 跟 鏡頭                 ← 「跟 X」＝追的是 X 當下的位置（不是目標）＝連鎖延遲
//   士兵: 緩出 0.3 @0.1                        ← @秒＝延遲多久才開始
// 曲線：即時｜線性 秒｜緩入 秒｜緩出 秒｜緩入緩出 秒｜階梯 秒（停在原地到該秒才跳）｜半衰期 秒（指數追隨）
//       ｜彈簧 半衰期 過衝比例（0～0.8，選填，預設 0.2）｜關鍵格 秒:值 秒:值 …（線性內插，值可超過 1＝過衝）
//       英文同義：instant linear easeIn easeOut easeInOut step lag spring keys；「跟」只能搭配半衰期／彈簧
// 畫面模擬（少爺同日「或是你能用畫面模擬」）：曲線圖下方再畫一個小場景，每條軌道驅動一個物件——
//   畫面 旋轉 90     ← 物件繞中心轉到 90°（甩鏡頭、陣型轉向）
//   畫面 移動        ← 物件從左滑到右（預設；位移、追趕）
//   畫面 縮放 1.3    ← 物件從原大小縮放到 1.3 倍（鏡頭推近、受擊放大）
//   畫面 淡入        ← 物件從透明到不透明（提示出現、UI 淡入）
//   軌道可加「形狀 視野／方陣／箭頭／點／框／畫面」；不寫＝依名稱猜（鏡頭→視野、陣型／士兵→方陣、其他→箭頭）
//   「畫面」＝整個畫面框（含地平線）繞自己中心轉，旋轉模式下用來表現鏡頭歪頭（Roll）

const KIND_ALIASES = {
  即時: 'instant', instant: 'instant',
  線性: 'linear', linear: 'linear',
  緩入: 'easeIn', easein: 'easeIn', 緩出: 'easeOut', easeout: 'easeOut', 緩入緩出: 'easeInOut', easeinout: 'easeInOut',
  階梯: 'step', step: 'step', hold: 'step',
  半衰期: 'lag', 追隨: 'lag', lag: 'lag',
  彈簧: 'spring', spring: 'spring',
  關鍵格: 'keys', keys: 'keys',
}
const SCENE_ALIASES = { 旋轉: 'rotate', rotate: 'rotate', 移動: 'move', move: 'move', 縮放: 'scale', scale: 'scale', 淡入: 'fade', fade: 'fade' }
const SHAPE_ALIASES = { 視野: 'cone', cone: 'cone', 方陣: 'block', block: 'block', 箭頭: 'arrow', arrow: 'arrow', 點: 'dot', dot: 'dot', 框: 'frame', frame: 'frame', 畫面: 'screen', screen: 'screen' }
const NEEDS_SECONDS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'step', 'lag', 'spring'])

/** 軌道沒指定形狀時依名稱猜 */
export function motionShapeOf(InTrack) {
  if (InTrack.shape) return InTrack.shape
  if (/鏡頭|攝影機|視野|相機|camera/i.test(InTrack.name)) return 'cone'
  if (/陣型|士兵|方陣|隊|兵|formation|soldier/i.test(InTrack.name)) return 'block'
  return 'arrow'
}
const FOLLOWABLE = new Set(['lag', 'spring'])
const MAX_TRACKS = 6
const SIM_DT = 1 / 480

const num = (InText) => { const _n = Number(String(InText).replace(/秒$|s$/i, '')); return Number.isFinite(_n) ? _n : null }

/** 規格文字 → { title, duration, scene:{ mode, amount }, tracks:[{ name, kind, args, delay, follow, shape }], errors } */
export function parseMotionSpec(InText) {
  const out = { title: '', duration: null, scene: { mode: 'move', amount: null }, tracks: [], errors: [] }
  for (const _raw of String(InText ?? '').split(/\r?\n/)) {
    const line = _raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const _scene = line.match(/^(畫面|scene)\s+(\S+)(?:\s+(\S+))?$/i)
    if (_scene) {
      const _mode = SCENE_ALIASES[_scene[2]] ?? SCENE_ALIASES[_scene[2].toLowerCase()]
      if (!_mode) { out.errors.push(`畫面模擬「${_scene[2]}」不認得（旋轉／移動／縮放／淡入）`); continue }
      const _amt = _scene[3] !== undefined ? num(_scene[3].replace(/°$/, '')) : null
      if (_scene[3] !== undefined && _amt === null) out.errors.push(`畫面模擬的數值「${_scene[3]}」要是數字`)
      out.scene = { mode: _mode, amount: _amt }
      continue
    }
    const _meta = line.match(/^(標題|title|秒|時長|seconds)\s+(.+)$/i)
    if (_meta && !/[:：]/.test(line.split(/\s+/)[0])) {
      if (/^(標題|title)$/i.test(_meta[1])) out.title = _meta[2].trim()
      else {
        const _d = num(_meta[2].trim())
        if (_d === null || _d <= 0 || _d > 30) out.errors.push(`「${line}」：時間軸長度要是 0～30 秒的數字`)
        else out.duration = _d
      }
      continue
    }
    const _m = line.match(/^([^:：]+)[:：]\s*(.+)$/)
    if (!_m) { out.errors.push(`看不懂「${line}」：軌道要寫成「名稱: 曲線」`); continue }
    const name = _m[1].trim()
    const _tokens = _m[2].trim().split(/\s+/)
    const kind = KIND_ALIASES[_tokens[0]] ?? KIND_ALIASES[_tokens[0].toLowerCase()]
    if (!kind) { out.errors.push(`「${name}」的曲線「${_tokens[0]}」不認得（即時／線性／緩入／緩出／緩入緩出／階梯／半衰期／彈簧／關鍵格）`); continue }
    const track = { name, kind, args: [], delay: 0, follow: null, shape: null }
    for (let i = 1; i < _tokens.length; i++) {
      const _t = _tokens[i]
      if (/^(形狀|shape)$/i.test(_t)) {
        const _s = _tokens[++i]
        track.shape = SHAPE_ALIASES[_s] ?? SHAPE_ALIASES[String(_s).toLowerCase()] ?? null
        if (!track.shape) out.errors.push(`「${name}」的形狀「${_s}」不認得（視野／方陣／箭頭／點／框）`)
        continue
      }
      if (/^@/.test(_t)) { track.delay = num(_t.slice(1)) ?? 0; continue }
      if (/^(延遲|delay)$/i.test(_t)) { track.delay = num(_tokens[++i]) ?? 0; continue }
      if (/^(跟|follow)$/i.test(_t)) { track.follow = _tokens[++i] ?? null; continue }
      if (kind === 'keys') {
        const _kv = _t.match(/^([\d.]+)[:：]([-\d.]+)$/)
        if (_kv) track.args.push([Number(_kv[1]), Number(_kv[2])])
        else out.errors.push(`「${name}」的關鍵格「${_t}」要寫成 秒:值`)
        continue
      }
      const _n = num(_t)
      if (_n === null) out.errors.push(`「${name}」多了看不懂的「${_t}」`)
      else track.args.push(_n)
    }
    if (NEEDS_SECONDS.has(kind) && !(track.args[0] > 0)) out.errors.push(`「${name}」的${_tokens[0]}要給秒數（例：${_tokens[0]} 0.2）`)
    if (kind === 'keys' && track.args.length < 2) out.errors.push(`「${name}」的關鍵格至少要兩個（例：關鍵格 0:0 0.2:1）`)
    if (kind === 'spring' && track.args[1] !== undefined && !(track.args[1] >= 0 && track.args[1] <= 0.8)) out.errors.push(`「${name}」的彈簧過衝比例要在 0～0.8`)
    if (track.follow && !FOLLOWABLE.has(kind)) out.errors.push(`「${name}」：「跟」只能搭配半衰期或彈簧`)
    if (track.delay < 0) track.delay = 0
    out.tracks.push(track)
  }
  for (const t of out.tracks) if (t.follow && !out.tracks.some(x => x.name === t.follow && x !== t)) out.errors.push(`「${t.name}」跟的「${t.follow}」不是任何一條軌道`)
  if (!out.tracks.length && !out.errors.length) out.errors.push('沒有任何軌道（例：鏡頭: 即時）')
  if (out.tracks.length > MAX_TRACKS) out.errors.push(`軌道最多 ${MAX_TRACKS} 條`)
  return out
}

const ease = {
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - (1 - x) ** 3,
  easeInOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
}

/** 一條「不跟別人」的曲線在 t 秒（已扣延遲）的值 */
function directValue(InTrack, InT) {
  const [a = 0] = InTrack.args
  if (InT < 0) return 0
  switch (InTrack.kind) {
    case 'instant': return 1
    case 'linear': return Math.min(InT / a, 1)
    case 'easeIn': case 'easeOut': case 'easeInOut': return ease[InTrack.kind](Math.min(InT / a, 1))
    case 'step': return InT >= a ? 1 : 0
    case 'keys': {
      const _k = InTrack.args
      if (InT <= _k[0][0]) return _k[0][1]
      for (let i = 1; i < _k.length; i++) if (InT <= _k[i][0]) {
        const [t0, v0] = _k[i - 1], [t1, v1] = _k[i]
        return t1 === t0 ? v1 : v0 + (v1 - v0) * (InT - t0) / (t1 - t0)
      }
      return _k.at(-1)[1]
    }
    default: return 0
  }
}

/** 彈簧參數：過衝比例 → 阻尼比；包絡半衰期 → 角頻率 */
function springParams(InHalfLife, InOvershoot = 0.2) {
  const _o = Math.min(Math.max(InOvershoot, 0), 0.8)
  const zeta = _o <= 0.0001 ? 1 : -Math.log(_o) / Math.sqrt(Math.PI ** 2 + Math.log(_o) ** 2)
  return { zeta, omega: Math.LN2 / (InHalfLife * zeta) }
}

/** 一條軌道大約多久到位（自動時間軸長度用） */
function settleTime(InTrack, InByName, InDepth = 0) {
  const [a = 0] = InTrack.args
  const _base = { instant: 0, linear: a, easeIn: a, easeOut: a, easeInOut: a, step: a, lag: a * 5.6, spring: a * 7, keys: InTrack.args.at(-1)?.[0] ?? 0 }[InTrack.kind] ?? 0
  const _up = InTrack.follow && InDepth < MAX_TRACKS ? settleTime(InByName.get(InTrack.follow) ?? { args: [], kind: 'instant' }, InByName, InDepth + 1) : 0
  return InTrack.delay + _base + _up
}

/** 規格 → 取樣結果 { duration, times, tracks:[{ name, values }], yMin, yMax }；有錯誤回 null */
export function simulateMotion(InSpec, InSamples = 240) {
  if (!InSpec || InSpec.errors?.length || !InSpec.tracks?.length) return null
  const byName = new Map(InSpec.tracks.map(t => [t.name, t]))
  const _auto = Math.max(...InSpec.tracks.map(t => settleTime(t, byName))) * 1.25
  const duration = InSpec.duration ?? Math.min(Math.max(_auto, 0.2), 6)
  const steps = Math.ceil(duration / SIM_DT)
  // 依「跟誰」排順序：被跟的先算
  const order = []
  const _visit = (InTrack, InStack = new Set()) => {
    if (order.includes(InTrack) || InStack.has(InTrack)) return
    InStack.add(InTrack)
    if (InTrack.follow && byName.has(InTrack.follow)) _visit(byName.get(InTrack.follow), InStack)
    order.push(InTrack)
  }
  for (const t of InSpec.tracks) _visit(t)
  const fine = new Map()   // 軌道 → 每個模擬步的值
  for (const t of order) {
    const _vals = new Float64Array(steps + 1)
    const _target = t.follow ? fine.get(byName.get(t.follow)) : null
    if (t.kind === 'lag') {
      const _k = 1 - 2 ** (-SIM_DT / t.args[0])
      let v = 0
      for (let i = 0; i <= steps; i++) {
        const _time = i * SIM_DT
        if (_time >= t.delay) v += ((_target ? _target[i] : 1) - v) * _k
        _vals[i] = v
      }
    } else if (t.kind === 'spring') {
      const { zeta, omega } = springParams(t.args[0], t.args[1] ?? 0.2)
      const _sub = Math.max(1, Math.ceil(omega * SIM_DT / 0.1))
      const _h = SIM_DT / _sub
      let x = 0, vel = 0
      for (let i = 0; i <= steps; i++) {
        if (i * SIM_DT >= t.delay) {
          const _goal = _target ? _target[i] : 1
          for (let s = 0; s < _sub; s++) { vel += (omega * omega * (_goal - x) - 2 * zeta * omega * vel) * _h; x += vel * _h }
        }
        _vals[i] = x
      }
    } else {
      for (let i = 0; i <= steps; i++) _vals[i] = directValue(t, i * SIM_DT - t.delay)
    }
    fine.set(t, _vals)
  }
  const times = Array.from({ length: InSamples + 1 }, (_, i) => duration * i / InSamples)
  const tracks = InSpec.tracks.map(t => {
    const _f = fine.get(t)
    return { name: t.name, values: times.map(tt => _f[Math.min(steps, Math.round(tt / SIM_DT))]) }
  })
  const _all = tracks.flatMap(t => t.values)
  return {
    title: InSpec.title, duration, times, yMin: Math.min(0, ..._all), yMax: Math.max(1, ..._all), scene: InSpec.scene ?? { mode: 'move', amount: null },
    tracks: tracks.map((t, i) => ({ ...t, shape: motionShapeOf(InSpec.tracks[i]) })),
  }
}

/** 取樣結果在 t 秒的值（線性內插） */
export function motionValueAt(InSim, InTrackIndex, InT) {
  const _vals = InSim.tracks[InTrackIndex].values
  const _x = Math.min(Math.max(InT / InSim.duration, 0), 1) * (_vals.length - 1)
  const _i = Math.floor(_x)
  return _i >= _vals.length - 1 ? _vals.at(-1) : _vals[_i] + (_vals[_i + 1] - _vals[_i]) * (_x - _i)
}
