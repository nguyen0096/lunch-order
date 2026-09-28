# Lọc giao dịch SePay theo từ khóa

Hướng dẫn này bằng tiếng Việt vì người thực hiện là admin của văn phòng, thao
tác trên giao diện tiếng Việt của SePay.

## Vấn đề

Tài khoản ngân hàng dùng để thu tiền ăn trưa cũng là tài khoản cá nhân. Nếu
không lọc, SePay đồng bộ **mọi** giao dịch tiền vào: lương, tiền bạn bè chuyển
trả, hoàn tiền. Hậu quả:

- Những giao dịch không liên quan sẽ hiện trong app, ở mục **"Money that matched
  nobody"** trên màn hình Payments. Mục đó để phát hiện người trả tiền ăn nhưng
  ghi sai mã, chứ không phải để hiển thị sao kê cá nhân.
- Mỗi giao dịch tiền vào đều bị tính vào hạn mức tháng (gói FREE: 50 giao
  dịch/tháng).

## Cách làm

Vào <https://my.sepay.vn> → **Tài khoản ngân hàng** → chọn tài khoản đang dùng →
**Cấu hình chung**.

1. **Tắt "Đồng bộ giao dịch tiền ra".** Tiền đi ra không bao giờ là tiền ăn
   trưa.
2. **Bật "Lọc giao dịch theo từ khóa"** và nhập từ khóa: `LUNCH`

Xong. SePay sẽ **chỉ đồng bộ các giao dịch có nội dung chứa** từ khóa này.

## Tại sao là `LUNCH`

Mã thanh toán của app có dạng `LUNCHNGUY`: `LUNCH` + mã ngắn của người trả. Mã
này nằm trong nội dung chuyển khoản, và app hiển thị nó rất rõ trên màn hình
Bill để người trả sao chép. Mỗi người một mã, không đổi theo tuần, nên lưu được
mẫu chuyển khoản trong app ngân hàng.

Trước đây mã có dạng `L39NGUY`. Từ khóa `L` thì chẳng lọc được gì, vì gần như mọi
nội dung chuyển khoản đều có chữ L. Đó là lý do mã được đổi.

## Lọc ở đây khác với lọc ở webhook

Đây là điểm dễ nhầm, và chọn sai thì không đạt được mục đích:

| | |
| --- | --- |
| **Lọc giao dịch theo từ khóa** (ở tài khoản ngân hàng) | Giao dịch bị loại **không vào SePay**. Không vào SePay thì không thể vào app. |
| **"Chỉ gửi khi có mã thanh toán"** (ở webhook) | Chỉ quyết định giao dịch nào được **gửi đi**. SePay vẫn nhận và vẫn lưu phần còn lại. |

Cần tách bạch tiền cá nhân với tiền ăn trưa thì phải dùng loại thứ nhất.

## Đánh đổi, cần biết trước

Một người trả tiền ăn nhưng **quên ghi mã** thì giao dịch đó cũng không được
đồng bộ. App sẽ không thấy gì cả, thay vì thấy một giao dịch chưa khớp. Nói cách
khác, mã thanh toán trên màn hình Bill từ "nên có" trở thành "bắt buộc".

Đây là cái giá của việc lọc ngay từ đầu, và vẫn đáng, nhưng nên nói trước với
mọi người.

## Những điều tài liệu SePay không nói: kiểm tra trên giao diện

Tài liệu chỉ mô tả tính năng, không nói rõ ba điểm sau. Xem trực tiếp khi cấu
hình:

- Nhập được **nhiều từ khóa** hay chỉ một.
- Có **phân biệt chữ hoa/thường** không. Nếu có, nhập đúng `LUNCH` viết hoa, vì
  mã do app sinh ra luôn viết hoa.
- Áp dụng cho **giao dịch cũ** hay chỉ giao dịch mới. Nhiều khả năng chỉ áp dụng
  cho giao dịch mới, nên số giao dịch đã tính trong tháng này vẫn giữ nguyên.

## Sau khi bật

Ghi số tài khoản vào app: **Settings → Your office → Where the money goes**.
Webhook dùng số tài khoản để biết giao dịch thuộc văn phòng nào, nên nó phải
đúng, chứ không chỉ để sinh mã QR.
