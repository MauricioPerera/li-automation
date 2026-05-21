#Requires -Version 5.1
<#
.SYNOPSIS
    Relanza la app nativa de LinkedIn con WebView2 Remote Debugging habilitado.
#>
param(
    [int]$DebugPort = 9223
)

$ErrorActionPreference = 'Stop'
# Reemplaza con el AppID público de LinkedIn desde Microsoft Store (ej: obténlo con Get-AppxPackage)
$appId = '<APP_ID_DE_LINKEDIN_STORE>'

Write-Host "Cerrando LinkedIn si está corriendo..." -ForegroundColor Cyan
Get-Process -Name "LinkedIn" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "Seteando WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS..." -ForegroundColor Cyan
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"

Write-Host "Lanzando LinkedIn app nativa..." -ForegroundColor Cyan
explorer.exe "shell:AppsFolder\$appId"

Write-Host "Esperando a que WebView2 exponga CDP en puerto $DebugPort..." -ForegroundColor Cyan
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:$DebugPort/json/version" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "CDP detectado!" -ForegroundColor Green
        Write-Host "Browser: $($res.Browser)" -ForegroundColor Gray
        Write-Host "WebSocket: $($res.webSocketDebuggerUrl)" -ForegroundColor Gray
        exit 0
    } catch { }
}

Write-Error "No se detectó CDP en el puerto $DebugPort tras 40s."
