# Backoffice

Giao diện nội bộ cho quản trị chi nhánh và nhân viên. Ứng dụng dùng React, Vite, TypeScript, React Router,
TanStack Query và Mantine. Mọi API được gọi cùng origin qua `/api`; khi chạy dev, Vite chuyển tiếp tới gateway,
còn trong Docker nginx chuyển tiếp request đó.

## Cấu trúc chính

| Đường dẫn                                     | Vai trò                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/main.tsx`                                | Khởi tạo Mantine, React Router, TanStack Query và `SessionProvider`.                      |
| `src/App.tsx`                                 | Khai báo route và lớp bảo vệ trang đăng nhập/role.                                        |
| `src/api/api-client.ts`                       | Gửi request, giữ access token trong memory, refresh, retry và quản lý timer.              |
| `src/api/instance.ts`                         | Tạo API client dùng chung và nối callback session với React.                              |
| `src/api/endpoints.ts`                        | Các hàm gọi API auth theo contract tại `docs/api/auth.openapi.yaml`.                      |
| `src/api/api-error.ts`, `messages.ts`         | Đọc lỗi API và ánh xạ mã lỗi thành thông báo tiếng Việt.                                  |
| `src/api/queries.ts`                          | Query key và hook lấy dữ liệu bằng TanStack Query.                                        |
| `src/auth/session-context.tsx`                | Trạng thái phiên, `/me`, đăng nhập, đăng xuất và phản ứng khi mất quyền.                  |
| `src/auth/permissions.ts`                     | Quy tắc hiện route/nút theo role để giao diện dễ dùng; backend vẫn quyết định quyền thật. |
| `src/auth/require-auth.tsx`                   | Chặn trang riêng tư, giữ đường dẫn trở về và hiển thị trang không có quyền.               |
| `src/auth/active-branch.tsx`                  | Chi nhánh đang làm việc; chỉ lưu ID chi nhánh trong `localStorage`.                       |
| `src/auth/google-button.tsx`, `src/config.ts` | Tải Google Identity Services và đọc Client ID đã được Vite nhúng vào build.               |
| `src/components/icons.tsx`                    | Biểu tượng SVG dùng cho menu và nút (không dùng thư viện biểu tượng).                     |
| `src/layout/app-shell.tsx`                    | Sidebar, topbar, chọn chi nhánh và menu tài khoản.                                        |
| `src/pages/`                                  | Trang đăng nhập, trang chủ, chi nhánh, nhân viên, đổi mật khẩu và trang lỗi.              |
| `src/components/`                             | Thành phần dùng chung như hộp thoại xác nhận, editor vai trò và thông báo lỗi.            |

## Đăng nhập Google

1. Google Identity Services được tải trong `src/auth/google-button.tsx` và vẽ nút đăng nhập.
2. Khi Google trả ID token, `SessionProvider.loginWithGoogle` gửi credential tới `POST /api/auth/google`.
3. Auth service xác minh ID token; tài khoản phải được tạo trước và đang có quyền truy cập.
4. Backend trả access token trong response và refresh token qua cookie bảo mật. Frontend lưu access token trong
   API client, rồi tải thông tin hiện tại từ `GET /api/auth/me`.

## Đăng nhập ADMIN bằng mật khẩu

`src/pages/login-page.tsx` gửi email và mật khẩu tới `POST /api/auth/login`. Chỉ ADMIN được cấp mật khẩu mới dùng
được cách này. Backend trả cùng lỗi `INVALID_CREDENTIALS` cho các trường hợp sai thông tin hoặc tài khoản không
đủ điều kiện, tránh tiết lộ email có tồn tại hay không. `src/api/messages.ts` ánh xạ lỗi thành câu tiếng Việt;
`RATE_LIMITED` hiển thị số giây chờ nếu response có `Retry-After`.

## Session và refresh

- Access token chỉ nằm trong biến của `src/api/api-client.ts`; không ghi vào storage của trình duyệt.
- Refresh token là cookie `httpOnly`, JavaScript không thể đọc. Backend đặt thuộc tính `Secure`, `SameSite=Strict`
  và giới hạn cookie vào đường dẫn auth.
- Khi mở hoặc tải lại trang, `SessionProvider` gọi `api.restore()`, gửi `POST /api/auth/refresh` để khôi phục phiên,
  rồi truy vấn `/api/auth/me`.
- Khi access token gần hết hạn, client chủ động refresh trước khoảng một phút. Gặp `401 TOKEN_EXPIRED`, request
  gọi refresh và các request đồng thời dùng chung một Promise; refresh thành công thì gửi lại request gốc.
- `409 REFRESH_CONFLICT` được thử lại một lần để xử lý hai tab cùng xoay cookie. `INVALID_TOKEN` và
  `SESSION_EXPIRED` không kích hoạt refresh lần nữa: client xoá token và điều hướng về đăng nhập, giữ đường dẫn
  hiện tại để quay lại sau khi đăng nhập.
- Khi gặp `403`, client không đăng xuất. Session context tải lại `/me` và hiện thông báo không đủ quyền.
- Đăng xuất gọi `POST /api/auth/logout`; đăng xuất mọi thiết bị gọi `POST /api/auth/logout-all`. Sau đó client
  xoá token, huỷ timer, dọn query cache và đưa người dùng về trang đăng nhập.

## Router, role và chi nhánh

`src/App.tsx` đặt các trang riêng tư dưới `RequireAuth`. Trang chi nhánh chỉ dành cho ADMIN; trang nhân viên dành
cho ADMIN/MANAGER; đổi mật khẩu chỉ dành cho ADMIN. Sidebar và thao tác trong trang cũng lọc theo role.

MANAGER chỉ được lọc nhân viên theo các chi nhánh có role MANAGER trong `/me`; giao diện không cho chọn chi nhánh
ngoài danh sách đó. Backend auth vẫn kiểm lại actor, target và branch scope từ database cho mỗi request. Ẩn menu
không phải là cơ chế bảo mật.

## Chạy phát triển

Yêu cầu Node và pnpm theo phiên bản trong `.nvmrc` và `package.json` ở root. Cần gateway/auth cùng Postgres và
RabbitMQ theo hướng dẫn chạy local trong root `README.md`.

`pnpm dev` đọc `GOOGLE_CLIENT_ID` từ `.env` ở root để cấu hình `VITE_GOOGLE_CLIENT_ID` cho Vite. Auth service
cũng cần `GOOGLE_CLIENT_ID` trong `apps/auth/.env` để kiểm tra audience của ID token. Không ghi Client ID vào mã
nguồn hoặc log; thay đổi `.env` thì khởi động lại tiến trình Vite.

Build backoffice trong Docker dùng build arg `VITE_GOOGLE_CLIENT_ID`, được truyền từ `GOOGLE_CLIENT_ID` trong
`.env` root qua `docker-compose.yml`. Có thể build riêng image bằng `docker compose build backoffice`; lệnh này
không khởi động hay dừng container. Nếu thiếu Client ID, trang đăng nhập thông báo Google chưa được cấu hình và
vẫn cho ADMIN mở form email/mật khẩu.

## Thử Google Login thật

1. Trong Google Cloud Console, cấu hình OAuth Web Client, thêm origin của Backoffice vào danh sách JavaScript
   origins và thêm Gmail thử nghiệm vào OAuth Test users.
2. Đặt cùng Client ID vào cấu hình root dùng cho frontend và `apps/auth/.env` dùng cho backend; không đưa giá trị
   đó vào README, source control hoặc log.
3. Tạo user trước bằng lệnh `admin:create` hoặc trang Nhân viên. Tài khoản phải có role còn hiệu lực; Google login
   liên kết theo email đã provision lần đầu.
4. Mở Backoffice và đăng nhập bằng Google. Sau khi vào được, trang chủ hiển thị trạng thái liên kết Google và
   các role/chi nhánh lấy từ `/me`.

## Checklist kiểm thử thủ công

- Mở `/dang-nhap`, thử Google Login với user đã provision; thử email/mật khẩu ADMIN đúng và sai.
- Tải lại một trang riêng tư khi đã đăng nhập; xác nhận phiên được khôi phục bằng refresh cookie.
- Thử nhiều request đồng thời sau khi access token hết hạn; xác nhận client chỉ gửi một refresh trong cùng tab.
- Đăng xuất và đăng xuất mọi thiết bị; xác nhận giao diện về trang đăng nhập và query cache bị dọn.
- Với ADMIN: tạo, sửa, ngừng và kích hoạt lại chi nhánh; thử cập nhật bằng version cũ để thấy thông báo tải lại.
- Với ADMIN: tạo/sửa nhân viên, gán role, khóa/mở khóa, gỡ Google và reset mật khẩu ADMIN khác.
- Với MANAGER: xác nhận danh sách chỉ lọc được chi nhánh của mình và chỉ thao tác được STAFF trong scope.
- Thử URL không có quyền và xác nhận trang không tải dữ liệu; backend vẫn phải trả `403` nếu gọi API trực tiếp.
