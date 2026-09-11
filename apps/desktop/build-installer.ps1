# Empacota o instalador do BurgerHub Desktop.
#
# O electron-builder (mais especificamente o app-builder.exe que ele invoca
# via spawn) falha com ENOENT quando o caminho do projeto tem caracteres
# acentuados — "GESTÃO" quebra o spawn no Windows. Por isso este script copia
# só o necessário pra uma pasta temporária sem acento, builda lá, e traz o
# instalador final de volta pra apps/desktop/dist.
#
# Uso: powershell -ExecutionPolicy Bypass -File build-installer.ps1

$ErrorActionPreference = "Stop"
$srcDir = $PSScriptRoot
$buildDir = "C:\bh-desktop-build"

Write-Host "Copiando arquivos para $buildDir (fora do caminho acentuado)..."
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Force -Path "$buildDir\build" | Out-Null
Copy-Item "$srcDir\main.js", "$srcDir\preload.js", "$srcDir\store.js", "$srcDir\tray-icon.js", "$srcDir\package.json" -Destination $buildDir
Copy-Item "$srcDir\build\icon.ico" -Destination "$buildDir\build"

Write-Host "Instalando dependencias..."
Push-Location $buildDir
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install falhou" }

Write-Host "Empacotando instalador..."
npm run dist
if ($LASTEXITCODE -ne 0) { throw "electron-builder falhou" }
Pop-Location

Write-Host "Copiando instalador de volta para apps/desktop/dist..."
New-Item -ItemType Directory -Force -Path "$srcDir\dist" | Out-Null
Copy-Item "$buildDir\dist\*.exe" -Destination "$srcDir\dist" -Force

Write-Host "Pronto! Instalador em: $srcDir\dist"
Get-ChildItem "$srcDir\dist\*.exe" | Select-Object Name, @{N="MB";E={[math]::Round($_.Length/1MB,1)}}
