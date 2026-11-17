# Postflop 3-bet library, PC share: parts 18 and 19 of 20 of each spot (from the postflop 3-bet library worker).
# Resumable (finished .pfl files are skipped). Memory guard: stops node if free RAM drops under 2.5 GB, waits, resumes.
$ErrorActionPreference='Continue'; $D='C:\poker-3bet'; New-Item -ItemType Directory -Force $D | Out-Null; Set-Location $D
$B='https://raw.githubusercontent.com/Victor-Liang-ChE/poker-solver-compute/c2c426d'
if (-not (Test-Path solve-flops.mjs)) { Invoke-WebRequest "$B/solve-flops.mjs" -OutFile solve-flops.mjs -UseBasicParsing }
$W = if ($env:P3B_WORKERS) { $env:P3B_WORKERS } else { 4 }
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append status.txt }
function FreeMB { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024) }
foreach ($spot in 'co-bb-3bet','hj-bb-3bet','utg-bb-3bet','hj-co-3bet') {
  foreach ($part in 18,19) {
    while ($true) {
      while ((FreeMB) -lt 4000) { Log "waiting for memory ($(FreeMB) MB free) before $spot $part"; Start-Sleep 300 }
      Log "start $spot part $part/20, $W workers"
      $p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList "--max-old-space-size=4096 solve-flops.mjs --spot $spot --out out --workers $W --part $part/20 --strict 1" -WindowStyle Hidden -PassThru -RedirectStandardOutput "log-$spot-$part.txt" -RedirectStandardError "err-$spot-$part.txt"
      $guard = $false
      while (-not $p.HasExited) { Start-Sleep 15; if ((FreeMB) -lt 2500) { $guard = $true; & taskkill /T /F /PID $p.Id | Out-Null; break } }
      if ($guard) { Log "memory guard stopped $spot $part ($(FreeMB) MB free)"; Start-Sleep 300; continue }
      $p.WaitForExit(); Log "exit $spot $part code $($p.ExitCode), $((Get-ChildItem "out\$spot" -Filter *.pfl -ErrorAction SilentlyContinue | Measure-Object).Count) records"
      break
    }
  }
}
Log "all done"
