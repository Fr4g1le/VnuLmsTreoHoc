# VNU LMS - Treo học

Extension cho Chrome / Brave / Edge giúp treo máy học trên [LMS VNU](https://lms.vnu.edu.vn): tự mở lần lượt các mục trong mục lục, treo đủ thời gian yêu cầu rồi chuyển sang mục kế tiếp.

> **Tải bản mới nhất:** [**Releases → VnuLmsTreoHoc-vX.Y.zip**](https://github.com/Fr4g1le/VnuLmsTreoHoc/releases/latest)
>
> **Mới dùng lần đầu?** Xem [**hướng dẫn từng bước có hình**](docs/HUONG-DAN.md), mũi tên chỉ vào đúng nút cần bấm.

[![Bước 6: bắt đầu tự học](docs/img/06-bang-treo-hoc.png)](docs/HUONG-DAN.md)

## Tính năng

- **Tự học theo mục lục:** đọc tiến trình học tập của bạn, lập danh sách các mục chưa đạt và mở lần lượt từng mục.
- **Treo đúng thời gian cần:** lấy "Phải học tối thiểu N phút" trừ đi thời gian bạn đã học, cộng thêm vài phút dự phòng (chỉnh được). Mục đã hoàn thành thì bỏ qua.
- **Kiểm tra lại với server:** sau mỗi mục, xem server đã ghi nhận hoàn thành chưa; chưa đạt thì treo thêm.
- **Tự mở tab "Tiến trình học tập"** sau mỗi mục rồi quay lại, để cây mục lục cập nhật dấu ✓ (tắt được trong cài đặt).
- **Mục PDF / tài liệu:** mục không yêu cầu thời gian được treo theo số phút bạn chọn.
- **Tự xác nhận "Bạn có đang học tập không ?"** ngay khi hộp thoại hiện ra.
- **Chống dừng khi đổi tab** và tự phát lại video khi bị dừng.
- **Cập nhật một chạm:** nhấp đúp `CapNhat.bat` trong thư mục extension; extension tự khởi động lại và trang LMS tự tải lại.
- **Tắt tiếng nhanh** bằng một nút, để làm việc khác trong lúc treo.
- **Bảng điều khiển:** chọn loại mục (video, PDF, bài đọc…), chọn bài học muốn chạy, xem danh sách, thời gian còn lại và nhật ký.
- Chế độ tự học không bao giờ mở bài kiểm tra / trắc nghiệm.
- **Trợ lý trắc nghiệm (AI):** khi bạn tự mở một bài trắc nghiệm, bấm **🤖 Gợi ý đáp án** để Claude đọc câu hỏi, đánh dấu đáp án gợi ý kèm giải thích ngắn. **✍ Điền gợi ý** chọn sẵn các đáp án đó; **không bao giờ tự nộp bài**. Gợi ý được lưu lại, lần sau gặp câu giống hệt sẽ dùng luôn mà không gọi AI.
- **Bài nghe / điền chỗ trống:** với bài có file audio và các ô cần điền (1.1, 1.2…), cùng nút **🤖 Gợi ý đáp án** sẽ gửi audio kèm đề cho Gemini nghe rồi gợi ý từng ô (viết IN HOA nếu đề yêu cầu); **✍ Điền gợi ý** điền vào các ô. Bạn tự bấm **Lưu câu trả lời** ở từng câu. Cần khoá Gemini vì Claude không nghe được audio.

## Cách hoạt động

LMS chỉ cộng thời gian học của một mục **khi bạn rời khỏi mục đó**. Đủ "thời gian tối thiểu" thì server tự đánh dấu hoàn thành. Extension mở mục, chờ đủ giờ, rồi mở mục tiếp theo để server lưu thời gian của mục trước.

Riêng **video**, LMS chỉ cộng giờ cho phần video **mới được xem** (xem lại đoạn cũ hay video bị dừng thì không tính). Vì vậy với video, extension treo theo tiến độ xem thật, tự tua tới chỗ đã xem xa nhất khi mở lại, và chờ chứ không rời mục khi video bị dừng.

Server ghi nhận hoàn thành ngay khi rời mục, kể cả khi chưa mở tab "Tiến trình học tập". Tuy vậy cây mục lục trên trang chỉ đổi sang dấu ✓ sau khi mở tab đó, nên extension vẫn mở tab này sau mỗi mục.

## Cài đặt

1. Tải file **VnuLmsTreoHoc-vX.Y.zip** ở [Releases](https://github.com/Fr4g1le/VnuLmsTreoHoc/releases/latest) (hoặc **Code → Download ZIP**) rồi giải nén.
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

### Trợ lý trắc nghiệm (AI)

1. Lấy khoá AI, chọn một trong hai:
   - **Google Gemini (miễn phí):** vào [aistudio.google.com/apikey](https://aistudio.google.com/apikey), đăng nhập Google, bấm **Create API key**. Gói miễn phí có giới hạn lượt mỗi phút/ngày và câu hỏi có thể được Google dùng để cải thiện sản phẩm.
   - **Anthropic Claude (trả phí, chính xác hơn):** tạo khoá tại [platform.claude.com](https://platform.claude.com/settings/keys), cần nạp tiền vào tài khoản API; một bài 10 câu chỉ tốn vài trăm đồng.
2. Mở bảng **Treo học** → **⚙ Khoá API** (hoặc chuột phải biểu tượng extension → **Options**), chọn nhà cung cấp, dán khoá, bấm **Lưu**. Khoá chỉ lưu trong trình duyệt, trang LMS không đọc được.
3. Mở bài trắc nghiệm, bấm **LÀM BÀI**, rồi bấm **🤖 Gợi ý đáp án** trong bảng.
4. Xem gợi ý (khung xanh + giải thích dưới mỗi câu), bấm **✍ Điền gợi ý** hoặc tự chọn, kiểm tra lại rồi **tự bấm Nộp bài**.

Bài nghe điền chỗ trống làm giống hệt: bấm **🤖 Gợi ý đáp án** (AI nghe audio mất khoảng 30-60 giây), **✍ Điền gợi ý**, rồi bấm **Lưu câu trả lời** ở từng câu trước khi nộp.

AI có thể sai, nhất là với câu hỏi lừa ("đáp án nào SAI") hoặc kiến thức riêng của giáo trình, nên hãy đọc lại trước khi nộp. Tính năng AI chỉ có ở bản extension, không có ở bản Tampermonkey.

## Các file

| File | Vai trò |
|---|---|
| `manifest.json` | Khai báo extension |
| `content.js` | Logic treo học, trợ lý trắc nghiệm và bảng điều khiển (chạy trong trang LMS) |
| `bridge.js` | Cầu nối giữa trang và background |
| `background.js` | Gọi Claude (đã đóng gói sẵn từ `src/background.js`), mở/đóng bảng khi bấm biểu tượng |
| `options.html`, `options.js` | Trang nhập khoá API và chọn model |
| `CapNhat.bat` | Nhấp đúp để tải bản mới nhất từ Releases và ghi đè vào thư mục extension |
| `vnu-lms-treo-video.user.js` | Bản dùng cho Tampermonkey (không có AI) |

Sửa `src/background.js` thì build lại bằng `npm install` rồi `npm run build`.

Ảnh hướng dẫn trong `docs/img` được dựng từ các trang HTML trong `docs/src` bằng `powershell -File docs/render.ps1` (cần Brave).
