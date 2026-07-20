// ─── 心腹啟動器（workflow pills ＋ 欄位 ＋ 評估勾選）────────────────────────────
// 少爺 2026-07-20：CHAT composer / 侍酒師結帳區 / QA 留言列三處共用的「輸入區塊心腹」。
// 模板 SSOT 在 workflows.js；pill 拖曳排序共用 /api/workflow-order 跨裝置同步。
// onLaunch(prompt)：⚡ 啟動時把組好的完整 prompt 交給宿主——宿主決定送出路徑
//（CHAT=handleSend、QA=留言喚醒、侍酒師=加入描述隨結帳帶出）。
import { useState, useEffect } from 'react'
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Tooltip, openInEdge, isFacebookUrl } from './chatSupport.jsx'
import { WORKFLOWS, DECISION_WORKFLOWS, EVAL_SUMMARY, buildEvaluationBlock, KNOWLEDGE_WORKFLOWS, buildConsistencyCheckBlock } from './workflows.js'

function SortablePill({ wf, wfType, setWfType }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: wf.id })
  return (
    <Tooltip content={wf.desc} disabled={isDragging}>
      <button
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={() => setWfType(wf.id === wfType ? null : wf.id)}
        style={{
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.5 : 1,
          touchAction: 'manipulation',
        }}
        className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold tracking-wide border transition-colors cursor-grab active:cursor-grabbing ${
          wfType === wf.id
            ? 'bg-[var(--gold)]/20 border-[var(--gold)] text-[var(--gold)]'
            : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
        }`}>
        <span>{wf.icon}</span><span>{wf.label}</span>
      </button>
    </Tooltip>
  )
}

function WorkflowLauncher({ onLaunch, running = false, extraPills = null, launchLabel = '⚡ 啟動',
                            className = 'border-b border-[var(--border)] bg-[var(--surface-2)] p-2' }) {
  const [wfType, setWfType]                 = useState(null)
  const [wfUrl, setWfUrl]                   = useState('')
  const [wfThought, setWfThought]           = useState('')
  const [withEvaluation, setWithEvaluation] = useState(true)   // 決策類心腹附上評估框架（D 方案）
  const [workflowOrder, setWorkflowOrder]   = useState([])     // 心腹 pill 排序（跨裝置同步）

  // On mount: 拉取 workflow 排序（跨裝置同步）
  useEffect(() => {
    fetch('/api/workflow-order').then(r => r.json()).then(d => {
      if (Array.isArray(d.order) && d.order.length) setWorkflowOrder(d.order)
    }).catch(() => {})
  }, [])

  function handleWorkflowSend() {
    const wf = WORKFLOWS.find(w => w.id === wfType)
    if (!wf) return
    let prompt = wf.build(wfUrl.trim(), wfThought.trim())
    if (withEvaluation && DECISION_WORKFLOWS.includes(wfType)) {
      prompt += '\n' + buildEvaluationBlock(wfType)
    }
    if (KNOWLEDGE_WORKFLOWS.includes(wfType)) {
      prompt += '\n' + buildConsistencyCheckBlock()
    }
    setWfType(null); setWfUrl(''); setWfThought('')
    onLaunch(prompt)
  }

  // 根據 workflowOrder 重排 WORKFLOWS，新加入的 workflow 自動放到尾端
  const orderedWorkflows = (() => {
    if (!workflowOrder.length) return WORKFLOWS
    const map = new Map(WORKFLOWS.map(w => [w.id, w]))
    const result = []
    for (const id of workflowOrder) {
      const w = map.get(id)
      if (w) { result.push(w); map.delete(id) }
    }
    for (const w of map.values()) result.push(w)  // 新增的 workflow 接在後面
    return result
  })()

  // 拖曳感應器：桌面 PointerSensor（6px 啟動距離避免誤觸），手機 TouchSensor（長按 200ms 啟動）
  const sortSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  function handleWorkflowDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = orderedWorkflows.findIndex(w => w.id === active.id)
    const newIdx = orderedWorkflows.findIndex(w => w.id === over.id)
    const nextOrder = arrayMove(orderedWorkflows, oldIdx, newIdx).map(w => w.id)
    setWorkflowOrder(nextOrder)
    fetch('/api/workflow-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: nextOrder }),
    }).catch(() => {})
  }

  return (
    <div className={className}>
      {/* Workflow type pills（＋宿主自帶的額外 pills，例如 CHAT 的 請繼續 / FB 暫存 / 人脈盤查） */}
      <div className="flex gap-1.5 overflow-x-auto pb-1.5 mb-2">
        <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragEnd={handleWorkflowDragEnd}>
          <SortableContext items={orderedWorkflows.map(w => w.id)} strategy={horizontalListSortingStrategy}>
            {orderedWorkflows.map(wf => (
              <SortablePill key={wf.id} wf={wf} wfType={wfType} setWfType={setWfType} />
            ))}
          </SortableContext>
        </DndContext>
        {extraPills}
      </div>
      {/* Selected workflow fields */}
      {(() => {
        const wf = WORKFLOWS.find(w => w.id === wfType)
        if (!wf) return (
          <div className="text-[9px] text-[var(--text-muted)] text-center py-1">選擇心腹成員</div>
        )
        const isUrl = (s) => { try { new URL(s); return true } catch { return false } }
        const openWfUrl = () => {
          const u = wfUrl.trim()
          if (!isUrl(u)) return
          // FB 網域自動走 Edge；其他網域讓系統預設瀏覽器處理（這裡仍請 server 用 Edge）
          openInEdge(u)
        }
        return (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <input value={wfUrl} onChange={e => setWfUrl(e.target.value)}
                placeholder={wf.urlLabel}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)] font-mono" />
              <button onClick={openWfUrl} onTouchEnd={e => { e.preventDefault(); openWfUrl() }}
                disabled={!isUrl(wfUrl.trim())}
                title={isFacebookUrl(wfUrl.trim()) ? '開啟 FB 網址（Edge，避開 Chrome 擴充衝突）' : '在 Edge 瀏覽器開啟此網址'}
                className={`shrink-0 px-2 py-1 rounded border text-[10px] hover:text-[var(--text)] disabled:opacity-30 disabled:cursor-not-allowed ${
                  isFacebookUrl(wfUrl.trim())
                    ? 'border-[var(--gold)]/60 text-[var(--gold)]/80 hover:border-[var(--gold)] hover:text-[var(--gold)]'
                    : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--gold-border)]'
                }`}
                style={{ touchAction: 'manipulation' }}>
                🌐 Edge{isFacebookUrl(wfUrl.trim()) ? ' (FB)' : ''}
              </button>
            </div>
            <div className="flex gap-1.5">
              <input value={wfThought} onChange={e => setWfThought(e.target.value)}
                placeholder={wf.thoughtLabel}
                onKeyDown={e => { if (e.key === 'Enter') handleWorkflowSend() }}
                className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--gold-border)]" />
              <button onClick={handleWorkflowSend} disabled={running || !wfType}
                className="px-3 py-1 rounded bg-[var(--gold)]/20 border border-[var(--gold)]/60 text-[var(--gold)] text-[10px] font-semibold hover:bg-[var(--gold)]/30 disabled:opacity-40 shrink-0">
                {launchLabel}
              </button>
            </div>
            {DECISION_WORKFLOWS.includes(wfType) && (
              <label className="flex items-center gap-1.5 text-[9px] text-[var(--text-muted)] cursor-pointer select-none"
                     title={`此心腹的評估維度：${EVAL_SUMMARY[wfType]}`}
                     style={{ touchAction: 'manipulation' }}>
                <input type="checkbox" checked={withEvaluation}
                  onChange={e => setWithEvaluation(e.target.checked)}
                  className="accent-[var(--gold)] cursor-pointer" />
                <span>附上評估框架（{EVAL_SUMMARY[wfType]}）</span>
              </label>
            )}
          </div>
        )
      })()}
    </div>
  )
}

export { WorkflowLauncher }
