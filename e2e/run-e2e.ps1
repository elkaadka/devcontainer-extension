<#
.SYNOPSIS
  Runs the end-to-end test from Windows. Only Docker Desktop is required (no Node.js on the host).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\e2e\run-e2e.ps1 `
    -NpmRegistry https://registry.example.com/npm/ -PipIndexUrl https://registry.example.com/pypi/simple/
#>
param(
  [string]$NpmRegistry = "",
  [string]$PipIndexUrl = "",
  [string]$PipTrustedHost = "",
  [string]$Packages = "",
  [switch]$Keep
)
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$image = "devcontainer-composer-e2e-cli"

if (-not $PipTrustedHost -and $PipIndexUrl) {
  $PipTrustedHost = ([Uri]$PipIndexUrl).Host
}

Write-Host "Building $image ..."
docker build -t $image --build-arg "NPM_CONFIG_REGISTRY=$NpmRegistry" -f (Join-Path $repo "e2e\Dockerfile.cli") (Join-Path $repo "e2e")
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

# The Docker daemon (Docker Desktop, WSL 2 backend) sees C:\x\y as /run/desktop/mnt/host/c/x/y.
$work = Join-Path $repo "e2e\work"
$drive = $work.Substring(0, 1).ToLower()
$hostWork = "/run/desktop/mnt/host/$drive" + ($work.Substring(2) -replace '\\', '/')

$envArgs = @(
  "-e", "E2E_NPM_REGISTRY=$NpmRegistry",
  "-e", "E2E_PIP_INDEX_URL=$PipIndexUrl",
  "-e", "E2E_PIP_TRUSTED_HOST=$PipTrustedHost",
  "-e", "E2E_WORK=/repo/e2e/work",
  "-e", "E2E_HOST_WORK=$hostWork",
  "-e", "NPM_CONFIG_REGISTRY=$NpmRegistry"
)
if ($Packages) { $envArgs += @("-e", "E2E_PACKAGES=$Packages") }
if ($Keep -or $env:E2E_KEEP -eq "1") { $envArgs += @("-e", "E2E_KEEP=1") }

docker run --rm -t `
  -v //var/run/docker.sock:/var/run/docker.sock `
  -v "${repo}:/repo" `
  @envArgs `
  $image bash /repo/e2e/run-e2e.sh
exit $LASTEXITCODE
