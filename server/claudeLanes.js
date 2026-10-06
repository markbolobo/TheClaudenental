// 無頭聊天室的執行道：一個聊天室一條道。
//
// 少爺 2026-10-05「為什麼 TC 跨聊天室的操作又在排隊，而不是並行」：原本執行中表與隊伍都以專案路徑為鍵，
// 同專案任何兩個聊天室都互相排隊（當天實錄最久等 72 分鐘）。規則改為——
//   · 同一個聊天室同時只能有一個進程（同一份 transcript 不可雙寫、resume 撞交接縫隙會石沉），其餘排在該聊天室自己的隊伍
//   · 不同聊天室、不同專案一律並行
// 尚未拿到 session id 的新聊天室先掛暫時道名（new:n），init 後改掛真 id。
// 本模組只管記帳，不 spawn、不 broadcast——行為端在 index.js，機檢在 claudeLanes.check.mjs。

/** 專案路徑比對用（與 index.js normalizePath 同一把尺） */
function normProject(InPath) {
  return (InPath ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
}

export function createLaneRegistry() {
  // 道名（session id 或 new:n）→ 進程條目 { proc, sessionId, projectPath, status, ... }
  const procs = new Map()
  // session id → 排隊項目陣列 { projectPath, prompt, model, effort, onInit }
  const queues = new Map()
  // 石沉重試在途的 session id：重試前的空窗視同忙碌，新請求排隊而不是搶進同一個交接縫隙
  const holds = new Set()
  let seq = 0

  return {
    /** 登記新進程：有 session id 掛該 id，新聊天室掛暫時道名；回傳道名 */
    register(InEntry) {
      InEntry.laneKey = InEntry.sessionId ?? `new:${++seq}`
      procs.set(InEntry.laneKey, InEntry)
      return InEntry.laneKey
    },

    /** init 拿到真 session id → 道名改掛該 id（resume 回報同一個 id 時不動） */
    adopt(InEntry, InSessionId) {
      InEntry.sessionId = InSessionId
      if (!InSessionId || InEntry.laneKey === InSessionId) return
      if (procs.get(InEntry.laneKey) === InEntry) procs.delete(InEntry.laneKey)
      InEntry.laneKey = InSessionId
      procs.set(InSessionId, InEntry)
    },

    /** 進程結束後移出（道上已換成新進程時不動） */
    release(InEntry) {
      if (procs.get(InEntry.laneKey) === InEntry) procs.delete(InEntry.laneKey)
    },

    /** 該聊天室有進程在跑，或石沉重試在途 */
    isSessionBusy(InSessionId) {
      if (!InSessionId) return false
      return procs.get(InSessionId)?.status === 'running' || holds.has(InSessionId)
    },

    /** 該聊天室正在跑的進程條目（沒有回 null） */
    runningEntry(InSessionId) {
      const _e = InSessionId ? procs.get(InSessionId) : null
      return _e?.status === 'running' ? _e : null
    },

    /** 同專案正在跑的所有進程（給「專案有人在改檔就不提交」這類專案層閘門用） */
    runningInProject(InProjectPath) {
      const _p = normProject(InProjectPath)
      return [...procs.values()].filter(e => e.status === 'running' && normProject(e.projectPath) === _p)
    },

    /** 同專案還沒拿到 session id 的進程（新聊天室剛起跑、尚未 init） */
    pendingInitInProject(InProjectPath) {
      const _p = normProject(InProjectPath)
      return [...procs.values()].filter(e => e.status === 'running' && !e.sessionId && normProject(e.projectPath) === _p)
    },

    /** 排進該聊天室自己的隊伍；InCoalesce＝併入同室最後一則（QA 喚醒防堆成 N 個回合）。回傳 { pos, coalesced } */
    enqueue(InSessionId, InItem, { coalesce = false, coalesceSeparator = '\n\n' } = {}) {
      if (!InSessionId) throw new Error('enqueue 需要 session id（新聊天室不排隊、直接並行）')
      let _q = queues.get(InSessionId)
      if (!_q) { _q = []; queues.set(InSessionId, _q) }
      const _last = _q[_q.length - 1]
      if (coalesce && _last) {
        _last.prompt += `${coalesceSeparator}${InItem.prompt}`
        return { pos: _q.length, coalesced: true }
      }
      _q.push(InItem)
      return { pos: _q.length, coalesced: false }
    },

    /** 該聊天室閒置才取出下一則（忙碌或沒有回 null） */
    dequeue(InSessionId) {
      if (!InSessionId || this.isSessionBusy(InSessionId)) return null
      const _q = queues.get(InSessionId)
      if (!_q?.length) return null
      const _next = _q.shift()
      if (!_q.length) queues.delete(InSessionId)
      return _next
    },

    queueLength(InSessionId) {
      return queues.get(InSessionId)?.length ?? 0
    },

    hold(InSessionId) { if (InSessionId) holds.add(InSessionId) },
    unhold(InSessionId) { holds.delete(InSessionId) },

    /** 全部進程條目（含剛結束、10 秒內移出的） */
    entries() {
      return [...procs.values()]
    },
  }
}

/** 計數式集合：同一個 key 可被多個並行進程同時登記，全部釋放才算移除（取代 Set，API 同名） */
export function createRefCountSet() {
  const counts = new Map()
  return {
    add(InKey) { counts.set(InKey, (counts.get(InKey) ?? 0) + 1) },
    delete(InKey) {
      const _n = (counts.get(InKey) ?? 0) - 1
      if (_n > 0) counts.set(InKey, _n)
      else counts.delete(InKey)
    },
    has(InKey) { return counts.has(InKey) },
  }
}
