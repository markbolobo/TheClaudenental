# TheClaudenental — 開發協作者環境建置指南

> **🤖 給 Claude Code 用**：把這個資料夾打開，告訴 Claude「請依 SETUP_FOR_DEV.md 自動完成環境建置」，它會逐步執行下方指令、驗證、回報。
> **🧑 給人類用**：照下面 Step 0-9 做，每步有 ✅ 確認方法 / ❌ 故障處理。

完成後你會有：
- 一份**完全獨立**的 TheClaudenental 跑在你電腦上（跟 Mark 那邊資料隔離）
- 自己的 Anthropic API key 跑自己的 Claude Code
- 自己的 Tailnet 讓你從手機 / 平板看自己的 dashboard
- 完整的 PR workflow 跟 Mark 協作 codebase

**不會發生**（這是場景 A 純 dev 流程）：
- ❌ 看不到 Mark 的 chat / TODO / 規矩 / API 用量（資料完全隔離）
- ❌ 不需要加入 Mark 的 Tailnet
- ❌ 不會收到 Mark 分享的卡片（那是場景 B，這份文件不涵蓋）

---

## 🤖 給 Claude Code 的 Meta Prompt

如果你是 Claude Code 在讀這份文件協助使用者，請：

1. **依 Step 0 → Step 9 順序執行**，每步用對應驗證命令確認結果再往下
2. **遇到 ❌ 路徑** → 停下來，把錯誤訊息丟給使用者讓他看，問下一步怎麼處理
3. **指令執行前** → 先用簡短一句話告訴使用者你要做什麼
4. **API key / Tailscale account 等需要瀏覽器操作** → 不要嘗試自動化，明確告訴使用者「請開瀏覽器去 X」並等他確認完成
5. **寫入任何檔案前** → 確認路徑正確，避免覆蓋使用者既有檔案（如 `~/.claude/settings.json` 已有 hooks 配置）
6. **進度報告** → 每完成一步打勾並簡短說明下一步

---

## 整體流程

```
Step 0  確認前置需求（OS / 規格）
Step 1  申請 Anthropic API key（手動，瀏覽器）
Step 2  安裝 Node.js v24+
Step 3  安裝 Git
Step 4  安裝 Claude Code（VS Code Extension 或 CLI）
Step 5  Fork & Clone TheClaudenental
Step 6  npm install + 啟動 server + client
Step 7  驗證本機 dashboard 跑得起來
Step 8  安裝 Tailscale（建立你自己的 Tailnet — 從手機看你自己 dashboard）
Step 9  做改動 → push → 開 PR
```

---

## Step 0：確認前置需求

**需求**：Windows 10 / 11 · 8 GB RAM+ · 5 GB 磁碟+ · 穩定網路。

**驗證**：
```powershell
# Windows 版本
[System.Environment]::OSVersion
# RAM
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
# 磁碟空間（C: 剩餘）
(Get-PSDrive C).Free / 1GB
```

✅ Windows 版本顯示 10 或 11、RAM ≥ 8 GB、磁碟空餘 ≥ 5 GB → 繼續
❌ macOS / Linux → 暫未驗證，跟 Mark 確認

---

## Step 1：申請 Anthropic API key（你自己的）

**這步必須使用者手動做**，Claude Code 不要嘗試自動化。

1. 開瀏覽器去 [console.anthropic.com](https://console.anthropic.com)
2. 註冊 / 登入
3. 左側 **API Keys → Create Key** → 命名（例 `theclaudenental-dev`）
4. **複製並安全存放**（離開頁面就看不到了）

**強烈建議**（學自 2026-04 Google Cloud $18K 帳單事件）：
- 設 monthly **spend cap**（從 $20 起步）
- 開 email alert（用量達 50% / 80% / 100%）

✅ key 已存在密碼管理器
❌ key 不見 → 回 console 砍掉重做

**驗證**（驗 key 有效，不會花錢）：
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-api-XXX"   # 貼你的 key
curl -s https://api.anthropic.com/v1/messages `
  -H "x-api-key: $env:ANTHROPIC_API_KEY" `
  -H "anthropic-version: 2023-06-01" `
  -H "content-type: application/json" `
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

✅ 收到 JSON 回應含 `content` 字段 → key 有效
❌ 401 / 403 → key 錯，回 console check

---

## Step 2：安裝 Node.js v24+

### 自動安裝（推薦給 Claude Code 用）
```powershell
# 用 winget 自動裝 LTS
winget install OpenJS.NodeJS.LTS
# 重開 terminal 才生效
```

### 手動安裝
1. 進 [nodejs.org](https://nodejs.org) 下載 **LTS v24+**
2. installer 一路 Next
3. 重開 terminal / VS Code

**驗證**：
```powershell
node --version    # 應該 v24.x.x
npm --version     # 應該 10.x.x+
```

✅ Node v24+ → 繼續
❌ 找不到 node → 重開 terminal / 重啟電腦

---

## Step 3：安裝 Git

### 自動
```powershell
winget install Git.Git
```

### 手動
[git-scm.com](https://git-scm.com) 下載 → installer 一路 Next（含 Git Bash）

**驗證**：
```powershell
git --version    # 應該 git version 2.x.x
```

✅ Git 已裝
❌ 找不到 → 重開 terminal

---

## Step 4：安裝 Claude Code

### 方式 A：VS Code 擴充（推薦）
```powershell
# 先確保 VS Code 裝了
winget install Microsoft.VisualStudioCode
# 然後開 VS Code → Extensions → 搜 "Claude Code"（Anthropic 官方）→ Install
```

第一次用會跳登入，貼 Step 1 的 API key。

### 方式 B：CLI
```powershell
npm install -g @anthropic-ai/claude-code
claude login   # 會問你 API key，貼 Step 1 那個
```

**驗證**：
```powershell
# CLI 方式
claude --version

# VS Code 方式：開任何資料夾，啟動 Claude Code，能跟它對話即可
```

✅ Claude Code 能用
❌ 卡在登入 → 確認 API key 沒多餘空白 / 換行

---

## Step 5：Fork & Clone TheClaudenental

### 5-A：在 GitHub fork（推薦做法）
1. 進 [github.com/markbolobo/TheClaudenental](https://github.com/markbolobo/TheClaudenental)
2. 右上角點 **Fork** → 建到你帳號下
3. 之後改動推到你的 fork，從 fork 開 PR 回 upstream

### 5-B：clone 你的 fork
```powershell
cd C:\Project    # 或你習慣的工作目錄（不存在會被建出來）
git clone https://github.com/<你的-username>/TheClaudenental.git
cd TheClaudenental
git remote add upstream https://github.com/markbolobo/TheClaudenental.git
git fetch upstream
```

**驗證**：
```powershell
git remote -v
# 應該看到 origin（你的 fork）+ upstream（Mark 的）
```

---

## Step 6：npm install + 啟動

### 6-A：裝相依
```powershell
cd C:\Project\TheClaudenental\server
npm install
cd ..\client
npm install
cd ..
```

### 6-B：啟動

**Terminal 1**（server）：
```powershell
cd C:\Project\TheClaudenental\server
node index.js
# 應該看到 "Server running on http://localhost:3001"
```

**Terminal 2**（client，新開一個 terminal）：
```powershell
cd C:\Project\TheClaudenental\client
npm run dev
# 應該看到 "Local: http://localhost:4444"
```

### 6-C：開瀏覽器
```
http://localhost:4444
```

✅ 看到黑底金字 **THE CLAUDENENTAL** dashboard
❌ 連不上 → 看兩個 terminal 是否有紅字錯誤

**驗證**（從另一個 terminal 跑）：
```powershell
curl -s http://localhost:3001/api/health
# 應該回 JSON：{"ok":true,"connections":N,"sessions":N,...}
```

---

## Step 7：驗證本機 dashboard 跑得起來

開 dashboard 後檢查：
1. **THE CLAUDENENTAL** header 顯示 ✅
2. 右上 **👥 N/100** 連線數顯示 ✅
3. 各 tab 可切換（Chat / 待辦 / Tasks / History / 規矩 / Analytics / etc）✅
4. **Chat** tab 試送一條 prompt → 用你自己的 Anthropic key 跑 ✅

**進階驗證**：
1. VS Code 開 TheClaudenental 資料夾
2. 啟動 Claude Code
3. 跟 Claude 對話
4. dashboard 的 **Sessions** tab 應該看到該 session 出現

✅ 全部 work → 你環境建置完成
❌ 哪一步卡住 → 看終端紅字 + DevTools Console，回報 Mark + 截圖

---

## Step 8：安裝 Tailscale（建立你自己的 Tailnet）

> 這步是讓你**從手機 / 平板** 看到自己的 dashboard。對方想用 Mark 的 Tailnet 走，**這份文件不涵蓋**（那是場景 B）。

### 8-A：申請 Tailscale 帳號
1. 進 [tailscale.com](https://tailscale.com) → 用 Google / Microsoft / GitHub OAuth 登入
2. 你會自動拿到一個免費的 Tailnet（個人版可加 100 台裝置）

### 8-B：在電腦裝 Tailscale
```powershell
winget install Tailscale.Tailscale
# 或手動下載：https://tailscale.com/download/windows
```

### 8-C：登入電腦
```powershell
tailscale up
# 會跳瀏覽器驗證
```

### 8-D：在手機裝 Tailscale
- iOS: App Store 搜 Tailscale
- Android: Play Store 搜 Tailscale
- 用同一帳號登入（Google / Microsoft / GitHub）

### 8-E：找你電腦的 Tailnet IP
```powershell
tailscale ip -4
# 顯示 100.x.x.x（這是你電腦在 Tailnet 內的固定 IP）
```

### 8-F：手機開瀏覽器
```
http://100.x.x.x:4444
```
（**必須明確打 http://**，Chrome 會自動升級 https 失敗）

✅ 手機看到 dashboard
❌ 連不上 → `tailscale status` 看是否 direct connection、防火牆是否阻擋 4444

**注意**：
- 你電腦 server / client 必須在跑（Step 6-B 兩個 terminal 都要開著）
- 你 Tailnet 跟 Mark 的 Tailnet 是兩個獨立網路，互相看不到
- 只有你授權邀請（Settings → Invite User）的設備才能進你 Tailnet

---

## Step 9：做改動 → push → 開 PR

### 同步上游 → 建 branch → 改 code → push → PR
```powershell
# 同步上游最新
git checkout main
git pull upstream main

# 建分支（命名規範看 CONTRIBUTING.md）
git checkout -b feat/your-feature

# 改 code...

# commit（commit message 格式看 CONTRIBUTING.md）
git add <files>
git commit -m "feat(area): your change"

# push 到你的 fork
git push origin feat/your-feature

# 在 GitHub 你的 fork 頁面點 "Compare & pull request" 開 PR 回 upstream/main
```

### Mark review 流程
- Mark 會在 PR 留 comments
- 你修改 → 再 push 到同 branch（PR 自動更新）
- approve 後 Mark merge

✅ PR 開了 / 跟 Mark 對齊修改方向
❌ 不確定要做什麼 → GitHub Issues 開討論 / 私訊 Mark

---

## 故障排除

### Q1: Step 6 啟動失敗
- `node --version` 確認 v24+
- 刪 `node_modules` 重 `npm install`
- 看終端紅字回報 Mark

### Q2: localhost:4444 空白頁
- 開 DevTools (F12) 看 Console 紅字
- 看 client 終端是否有錯誤輸出

### Q3: Tailscale 連不到自己電腦
- 雙方都要在線 + Tailscale 開著
- `tailscale ping <你電腦的 hostname>` 測試
- Windows 防火牆可能擋 port 4444：
  ```powershell
  New-NetFirewallRule -DisplayName "TheClaudenental client" -Direction Inbound -LocalPort 4444 -Protocol TCP -Action Allow
  New-NetFirewallRule -DisplayName "TheClaudenental server" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow
  ```

### Q4: API key 用量爆了
- 立刻 console.anthropic.com 把 key revoke
- 重建一個 + 設更嚴格 spend cap

### Q5: PR review 卡住 / 不知道要做什麼
- 私訊 Mark 對齊方向
- 或在 GitHub Issues 開討論

---

## 安全注意事項（必讀）

1. **API key 永遠不離開你電腦**
   - 不 commit 到 git
   - 不貼到 Slack / Discord / 任何聊天
   - 建議裝 [TruffleHog](https://github.com/trufflesecurity/trufflehog) 掃 git 防誤 commit
   ```powershell
   trufflehog git file://. --only-verified
   ```

2. **TheClaudenental 部分檔案放在 ~/.claude/**
   - 你的 chat / TODO / ratings / 規矩 都在那
   - **絕對不要** 把 `~/.claude/` 加進任何 git repo
   - 你的本機資料跟 Mark 的本機資料完全隔離

3. **PR 前自我檢查**
   ```powershell
   git diff main..HEAD | Select-String -Pattern "sk-ant-|AIza|ghp_|gho_|password\s*[:=]"
   ```
   有 hit 就是 leak，不要 push

---

## 完成檢查表

```
✅ 自己 Anthropic API key + spend cap
✅ Node.js v24+
✅ Git
✅ Claude Code
✅ TheClaudenental fork + clone + 跑起來
✅ 自己的 Tailnet（可選但推薦）
✅ 手機可看自己的 dashboard
✅ 知道 PR 流程
```

歡迎加入。任何卡關回報 Mark，他會回覆並把問題加進這份文件的故障排除區。
