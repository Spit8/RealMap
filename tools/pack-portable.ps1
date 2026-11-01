# Windows portable package: RealMap_<version>_x64-portable.zip with the release executable
# (app/src-tauri/target/release/importcity.exe, built by `npm run tauri build`) renamed RealMap.exe,
# the portable marker (RealMap.portable: the app then only links to new versions), the licence, Microsoft's WebView2 bootstrapper (for the rare Windows without the runtime, checked
# to be signed by Microsoft) and a short readme. Used by .github/workflows/release.yml and by hand:
#   powershell -File tools/pack-portable.ps1 -Version 1.0.0 [-OutDir dist]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$OutDir = "dist"
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$exe = Join-Path $root "app/src-tauri/target/release/importcity.exe"
if (-not (Test-Path $exe)) { throw "portable build: $exe not found (run npm run tauri build first)" }
$work = Join-Path ([System.IO.Path]::GetTempPath()) "realmap-portable-$Version"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item $exe (Join-Path $work "RealMap.exe")
Copy-Item (Join-Path $root "LICENSE") (Join-Path $work "LICENSE.txt")
# Tells the app it runs portable: it then announces updates without installing them.
"Portable build: updates are downloaded by hand from GitHub." | Set-Content -Encoding utf8 (Join-Path $work "RealMap.portable")
$setup = Join-Path $work "MicrosoftEdgeWebview2Setup.exe"
Invoke-WebRequest "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $setup -UseBasicParsing
$sig = Get-AuthenticodeSignature $setup
if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") {
  throw "WebView2 bootstrapper: unexpected signature ($($sig.Status), $($sig.SignerCertificate.Subject))"
}
@(
  "RealMap $Version (portable)",
  "",
  "Lancer RealMap.exe. / Run RealMap.exe.",
  "",
  "Si l'application ne demarre pas, installer le runtime Microsoft WebView2 avec",
  "MicrosoftEdgeWebview2Setup.exe (deja present sur Windows 11 et la plupart des Windows 10).",
  "If the app does not start, install the Microsoft WebView2 runtime with",
  "MicrosoftEdgeWebview2Setup.exe (already present on Windows 11 and most Windows 10)."
) | Set-Content -Encoding utf8 (Join-Path $work "LISEZMOI-README.txt")
New-Item -ItemType Directory -Force $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir) "RealMap_${Version}_x64-portable.zip"
Compress-Archive -Path (Join-Path $work "*") -DestinationPath $zip -Force
Remove-Item -Recurse -Force $work
Write-Output $zip
