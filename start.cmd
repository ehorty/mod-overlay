@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Необязательный порт: start.cmd 4000  (или start.cmd --port 4000)
set "MOPORT=%~1"
if /i "%MOPORT%"=="--port" set "MOPORT=%~2"
if /i "%MOPORT%"=="-p" set "MOPORT=%~2"
if not "%MOPORT%"=="" set "PORT=%MOPORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Устанавливаю зависимости...
  call npm install
  if errorlevel 1 goto :error
)

if not exist "dist\index.js" (
  echo Собираю проект...
  call npm run build
  if errorlevel 1 goto :error
)

node dist\index.js
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo Не удалось запустить сервер. Проверьте сообщения выше.
pause
exit /b 1
