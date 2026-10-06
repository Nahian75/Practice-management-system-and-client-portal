@echo off
rem Local demo only: shows the current security code for the demo login in DEMO-LOGIN.txt.
cd /d "%~dp0"
node scripts\demo-code.mjs
pause
