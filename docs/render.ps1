# Chụp các trang hướng dẫn trong docs\src thành ảnh PNG trong docs\img bằng Brave chạy ngầm.
# Dùng: powershell -File docs\render.ps1 [tên-trang ...]
param([string[]]$Only)
$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
$src = Join-Path $PSScriptRoot 'src'
$out = Join-Path $PSScriptRoot 'img'
$profileDir = Join-Path $env:TEMP 'vnuguide\prof'
New-Item -ItemType Directory -Force $out, $profileDir | Out-Null

# Kích thước cửa sổ (px) của từng trang
$sizes = @{
  '01-tai-zip' = '1100,520'; '02-giai-nen' = '1100,520'; '03-mo-extensions' = '1100,560'
  '04-chon-thu-muc' = '1100,560'; '05-ghim' = '1100,460'; '06-bang-treo-hoc' = '1200,760'
  '07-lay-khoa-gemini' = '1100,560'; '08-nhap-khoa' = '1100,820'; '09-trac-nghiem' = '1200,760'
}

Get-ChildItem $src -Filter '*.html' | Where-Object { -not $Only -or $Only -contains $_.BaseName } | ForEach-Object {
  $name = $_.BaseName
  $size = if ($sizes[$name]) { $sizes[$name] } else { '1100,600' }
  $png = Join-Path $out "$name.png"
  $url = 'file:///' + ($_.FullName -replace '\\', '/')
  $args = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', "--user-data-dir=$profileDir",
    '--hide-scrollbars', '--force-device-scale-factor=1.5', '--virtual-time-budget=3000', "--window-size=$size", "--screenshot=$png", $url)
  $p = Start-Process -FilePath $exe -ArgumentList $args -PassThru -WindowStyle Hidden
  if (-not $p.WaitForExit(40000)) { Stop-Process -Id $p.Id -Force; Write-Output "$name : quá thời gian" }
  else { Write-Output ("{0} : {1:N0} KB" -f $name, ((Get-Item $png).Length / 1KB)) }
}
