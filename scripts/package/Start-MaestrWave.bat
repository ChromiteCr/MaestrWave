@echo off
rem MaestrWave one-click launcher (Windows) -- double-click this file.
rem To stop: close the minimized backend console window, or press Ctrl+C there.

cd /d "%~dp0"

rem Optional config (TME cloud generation keys, port...): edit config.env in this folder
if exist config.env (
  for /f "usebackq eol=# delims== tokens=1,*" %%a in ("config.env") do (
    if not "%%a"=="" set "%%a=%%b"
  )
)

rem Runtime data goes into the extracted folder for persistence
if "%PORT%"=="" set "PORT=3000"
set "OUTPUT_DIR=%CD%\output\sessions"
set "PROJECTS_DIR=%CD%\output\projects"
set "SOUNDFONT_DIR=%CD%\soundfonts"
set "SCORE_PREFS_PATH=%CD%\output\score_prefs.json"
if exist "%CD%\fluidsynth\fluidsynth.exe" set "PATH=%CD%\fluidsynth;%PATH%"
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
if not exist "%PROJECTS_DIR%" mkdir "%PROJECTS_DIR%"

echo Starting MaestrWave backend...
start "MaestrWave Backend" /min cmd /c "MaestrWave\MaestrWave.exe"
timeout /t 3 /nobreak >nul
start "" "http://localhost:%PORT%"
