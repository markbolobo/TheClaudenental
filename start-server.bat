@echo off
rem Legacy bare-start (pre-pm2 era), kept as fallback. Daily use: Wake-TC.bat
rem (pm2 manages this service as "claudenental-server" - see .agent/workflows/TheClaudenental_setup.md)
netstat -ano | findstr ":3001.*LISTENING" >nul
if %errorlevel%==0 (
    echo [start-server] Port 3001 is already in use - probably pm2's claudenental-server.
    echo Daily startup: use Wake-TC.bat. To bare-start anyway, first run: pm2 stop claudenental-server
    pause
    exit /b 1
)
cd /d "C:\Project\TheClaudenental\server"
"C:\Program Files\nodejs\node.exe" index.js
