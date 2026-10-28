@echo off
rem Nhap dup file nay de cap nhat extension "VNU LMS - Treo hoc" len ban moi nhat tren GitHub Releases.
rem Chi dung curl va tar co san trong Windows 10/11; chi ghi de cac file cua extension trong thu muc nay.
setlocal
title Cap nhat VNU LMS - Treo hoc
cd /d "%~dp0"

if not exist "manifest.json" (
  echo Khong thay manifest.json. Hay de CapNhat.bat nam trong thu muc extension.
  goto :end
)
findstr /c:"VNU LMS" manifest.json >nul || (
  echo Thu muc nay khong phai extension VNU LMS - Treo hoc.
  goto :end
)

set "TMPD=%TEMP%\VnuLmsTreoHoc-update"
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%"

rem Ten file zip trong Release doi theo phien ban (VnuLmsTreoHoc-vX.Y.zip), nen hoi GitHub link file .zip cua ban moi nhat
set "ZIPURL="
for /f "tokens=2 delims= " %%U in ('curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/Fr4g1le/VnuLmsTreoHoc/releases/latest" ^| findstr /c:"browser_download_url" ^| findstr /i /c:".zip"') do set "ZIPURL=%%~U"
if not defined ZIPURL (
  echo Khong tim thay ban moi tren GitHub. Kiem tra mang roi thu lai.
  goto :end
)

echo Dang tai ban moi nhat...
curl -fL --silent --show-error -o "%TMPD%\update.zip" "%ZIPURL%" || (
  echo Tai that bai. Kiem tra mang roi thu lai.
  goto :end
)
mkdir "%TMPD%\x"
tar -xf "%TMPD%\update.zip" -C "%TMPD%\x" || (
  echo Giai nen that bai.
  goto :end
)
rem Tu v3.12, file extension nam ngay o goc zip; ban cu nam trong thu muc con VnuLmsTreoHoc
set "FROM="
if exist "%TMPD%\x\manifest.json" set "FROM=%TMPD%\x"
if not defined FROM if exist "%TMPD%\x\VnuLmsTreoHoc\manifest.json" set "FROM=%TMPD%\x\VnuLmsTreoHoc"
if not defined FROM (
  echo File tai ve khong dung dinh dang.
  goto :end
)

rem Chi chep cac file cua extension (khong chep thu muc con)
xcopy "%FROM%\*.*" "%~dp0." /y /q >nul
rmdir /s /q "%TMPD%"
echo.
echo Da cap nhat xong.
echo Extension se tu khoi dong lai trong khoang 30 giay neu trang LMS dang mo.
echo Neu khong thay, vao trang quan ly extension va bam nut tai lai.

:end
echo.
pause
