# RetirementBuddy - a fully local, browser-only app (no backend) on Windows.
# Everything runs in your browser; your data never leaves this machine.
# Usage:  .\run.ps1   (or double-click run.bat)
# To make a shareable build:  cd frontend ; npm run build
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js/npm not found. Install Node 18+ from https://nodejs.org"
    exit 1
}

Set-Location (Join-Path $Root "frontend")
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' -and
                   ($_.PrefixOrigin -eq 'Dhcp' -or $_.SuffixOrigin -eq 'Dhcp') } |
    Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "  RetirementBuddy is starting."
Write-Host "  -> On this PC:         http://localhost:5173"
if ($lanIp) { Write-Host "  -> On another device:  http://${lanIp}:5173  (same Wi-Fi/LAN)" }
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

npm run dev
