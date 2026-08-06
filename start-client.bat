@echo off
rem Legacy bare-start (pre-pm2 era), kept as fallback. Daily use: Wake-TC.bat
rem (pm2 manages this service as "claudenental-client" - see .agent/workflows/TheClaudenental_setup.md)
netstat -ano | findstr ":4444.*LISTENING" >nul
if %errorlevel%==0 (
    echo [start-client] Port 4444 is already in use - probably pm2's claudenental-client.
    echo Daily startup: use Wake-TC.bat. To bare-start anyway, first run: pm2 stop claudenental-client
    pause
    exit /b 1
)
cd /d "C:\Project\TheClaudenental\client"
"C:\Program Files\nodejs\node.exe" node_modules/.bin/vite
