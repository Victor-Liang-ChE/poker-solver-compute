# Postflop 3-bet library, PC share (from the postflop 3-bet library worker): solves the given parts of 20 of one spot.
# Resumable (finished .pfl files are skipped). Guard: stops node if free RAM drops under 2.5 GB or deadlock.exe runs, waits, resumes.
param([string]$Spot, [string]$Parts, [int]$Workers = 4)
$Node = @('C:\Program Files\nodejs\node.exe', "$env:APPDATA\fnm\node-versions\v22.23.4\installation\node.exe") | ? { Test-Path $_ } | select -First 1
$ErrorActionPreference='Continue'; $D='C:\poker-3bet'; New-Item -ItemType Directory -Force $D | Out-Null; Set-Location $D
if (-not (Test-Path solve-flops.mjs)) { Invoke-WebRequest 'https://raw.githubusercontent.com/Victor-Liang-ChE/poker-solver-compute/c2c426d/solve-flops.mjs' -OutFile solve-flops.mjs -UseBasicParsing }
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append status.txt }
function Game { [bool](Get-Process deadlock -ErrorAction SilentlyContinue) }
function FreeMB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024) }
foreach ($part in ($Parts -split ',')) {
  while ($true) {
    while ((FreeMB) -lt 4000 -or (Game)) { Log "waiting (free $(FreeMB) MB, deadlock $(Game)) before $Spot $part"; Start-Sleep 300 }
    Log "start $Spot part $part/20, $Workers workers"
    $p = Start-Process -FilePath $Node -ArgumentList "--max-old-space-size=4096 solve-flops.mjs --spot $Spot --out out --workers $Workers --part $part/20 --strict 1" -WindowStyle Hidden -PassThru -RedirectStandardOutput "log-$Spot-$part.txt" -RedirectStandardError "err-$Spot-$part.txt"
    if (-not $p) { Log "could not start node ($Node); stopping"; exit 1 }
    $guard = $false
    while (-not $p.HasExited) { Start-Sleep 15; if ((FreeMB) -lt 2500 -or (Game)) { $guard = $true; & taskkill /T /F /PID $p.Id | Out-Null; break } }
    if ($guard) { Log "guard stopped $Spot $part (free $(FreeMB) MB, deadlock $(Game))"; Start-Sleep 300; continue }
    $p.WaitForExit(); Log "exit $Spot $part, $((Get-ChildItem "out\$Spot" -Filter *.pfl -ErrorAction SilentlyContinue | Measure-Object).Count) records"
    break
  }
}
Log "all done $Spot $Parts"
