# VNU LMS - Treo học

Extension cho Chrome / Brave / Edge giúp treo máy học trên [LMS VNU](https://lms.vnu.edu.vn): tự mở lần lượt các mục trong mục lục, treo đủ thời gian yêu cầu rồi chuyển sang mục kế tiếp.

## Tính năng

- **Tự học theo mục lục:** đọc tiến trình học tập của bạn, lập danh sách các mục chưa đạt và mở lần lượt từng mục.
- **Treo đúng thời gian cần:** lấy "Phải học tối thiểu N phút" trừ đi thời gian bạn đã học, cộng thêm vài phút dự phòng (chỉnh được). Mục đã hoàn thành thì bỏ qua.
- **Kiểm tra lại với server:** sau mỗi mục, xem server đã ghi nhận hoàn thành chưa; chưa đạt thì treo thêm.
- **Tự mở tab "Tiến trình học tập"** sau mỗi mục rồi quay lại, để cây mục lục cập nhật dấu ✓ (tắt được trong cài đặt).
- **Mục PDF / tài liệu:** mục không yêu cầu thời gian được treo theo số phút bạn chọn.
- **Tự xác nhận "Bạn có đang học tập không ?"** ngay khi hộp thoại hiện ra.
- **Chống dừng khi đổi tab** và tự phát lại video khi bị dừng.
- **Tắt tiếng nhanh** bằng một nút, để làm việc khác trong lúc treo.
- **Bảng điều khiển:** chọn loại mục (video, PDF, bài đọc…), chọn bài học muốn chạy, xem danh sách, thời gian còn lại và nhật ký.
- Không bao giờ mở bài kiểm tra / trắc nghiệm.

## Cách hoạt động

LMS chỉ cộng thời gian học của một mục **khi bạn rời khỏi mục đó**. Đủ "thời gian tối thiểu" thì server tự đánh dấu hoàn thành. Extension mở mục, chờ đủ giờ, rồi mở mục tiếp theo để server lưu thời gian của mục trước.

Server ghi nhận hoàn thành ngay khi rời mục, kể cả khi chưa mở tab "Tiến trình học tập". Tuy vậy cây mục lục trên trang chỉ đổi sang dấu ✓ sau khi mở tab đó, nên extension vẫn mở tab này sau mỗi mục.

## Cài đặt

1. Tải repo này về: bấm **Code → Download ZIP** rồi giải nén (hoặc `git clone`).
2. Mở trang quản lý extension:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Bật **Developer mode** (Chế độ dành cho nhà phát triển).
4. Bấm **Load unpacked** và chọn thư mục vừa giải nén (thư mục có file `manifest.json`).
5. Ghim biểu tượng extension: 🧩 → 📌.

Muốn dùng bằng Tampermonkey thay vì extension: tạo script mới và dán nội dung `vnu-lms-treo-video.user.js`.

### Riêng với Brave

- Cho phép tự phát video: ở trang LMS, bấm ổ khóa cạnh thanh địa chỉ → **Site settings** → **Autoplay** → **Allow**.
- Thêm `lms.vnu.edu.vn` vào danh sách luôn hoạt động trong `brave://settings/system` → **Memory Saver**, để tab không bị cho ngủ.

## Sử dụng

1. Đăng nhập LMS và mở trang chi tiết lớp học.
2. Bấm nút **Treo học** ở góc dưới bên trái trang (hoặc biểu tượng extension).
3. Tuỳ chọn trong **Cài đặt** và **Chọn bài học**, bấm **🔊 Tắt tiếng** nếu cần.
4. Bấm **▶ Bắt đầu tự học**.

Lưu ý:

- Để cửa sổ trình duyệt rộng từ 992px trở lên, vì cửa sổ hẹp thì trang ẩn cây mục lục.
- Không thu nhỏ cửa sổ và không để máy ngủ trong lúc treo.
- Nếu bị đẩy về trang chủ, extension tự quay lại lớp và chạy tiếp.

## Các file

| File | Vai trò |
|---|---|
| `manifest.json` | Khai báo extension |
| `content.js` | Logic treo học và bảng điều khiển (chạy trong trang LMS) |
| `bridge.js`, `background.js` | Bấm biểu tượng extension để mở/đóng bảng điều khiển |
| `vnu-lms-treo-video.user.js` | Bản dùng cho Tampermonkey |
