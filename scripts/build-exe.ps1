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

Write-Host '3/5 Copie de node.exe...'
Copy-Item (Get-Command node).Source dist\appdata-analyzer.exe -Force

# L'icone et les metadonnees DOIVENT etre posees AVANT l'injection SEA :
# modifier les ressources PE apres coup corromprait le blob injecte.
# rcedit : binaire OFFICIEL electron/rcedit, version epinglee + SHA256 verifie
# (pas de paquet npm tiers dans la chaine de build).
Write-Host '4/5 Icone Umbra Labs + metadonnees (rcedit)...'
$rcedit = 'dist\rcedit-x64.exe'
$rceditSha = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a'
if (-not (Test-Path $rcedit) -or ((Get-FileHash $rcedit -Algorithm SHA256).Hash.ToLower() -ne $rceditSha)) {
  Invoke-WebRequest 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' -OutFile $rcedit -UseBasicParsing
}
if ((Get-FileHash $rcedit -Algorithm SHA256).Hash.ToLower() -ne $rceditSha) { throw 'rcedit : empreinte SHA256 inattendue' }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
& $rcedit dist\appdata-analyzer.exe --set-icon assets\logo.ico `
  --set-version-string ProductName 'Drive Cleaner' `
  --set-version-string CompanyName 'Umbra Labs' `
  --set-version-string FileDescription 'Drive Cleaner - safe Windows disk cleanup (Umbra Labs)' `
  --set-version-string LegalCopyright 'MIT - Umbra Labs' `
  --set-file-version $version --set-product-version $version
if ($LASTEXITCODE -ne 0) { throw 'echec rcedit' }

Write-Host '5/5 Injection du blob (postject)...'
npx --yes postject dist\appdata-analyzer.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'echec postject' }

$exe = Get-Item dist\appdata-analyzer.exe
Write-Host ("OK -> {0} ({1:N1} Mo)" -f $exe.FullName, ($exe.Length / 1MB))
