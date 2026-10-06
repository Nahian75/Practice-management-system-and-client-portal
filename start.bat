@echo off
setlocal
rem Starts Stass on this computer: the containers, the API and the web app.
rem Local use only, with test data. Stop everything with stop.bat.
cd /d "%~dp0"
rem Pauses use ping, not timeout: timeout refuses to run when the window takes no typing.

docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
echo Starting Docker Desktop...
start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:wait_docker
set /a tries+=1
if %tries% gtr 60 goto docker_failed
ping -n 6 127.0.0.1 >nul
docker info >nul 2>&1
if errorlevel 1 goto wait_docker
:docker_ready

echo Starting the database, document storage, virus scanner and mail catcher...
echo (The virus scanner's first start can take a few minutes.)
docker compose up -d --wait
if errorlevel 1 goto failed

echo Building the API and bringing the database up to date...
call npm run build -w @practice/api
if errorlevel 1 goto failed
call npm run migrate:local -w @practice/api
if errorlevel 1 goto failed

start "Stass API" cmd /k npm run start:local -w @practice/api
start "Stass web" cmd /k npm run dev -w @practice/web

echo Waiting for the web app...
set /a tries=0
:wait_web
set /a tries+=1
if %tries% gtr 90 goto failed
ping -n 3 127.0.0.1 >nul
curl -s -o nul http://localhost:3000/sign-in
if errorlevel 1 goto wait_web

start "" http://localhost:3000
echo.
echo Stass is running at http://localhost:3000
echo Emails it sends (invitations, password resets) are at http://127.0.0.1:8025
echo.
echo First time? Invite yourself, then accept the invitation from the emails page:
echo   npm run invite:local -w @practice/api -- --kind staff --email you@practice.test --name "Your Name" --role administrator --role partner
echo.
echo Stop everything with stop.bat.
goto :eof

:docker_failed
echo Docker Desktop did not start. Start it yourself, then run start.bat again.
pause
exit /b 1

:failed
echo Something went wrong: see the messages above.
pause
exit /b 1
