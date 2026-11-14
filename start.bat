@echo off
cd /d "%~dp0"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

where py >nul 2>&1
if errorlevel 1 goto usepython

py -3 server.py --open
goto done

:usepython
python server.py --open

:done
echo.
echo Server stopped. If it failed immediately, read the message above.
pause
