#Requires -Version 5.1
<#
.SYNOPSIS
    Lanza Microsoft Edge como app de LinkedIn con Remote Debugging habilitado.
.DESCRIPTION
    Detecta si ya hay una instancia con CDP en el puerto 9222.
    Si no, lanza Edge con --app=https://www.linkedin.com en un perfil dedicado.
#>
param(
    [int]$Port = 9222,
    [string]$ProfileDir = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\LI-Automation"
)

$ErrorActionPreference = 'Stop'

function Test-CdpLinkedIn {
    param([int]$p)
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:$p/json" -TimeoutSec 3 -ErrorAction Stop
        $li = $res | Where-Object { $_.url -like '*linkedin.com*' -and $_.type -eq 'page' }
        if ($li) { return @{ok=$true; target=$li; msg="LinkedIn ya abierto en CDP puerto $p"} }
        return @{ok=$false; msg="Navegador detectado en puerto $p pero sin LinkedIn."}
    } catch {
        return @{ok=$false; msg="No hay navegador en puerto $p."}
    }
}

$check = Test-CdpLinkedIn -p $Port
if ($check.ok) {
    Write-Host $check.msg -ForegroundColor Green
    exit 0
}

Write-Host $check.msg -ForegroundColor Yellow
Write-Host "Buscando Microsoft Edge..." -ForegroundColor Cyan

$edgePaths = @(
    (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction SilentlyContinue).'(Default)',
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $edgePaths) {
    Write-Error "No se encontró Microsoft Edge. Instálalo o ajusta la ruta manualmente."
}

$edge = $edgePaths | Select-Object -First 1
Write-Host "Edge encontrado: $edge" -ForegroundColor Green
Write-Host "Perfil dedicado: $ProfileDir" -ForegroundColor DarkGray

$proc = Start-Process -FilePath $edge -ArgumentList `
    "--app=https://www.linkedin.com",`
    "--remote-debugging-port=$Port",`
    "--user-data-dir=`"$ProfileDir`"",`
    "--no-first-run",`
    "--no-default-browser-check" -PassThru

Write-Host "Edge lanzado (PID $($proc.Id)). Esperando a que CDP responda..." -ForegroundColor Cyan

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 800
    $check = Test-CdpLinkedIn -p $Port
    if ($check.ok) {
        Write-Host $check.msg -ForegroundColor Green
        exit 0
    }
}

Write-Error "No se pudo conectar a LinkedIn via CDP tras 24s. Revisa que Edge haya iniciado."
