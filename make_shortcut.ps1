param([switch]$IfMissing)
# Puts an "Aura" icon on the desktop (and in the Start menu) that opens the app directly.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root '.venv\Scripts\pythonw.exe'
$app = Join-Path $root 'app\app.py'
$ico = Join-Path $root 'app\aura_icon4.ico'
if (-not (Test-Path $py)) { exit 1 }
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
  if (-not $dir -or -not (Test-Path $dir)) { continue }
  $lnk = Join-Path $dir 'Aura.lnk'
  if ($IfMissing -and (Test-Path $lnk)) { continue }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $py
  $s.Arguments = '"' + $app + '"'
  $s.WorkingDirectory = $root
  $s.IconLocation = $ico
  $s.Description = 'Aura'
  $s.Save()
}
