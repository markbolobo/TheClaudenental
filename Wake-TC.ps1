# Wake-TC.ps1 — TC（TheClaudenental）連線檢查＋喚醒
# 雙擊 Wake-TC.bat 執行。已在線 → 直接開瀏覽器；沒在線 → pm2 resurrect 後等到健康再開。
# 開機自啟現制 = 啟動資料夾 TheClaudenental.vbs → pm2 resurrect（詳 .agent/workflows/TheClaudenental_setup.md §三.4）；
# 本腳本是同一機制的手動觸發版，加上健康檢查與等待。

$ErrorActionPreference = 'SilentlyContinue'
$PM2 = "$env:APPDATA\npm\pm2.cmd"

function Test-Server { try { (Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/tools' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }
function Test-Client { try { (Invoke-WebRequest -Uri 'http://localhost:4444' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } }

Write-Host '=== TheClaudenental 連線檢查 ===' -ForegroundColor Cyan
$serverUp = Test-Server
$clientUp = Test-Client
Write-Host ("Server (3001): " + $(if ($serverUp) { '🟢 在線' } else { '🔴 離線' }))
Write-Host ("Client (4444): " + $(if ($clientUp) { '🟢 在線' } else { '🔴 離線' }))

if ($serverUp -and $clientUp) {
    Write-Host '✅ TC 已在線，開啟瀏覽器。' -ForegroundColor Green
    Start-Process 'http://localhost:4444'
    Start-Sleep -Seconds 2
    exit 0
}

if (-not (Test-Path $PM2)) {
    Write-Host "❌ 找不到 pm2（$PM2）。請確認 npm 全域套件仍在。" -ForegroundColor Red
    pause
    exit 1
}

Write-Host '喚醒中：pm2 resurrect…' -ForegroundColor Yellow
& $PM2 resurrect | Out-Null

# 等待健康（最多 90 秒）
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if ((Test-Server) -and (Test-Client)) {
        Write-Host '✅ TC 已喚醒，開啟瀏覽器。' -ForegroundColor Green
        Start-Process 'http://localhost:4444'
        Start-Sleep -Seconds 2
        exit 0
    }
    Write-Host '  …等待服務就緒'
}

Write-Host '⚠️ 90 秒內未就緒。pm2 目前狀態：' -ForegroundColor Red
& $PM2 list
Write-Host '若清單裡沒有 claudenental-server / claudenental-client（pm2 dump 遺失），'
Write-Host '請看 pm2 logs claudenental-server，或在聊天室叫 Claude 修。'
pause
