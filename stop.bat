@echo off
setlocal
rem Stops what start.bat started: the web app, the API and the containers.
rem Local data (database, documents, emails) is kept for next time.
cd /d "%~dp0"

echo Stopping the web app and the API...
taskkill /FI "WINDOWTITLE eq Stass web*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Stass API*" /T /F >nul 2>&1
rem Anything still listening on their ports, such as servers started by hand.
call :stop_port 3000
call :stop_port 3001

echo Stopping the containers (your local data is kept)...
docker compose stop
echo Stopped.
goto :eof

:stop_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:%1 .*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
goto :eof
