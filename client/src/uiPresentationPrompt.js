// 介面視覺層的非元件共用：購物車 key、選件快照與結帳 prompt 壓縮（拆出 UiPresentationView.jsx 讓 Fast Refresh 只看到元件）
export const uiKey = (pid, uid) => `${pid}:ui:${uid}`
export const UI_PURPOSE_LABEL = { '豐': '畫面豐富度', '教': '教學提示', '資': '資訊與介面設定' }

/** 介面視覺條目 → 購物車選件快照（帶 md 路徑與目前選的皮） */
export function cartItemOfUi(InPid, InData, InUiPresentation, InUi, InSkin) {
  const _dir = String(InUiPresentation?.presentationDir ?? '').replace(/\\/g, '/')
  return {
    key: uiKey(InPid, InUi.id), project: InData?.project, nodeKind: 'ui',
    uiId: InUi.id, uiNum: InUi.num, uiTitle: InUi.title, group: InUi.group, groupName: InUi.groupName,
    purpose: InUi.purpose, purposeAlso: InUi.purposeAlso, status: InUi.status,
    mdPath: _dir ? `${_dir}/${InUi.file}` : InUi.file,
    wbp: InUi.wbp, cppClass: InUi.cppClass, scenarios: InUi.scenarios ?? [],
    events: (InUi.events ?? []).map(e => e.ref ? `${e.name}@${e.ref}` : e.name),
    additions: (InUi.additions ?? []).filter(a => !a.done).map(a => a.text),
    skinCount: (InUi.skins ?? []).length,
    skin: InSkin ? { name: InSkin.name, file: InSkin.file, anchor: InSkin.anchor, status: InSkin.status } : null,
  }
}

// 結帳 prompt 用：把 UI 壓成幾行（與 Sommelier.jsx composePrompt 的其他 nodeKind 同風格）
export function uiPromptLines(idx, it) {
  const _purpose = `${it.purpose}${it.purposeAlso ? `兼${it.purposeAlso}` : ''}`
  const lines = [`${idx + 1}. 【介面視覺】#${it.uiNum} ${it.uiTitle}（${it.group} ${it.groupName}／目的 ${_purpose}／${it.status}）`]
  lines.push(`   檔案: ${it.mdPath}`)
  lines.push(it.skin
    ? `   目前選的皮: ${it.skin.name}（${it.skin.file}${it.skin.anchor ? '#' + it.skin.anchor : ''}，${it.skin.status}）${it.skinCount > 1 ? `；共 ${it.skinCount} 個皮` : ''}`
    : '   目前選的皮: （尚無提案）')
  if (it.wbp || it.cppClass) lines.push(`   WBP: ${it.wbp || '（無）'} · C++: ${it.cppClass || '?'}`)
  if (it.events?.length) lines.push(`   機制事件: ${it.events.join(' | ').slice(0, 700)}`)
  if (it.additions?.length) lines.push(`   ⚠ 需機制追加: ${it.additions.join(' | ').slice(0, 500)}`)
  if (it.scenarios?.length) lines.push(`   情境: ${it.scenarios.join(', ')}`)
  lines.push('   → 機制與演出分開（演出＝可換的皮，只訂閱機制事件）；皮需要新時機就寫進該 md「需機制追加」，演出對應寫在「演出對應」該皮的小節；改完跑 extract_ui_presentation.mjs')
  return lines
}
