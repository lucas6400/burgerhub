# Publica a versao mais recente do app (gerada por build-installer.ps1) para a atualizacao automatica.
#
# Os apps ja instalados conferem https://desktop-updates.vercel.app a cada 4 horas, baixam a versao nova sozinhos
# e instalam de madrugada (ou pelo menu da bandeja). A pasta publicada so guarda a ULTIMA versao.
#
# Fluxo: 1) aumente "version" em package.json  2) build-installer.ps1  3) este script.
# Uso: powershell -ExecutionPolicy Bypass -File publish-update.ps1
# (Arquivo sem acentos de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI e quebra o script.)

$ErrorActionPreference = "Stop"
$srcDir = $PSScriptRoot
$pubDir = Join-Path $srcDir "..\desktop-updates"

$yml = Join-Path $srcDir "dist\latest.yml"
if (-not (Test-Path $yml)) { throw "dist\latest.yml nao existe - rode build-installer.ps1 antes." }
$version = (Select-String -Path $yml -Pattern "^version:\s*(.+)$").Matches[0].Groups[1].Value.Trim()
$installer = Join-Path $srcDir "dist\BurgerHub-Setup-$version.exe"
if (-not (Test-Path $installer)) { throw "Instalador $installer nao encontrado." }

Write-Host "Publicando versao $version..."
Get-ChildItem $pubDir -Include *.exe, *.blockmap, latest.yml -Recurse -File | Remove-Item -Force
Copy-Item $installer, "$installer.blockmap", $yml -Destination $pubDir -Force

# Endereco FIXO de download (/download) apontando pra versao nova: e o link que o painel mostra pra quem esta logado.
$vercelJson = @"
{
  "redirects": [
    { "source": "/download", "destination": "/BurgerHub-Setup-$version.exe", "permanent": false }
  ],
  "headers": [
    { "source": "/latest.yml", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] },
    { "source": "/(.*).exe", "headers": [{ "key": "Cache-Control", "value": "public, max-age=3600" }] }
  ]
}
"@
[System.IO.File]::WriteAllText((Join-Path $pubDir "vercel.json"), $vercelJson, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $pubDir
npx vercel deploy --prod --yes
if ($LASTEXITCODE -ne 0) { throw "vercel deploy falhou" }
Pop-Location
Write-Host "Pronto! Os apps instalados vao atualizar para $version sozinhos. Download novo: https://desktop-updates.vercel.app/download"
