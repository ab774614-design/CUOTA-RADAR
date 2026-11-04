@echo off
rem Arranca CuotaRadar con el Node portátil de la carpeta rotacion-voley y abre el navegador.
cd /d "%~dp0"
start "" http://localhost:5180
"%~dp0..\rotacion-voley\runtime\node-v26.13.0-win-x64\node.exe" server.js
