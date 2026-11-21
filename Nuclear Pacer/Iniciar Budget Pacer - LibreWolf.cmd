@echo off
setlocal
title Budget Pacer - LibreWolf
cd /d "%~dp0"
if errorlevel 1 goto folder_error
where node.exe >nul 2>&1
if errorlevel 1 goto node_error
if not exist "pacer-librewolf.js" goto files_error
if not exist "pacer-launcher.js" goto files_error
if not exist "pacer-server.js" goto files_error
if not exist "ai-budget-pacer.html" goto files_error
node.exe "%~dp0pacer-librewolf.js" %*
if errorlevel 1 goto failed
exit /b 0
:folder_error
echo ERROR: No se pudo abrir la carpeta del proyecto.
goto failed
:node_error
echo ERROR: Node.js no esta instalado o no esta en PATH.
echo Se necesita Node.js 18 o posterior.
goto failed
:files_error
echo ERROR: Faltan archivos de Budget Pacer en la carpeta del iniciador.
echo Se necesitan pacer-librewolf.js, pacer-launcher.js,
echo pacer-server.js y ai-budget-pacer.html.
:failed
echo.
echo No se pudo abrir Budget Pacer en LibreWolf. No se abrira otro navegador.
if /i not "%~1"=="--no-browser" pause
exit /b 1
