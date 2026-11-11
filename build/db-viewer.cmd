@echo off
rem db-viewer [verbinding] [opties] - starts DB Viewer with these arguments (db-viewer --help).
rem "start" returns at once, so the terminal stays free while the app runs.
start "" "%~dp0DB Viewer.exe" %*
