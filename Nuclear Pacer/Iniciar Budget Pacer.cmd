@echo off
setlocal
title Budget Pacer
cd /d "%~dp0"
if errorlevel 1 goto folder_error
where node.exe >nul 2>&1
if errorlevel 1 goto node_error
if not exist "pacer-launcher.js" goto files_error
if not exist "pacer-server.js" goto files_error
if not exist "ai-budget-pacer.html" goto files_error
node.exe "%~dp0pacer-launcher.js" %*
if errorlevel 1 goto failed
exit /b 0
:folder_error
echo ERROR: No se pudo abrir la carpeta del proyecto.
goto failed
:node_error
echo ERROR: Node.js no esta instalado o no esta en PATH.
echo Instala Node.js 18 o posterior desde https://nodejs.org y vuelve a intentarlo.
goto failed
:files_error
echo ERROR: Faltan archivos. Conserva el lanzador, pacer-launcher.js,
echo pacer-server.js y ai-budget-pacer.html en la misma carpeta.
:failed
echo.
echo No se pudo abrir Budget Pacer. Revisa el mensaje anterior.
if /i not "%~1"=="--no-browser" pause
exit /b 1
