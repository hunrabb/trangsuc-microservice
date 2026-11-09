# Phase 7 — Thu mua vàng bạc cũ và đổi trang sức

Cập nhật: 2026-11-09. Branch: `feat/sales-pos`.

**Task 7.1: DONE về triển khai backend, unit test và kiểm tra tĩnh. PostgreSQL integration/migration: NOT VERIFIED. Phase 7 chưa hoàn thành.** Phase 6 vẫn **Pending Integration Acceptance**; Task 6.5B và các migrations Phase 6 chưa được xác minh trên PostgreSQL thật.

Repo đang có nhiều thay đổi Phase 4–6 chưa commit. Task này bổ sung module riêng, giữ nguyên các thay đổi đó; không commit/push, chuyển branch, reset/restore/clean. Không chạy Docker, PostgreSQL, RabbitMQ, migration deploy/dev hay integration tests.

## Roadmap và acceptance criteria

Nguồn: [ke-hoach.md](ke-hoach.md), Giai đoạn 7; yêu cầu Task 7.1 tiếp nhận và quản lý phiếu.

| Tiêu chí | Trạng thái |
| --- | --- |
| Tiếp nhận hàng theo mã tem tham chiếu hoặc nhập tay; nhiều món; liên hệ khách; mô tả và tình trạng | DONE backend 7.1; chưa có UI/scanner |
| Phân biệt trọng lượng khai báo, số đo ban đầu và kết quả kiểm định | DONE 7.1 cho hai trường đầu; kết quả kiểm định thuộc 7.2 |
| CRUD cần thiết, phân trang/lọc, phân quyền chi nhánh, lifecycle intake | DONE 7.1; không có API xoá |
| Idempotency, version, audit cùng transaction | DONE ở code/unit; cạnh tranh trên DB thật NOT VERIFIED |
| Kiểm định, giá mua vào, khấu trừ và phê duyệt giá | Chưa triển khai; Task 7.2 |
| `Payment(PAYOUT)`, trả tiền, chuyển quyền sở hữu | Chưa triển khai |
| Nhập Inventory `BOUGHT_BACK`/`PENDING_MELT`, movement `BUYBACK` | Chưa triển khai |
| Đổi hàng, lỗi nhập món cũ phải nhả món mới, không có hoá đơn nửa vời | Chưa triển khai |
| Chặn một tem đã mua lại bị mua lại lần hai | Chưa triển khai ở giao dịch thu mua; tham chiếu intake chưa xác minh không phải bằng chứng đã mua |
| Báo cáo thu mua theo ngày và lợi nhuận tiền công/chênh lệch vàng | Chưa triển khai |
| Mọi phiếu thu mua có audit | DONE đối với phiếu intake: tạo/sửa/gửi/huỷ; audit giao dịch các bước sau chưa triển khai |

Chỉ hoàn tất Task 7.1. Không triển khai Task 7.2–7.5 hoặc Phase 8.

## Service ownership và ranh giới

`Sales → BuybacksModule` sở hữu phiếu tiếp nhận. Theo bảng ownership trong `CLAUDE.md`, Sales đã sở hữu khách hàng, thu mua và đổi hàng. Không tạo service mới hay database catalog/thu mua riêng. `Inventory` tiếp tục sở hữu sản phẩm, tồn kho và giá kim loại; Task này không đọc database hay gọi API Inventory, không sửa POS, checkout hoặc recovery worker.

`Customer` hiện có trong cùng Sales được tham chiếu bằng FK nếu chọn khách cũ. Nhập liên hệ mới chỉ lưu snapshot tên/số điện thoại trên phiếu, không tự tạo hoặc sửa khách. Không thu thập giấy tờ định danh, địa chỉ hay tài khoản ngân hàng. Không thêm RabbitMQ event, outbox hay consumer vì bước này chưa có bên tiêu thụ.

`AuditLog` POS hiện bắt buộc `orderId`; dùng `BuybackIntakeAudit` riêng để không tạo hoá đơn giả. Audit chỉ append ở application, ghi actor, branch, action, trạng thái/phiên bản trước–sau và thời gian. Không chép liên hệ, ghi chú hoặc idempotency key vào audit. Detail trả 50 bản ghi mới nhất theo version; lịch sử cũ vẫn được lưu, chưa cung cấp endpoint duyệt toàn bộ lịch sử.

## Dữ liệu tiếp nhận

- Một phiếu có 1–20 dòng, mỗi dòng tương ứng một món vật lý; không có quantity gộp.
- `source=STORE_TAG` bắt buộc `referenceTagCode`; `EXTERNAL` phải để null/không gửi mã này. Đây là **tham chiếu khách/nhân viên khai báo, chưa xác minh xuất xứ hoặc quyền sở hữu**. Không cho lặp cùng mã trong một phiếu; chưa áp unique trên các phiếu intake khác nhau.
- `assetKind`: `GOLD`, `SILVER`, `JEWELRY`; mô tả và tình trạng bắt buộc.
- `declaredWeight`: trọng lượng khách khai; `initialMeasuredWeight`: số đo ban đầu. Đơn vị **chỉ**, Decimal(12,4), API dùng chuỗi, tối đa 8 chữ số phần nguyên/4 phần lẻ, phải dương nếu có. Có thể để null khi chưa có thông tin; không mặc định thành 0.
- `declaredPurity` chỉ là hàm lượng khách khai; không phải kết quả kiểm định. DTO từ chối `verifiedWeight`, `verifiedPurity`, giá hoặc trường phê duyệt. Kết quả kiểm định cùng người xác minh/thời gian/chứng cứ sẽ được thiết kế riêng ở 7.2.
- Mã phiếu server sinh `BB-<UUID>`, unique; actor lấy từ JWT; branch lấy từ route và kiểm quyền backend; thời gian do server sinh.
- Các ghi chú optional bỏ trống mặc định null; chuỗi chỉ có khoảng trắng bị từ chối. PUT thay toàn bộ dữ liệu editable, trường optional bỏ qua được xoá về null. Dòng nhận ID mới sau PUT DRAFT; ID dòng ổn định sau khi gửi kiểm định.

## Lifecycle và authorization

```text
DRAFT ──submit──> PENDING_APPRAISAL
  │                    │
  └────cancel──────────┴──> CANCELLED
```

`PENDING_APPRAISAL` chỉ có nghĩa đang chờ kiểm định. `CANCELLED` là terminal trong Task 7.1. Không tự hoàn tất mua, thanh toán hoặc nhập kho; không cho mở lại phiếu đã huỷ hoặc sửa phiếu đang chờ kiểm định.

| Thao tác | STAFF đúng chi nhánh | MANAGER đúng chi nhánh / ADMIN toàn hệ thống |
| --- | --- | --- |
| Tạo, danh sách, xem chi tiết | Có | Có |
| Sửa/gửi DRAFT | Chỉ phiếu chính mình tạo | Mọi phiếu trong phạm vi |
| Huỷ DRAFT | Chỉ phiếu chính mình tạo | Có |
| Huỷ PENDING_APPRAISAL | Không | Có, có lý do |
| Sửa PENDING_APPRAISAL hoặc thao tác CANCELLED | Không | Không |

Tái sử dụng `JwtAuthModule`, `@Roles`, policy chi nhánh hiện có. Token mặc định audience `backoffice`; không thêm role. Tất cả thao tác service kiểm branch; truy vấn bản ghi cũng ràng buộc `id + branchId`. Route chi nhánh không được cấp quyền trả 403; ID thuộc chi nhánh khác dưới một route được phép trả 404. Body/query strict không nhận branchId/createdBy/status tùy ý từ frontend.

Mọi phản hồi endpoint đặt `Cache-Control: no-store`. List bỏ số điện thoại, ghi chú và các dòng chi tiết. Presenter không trả idempotency key hoặc request hash. Gateway dùng route private hiện có; không sửa route hoặc policy authorization của các module trước.

## API và contracts

Prefix qua Gateway: `/api/admin/sales/branches/{branchId}/buybacks`.
Sales nhận cùng suffix dưới `/admin/branches/{branchId}/buybacks`.

| Method | Suffix | Request | Thành công |
| --- | --- | --- | --- |
| POST | `/` | `CreateBuyback`, header `Idempotency-Key` | 201 detail; retry trả cùng phiếu hiện tại |
| GET | `/` | `page`, `pageSize`, `status`, `from`, `to` | 200 `{items,total,page,pageSize}` |
| GET | `/by-key` | Header `Idempotency-Key` của chính actor/branch | 200 detail |
| GET | `/{id}` | UUID | 200 detail |
| PUT | `/{id}` | `UpdateBuyback`: toàn bộ nội dung + `version` | 200 detail |
| POST | `/{id}/submit` | `{version}` | 200 detail |
| POST | `/{id}/cancel` | `{version,reason}`; reason 5–500 ký tự | 200 detail |

`page` mặc định 1, tối đa 10000; `pageSize` mặc định 20, tối đa 50. Từ chối query lạ, mảng, boolean hoặc số không nguyên. Lọc status và `receivedAt` UTC bằng `from <= receivedAt <= to`; yêu cầu `from <= to`. Chi nhánh lọc qua route bắt buộc. Thứ tự ổn định `receivedAt DESC, id DESC`.

Lỗi dùng envelope/error codes hiện có: 400 validation, 401 token, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `INVALID_STATE`/`VERSION_CONFLICT`, 422 `IDEMPOTENCY_KEY_REUSED`, 503 khi hết thời gian chờ khoá. DTO dùng Zod shared; OpenAPI Sales sinh components từ cùng nguồn. Các điều kiện liên trường (source/mã tem, không lặp tem, from/to) vẫn được backend kiểm, có mô tả trong spec.

Ví dụ tạo phiếu (header `Idempotency-Key` bắt buộc):

```json
{
  "customer": { "name": "Khách thử", "phone": "0912345678" },
  "items": [{
    "source": "EXTERNAL",
    "assetKind": "GOLD",
    "description": "Nhẫn cũ",
    "condition": "Trầy nhẹ",
    "declaredWeight": "1.2000",
    "initialMeasuredWeight": "1.1500",
    "declaredPurity": "Khách khai 18K"
  }]
}
```

Khách cũ thay `customer` bằng `{ "customerId": "<UUID>" }`; không được gửi đồng thời ID và tên/số điện thoại.

## Transactions, concurrency và idempotency

- Migration mới: `apps/sales/prisma/migrations/20261109130000_buyback_intake/migration.sql`. Chỉ thêm 4 enums và 3 bảng `BuybackIntake`, `BuybackIntakeItem`, `BuybackIntakeAudit`; không viết lại migration cũ hoặc dữ liệu hiện có.
- Header có unique code, unique `(branchId,createdBy,idempotencyKey)`, version, indexes branch/status/receivedAt/id và customerId. FK chỉ trong schema Sales. Các UUID Auth là tham chiếu logic, không có FK xuyên service.
- SQL CHECK bảo vệ version dương, trạng thái/timestamps/lý do huỷ, trọng lượng dương nếu có, vị trí dòng 1–20, source/mã tham chiếu, chuỗi version audit. Unique `(intakeId,position)` và `(intakeId,toVersion)`.
- Tạo header, dòng và audit trong cùng transaction. Sửa/gửi/huỷ lấy row lock `FOR UPDATE` theo id/branch rồi kiểm quyền sở hữu, version và state. UPDATE có điều kiện id/branch/version/status, count phải bằng 1; tăng version và append audit atomically.
- Transaction ghi `ReadCommitted`, `lock_timeout=3s`, dùng helper retry deadlock hiện có. Đọc detail/list dùng `RepeatableRead`; replay key lấy `FOR SHARE` để không trộn header và dòng đang được thay thế.
- Creation key dài 1–200 ký tự, scope actor + branch. Hash SHA256 nội dung chuẩn hoá điện thoại và Decimal; thứ tự dòng có ý nghĩa. Cùng key/nội dung trả lại ID và snapshot hiện tại, kể cả đã sửa/gửi/huỷ, không thêm audit. Khác nội dung request gốc trả 422.
- Unique constraint phân xử race tạo phiếu; chỉ bắt đúng lỗi index idempotency và đọc lại trong transaction mới. Không nuốt lỗi unique mã phiếu/hạ tầng. Key/hash không được trả ra response hay ghi trong audit. Tra key không nhận key của nhân viên khác.

## Files Task 7.1

- Mới: `apps/sales/src/buybacks/{buybacks.module.ts,buybacks.controller.ts,buybacks.service.ts}`.
- Mới: migration `20261109130000_buyback_intake/migration.sql`, `libs/contracts/src/buyback-api.ts`.
- Mới: `apps/sales/test/buybacks.test.mjs`, `apps/gateway/src/proxy/buybacks.test.ts`, tài liệu này.
- Bổ sung: `apps/sales/prisma/schema.prisma`, `apps/sales/src/app.module.ts`, `apps/sales/package.json`, `apps/sales/README.md`.
- Bổ sung: `libs/contracts/src/index.ts`, `libs/contracts/src/openapi.ts`, `docs/api/sales.openapi.yaml`, `docs/thiet-ke.md` mục 5.3.1.
- Prisma generated client và dist được sinh cục bộ, ignored theo repo; không cần commit chúng.

## Verification — giới hạn đúng Task 7.1

Chỉ chạy checks trên module mới/package trực tiếp thay đổi; không chạy lại test Phase 4/5/6, toàn monorepo, load test hay integration test.

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm --filter @jewelry/contracts build` | PASS |
| `pnpm --filter @jewelry/sales db:generate` | PASS, chỉ sinh client, không kết nối DB |
| `pnpm --filter @jewelry/sales build` | PASS |
| `pnpm --filter @jewelry/sales test:buybacks` | PASS: 18 tests, 0 failed/skipped |
| Unit route Gateway `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON apps/gateway/src/proxy/buybacks.test.ts` | PASS: 1 test |
| ESLint các file TS/MJS thay đổi của 7.1 | PASS |
| Typecheck contracts, Sales, Gateway (chạy tuần tự) | PASS cả 3 package |
| `pnpm --filter @jewelry/sales exec prisma validate` | PASS, kiểm tra schema offline |
| OpenAPI generate và `--check --only=sales`; `validate-api docs/api/sales.openapi.yaml` | PASS; validator trả `valid: true` |
| Prettier các file code; `git diff --check` các file tracked liên quan | PASS |
| PostgreSQL integration/migration apply/SQL CHECK/FK thực tế | **NOT VERIFIED**, không chạy theo yêu cầu |
| Concurrent requests trên PostgreSQL thật | **NOT VERIFIED**; unit fake không chứng minh khoá/unique/isolation trên DB |
| HTTP xuyên Gateway/Sales/JWT/adapter thật, triển khai migration chain | **NOT VERIFIED**, không khởi động stack |

Unit tests kiểm tạo nhiều món, input/phone/weight/unknown fields, chi nhánh và actor thật, STAFF sở hữu phiếu, trạng thái khoá/terminal, stale version/CAS, idempotency/recovery/race unique được mô phỏng, rollback khi audit lỗi, audit context/giới hạn 50, pagination/filter/time, controller metadata/validation và Gateway route. Fake chỉ cung cấp model intake/customer; truy cập payment/order/outbox/Inventory ngoài phạm vi bị từ chối. Không tuyên bố concurrency hoặc rollback đã PASS trên database thật.

## Quyết định cần xác nhận trước các bước tiếp theo

Các lựa chọn hiện tại cho bước intake: tối đa 20 món; mã UUID; STAFF thao tác DRAFT của mình nhưng xem phiếu cùng chi nhánh; MANAGER/ADMIN được huỷ phiếu chờ kiểm định; cho phép thiếu trọng lượng/hàm lượng khi chưa có thông tin; tem chỉ là tham chiếu chưa xác minh. Cần xác nhận với nghiệp vụ trước khi mở rộng: mã in phiếu theo chi nhánh, quyền xem liên hệ khách, mức bắt buộc số đo khi bàn giao kiểm định, cách xác minh tem/hàng ngoài, phân quyền người kiểm định/phê duyệt, thời gian lưu PII và audit.

Roadmap có màn hình POS thu mua ở mức tổng thể, chưa phân định bắt buộc UI trong Task 7.1. Lần này chuẩn bị backend/contracts; giao diện danh sách/tạo/chi tiết/sửa intake được hoãn, không redesign Backoffice. Chưa có thao tác quét hoặc xác minh tem thực tế.

## Chuẩn bị Task 7.2 — chưa triển khai

1. Chốt tiêu chuẩn kiểm định, quyền appraiser theo role hiện có, đơn vị/quy tắc quy đổi và chứng cứ xác minh.
2. Thiết kế kết quả kiểm định tách biệt dữ liệu khách khai/số đo ban đầu, gắn với ID món đã khoá, actor/time/version.
3. Xác định API giá mua vào từ Inventory, snapshot giá/khấu trừ, Decimal và quy tắc làm tròn; không tin giá frontend.
4. Mở rộng lifecycle và policy có kiểm soát, xử lý cạnh tranh với huỷ; giữ audit/optimistic locking.
5. Trước acceptance cần môi trường PostgreSQL được cho phép để xác minh migration chain, constraints, row lock và unique-key races. Các bước chi tiền/nhập kho/đổi hàng/báo cáo vẫn ngoài 7.1.
