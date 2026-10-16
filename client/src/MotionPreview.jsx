import { useEffect, useMemo, useRef, useState } from 'react'
import { parseMotionSpec, simulateMotion, motionValueAt } from './motionSpec.js'

// 🎞 動態示意（少爺 2026-10-10「我想要 TC 在問我速度方面的問題時，搭配這種動圖（更能看出速度感）」「或是你能用畫面模擬」）：
// 上半＝數值曲線（仿動畫數值曲線圖：曲線＋播放頭＋曲線上的點），下半＝畫面模擬（每條軌道驅動一個物件：轉、滑、縮放、淡入）。
// 循環播放：起點停一下 → 照真實速度跑完 → 終點停一下；可切 ½×、¼× 慢放看細節（真實速度才是玩家感受到的）。
// 規格與模擬在 motionSpec.js（server 說明驗證、機檢共用）。

const COLORS = ['#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#f472b6', '#f87171']
const RATES = [[1, '1×'], [0.5, '½×'], [0.25, '¼×']]
const HOLD_START = 0.35
const HOLD_END = 0.8
const G = { w: 320, h: 118, l: 30, r: 312, t: 10, b: 96 }

const fmtSec = (InSec) => `${InSec < 1 ? InSec.toFixed(InSec < 0.1 ? 3 : 2) : InSec.toFixed(1)} 秒`

/** 時間軸刻度：挑一個讓刻度不超過 6 個的間隔 */
function timeTicks(InDuration) {
  const _step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2].find(s => InDuration / s <= 6) ?? 5
  return Array.from({ length: Math.floor(InDuration / _step + 1e-6) + 1 }, (_, i) => +(i * _step).toFixed(3))
}

/** 物件形狀（本地座標：原點＝轉軸，朝 +x 方向）；centered＝畫在自己中心（移動／縮放／淡入用） */
function Shape({ shape, color, centered = false }) {
  const _shift = centered ? { cone: -26, block: -36, arrow: -26, dot: -48, frame: -42 }[shape] ?? 0 : 0
  return (
    <g transform={`translate(${_shift},0)`}>
      {shape === 'cone' && (() => {
        const _r = centered ? 40 : 58, _h = 24 * Math.PI / 180
        return <path d={`M0 0 L${_r * Math.cos(-_h)} ${_r * Math.sin(-_h)} A${_r} ${_r} 0 0 1 ${_r * Math.cos(_h)} ${_r * Math.sin(_h)} Z`} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={1.2} />
      })()}
      {shape === 'block' && [26, 36, 46].flatMap(x => [-10, 0, 10].map(y => <circle key={`${x}${y}`} cx={x} cy={y} r={3.2} fill={color} />))}
      {shape === 'arrow' && <><line x1={0} y1={0} x2={46} y2={0} stroke={color} strokeWidth={2} /><path d="M52 0 L44 -5 L44 5 Z" fill={color} /></>}
      {shape === 'dot' && <circle cx={48} cy={0} r={5.5} fill={color} />}
      {shape === 'frame' && <rect x={22} y={-14} width={40} height={28} rx={2} fill="none" stroke={color} strokeWidth={1.6} />}
      {shape === 'screen' && (
        <g transform={`translate(${-_shift},0)`}>
          <rect x={-70} y={-40} width={140} height={80} rx={3} fill={color} fillOpacity={0.06} stroke={color} strokeWidth={1.4} />
          <line x1={-62} y1={12} x2={62} y2={12} stroke={color} strokeOpacity={0.7} strokeDasharray="5 3" />
          <path d="M-4 0 L4 0 M0 -4 L0 4" stroke={color} strokeWidth={1.2} />
        </g>
      )}
    </g>
  )
}

/** 畫面模擬：依模式把每條軌道的當下值套到物件上 */
function Scene({ sim, values }) {
  const { mode, amount } = sim.scene
  const n = sim.tracks.length
  if (mode === 'rotate') {
    const _deg = amount ?? 90
    const _ang = (v) => -90 + _deg * v
    const _ray = (InDeg, InKey) => <line key={InKey} x1={160} y1={84} x2={160 + 70 * Math.cos(InDeg * Math.PI / 180)} y2={84 + 70 * Math.sin(InDeg * Math.PI / 180)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />
    // 「畫面」形狀＝畫面框繞自己中心轉（鏡頭歪頭）：從水平開始，不畫起訖射線
    const _onlyScreens = sim.tracks.every(t => t.shape === 'screen')
    return (
      <svg viewBox="0 0 320 150" className="w-full text-[var(--text-muted)]">
        {!_onlyScreens && <>{_ray(_ang(0), 'from')}{_ray(_ang(1), 'to')}
          <text x={160 + 74 * Math.cos(_ang(1) * Math.PI / 180)} y={84 + 74 * Math.sin(_ang(1) * Math.PI / 180) + 3} fontSize={9} fill="currentColor" textAnchor="middle">{_deg}°</text></>}
        {_onlyScreens && <line x1={60} y1={84} x2={260} y2={84} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="3 3" />}
        {sim.tracks.map((t, i) => (
          <g key={t.name} transform={`translate(160,84) rotate(${t.shape === 'screen' ? _deg * values[i] : _ang(values[i])})`}><Shape shape={t.shape} color={COLORS[i % COLORS.length]} /></g>
        ))}
        <circle cx={160} cy={84} r={2.5} fill="currentColor" />
      </svg>
    )
  }
  if (mode === 'scale' || mode === 'fade') {
    const _gap = 320 / n
    return (
      <svg viewBox="0 0 320 110" className="w-full text-[var(--text-muted)]">
        {sim.tracks.map((t, i) => {
          const _x = _gap * (i + 0.5)
          const _s = mode === 'scale' ? 1 + ((amount ?? 1.3) - 1) * values[i] : 1
          const _o = mode === 'fade' ? Math.min(Math.max(values[i], 0), 1) : 1
          return (
            <g key={t.name}>
              {mode === 'scale' && <g transform={`translate(${_x},50) scale(${amount ?? 1.3})`} opacity={0.25}><Shape shape={t.shape} color="currentColor" centered /></g>}
              <g transform={`translate(${_x},50) scale(${_s})`} opacity={_o}><Shape shape={t.shape} color={COLORS[i % COLORS.length]} centered /></g>
              <text x={_x} y={102} fontSize={9} fill="currentColor" textAnchor="middle">{t.name}</text>
            </g>
          )
        })}
      </svg>
    )
  }
  // 移動：每條軌道一條跑道，物件從左（起點）滑到右（目標）
  const _lane = 30
  return (
    <svg viewBox={`0 0 320 ${n * _lane + 10}`} className="w-full text-[var(--text-muted)]">
      {sim.tracks.map((t, i) => {
        const _y = i * _lane + 20
        const _x = 70 + 220 * values[i]
        return (
          <g key={t.name}>
            <text x={4} y={_y + 3} fontSize={9} fill="currentColor">{t.name}</text>
            <line x1={70} y1={_y} x2={290} y2={_y} stroke="currentColor" strokeOpacity={0.25} />
            <line x1={290} y1={_y - 8} x2={290} y2={_y + 8} stroke="currentColor" strokeOpacity={0.5} strokeDasharray="2 2" />
            <g transform={`translate(${Math.min(_x, 316)},${_y})`}><Shape shape={t.shape} color={COLORS[i % COLORS.length]} centered /></g>
          </g>
        )
      })}
    </svg>
  )
}

export function MotionPreview({ text }) {
  const spec = useMemo(() => parseMotionSpec(text), [text])
  const sim = useMemo(() => simulateMotion(spec), [spec])
  const [rate, setRate] = useState(1)
  const [playing, setPlaying] = useState(true)
  const [t, setT] = useState(0)
  const startRef = useRef(null)

  useEffect(() => {
    if (!sim || !playing) return
    let _raf = 0
    startRef.current = null
    const _cycle = HOLD_START + sim.duration / rate + HOLD_END
    const _tick = (InNow) => {
      if (startRef.current === null) startRef.current = InNow
      const _e = ((InNow - startRef.current) / 1000) % _cycle
      setT(Math.min(Math.max(_e - HOLD_START, 0) * rate, sim.duration))
      _raf = requestAnimationFrame(_tick)
    }
    _raf = requestAnimationFrame(_tick)
    return () => cancelAnimationFrame(_raf)
  }, [sim, rate, playing])

  if (!sim) {
    return (
      <div className="text-[10px] text-amber-300/90 space-y-0.5">
        <div>🎞 動態示意的規格有誤，畫不出來：</div>
        {spec.errors.map((e, i) => <div key={i}>・{e}</div>)}
      </div>
    )
  }
  const _x = (InSec) => G.l + (G.r - G.l) * InSec / sim.duration
  const _y = (InVal) => G.b - (G.b - G.t) * (InVal - sim.yMin) / (sim.yMax - sim.yMin)
  const values = sim.tracks.map((_, i) => motionValueAt(sim, i, t))
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        {sim.title && <span className="text-violet-200">{sim.title}</span>}
        <span className="flex-1" />
        <button onClick={() => setPlaying(v => !v)} title={playing ? '暫停' : '播放'} className="px-1.5 rounded border border-violet-500/40 text-violet-200 hover:bg-violet-500/10">{playing ? '❚❚' : '▶'}</button>
        {RATES.map(([r, label]) => (
          <button key={r} onClick={() => setRate(r)} title={r === 1 ? '真實速度（玩家感受到的）' : '慢放看細節'}
            className={`px-1.5 rounded border ${rate === r ? 'border-violet-400 text-violet-100 bg-violet-500/20' : 'border-violet-500/30 text-violet-300/80 hover:bg-violet-500/10'}`}>{label}</button>
        ))}
        <span className="text-[var(--text-muted)] tabular-nums w-14 text-right">{fmtSec(t)}</span>
      </div>
      {/* 數值曲線：0＝起點、1＝目標；縱線＝播放頭，曲線上的點＝當下的值 */}
      <svg viewBox={`0 0 ${G.w} ${G.h + 14}`} className="w-full text-[var(--text-muted)]">
        <rect x={G.l} y={G.t} width={G.r - G.l} height={G.b - G.t} fill="none" stroke="currentColor" strokeOpacity={0.35} />
        {[0, 1].map(v => (
          <g key={v}>
            <line x1={G.l} x2={G.r} y1={_y(v)} y2={_y(v)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="3 3" />
            <text x={G.l - 4} y={_y(v) + 3} fontSize={8} fill="currentColor" textAnchor="end">{v}</text>
          </g>
        ))}
        {timeTicks(sim.duration).map(s => (
          <text key={s} x={_x(s)} y={G.b + 11} fontSize={8} fill="currentColor" textAnchor="middle">{s}s</text>
        ))}
        {sim.tracks.map((tr, i) => (
          <polyline key={tr.name} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={1.6}
            points={tr.values.map((v, j) => `${_x(sim.times[j]).toFixed(1)},${_y(v).toFixed(1)}`).join(' ')} />
        ))}
        <line x1={_x(t)} x2={_x(t)} y1={G.t} y2={G.b} stroke="#c4b5fd" strokeOpacity={0.8} />
        {sim.tracks.map((tr, i) => <circle key={tr.name} cx={_x(t)} cy={_y(values[i])} r={3.2} fill={COLORS[i % COLORS.length]} />)}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
        {sim.tracks.map((tr, i) => (
          <span key={tr.name} className="inline-flex items-center gap-1"><span className="w-2.5 h-0.5 inline-block" style={{ background: COLORS[i % COLORS.length] }} />{tr.name}</span>
        ))}
      </div>
      {/* 畫面模擬：同一組值驅動物件，直接看「誰先到、誰慢半拍」 */}
      <div className="rounded border border-violet-500/20 bg-black/20"><Scene sim={sim} values={values} /></div>
    </div>
  )
}
