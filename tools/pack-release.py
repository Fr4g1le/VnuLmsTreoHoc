# Đóng gói file zip cho GitHub Releases: python tools/pack-release.py  ->  dist/VnuLmsTreoHoc-vX.Y.zip
#
# Các file extension nằm ngay ở gốc zip: giải nén bằng "Extract All" của Windows rồi chọn đúng thư mục vừa
# giải nén là nạp được (trước v3.12 phải vào thêm một thư mục con, dễ gặp lỗi "Manifest file is missing").
# Zip vẫn kèm bản sao trong thư mục con VnuLmsTreoHoc/ vì CapNhat.bat của v3.1 - v3.11 chỉ tìm ở đó.
import json, pathlib, subprocess, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ['manifest.json', 'background.js', 'bridge.js', 'content.js', 'options.html', 'options.js',
         'README.md', 'vnu-lms-treo-video.user.js', 'CapNhat.bat']

dirty = subprocess.run(['git', 'status', '--porcelain', '--', *FILES], cwd=ROOT, capture_output=True, text=True).stdout
if dirty.strip():
    sys.exit('Còn thay đổi chưa commit, hãy commit trước khi đóng gói:\n' + dirty)

version = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
out = ROOT / 'dist' / f'VnuLmsTreoHoc-v{version}.zip'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        data = (ROOT / name).read_bytes()  # đọc từ thư mục làm việc để CapNhat.bat giữ xuống dòng CRLF
        z.writestr(name, data)
        z.writestr('VnuLmsTreoHoc/' + name, data)
print(out)
