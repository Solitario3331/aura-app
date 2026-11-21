@echo off
cd /d "%~dp0"
call config.bat
echo ==== Aura setup check ====
echo Qwen address: %OLLAMA_URL%   model: %QWEN_MODEL%
if exist .venv\Scripts\python.exe (echo [OK]  Python and Aura parts) else (echo [BAD] Aura parts missing - run the setup file)
curl.exe -s -m 8 %OLLAMA_URL%/api/tags > "%TEMP%\aura_tags.txt" 2>nul
if errorlevel 1 (
  echo [BAD] Cannot reach Qwen at %OLLAMA_URL%
  echo       Is the 5090 PC on and Ollama running? Is the address right? ^(ollama_url.txt^)
) else (
  echo [OK]  Qwen PC answers
  findstr /i /c:"%QWEN_MODEL%" "%TEMP%\aura_tags.txt" >nul && (echo [OK]  Model %QWEN_MODEL%) || echo [BAD] Model %QWEN_MODEL% is missing on that PC
)
where claude >nul 2>&1 && (echo [OK]  Claude Code installed) || echo [BAD] Claude Code missing - run the setup file
if exist VERSION (set /p AURA_VER=<VERSION) else (set AURA_VER=unknown)
echo [OK]  Aura version %AURA_VER% ^(updates come from the Update button^)
echo.
pause
