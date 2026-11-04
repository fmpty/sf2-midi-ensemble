# Check libnativesynth.so 16KB ELF alignment inside debug APK (needs build-tools zipalign + llvm-readelf in NDK)
param(
    [string]$Apk = "$PSScriptRoot\..\android\app\build\outputs\apk\debug\app-debug.apk"
)
$ErrorActionPreference = "Stop"
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$zipalign = Get-ChildItem -Path (Join-Path $sdk "build-tools") -Recurse -Filter "zipalign.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not (Test-Path $Apk)) { Write-Error "APK not found: $Apk — run build_android.bat first" }
if ($zipalign) {
    Write-Host "=== zipalign -P 16 ==="
    & $zipalign.FullName -c -P 16 -v 4 $Apk
} else {
    Write-Warning "zipalign not found under $sdk\build-tools"
}
$ndk = Join-Path $sdk "ndk\28.0.13004108\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe"
if (-not (Test-Path $ndk)) {
    $ndk = Get-ChildItem (Join-Path $sdk "ndk") -Recurse -Filter "llvm-readelf.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ndk) { Write-Warning "llvm-readelf not found — install NDK 28 in SDK Manager"; exit 0 }
$tmp = Join-Path $env:TEMP ("mid14-so-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($Apk, $tmp)
$so = Get-ChildItem $tmp -Recurse -Filter "libnativesynth.so" |
    Where-Object { $_.FullName -match "arm64-v8a" } |
    Select-Object -First 1
if (-not $so) {
    $so = Get-ChildItem $tmp -Recurse -Filter "libnativesynth.so" | Select-Object -First 1
}
if (-not $so) { Write-Error "libnativesynth.so not in APK" }
Write-Host "Checking: $($so.FullName.Replace($tmp, ''))"
Write-Host "=== LOAD align (expect Align 0x4000 for arm64-v8a) ==="
$loadLines = & $ndk -l $so.FullName | Select-String "LOAD"
$loadLines | ForEach-Object { Write-Host $_.Line }
$bad = $loadLines | Where-Object { $_.Line -match "Align 0x1000" }
if ($bad) {
    Write-Error "libnativesynth.so still 4KB-aligned — need NDK 28 + clean rebuild (build_android.bat)"
}
Remove-Item -Recurse -Force $tmp
