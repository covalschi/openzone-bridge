# Start the OpenZone bridge on Windows.
#
#   .\run.ps1          start once, exit when the bridge exits
#   .\run.ps1 -Loop    restart on crash, 5 s pause between attempts
#
# The script is deliberately dumb: check the tools, check .env, install the
# two dependencies if they are missing, run. For unattended hosting register
# a Scheduled Task (see the Running section of README.md) -- a console loop
# dies with its window, a task does not.
param([switch]$Loop)

Set-Location $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node not found. Install Node.js 24 or newer.'
    exit 1
}

$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 24) {
    Write-Error "Node $(node -v) is too old: the bridge needs 24+ (node:sqlite ships unflagged from 24; package.json engines)."
    exit 1
}

if (-not (Test-Path .env)) {
    Write-Error 'No .env here. Copy .env.example to .env and fill it in -- see SETUP.md.'
    exit 1
}

if (-not (Test-Path node_modules)) {
    Write-Host 'Installing dependencies (first run)...'
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Loop) {
    while ($true) {
        node --disable-warning=ExperimentalWarning src/index.js
        if ($LASTEXITCODE -eq 0) { break }
        Write-Host "Bridge exited with $LASTEXITCODE. Restarting in 5 s (Ctrl+C to stop)..."
        Start-Sleep -Seconds 5
    }
} else {
    node --disable-warning=ExperimentalWarning src/index.js
    exit $LASTEXITCODE
}
