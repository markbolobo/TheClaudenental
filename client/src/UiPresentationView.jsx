import { useMemo, useState } from 'react'
import { RichText } from './ScenarioView.jsx'
import { uiKey, UI_PURPOSE_LABEL } from './uiPresentationPrompt.js'
import { stripSource } from './scenarioPrompt.js'

// 🎨 介面視覺視圖（Sommelier 第七血肉，少爺 2026-10-20 立：「我預期TC 仕酒師會有一個項目視能讓我看到這些視覺與脈絡體驗」）— presentation/UI_##_*.md：
// 一個正式 UI 一張：功能 / 機制事件 / 需機制追加 / 演出對應（每個皮一小節）/ 待定奪。
// 機制與演出分開、演出是可換的皮：細節頁上方切皮＋iframe 嵌提案頁（捲到錨點），下方「機制 × 演出」兩欄對照。
// 資料來源 ui_presentation.json（extract_ui_presentation.mjs）；提案頁走 /api/sommelier/ui-proposal（唯讀、只收 AI_Utils）。
// 非元件共用（購物車 key／選件快照／結帳 prompt）在 uiPresentationPrompt.js。

const SORT_STORE_KEY = 'tc_sommelier_ui_sort'
const SORTS = [['timeline', '情境時間軸'], ['purpose', '依目的'], ['group', '依組別']]
const PURPOSE_META = {
  '豐': { cls: 'border-rose-500/40 text-rose-300' },
  '教': { cls: 'border-sky-500/40 text-sky-300' },
  '資': { cls: 'border-[var(--border)] text-[var(--text-muted)]' },
}
const STATUS_META = {
  active: null,
  'cpp-only': { label: '只有 C++', cls: 'border-amber-400/40 text-amber-300' },
  disabled: { label: '停用中', cls: 'border-[var(--border)] text-[var(--text-muted)]' },
}
const SKIN_STATUS = { proposal: '提案', adopted: '定案', implemented: '已實作', retired: '退役' }

function loadSort() {
  try { const v = localStorage.getItem(SORT_STORE_KEY); return SORTS.some(([k]) => k === v) ? v : 'timeline' } catch { return 'timeline' }
}
function saveSort(InSort) {
  try { localStorage.setItem(SORT_STORE_KEY, InSort) } catch { /* 無痕或封鎖儲存：只是不記住排法 */ }
}
function PurposeChip({ u }) {
  const meta = PURPOSE_META[u.purpose] ?? PURPOSE_META['資']
  return (
    <span title={`${UI_PURPOSE_LABEL[u.purpose] ?? u.purpose}${u.purposeAlso ? `（兼${UI_PURPOSE_LABEL[u.purposeAlso] ?? u.purposeAlso}）` : ''}`}
      className={`text-[8px] px-1 rounded border shrink-0 ${meta.cls}`}>{u.purpose}{u.purposeAlso ? `/${u.purposeAlso}` : ''}</span>
  )
}
function Section({ title, hint, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">{title}{hint && <span className="ml-2 normal-case tracking-normal text-[var(--text-muted)]">{hint}</span>}</div>
      {children}
    </div>
  )
}
const proposalUrl = (InPid, InSkin) => `/api/sommelier/ui-proposal/${encodeURIComponent(InPid)}/${InSkin.file.split('/').map(encodeURIComponent).join('/')}${InSkin.anchor ? '#' + encodeURIComponent(InSkin.anchor) : ''}`

// 情境的「看到／聽到」摘錄：介面組全收，其他組只收提到這個 UI（WBP 名／C++ 類別／標題）的條目
function seeHearExcerpt(InScenario, InUi) {
  const _wbpName = (InUi.wbp ?? '').split('/').pop()
  const _cls = (InUi.cppClass ?? '').replace(/^U/, '')
  const _title = (InUi.title ?? '').replace(/（.*$/, '')
  const _hit = (t) => (_wbpName && t.includes(_wbpName)) || (_cls && t.includes(_cls)) || (_title.length >= 2 && t.includes(_title))
  const out = []
  for (const [grp, items] of Object.entries(InScenario?.seeHear ?? {}))
    for (const it of items ?? []) {
      const _related = _hit(it.text ?? '')
      if (grp === '介面' || _related) out.push({ grp, marker: it.marker, text: stripSource(it.text), related: _related })
    }
  out.sort((a, b) => Number(b.related) - Number(a.related))
  return out.slice(0, 8)
}

export function UiPresentationView({ uiPresentation, scenario, projectId, query, initialId, cartKeys, onToggleUiCart, onUiCartSkinChange, onJumpToScenario, onJumpToIntent, onJumpToMemory }) {
  const uis = useMemo(() => uiPresentation?.uis ?? [], [uiPresentation])
  const groups = useMemo(() => uiPresentation?.groups ?? {}, [uiPresentation])
  const [uid, setUid] = useState(initialId ?? null)
  const [sort, setSort] = useState(loadSort)
  const [onlySkins, setOnlySkins] = useState(false)
  const [onlyAdditions, setOnlyAdditions] = useState(false)
  const [skinByUi, setSkinByUi] = useState({})   // UI id → 目前選的皮 index
  // 外部指定條目（情境頁點「此情境出現的 UI」）：prop 變了才同步，不用 effect（同 ScenarioView）
  const [seenInitialId, setSeenInitialId] = useState(initialId)
  if (initialId !== seenInitialId) {
    setSeenInitialId(initialId)
    if (initialId) setUid(initialId)
  }
  const changeSort = (v) => { setSort(v); saveSort(v) }

  const scenarios = useMemo(() => [...(scenario?.scenarios ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [scenario])
  const scenarioById = useMemo(() => new Map(scenarios.map(s => [s.id, s])), [scenarios])
  const byId = useMemo(() => new Map(uis.map(u => [u.id, u])), [uis])

  const tokens = useMemo(() => (query ?? '').toLowerCase().split(/\s+/).filter(Boolean), [query])
  const visible = useMemo(() => uis.filter(u => {
    if (onlySkins && !(u.skins ?? []).length) return false
    if (onlyAdditions && !(u.additions ?? []).some(a => !a.done)) return false
    const hay = `${u.num} ${u.id} ${u.title} ${u.wbp} ${u.cppClass} ${u.groupName} ${(u.skins ?? []).map(s => s.name).join(' ')} ${u.text ?? ''}`.toLowerCase()
    return tokens.every(t => hay.includes(t))
  }), [uis, onlySkins, onlyAdditions, tokens])

  // 左欄分組：情境時間軸（同一 UI 可出現在多個情境）／目的（豐教資）／組別（A～H）
  const grouped = useMemo(() => {
    if (sort === 'purpose')
      return ['豐', '教', '資'].map(p => [`${p}・${UI_PURPOSE_LABEL[p]}`, visible.filter(u => u.purpose === p)]).filter(([, arr]) => arr.length)
    if (sort === 'group')
      return Object.keys(groups).map(g => [`${g}. ${groups[g]}`, visible.filter(u => u.group === g)]).filter(([, arr]) => arr.length)
    const out = scenarios.map(s => [`${s.id.slice(0, 3)} ${s.title.replace(/（.*$/, '')}`, visible.filter(u => (u.scenarioIds ?? []).includes(s.id)), s.id]).filter(([, arr]) => arr.length)
    const _orphan = visible.filter(u => !(u.scenarioIds ?? []).length)
    if (_orphan.length) out.push(['（未標情境）', _orphan])
    return out
  }, [sort, visible, groups, scenarios])

  const u = uid ? byId.get(uid) : null
  const skins = u?.skins ?? []
  const skinIdx = Math.min(skinByUi[uid] ?? 0, Math.max(0, skins.length - 1))
  const skin = skins[skinIdx] ?? null
  const inCart = u ? cartKeys.has(uiKey(projectId, u.id)) : false
  const pickSkin = (i) => {
    setSkinByUi(m => ({ ...m, [uid]: i }))
    if (inCart) onUiCartSkinChange?.(u, skins[i])
  }
  const rich = (t) => <RichText text={t} onJumpToScenario={onJumpToScenario} onJumpToIntent={onJumpToIntent} onJumpToMemory={onJumpToMemory} />

  if (!uis.length) return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-xs px-6 text-center">
      尚無介面視覺資料 — 在 presentation/UI_##_*.md 建檔，並把 extract_ui_presentation.mjs 接進 sommelier.json 的 extractCommand 後跑刷新指令
    </div>
  )

  const st = uiPresentation?.stats ?? {}
  const openAdditions = (u?.additions ?? []).filter(a => !a.done)

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左：三種排法＋篩選 */}
      <div className="w-72 shrink-0 border-r border-[var(--border)] overflow-y-auto p-2">
        <div className="px-1 pb-2 mb-2 border-b border-[var(--border)] space-y-1">
          <div className="text-[9px] uppercase tracking-widest text-[var(--gold)]/70">🎨 介面視覺</div>
          <div className="text-[9px] text-[var(--text-muted)]">
            {st.uis ?? uis.length} 個 UI · 豐 {st.byPurpose?.['豐'] ?? 0}／教 {st.byPurpose?.['教'] ?? 0}／資 {st.byPurpose?.['資'] ?? 0} · 有提案 {st.withSkins ?? 0}／無 {st.withoutSkins ?? 0} · ⚠ 需機制追加 {st.additions ?? 0}
          </div>
          {st.brokenSkins > 0 && <div className="text-[9px] text-red-400" title={(uiPresentation?.brokenSkins ?? []).map(b => `${b.ui} ${b.skin}：${b.reason}`).join('\n')}>⚠ {st.brokenSkins} 個皮的提案頁或錨點找不到</div>}
          <div className="flex rounded border border-[var(--border)] overflow-hidden">
            {SORTS.map(([k, label]) => (
              <button key={k} onClick={() => changeSort(k)}
                className={`flex-1 px-1 py-0.5 text-[10px] ${sort === k ? 'bg-[var(--gold)]/20 text-[var(--gold)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>{label}</button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] cursor-pointer">
            <input type="checkbox" checked={onlySkins} onChange={e => setOnlySkins(e.target.checked)} />只看有提案的
          </label>
          <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] cursor-pointer">
            <input type="checkbox" checked={onlyAdditions} onChange={e => setOnlyAdditions(e.target.checked)} />只看有需機制追加的
          </label>
        </div>
        {grouped.map(([label, arr, sid]) => (
          <div key={label} className="mb-1">
            <div className="px-1 py-0.5 text-[10px] tracking-wide text-[var(--gold)]/70 flex items-center gap-1">
              {sid ? <button onClick={() => onJumpToScenario?.(sid)} title="跳到情境體驗" className="truncate text-left hover:text-[var(--gold)]">🎬 {label}</button> : <span className="truncate">{label}</span>}
              <span className="text-[8px] shrink-0">({arr.length})</span>
            </div>
            {arr.map(x => {
              const _adds = (x.additions ?? []).filter(a => !a.done).length
              const _st = STATUS_META[x.status]
              return (
                <button key={x.id} onClick={() => setUid(x.id)}
                  className={`w-full text-left pl-3 pr-2 py-0.5 rounded text-[11px] flex items-center gap-1 ${uid === x.id ? 'bg-[var(--gold)]/10 text-[var(--gold)]' : 'text-[var(--text)] hover:bg-[var(--surface)]'}`}>
                  <span className="text-[9px] text-[var(--text-muted)] shrink-0 w-5 text-right">{x.num}</span>
                  <span className="truncate flex-1">{x.title}</span>
                  <PurposeChip u={x} />
                  {(x.skins ?? []).length > 0 && <span className="text-[8px] text-[var(--gold)]/80 shrink-0" title={`${x.skins.length} 個皮`}>🎨{x.skins.length}</span>}
                  {_adds > 0 && <span className="text-[8px] px-1 rounded bg-amber-400/20 text-amber-300 shrink-0" title="需機制追加">⚠{_adds}</span>}
                  {_st && <span className={`text-[8px] px-1 rounded border shrink-0 ${_st.cls}`}>{_st.label}</span>}
                </button>
              )
            })}
          </div>
        ))}
        {!grouped.length && <div className="text-[10px] text-[var(--text-muted)] px-1">沒有符合條件的 UI</div>}
      </div>

      {/* 右：細節 */}
      <div className="flex-1 overflow-y-auto p-3 min-w-0">
        {!u ? (
          <div className="text-[var(--text-muted)] text-[11px] leading-relaxed max-w-lg mx-auto mt-10 space-y-2">
            <div className="text-[var(--gold)] text-sm">🎨 介面視覺</div>
            <p>遊戲中每個正式 UI 一張：上方切換各版<b>視覺提案（皮）</b>並直接嵌入提案頁看動態演出，下方對照<b>機制事件 × 這個皮的演出</b>，再往下是它出現在哪些<b>情境</b>。</p>
            <p>機制與演出分開：機制決定「發生了什麼、什麼時候」，皮只訂閱事件把它演出來、可以整套替換。皮需要新時機時，記在「需機制追加」（⚠ 標示）。</p>
            <p>目的分三種，強度不同：<b>豐</b>＝畫面豐富度（全開）、<b>教</b>＝教學提示（收斂）、<b>資</b>＝資訊與介面設定（最克制）。</p>
            <p className="text-[10px]">來源：<code>presentation/UI_##_*.md</code>（格式見同目錄 README.md）</p>
          </div>
        ) : (
          <div className="max-w-5xl space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded border border-[var(--gold)]/40 text-[var(--gold)]">{u.group}. {u.groupName}</span>
              <code className="text-base text-[var(--text)]">#{u.num} {u.title}</code>
              <PurposeChip u={u} />
              {STATUS_META[u.status] && <span className={`text-[8px] px-1 rounded border ${STATUS_META[u.status].cls}`}>{STATUS_META[u.status].label}</span>}
              <button onClick={() => onToggleUiCart(u, skin)}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${inCart ? 'border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50'}`}>
                {inCart ? '🛒✓ 已在購物車' : '🛒 討論這個 UI'}
              </button>
            </div>
            <div className="text-[9px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
              <span>WBP <code>{u.wbp || '（無）'}</code></span><span>C++ <code>{u.cppClass}</code></span><span>更新 {u.updated}</span><span className="truncate">檔案 <code>{u.file}</code></span>
            </div>
            {u.function && <div className="text-[11px] text-[var(--text)] border-l-2 border-[var(--gold)]/40 pl-2">{rich(u.function.split(/\r?\n/)[0])}</div>}

            {/* 皮切換＋iframe */}
            <Section title="視覺提案（皮）" hint={skins.length ? `${skins.length} 個版本，切換即換頁內段落` : null}>
              {skins.length ? (
                <>
                  <div className="flex flex-wrap items-center gap-1">
                    {skins.map((s, i) => (
                      <button key={`${s.file}#${s.anchor}`} onClick={() => pickSkin(i)}
                        title={`${s.file}#${s.anchor} · ${SKIN_STATUS[s.status] ?? s.status}${s.fileOk === false ? ' · ⚠ 提案檔不存在' : s.anchorOk === false ? ' · ⚠ 錨點不在頁內' : ''}`}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${i === skinIdx ? 'bg-[var(--gold)]/15 border-[var(--gold)]/60 text-[var(--gold)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'} ${s.fileOk === false || s.anchorOk === false ? 'line-through' : ''}`}>
                        {s.name}
                      </button>
                    ))}
                    <div className="flex-1" />
                    {skin && <a href={proposalUrl(projectId, skin)} target="_blank" rel="noreferrer"
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50">↗ 在新分頁開啟</a>}
                  </div>
                  {skin && (
                    <iframe key={skin.file} src={proposalUrl(projectId, skin)} title={`${u.title}｜${skin.name}`}
                      className="w-full h-[70vh] rounded border border-[var(--border)] bg-black" />
                  )}
                </>
              ) : (
                <div className="border border-dashed border-[var(--border)] rounded p-3 text-[11px] text-[var(--text-muted)] space-y-1">
                  <div>尚無提案</div>
                  <div>目的：<b className="text-[var(--text)]">{u.purpose}・{UI_PURPOSE_LABEL[u.purpose] ?? ''}</b>{u.purposeAlso ? `（兼${u.purposeAlso}・${UI_PURPOSE_LABEL[u.purposeAlso] ?? ''}）` : ''}——提案時照這一階的強度做</div>
                </div>
              )}
            </Section>

            {/* 機制 × 演出 */}
            <Section title="機制 × 演出" hint="左＝機制（換皮不動），右＝目前這個皮怎麼演">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="border border-[var(--border)] rounded p-2 space-y-1 min-w-0">
                  <div className="text-[10px] text-[var(--text-muted)]">機制事件（既有）</div>
                  {(u.events ?? []).length ? u.events.map((e, i) => (
                    <div key={i} className="text-[11px] text-[var(--text)] break-all">
                      <code className="text-[var(--gold)]/90">{e.name}</code>
                      {e.ref && <span className="ml-1 text-[9px] text-[var(--text-muted)]">{e.ref}</span>}
                      {e.note && <span className="ml-1 text-[10px] text-[var(--text-muted)]">（{e.note}）</span>}
                    </div>
                  )) : <div className="text-[10px] text-[var(--text-muted)]">（只有共同時機）</div>}
                  <div className="text-[9px] text-[var(--text-muted)]">共同時機：BeginShow／EndShow／BeginHide／EndHide／Enabled／Disabled／Selected／Unselected／Confirmed／CancelConfirmed</div>
                  {(u.additions ?? []).length > 0 && (
                    <div className="mt-1 pt-1 border-t border-[var(--border)] space-y-0.5">
                      <div className="text-[10px] text-amber-300">需機制追加</div>
                      {u.additions.map((a, i) => (
                        <div key={i} className={`text-[11px] rounded px-1.5 py-0.5 border ${a.done ? 'border-[var(--border)] text-[var(--text-muted)] line-through' : 'border-amber-400/50 bg-amber-400/10 text-amber-200'}`}>
                          {a.done ? '✓' : '⚠'} {rich(a.text)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border border-[var(--border)] rounded p-2 space-y-1 min-w-0">
                  <div className="text-[10px] text-[var(--text-muted)]">演出對應{skin ? `：${skin.name}` : ''}</div>
                  {skin
                    ? (skin.mapping ? <div className="text-[11px] text-[var(--text)]">{rich(skin.mapping)}</div> : <div className="text-[10px] text-[var(--text-muted)]">（md 的「演出對應」還沒有「### {skin.name}」小節）</div>)
                    : <div className="text-[10px] text-[var(--text-muted)]">（尚無提案）</div>}
                </div>
              </div>
            </Section>

            {/* 脈絡：出現的情境 */}
            <Section title="脈絡" hint="這個 UI 出現在哪些情境（點標題跳情境體驗）">
              {(u.scenarioIds ?? []).length ? u.scenarioIds.map(sid => {
                const sc = scenarioById.get(sid)
                const ex = sc ? seeHearExcerpt(sc, u) : []
                return (
                  <div key={sid} className="border border-[var(--border)] rounded p-2 space-y-1">
                    <button onClick={() => onJumpToScenario?.(sid)} className="text-[11px] text-[var(--gold)] hover:underline text-left">🎬 {sid.slice(0, 3)} {sc?.title ?? sid}</button>
                    {sc?.oneLiner && <div className="text-[11px] text-[var(--text)] italic">{sc.oneLiner}</div>}
                    {ex.length > 0 && (
                      <div className="space-y-0.5">
                        <div className="text-[9px] text-[var(--text-muted)]">玩家看到／聽到（摘錄）</div>
                        {ex.map((x, i) => (
                          <div key={i} className={`text-[10px] flex gap-1 ${x.related ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                            <span className="shrink-0">{x.marker}</span><span className="shrink-0 text-[9px] text-[var(--text-muted)]">{x.grp}</span>
                            <span className="min-w-0">{rich(x.text.length > 220 ? x.text.slice(0, 220) + '…' : x.text)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              }) : <div className="text-[10px] text-[var(--text-muted)]">（未標情境）</div>}
              {(u.missingScenarios ?? []).length > 0 && <div className="text-[9px] text-red-400">找不到情境檔：{u.missingScenarios.join('、')}</div>}
            </Section>

            {(u.openDecisions ?? []).length > 0 && (
              <Section title="⬜ 待定奪">
                {u.openDecisions.map(d => (
                  <div key={d.id} className={`border rounded p-2 space-y-1 ${d.resolved ? 'border-[var(--border)] opacity-60' : 'border-amber-400/30'}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${d.resolved ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-400/20 text-amber-300'}`}>{d.resolved ? '✓ 已定' : d.id}</span>
                      <span className="text-[11px] text-[var(--text)]">{d.title}</span>
                    </div>
                    {!d.resolved && d.status && <div className="text-[10px] text-[var(--text-muted)]"><b>現況</b>：{rich(d.status)}</div>}
                    {!d.resolved && d.options && <div className="text-[10px] text-emerald-300/80"><b>選項</b>：{rich(d.options)}</div>}
                    {d.resolved && d.resolution && <div className="text-[10px] text-emerald-300/80">{d.resolvedAt} 定案：{d.resolution}</div>}
                  </div>
                ))}
              </Section>
            )}

            {openAdditions.length > 0 && <div className="text-[9px] text-[var(--text-muted)]">⚠ 尚有 {openAdditions.length} 項需機制追加——機制補上前，皮不要自己推算遊戲狀態。</div>}
          </div>
        )}
      </div>
    </div>
  )
}
