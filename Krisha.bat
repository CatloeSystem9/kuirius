@echo off
rem Krisha — one-click native start (tray-resident, hotkeys, server, window)
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0windows\krisha-tray.ps1"
