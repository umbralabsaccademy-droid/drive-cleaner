# Génère dist\appdata-analyzer.exe — exécutable autonome (aucun Node requis sur la machine cible).
#
# Méthode : Node SEA (Single Executable Application), la voie officielle Node 22 :
#   1. esbuild bundle tout le TypeScript en UN fichier CommonJS (dist\cli.cjs)
#   2. node --experimental-sea-config prépare le blob SEA
#   3. copie de node.exe → l'exécutable final
#   4. postject injecte le blob dans la copie (fuse officielle Node)
# esbuild et postject sont invoqués via npx (cache npm), rien n'est ajouté aux dépendances du projet.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '1/4 Bundle esbuild...'
npx --yes esbuild src/cli.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/cli.cjs
if ($LASTEXITCODE -ne 0) { throw 'echec esbuild' }

Write-Host '2/4 Preparation du blob SEA...'
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw 'echec sea-config' }

Write-Host '3/4 Copie de node.exe...'
Copy-Item (Get-Command node).Source dist\appdata-analyzer.exe -Force

Write-Host '4/4 Injection du blob (postject)...'
npx --yes postject dist\appdata-analyzer.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'echec postject' }

$exe = Get-Item dist\appdata-analyzer.exe
Write-Host ("OK -> {0} ({1:N1} Mo)" -f $exe.FullName, ($exe.Length / 1MB))
