// ─── 心腹（workflow prompt 模板）定義（2026-07-20 自 App.jsx ChatPanel 內搬出成模組）──────
// 原為 ChatPanel 函式內宣告；皆為純資料與純函式，搬到模組層供各分頁內嵌對話共用。

  const WORKFLOWS = [
    {
      id: 'youtube', icon: '🎬', label: 'YouTube 吸收',
      desc: 'YouTube 影片深度吸收\n自動查創作者含金量、下字幕、時序因果分析、整理到 knowledge/',
      urlLabel: '影片網址', thoughtLabel: '吸收後的期望或重點方向',
      build: (url, thought) =>
`我貼上一部影片讓你做深度知識吸收，請依照以下步驟：

1. 確認作者含金量（查 memory/reference_youtube_creators.md）；若未記錄，先告訴我再繼續
2. 在 AI_Utils/ 用 yt-dlp 下載 SRT 字幕，再用 Read 工具讀取全文
3. **時序因果分析**：還原影片的敘事結構——作者的鋪陳→論點→轉折→結論各在哪個時間點、前後邏輯是什麼
4. **視覺缺口標記**：字幕沒說但影片明顯在展示的內容（程式碼、圖表、演示動作），標記為「[視覺補充待確認]」
5. 萃取對羅馬專案或 UE 開發有價值的知識，整理為 .agent/knowledge/[主題].md（格式：Raw Data → Narrative Flow → Key Insights → Visual Gaps → Clues for Further Investigation）
6. 更新 MEMORY.md 索引

影片：${url}
我的想法：${thought || '（未填）'}`,
    },
    {
      id: 'report', icon: '📰', label: '報導/查驗',
      desc: '報導事實查驗 + 協作反思\n交叉比對可信度、提取有用部分、評估對協作的意義',
      urlLabel: '報導或文章網址', thoughtLabel: '這篇對我們協作的意義是什麼',
      build: (url, thought) =>
`我貼上一篇報導讓你查驗並沉澱為協作基石：

1. 用 WebFetch 或 WebSearch 讀取完整內容
2. **事實查驗**：找出報導的核心主張，交叉比對其他來源，標記「可信／存疑／未經證實」
3. **提取對我們有用的部分**：這篇報導如何影響我們的開發方向、工具選擇、或協作方式
4. **協作反思**：根據這篇內容，評估我們目前的協作模式是否還是最理想的，列出可改進的具體點
5. 將查驗結果與洞察整理為 .agent/knowledge/ 下的參考文件

報導網址：${url}
對協作的意義：${thought || '（未填）'}`,
    },
    {
      id: 'tutorial', icon: '📖', label: '教學/文件',
      desc: '教學文章 / 官方文件深度吸收\n自動找前後系列、整合成 knowledge/[主題].md',
      urlLabel: '教學文章或官方文件網址', thoughtLabel: '想補齊的知識方向',
      build: (url, thought) =>
`我貼上一篇教學或文件讓你補齊完整知識：

1. 用 WebFetch 讀取主文內容
2. **找前後系列**：確認這篇是否屬於某個系列（第幾篇、有無 Part 1/2/3、官方文件的相鄰章節），把完整系列清單列出來
3. **逐一吸收系列文章**：依序讀取所有相關篇章，不留知識缺口
4. 整合所有文章，整理為結構完整的 .agent/knowledge/[主題].md，包含：概念全貌、關鍵 API/步驟、常見坑、與羅馬專案的對應點
5. 更新 MEMORY.md 索引

文章網址：${url}
知識補齊方向：${thought || '（未填）'}`,
    },
    {
      id: 'aicase', icon: '👥', label: 'AI 協作案例',
      desc: '分析別人的 AI 協作案例\n提煉協作模式、做差距分析、具體改進建議',
      urlLabel: 'FB 貼文或社群連結（或貼上截圖說明）', thoughtLabel: '覺得哪個做法值得學習或反思',
      build: (url, thought) =>
`我分享一個別人與 AI 協作的案例，請分析並找出我們可以借鏡的地方：

1. 讀取或理解案例內容（網址 / 截圖說明）
2. **提煉協作模式**：他們用了什麼方法、工具、提示詞結構，與我們的做法有何不同
3. **差距分析**：他們做到了我們還沒做到的是什麼？我們有沒有比他們更好的地方？
4. **改進建議**：具體列出 1~3 個可以直接套用或調整到我們協作中的做法
5. 若值得長期參考：更新 memory/feedback_*.md 或 preferences.md

案例來源：${url || '（見我的補充說明）'}
我覺得值得學習的點：${thought || '（未填）'}`,
    },
    {
      id: 'github', icon: '🔗', label: 'GitHub 倉庫',
      desc: 'GitHub repo 整合決策\n全面理解 + 社群經驗 + 推薦 Fork / 整合 / 學原理 路線',
      urlLabel: 'GitHub repo 網址', thoughtLabel: '想怎麼用它（fork / 整合 / 學原理）',
      build: (url, thought) =>
`我分享一個 GitHub 倉庫，請做全面理解並給出行動建議：

1. 用 WebFetch 讀取 README、主要文件、CHANGELOG
2. **全面理解 repo**：它解決什麼問題、架構是什麼、核心技術原理是什麼
3. **社群使用經驗**：搜尋 Issues、Discussions、相關教學文章或 YouTube 影片，找出常見坑與最佳實踐
4. **與我們的關聯評估**：
   - Fork 路線：值得 fork 嗎？哪些部分要改造才符合我們需求？
   - 整合路線：可以直接當 dependency 或插件嗎？
   - 學習路線：主要是理解原理技術，不直接使用
5. 產出建議報告：推薦哪條路線 + 具體下一步行動
6. 若決定採用：整理關鍵知識到 .agent/knowledge/[repo名稱].md

Repo：${url}
初步想法：${thought || '（未填）'}`,
    },
    {
      id: 'screenshot', icon: '📸', label: '截圖解析',
      desc: '截圖解析推導實作方案\n對照 GASP 知識庫，從截圖推導羅馬版本（禁止自行發明）',
      urlLabel: '截圖說明或對應系統', thoughtLabel: '要解決的問題或疑惑',
      build: (url, thought) =>
`我貼上截圖讓你解析並推導實作方案：
1. 先查 .agent/knowledge/ 有無相關既有分析
2. 識別截圖中的架構、關鍵節點與數值
3. 對照 GASP 知識庫，推導羅馬專案的對應實作（不自行發明，從截圖推導）
4. 產出可直接執行的步驟

截圖說明／系統：${url}
要解決的問題：${thought || '（未填）'}`,
    },
    {
      id: 'knowledge', icon: '📚', label: '知識庫擴充',
      desc: '擴充 .agent/knowledge/ 再回答\n先補齊資料，再用新資料回應（避免憑舊印象）',
      urlLabel: '主題或文件網址', thoughtLabel: '具體想知道什麼',
      build: (url, thought) =>
`請針對以下主題擴充 .agent/knowledge/，再回答我：
1. 搜尋 .agent/knowledge/ 現有相關資料並評估是否足夠
2. 若不足：補充分析，寫入 knowledge/[主題].md
3. 補充完成後，用新資料回答問題

主題／資料來源：${url}
具體問題：${thought || '（未填）'}`,
    },
    {
      id: 'anim', icon: '🎞', label: '動畫自動加工',
      desc: '動畫自動加工 A×B 組合\nA=搜尋方法、B=操作類型；缺一必先問、不擅自假設',
      urlLabel: 'A：搜尋方法（或動畫路徑）', thoughtLabel: 'B：操作類型（或目標說明）',
      build: (url, thought) =>
`動畫自動加工任務，請先確認 A × B 組合再執行：

A（搜尋方法）：${url || '（請補充）'}
B（操作類型）：${thought || '（請補充）'}

參考：.agent/workflows/z_sub_anim_auto_process.md
若 A 或 B 未指定，先向我提問確認，不可擅自假設。`,
    },
    {
      id: 'dream', icon: '🧠', label: 'Dream Pass',
      desc: '定期記憶整理清理\n冗餘/過時/重複的 memory 條目合併或淘汰',
      urlLabel: '（選填）特別關注的領域', thoughtLabel: '（選填）本次清理的重點指示',
      build: (url, thought) =>
`做一次 dream pass。
${url ? `特別關注：${url}` : ''}
${thought ? `重點指示：${thought}` : ''}
參考流程：.agent/workflows/dream_pass.md`.trim(),
    },
    {
      id: 'debug', icon: '🔬', label: '除錯流程',
      desc: '變數隔離 + 基準比較除錯\n不直接猜原因，列變數 → 最小可重現 → 一次改一個',
      urlLabel: '異常現象描述', thoughtLabel: '懷疑方向或已嘗試過的做法',
      build: (url, thought) =>
`除錯任務，請用「變數隔離 + 基準比較」方法，不要直接猜原因：

異常現象：${url}
懷疑方向：${thought || '（未填）'}

步驟：
1. 確認「已知正常的基準狀態」是什麼
2. 列出可能影響的變數清單
3. 設計最小可重現路徑
4. 一次只改一個變數驗證，記錄結果`,
    },
    {
      id: 'handoff', icon: '📋', label: 'Session 交接',
      desc: 'Session 中途交接\n整理成果 + 更新 last_session_state.md + 列下 session 優先事項',
      urlLabel: '（選填）本次 session 主要做了什麼', thoughtLabel: '下個 session 的優先事項',
      build: (url, thought) =>
`請幫我做 Session 交接：
1. 整理本次 session 的主要成果（完成了什麼、遺留什麼）
2. 更新 .agent/last_session_state.md
3. 確認有需要同步到 memory/ 或 knowledge/ 的新知識
4. 列出下個 session 的優先待辦

本次摘要：${url || '（請自行從對話推導）'}
下個 session 優先事項：${thought || '（請自行從對話推導）'}`,
    },
    {
      id: 'trace', icon: '🎯', label: '系統追溯',
      desc: 'UE 系統追溯\n從畫面描述 / 系統名稱反推實作，L1-L4 齊全度判定 → 實作 / 補全 / 建 TODO',
      urlLabel: '畫面描述 或 UE 系統名稱',
      thoughtLabel: '特別關注的情境、目標效果、延伸方向',
      build: (url, thought) =>
`UE 系統追溯任務：從畫面 / 系統名稱反推 UE 實作，判斷知識是否足以動手。

描述 / 系統名稱：${url}
特別關注：${thought || '（未指定）'}

## 第 1 步：判定知識齊全度

依 L1-L4 權威等級查詢（參照 MEMORY.md「知識來源權威分級」）：
- **L1** 羅馬專案實際 C++/BP/Asset（是否已有類似實作）
- **L2** .agent/knowledge/ 的 GASP_*.md / Engine_*.md 條目
- **L3** UE 官方文件 / 教學（需 WebFetch 驗證版本）
- **L4** ★★★★★ 創作者教學（查 memory/reference_youtube_creators.md）

**齊全標準**：至少一項 L1-L4 有明確成功案例支持（可直接照搬或小改）

## 第 2 步：依齊全度分支

### A. 不齊全（缺口明顯）
- 說清楚「我懂的部分」（明確引用 L1-L4 來源）
- 列出缺口：具體哪些細節沒有明確資料
- 給我兩個選項：
  1. 走「📚 知識庫擴充」或「📖 教學/文件」心腹先補全
  2. 用現有知識先給方向性建議（承擔部分不確定）
- 等我選哪條路再動，不要自行決定

### B. 齊全（成功案例明確）
提供完整內容：
- 核心系統 / 類別 / 類別階層
- 關鍵 API / 節點 / 資產型別
- 常見坑 / 注意事項
- **明確引用 L1-L4 來源**（檔名 + 章節或時間戳）

然後問我選哪個方向：
1. **直接提實作方案**，我確認細節後開工
2. **列出近期最可能實作的延伸話題**（例如：這技術還能用在 X / Y / Z），討論後決定優先順序

等我確認後：
- 「實作」→ 進入實作階段
- 「建 TODO」→ 之後 TODO 看板做好可寫進去（階段：💡 想到了 / 🗣 討論中）
- 「擱置 / 倉庫」→ 記錄歸檔暫不實作

## 禁忌
- 禁止自行發明實作方式（必須有 L1-L4 來源支持）
- 禁止將 L6 歸檔當事實依據（僅供 fork 參考，以 L1-L4 為準）
- 禁止從空白處畫想像，必從 Baseline（現有系統）推導`,
    },
    {
      id: 'plan', icon: '🏗', label: '新功能規劃',
      desc: '疊加不破壞原則規劃新功能\n探勘現有邊界 + 旁邊加不動主幹 + 驗證清單',
      urlLabel: '功能描述或相關資料連結', thoughtLabel: '希望如何疊加（不改哪些部分）',
      build: (url, thought) =>
`新功能規劃，請用「疊加不破壞」原則：

功能描述：${url}
疊加方向：${thought || '（未填）'}

步驟：
1. 用 git diff / grep 確認現有穩定架構的邊界
2. 確認新功能影響哪些現有路徑
3. 設計「在舊功能旁邊加，不動舊功能主幹」的方案
4. 列出完成後的驗證清單（確認舊功能仍正常）`,
    },
    {
      id: 'close', icon: '🏁', label: '結案結算',
      desc: 'Session 收尾結算\n成果摘要 + 遺留清單 + 同步知識 + 變更清單 + TODO 看板掃描',
      urlLabel: '（選填）本 Session 完成的主要成果', thoughtLabel: '（選填）遺留或要交接的事項',
      build: (url, thought) =>
`結案結算 — 本次 Session 要收尾，請幫我處理：

1. **成果摘要**：本次 Session 完成的事項清單，以及大致的時間／token 花費範圍
2. **遺留清單**：未完成或遺留的 TODO，附上下次可以直接切入的起點（檔案路徑 / 函式 / 待決策問題）
3. **更新 .agent/last_session_state.md**：讓下個 Session 用「🚀 Session 啟動」能無縫接上
4. **同步新知識**：把本次新發現的規律、踩坑、決策理由，寫進對應的 memory/feedback_*.md 或 knowledge/
5. **變更清單**：列出該 commit 的檔案（分組別：code / memory / docs），但不要自作主張 commit，等我確認
6. **規矩快照**：若本次評分資料有顯著變化，建議我去規矩頁面按「⚡ 分析並存檔」

7. **⭐ TODO 看板掃描**（GET /api/todos）：
   - 列出本次 session 動過的卡（updatedAt 在 session 期間內）
   - 列出仍在「實作中」「驗證中」的卡，附上 sessionId 對應關係
   - 找出「擱置」超過 7 天的卡，建議翻倉庫或重啟
   - 找出「想到了」超過 30 天的卡，建議移倉庫
   - 沒被討論過的「想到了」卡，建議下次 session 啟動優先處理
   - 任何在 \`memory/MEMORY.md\` 待處理區的議題，但 TODO 看板沒對應卡的，建卡
   - 任何已標完成但 MEMORY.md 還列待辦的，跨 Session 全面同步（參 \`feedback_cross_session_full_sync.md\`）

本次主要成果：${url || '（請自行從對話推導）'}
遺留事項：${thought || '（請自行從對話推導）'}`,
    },
    {
      id: 'start', icon: '🚀', label: 'Session 啟動',
      desc: 'Session 啟動接手前情\n讀 last_session_state + 規矩確認 + TODO 掃描 + 推薦起手式',
      urlLabel: '（選填）今天想聚焦的主題', thoughtLabel: '（選填）特別想避免或警覺的事',
      build: (url, thought) =>
`Session 啟動 — 請幫我暖機：

1. **讀取上次交接**：.agent/last_session_state.md 拿到上次 session 的接續點
2. **掃描在途工作**：memory/MEMORY.md 的「待處理任務」段，列出目前進行中的項目
3. **⭐ TODO 看板掃描**（GET /api/todos）：
   - 列出當前「實作中」「驗證中」「討論中」的卡，按 updatedAt 排序
   - 列出有 sessionId 但 session 已關閉的卡（孤兒卡），建議是否要重啟接續
   - 列出超過 7 天無更新的「擱置」卡，提醒考慮翻倉庫或重啟
   - 列出本週新增的「想到了」卡，看是否值得這次 session 處理
4. **載入今日上下文**：如果有聚焦主題，主動載入對應的 .agent/knowledge/*.md 檔案
5. **環境檢查**：git status / 未 commit 的變更 / pm2 服務狀態 / 上次雙版本編譯是否通過
6. **⭐ 雙軌同步檢查**（feedback_dual_continuity_strategy）：
   - MEMORY.md 待處理 vs TODO 看板狀態是否一致
   - project_*.md 結案標記 vs MEMORY.md / TODO 是否同步
   - 不一致 → 立即補同步
7. **建議起手式**：告訴我今天第一步建議從哪裡開始，並列出 2~3 個可選方向讓我挑
8. **規矩確認**：讀取目前的偏好文字（PREF_TEXT_KEY），確認風格基準

今天想聚焦：${url || '（還沒決定，請從待辦中推薦）'}
警覺事項：${thought || '（無）'}`,
    },
  ]

  // 決策類心腹：需要「做法選項 + 優劣 + 商機 + 效能 + 風險 + 推薦」評估
  const DECISION_WORKFLOWS = ['plan', 'debug', 'github', 'report', 'tutorial', 'anim', 'trace']

  // 各心腹 checkbox 顯示的評估重點摘要（UI 端同步顯示）
  const EVAL_SUMMARY = {
    plan:     '做法優劣／商機／效能／疊加風險／推薦',
    debug:    '根因假設／驗證步驟／副作用／回滾／推薦',
    github:   '健康度／契合度／採用方式／整合成本／推薦',
    report:   '含金量／誤區／借鏡價值／風險／推薦',
    tutorial: '含金量／重疊度／補齊方向／吸收深度／推薦',
    anim:     'A×B 組合／品質vs速度／批次可行性／效能／推薦',
    trace:    '齊全度／缺口／實作選項／效能／疊加風險／推薦',
  }

  function buildEvaluationBlock(mode) {
    const bodies = {
      // 🏗 新功能規劃 — 完整 6 維度
      plan:
`### 1. 做法選項
至少列出 2 個可行方案（A / B [/ C]），各自一句話說明核心思路

### 2. 各方案優劣
- 實作複雜度（幾行改動、需動多少檔）
- 可維護性（未來改動成本、理解門檻）

### 3. 商機 / 長期價值
- 能沉澱什麼（知識庫條目、工具、pattern）
- 能否重用到其他模組 / 專案

### 4. 效能風險
- 記憶體、幀率、同屏規模影響（UE 專案特別關注）
- 最壞情況 benchmark 預估

### 5. 疊加不破壞風險
- 會動到哪些現有穩定路徑
- 回滾成本（好退？難退？）

### 6. 推薦選項 + 理由
明確下結論，不只列表；若我堅持某方案，說明你會怎麼補強它的風險面`,

      // 🔬 除錯流程 — 根因優先
      debug:
`### 1. 根因假設
列出至少 2 個可能根因（H1 / H2 ...），各自附支持證據與反對證據

### 2. 驗證步驟
每個假設給出具體驗證方法（grep 什麼、改什麼變數隔離、用什麼指令觀察）
排序由便宜到昂貴，先做便宜的

### 3. 副作用評估
若按主推方向修復，連帶會影響哪些現有路徑？有無隱性耦合？

### 4. 回滾路徑
修改點在哪、回滾成本（git revert 即可？還是需要手動拆？）

### 5. 疊加不破壞點檢
對照現有穩定行為，列出修復後必須仍正常的 3-5 個驗證點

### 6. 推薦修復方向 + 理由
下結論：先做哪個假設的驗證、為何先這個；若根因已幾乎確定就直接給修復方案`,

      // 🔗 GitHub 倉庫 — 整合決策
      github:
`### 1. 倉庫健康度
- 授權（MIT / GPL / 商用可否）
- 近期活躍度（last commit / issue 回應速度）
- star / fork 規模
- 維護者可靠性

### 2. 架構契合度
- 與現有專案是否相容（UE 版本 / 相依性衝突）
- 命名規範、C++ 風格是否與我們落差大

### 3. 採用方式選項
列出 2-3 種採用路徑：
- Fork 深度客製
- 作為 submodule / plugin 掛載
- 抽概念重寫
- 只學原理不引入

### 4. 取代現有方案風險
如果我們已有類似工具，換過去的機會成本是什麼？

### 5. 整合成本 + 維護負擔
- 學習曲線
- API 穩定度（上游若大改我們跟不跟）
- 長期維護要不要投人

### 6. 推薦採用方式 + 理由
明確下結論，指出若選推薦方案該從哪一步動手`,

      // 📰 報導/查驗 — 資訊可信度
      report:
`### 1. 含金量評估
- 資料來源可信度（一手 / 二手 / GPT 味 / 農場）
- 作者權威性（背景、過往作品）
- 是否有可驗證的具體事實（版本號、benchmark、code link）

### 2. 誤區辨識
找出文章中「看似合理但其實錯」或「過度簡化」的點
特別注意：時效性落後、脫離上下文的結論、商業置入

### 3. 借鏡價值
哪些部分可直接吸收、哪些需要改造、哪些只是靈感

### 4. 與既有知識的差距 / 重疊
對照我們的 memory / knowledge，是補洞還是重複？

### 5. 潛在風險
盲目套用會踩什麼雷（效能 / 架構污染 / 維護陷阱）

### 6. 推薦行動 + 理由
下結論：深讀筆記 / 摘要存檔 / 跳過 / 進一步查證某點`,

      // 📖 教學/文件 — 知識吸收決策
      tutorial:
`### 1. 知識含金量
- 深度（基礎教學？進階？官方 API？）
- 正確性（有無驗證過的程式碼、輸出範例）
- 新舊程度（UE 版本、API 是否 deprecated）

### 2. 與現有知識庫重疊度
查 memory / knowledge 現有條目，這份資料是補空白、強化、還是重複？

### 3. 補齊方向
- 值得吸收成 knowledge/ 條目嗎？路徑建議？
- 是否需要拆成多個小條目

### 4. 實用場景
對羅馬專案 / TheClaudenental 有哪些直接用到的地方（具體點名檔案或系統）

### 5. 時間投資 vs 回報
讀完需要多久、吸收後能節省多少未來的時間

### 6. 推薦吸收深度 + 理由
下結論：深讀 + 寫條目 / 快速摘要存檔 / 只記 reference 連結 / 跳過`,

      // 🎯 系統追溯 — L1-L4 齊全度 + 實作方向 + 疊加風險
      trace:
`### 1. 知識齊全度評分
逐一盤點 L1-L4 來源支持度（0-5 分）：
- L1 羅馬專案實作：找到幾個類似例子？位置？
- L2 knowledge/ GASP_*.md / Engine_*.md：哪些條目涵蓋？
- L3 UE 官方文件 / 教學：有明確 API / 範例嗎？
- L4 創作者教學：誰做過？品質等級？
總分評級：齊全（>=12）/ 勉強（8-11）/ 不齊全（<8）

### 2. 缺口分析 + 補全路徑
- 具體哪些細節沒資料（點名到變數 / 參數 / 函式層級）
- 補全建議：走「📚 知識庫擴充」/「📖 教學/文件」/「🎬 YouTube 吸收」哪條？
- 預估補全時間（概略：短<1h / 中1-3h / 長>3h）

### 3. 實作方案選項
列出 2-3 條可行路徑：
- 完全照搬 L1 現有實作
- 以 L2/L3/L4 為藍本，改造到羅馬環境
- 混合方案（部分照搬 + 部分自製）
各自一句話說明核心取捨

### 4. 效能風險
- UE 同屏 150-200 人 / 25 玩家士兵規模下的影響
- 記憶體、幀率、Tick 成本
- LOD 策略需求

### 5. 疊加不破壞風險
- 會動到羅馬現有哪些穩定路徑（Character / ABP / Mover / AI / CR）
- 與現有 Formation / RomanCharacter / 大盾等系統的相容性
- 回滾成本（好退？難退？）

### 6. 推薦方向 + 下一步
下結論：
- **立即實作**（哪個方案、從哪一步動手）
- 或 **建 TODO**（放 💡 想到了 / 🗣 討論中 哪一階段）
- 或 **擱置歸檔**（說明擱置條件，何時翻出來）
若我堅持某方向，說明你會怎麼補強它的風險面`,

      // 🎞 動畫自動加工 — 加工路徑選擇
      anim:
`### 1. 加工方法選項
列出 2-3 種可行方法（對照 z_sub_anim_auto_process.md 的 A × B 組合）：
- AnimModifier（Blueprint 批次）
- ControlRig（執行期或 bake）
- Python 批次（離線）
- 手動調整

### 2. 品質 vs 速度 trade-off
各方法的輸出品質 / 處理時間 / 錯誤容忍度比較

### 3. 批次處理可行性
- 能一次處理多少資產
- 錯誤重做成本（單檔 retry 還是整批 rebuild）
- 是否可分段執行

### 4. 效能影響
- ABP 執行期成本（若是 runtime 方案）
- 記憶體佔用（新增 curve / notify 數量）
- 同屏規模瓶頸（150-200 人的影響）

### 5. 疊加不破壞風險
- 會不會動到現有角色 / 現有 BP
- 原始資產是否保留（可否回滾）
- 對 Retarget / IK 的下游影響

### 6. 推薦方法 + 理由
下結論：指定 A 搜尋法 × B 操作類型，並說明為什麼這個組合最適合這批資產`,
    }

    const body = bodies[mode] ?? bodies.plan
    return `
---

## 評估框架（請附在主回覆後）

請以「疊加不破壞」原則，提供結構化評估：

${body}`
  }

  // 會產出 knowledge 文件的心腹：必須做「知識一致性確認」
  const KNOWLEDGE_WORKFLOWS = ['youtube', 'report', 'tutorial', 'aicase', 'github', 'screenshot', 'knowledge', 'trace']

  function buildConsistencyCheckBlock() {
    return `
---

## 知識一致性確認（產出 knowledge 文件前必做）

**目的**：避免重複造輪、避免衝突、確保新知識與既有知識庫相互引用。

### 步驟
1. **盤點關鍵詞**：抽出本次主題的 3-5 個關鍵詞（系統名 / 工具 / 概念）
2. **grep 現有 knowledge**：對 \`.agent/knowledge/\` + \`memory/\` 跑關鍵詞 grep
3. **三類定位**：對每個 hit 做分類
   - **重疊**：既有資料已涵蓋此點 → 引用而非重寫
   - **衝突**：既有說法與本次來源不同 → 標 ⚠️ 並評估誰權威（用 L1-L4 等級判定）
   - **補洞**：既有沒提過 → 本次可作為新增章節
4. **新文件加「知識一致性比對」段**：表格形式列「現有資料 → 重疊/衝突/補洞」
5. **MEMORY.md 索引**：新文件加索引條目，引用其他相關文件時用 markdown link

### 重要度與參考價值分類
產出文件時，每個 Insight 標等級：
- 🔴 **核心**（VERIFIED + 對羅馬專案直接價值高）
- 🟡 **適用條件**（HYPOTHESIS + 需實測驗證）
- 🟢 **細節**（VERIFIED 但邊角資訊）

### 跨 Session 全面同步
若本次內容讓既有「待處理任務」變成已完成（如真因確認、結案）：
- 更新議題專屬 md（加結案標記）
- 移除 MEMORY.md 「## 待處理任務」對應條目
- TODO 看板對應卡推到 ✅ 完成
- grep \`.agent/workflows/\` + \`.agent/skills/\` 找引用，同步更新
- 半同步 = 沒同步（參 \`memory/feedback_cross_session_full_sync.md\`）`
  }

export { WORKFLOWS, DECISION_WORKFLOWS, EVAL_SUMMARY, buildEvaluationBlock, KNOWLEDGE_WORKFLOWS, buildConsistencyCheckBlock }
