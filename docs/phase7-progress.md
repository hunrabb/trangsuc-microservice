# Phase 7 — Thu mua vàng bạc cũ và đổi trang sức

Task 7.UI-A (Backoffice tiếp nhận, kiểm định, báo giá và duyệt giá): xem [tiến độ UI](phase7-ui-progress.md). Phần bên dưới ghi lại tiến độ backend Phase 7 theo từng task.

Cập nhật: 2026-11-09. Branch: `feat/sales-pos`.

**Task 7.5A: BLOCKED — chưa thể chạy DB-13.** Docker Engine qua context
`desktop-linux` không kết nối được; WSL interop báo lỗi vsock, file env test
trong `/tmp` đã mất. Chưa có SQL assertion hay worker run mới. Không xoá/tạo
lại volume hoặc sửa cấu hình WSL. Chẩn đoán và trạng thái DB-13A–E nằm trong
[phase7-buyback-inventory-evidence.md](phase7-buyback-inventory-evidence.md).
Lần kiểm tra lại 2026-11-09: Engine và WSL interop vẫn không truy cập được;
DB-13A–E tiếp tục BLOCKED, chưa có SQL assertion mới.

**Task 7.4: DONE trong phạm vi backend kết nối thu mua → Inventory → Report.**
Chỉ settlement đã SETTLED sau xác nhận tiền và bàn giao mới tạo món `BOUGHT_BACK`/
`PENDING_MELT` trong Inventory; Report ghi fact thu mua riêng với doanh thu bán hàng.
PostgreSQL integration 12/12 PASS; RabbitMQ integration 3/3 PASS trên Docker test
riêng. Thiết kế, migration, kiểm thử và giới hạn xem
[phase7-buyback-inventory-evidence.md](phase7-buyback-inventory-evidence.md).
Test bù event `DB-13` thêm sau đó chưa chạy lại được vì phiên WSL/Docker bị
ngắt; xem Task 7.5A BLOCKED trong evidence. Task 7.5B chưa triển khai; Phase 6 vẫn PARTIAL.

**Task 7.3: DONE trong phạm vi backend settlement và đổi trang sức, với xác nhận tiền/bàn giao thủ công.**
Kết quả PostgreSQL/Inventory HTTP và RabbitMQ/Report, giới hạn kiểm chứng và hướng dẫn
chạy ở [phase7-settlement-evidence.md](phase7-settlement-evidence.md). Phase 6 vẫn PARTIAL.

**Task 7.2: DONE trong phạm vi backend kiểm định, định giá và duyệt giá đã được yêu cầu.**
Unit mới 12/12 PASS; regression intake 18/18 và Gateway route 1/1 PASS; PostgreSQL
integration 18/18 PASS (MIG-01 + DB-01…DB-17). Không có chi tiền, nhập kho hoặc đổi hàng.
**Phase 7 chưa hoàn thành; Phase 6 vẫn PARTIAL**, xem kết quả thực tế 6.5B trong
[phase6-acceptance-report.md](phase6-acceptance-report.md), không dùng trạng thái lịch sử dưới đây thay kết quả mới.

Baseline trước Task 7.2: working tree sạch, branch `feat/sales-pos`, HEAD `48e469a`
(checkpoint local, không mặc định đã push). Không commit/push/reset/restore/clean,
rebase/merge hoặc đổi branch trong Task 7.2. Chỉ bật PostgreSQL test riêng; giữ nguyên
DB dev/production và DB evidence Phase 6. Phần **Task 7.1 bên dưới là ghi nhận lịch sử**
của lúc triển khai intake; phần kiểm chứng mới và kế hoạch 7.3 ở cuối tài liệu.

## Roadmap và acceptance criteria

Nguồn: [ke-hoach.md](ke-hoach.md), Giai đoạn 7; yêu cầu Task 7.1 tiếp nhận và quản lý phiếu.

| Tiêu chí | Trạng thái |
| --- | --- |
| Tiếp nhận hàng theo mã tem tham chiếu hoặc nhập tay; nhiều món; liên hệ khách; mô tả và tình trạng | DONE backend 7.1; chưa có UI/scanner |
| Phân biệt trọng lượng khai báo, số đo ban đầu và kết quả kiểm định | DONE 7.1 cho hai trường đầu; kết quả kiểm định thuộc 7.2 |
| CRUD cần thiết, phân trang/lọc, phân quyền chi nhánh, lifecycle intake | DONE 7.1; không có API xoá |
| Idempotency, version, audit cùng transaction | 7.2 appraisal/approval/policy CAS và rollback đã PostgreSQL PASS; create-key race 7.1 trước đây chỉ unit |
| Kiểm định, giá mua vào, khấu trừ và phê duyệt giá | DONE backend Task 7.2; unit và PostgreSQL integration PASS, xem mục mới cuối file |
| Settlement chi tiền, xác nhận thực tế và bàn giao | DONE backend 7.3 bằng chứng thủ công; 7.4 phát event ghi kho sau SETTLED |
| Nhập Inventory `BOUGHT_BACK`/`PENDING_MELT`, movement `BUYBACK` | DONE backend 7.4, PostgreSQL và RabbitMQ integration PASS |
| Đổi hàng, giữ món mới và phục hồi khi một DB lỗi | DONE backend 7.3; 7.4 nhập món cũ vào Inventory khi hoàn tất |
| Chặn một tem đã mua lại bị mua lại lần hai | Chưa triển khai ở giao dịch thu mua; tham chiếu intake chưa xác minh không phải bằng chứng đã mua |
| Báo cáo thu mua theo ngày và lợi nhuận tiền công/chênh lệch vàng | DONE 7.4 số lượng/giá trị/đối soát; lợi nhuận tiền công và vàng chưa thuộc 7.4, chưa có chính sách xác định |
| Mọi phiếu thu mua có audit | DONE intake, 7.2 appraisal/approval, 7.3 settlement và 7.4 receipt |

Các mục thiết kế Task 7.1 bên dưới là ghi nhận lịch sử; kết quả 7.2 và 7.3 nằm ở
phần evidence riêng. Chưa triển khai 7.5 hoặc Phase 8.

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

## Chuẩn bị Task 7.2 — ghi nhận lịch sử trước khi triển khai

1. Chốt tiêu chuẩn kiểm định, quyền appraiser theo role hiện có, đơn vị/quy tắc quy đổi và chứng cứ xác minh.
2. Thiết kế kết quả kiểm định tách biệt dữ liệu khách khai/số đo ban đầu, gắn với ID món đã khoá, actor/time/version.
3. Xác định API giá mua vào từ Inventory, snapshot giá/khấu trừ, Decimal và quy tắc làm tròn; không tin giá frontend.
4. Mở rộng lifecycle và policy có kiểm soát, xử lý cạnh tranh với huỷ; giữ audit/optimistic locking.
5. Trước acceptance cần môi trường PostgreSQL được cho phép để xác minh migration chain, constraints, row lock và unique-key races. Các bước chi tiền/nhập kho/đổi hàng/báo cáo vẫn ngoài 7.1.


## Task 7.2 — kiểm định, báo giá và phê duyệt (2026-11-09)

### Phạm vi và quyết định nghiệp vụ đã được xác nhận

Người dùng chọn: **dùng MetalPrice.buyPrice của Inventory theo đúng tuổi kim loại,
khấu trừ VND/món do ADMIN cấu hình, làm tròn nửa lên đến 1.000 VND; người duyệt khác
người lập**. Không lấy giá Internet, không hardcode giá thị trường/chiết khấu/hao hụt/
tiền công, không đặt ngưỡng tiền duyệt. Không có policy/giá hợp lệ thì chặn báo giá.

Sales sở hữu kiểm định, policy khấu trừ/ánh xạ hàm lượng, quote và approval. Inventory
vẫn sở hữu `Metal/MetalPrice`, chỉ bổ sung **read-only** internal endpoint lấy giá
mua vào có hiệu lực. Sales không đọc schema/database Inventory. Không thêm event,
outbox, payment, stock receipt hoặc chuyển quyền sở hữu ở Task 7.2.

### Lifecycle và quyền

```text
DRAFT -> PENDING_APPRAISAL -> APPRAISED -> APPROVED / REJECTED
  |             |
  +--cancel-----+-> CANCELLED (policy 7.1 giữ nguyên)
```

- STAFF/MANAGER trong chi nhánh và ADMIN toàn hệ thống ghi kiểm định riêng mỗi món
  khi phiếu PENDING_APPRAISAL hoặc APPRAISED. STAFF được giao quyền này theo membership
  chi nhánh hiện có; không có role mới hoặc tự nhận actor/branch từ body.
- Từng món lưu revision bất biến: số cân thực, trọng lượng chấp nhận (dương và không
  vượt số cân), metalId, GOLD/SILVER, hàm lượng **phần nghìn** `(0,1000]`, tình trạng,
  ghi chú, actor JWT, thời gian server và intakeVersion. Dữ liệu khai báo/số đo ban
  đầu 7.1 không bị ghi đè. JEWELRY được kiểm định thành GOLD hoặc SILVER; phiếu khai
  GOLD/SILVER phải khớp loại kiểm định. Tham chiếu metal không có giá/policy phù hợp
  không thể dùng tạo quote. Phần mềm không tự suy đoán tuổi từ nhãn/mã tem.
- Chỉ chuyển APPRAISED khi mọi món có kết quả. Tạo quote cần đúng toàn bộ item IDs,
  đủ kết quả hiện hành, policy đúng branch/metal/kind/purity/version và nguồn giá hợp lệ.
- Sửa một kết quả làm quote QUOTED hiện hành thành SUPERSEDED, xoá activeQuoteId;
  quote cũ và revision cũ được giữ, không sửa lại snapshot. Tạo quote mới cũng
  supersede quote chưa duyệt trước đó; quote/request cũ không thể ghi đè quote mới.
- MANAGER đúng chi nhánh hoặc ADMIN được duyệt/từ chối quote hiện hành. **Ngay cả
  ADMIN cũng không được tự duyệt** nếu là người tạo intake, người tạo quote hoặc
  người ghi một trong các kết quả kiểm định đang được quote sử dụng.
- REJECTED bắt buộc lý do 5–500 ký tự, lưu cùng quote/actor/time/audit trong transaction.
  Yêu cầu tách maker-checker áp dụng approval; từ chối có lý do không chi tiền.
- APPROVED/REJECTED terminal trong 7.2; không sửa lại intake, kiểm định, tiền/line
  snapshot hoặc quyết định. Approval không phải xác nhận đã mua/trả tiền/nhập kho.
  Không mở lại/cancel APPRAISED bằng endpoint 7.1; dùng quyết định quote của 7.2.

### Công thức, đơn vị, độ chính xác và snapshot

```text
net_i = acceptedWeightChi_i × Inventory.buyPricePerChi(alloy_i) − policy.deductionVndPerItem_i
amount_i = HALF_UP(net_i / 1000) × 1000
quote.total = SUM(amount_i)
```

Giá mua đã theo tuổi của metal mà ADMIN ánh xạ trong policy, **không nhân thêm hàm
lượng lần nữa**. Hàm lượng phần nghìn là kết quả assay/tiêu chí chọn đúng policy,
không phải hệ số tự động nhân lên giá đã theo tuổi. Không dùng `sellPrice` hoặc fallback
về giá tự bịa. Policy chỉ cấu hình ánh xạ metal/kind/purity và khấu trừ VND/món; việc
nhập giá mua vào vẫn dùng cơ chế append-only có sẵn của Inventory. Không seed policy
0 hoặc lấy khấu trừ từ frontend báo giá. ADMIN phải nhập rõ mức khấu trừ, kể cả 0,
và lý do cấu hình. Chưa hỗ trợ khấu trừ phần trăm/theo chỉ/hao hụt hoặc quy đổi gram.

Tính bằng Decimal precision 48, không Float/Number cho tiền/trọng lượng. Weight
Decimal(12,4), purity Decimal(8,4), đơn giá/khấu trừ Decimal(15,2), tiền dòng/tổng
Decimal(20,2), API dùng chuỗi. Chặn net âm và overflow; net nhỏ có thể làm tròn về
0, không tự suy diễn thành payout hoặc đặt ngưỡng tiền duyệt. Làm tròn **từng món**
rồi cộng, không round tổng chưa làm tròn. Ví dụ test: 1,2500 chỉ × 2.000.000,25 −
1.500,31 = 2.498.500,0025 → **2.499.000 VND**; dòng thứ hai 1 chỉ → 1.998.000;
tổng đúng 4.497.000 VND. Đây là dữ liệu synthetic, không phải giá thị trường.

Snapshot gồm measured/accepted weight, purity, metalId/kind/code, appraisalId/actor,
policyId/version/khấu trừ, priceId, đơn vị `VND_PER_CHI_ALLOY`, effectiveFrom/capturedAt
của Inventory, đơn giá mua, amount từng dòng, total/currency VND, sourceVersion,
rounding `HALF_UP_1000_VND_PER_LINE`, người và thời điểm báo giá/quyết định.

Đổi giá mua hoặc policy sau lúc quote không reprice quote đã phát hành hoặc quote
đã duyệt. Approval duyệt **snapshot đã báo**, không gọi Inventory lại. Nếu muốn
báo lại giá, tạo quote mới với header version mới trước approval. Policy có thể
ngừng dùng cho quote mới; điều đó không tự thu hồi quote đang chờ duyệt. Chưa có
quote TTL/revocation policy tự động; cần quyết định riêng nếu nghiệp vụ yêu cầu.

### API

Prefix Gateway giữ nguyên `/api/admin/sales/branches/{branchId}/buybacks`; private
backoffice audience. Sales cùng suffix dưới `/admin/branches/{branchId}/buybacks`.
Mọi response mới `Cache-Control: no-store`. Branch từ route được kiểm membership
JWT, actor từ JWT; DTO strict từ chối actorId/branchId/status/giá/tổng tự truyền.

| Method | Suffix | Body / quyền | Kết quả |
| --- | --- | --- | --- |
| GET | `/price-policies` | STAFF/MANAGER branch, ADMIN | Tối đa 100 policy theo ID, gồm active flag/version |
| POST | `/price-policies` | ADMIN; metalId/kind/purity, label, deductionVndPerItem, reason; Idempotency-Key | 201 policy; tạo + audit atomically; replay cùng nội dung trả policy hiện tại |
| PUT | `/price-policies/{policyId}` | ADMIN; version, label, deductionVndPerItem, isActive, reason | 200 revision; identity mapping không đổi tại chỗ |
| GET | `/{id}/appraisals` | Actor được xem branch | 200 intakeId/status/version và kết quả hiện hành từng món |
| PUT | `/{id}/items/{itemId}/appraisal` | STAFF/MANAGER branch, ADMIN; version/weights/metal/purity/condition/notes; Idempotency-Key | 200 appraisal revision |
| POST | `/{id}/quotes` | STAFF/MANAGER branch, ADMIN; version, items[itemId,policyId,policyVersion]; Idempotency-Key | 201 snapshot giá từ backend |
| GET | `/{id}/quotes` | Actor được xem branch | 200 header version/activeQuoteId và tối đa 50 quotes gần nhất, gồm lines |
| POST | `/{id}/quotes/{quoteId}/approve` | MANAGER branch / ADMIN; `{version}`; Idempotency-Key; maker-checker | 200 APPROVED snapshot |
| POST | `/{id}/quotes/{quoteId}/reject` | MANAGER branch / ADMIN; `{version,reason}`; Idempotency-Key | 200 REJECTED snapshot |

Inventory bổ sung `GET /internal/buyback-prices/{metalId}`: current buy rate + source
identity/time, không `sellPrice`, stock hoặc contact. Dùng internal network như
các route nội bộ hiện có; Gateway chặn cả direct/encoded internal path. Không khởi
động service Inventory đầy đủ cho integration; runner chỉ mount controller này,
MetalsService/Prisma thật và GlobalExceptionFilter production trên loopback.

Mã lỗi: 400 VALIDATION_FAILED, 403 FORBIDDEN hoặc
BUYBACK_SEPARATE_APPROVER_REQUIRED, 404 NOT_FOUND, 409 VERSION_CONFLICT/INVALID_STATE/
BUYBACK_POLICY_REQUIRED/BUYBACK_APPRAISAL_INCOMPLETE/BUYBACK_PRICE_INVALID/
METAL_PRICE_NOT_SET, 422 IDEMPOTENCY_KEY_REUSED, 503 SERVICE_UNAVAILABLE khi lỗi
nguồn giá/lock timeout. Đọc giá GET timeout 3s/lượt, retry lỗi tạm tối đa hai lần theo
client chung; không có HTTP trong DB transaction. Idempotency key không đưa vào URL.

### Schema, locking, idempotency và DB guards

Migration mới duy nhất: `20261109140000_buyback_appraisal`. Chỉ additive và thay
CHECK lifecycle để mở rộng state; không sửa migration cũ, không xóa dữ liệu.

- `BuybackAppraisal`: append-only revisions, FK intake/item, unique(itemId,intakeVersion).
- `BuybackPricePolicy` + `BuybackPolicyAudit`: ánh xạ và khấu trừ theo branch,
  version/CAS, create key/hash scope branch/actor; audit config có lý do và snapshot.
- `BuybackQuote` + `BuybackQuoteLine`: immutable pricing snapshot, FK intake/appraisal/
  policy, composite active-quote ownership FK, unique quote/item, partial unique
  **one QUOTED** và **one APPROVED** mỗi intake. Header `activeQuoteId` chọn snapshot
  hiện hành; sourceVersion lưu version trước khi tạo quote.
- `BuybackRequest`: unique(intakeId,actorId,key), hash chứa operation/target/body và
  response JSON gốc; không trả key/hash ra API. Cùng key và nội dung retry trả kết
  quả cũ trước version/state check; đổi body/operation/target trả 422. Key khác
  sau terminal không tạo quyết định mới. Response replay mô tả kết quả gốc; GET
  dùng để xem trạng thái hiện tại. Decimal string representation khác được coi
  là body khác; quote items được canonical sort theo itemId.
- Ghi: row lock header id+branch, lock_timeout 3s, ReadCommitted, CAS version/status,
  tăng version/audit/request cùng transaction. Hai appraisers, quote/approval/edit
  hoặc hai approvers cùng version chỉ một mutation thắng; replay cùng key được
  trả từ request record trong transaction đã khoá.
- Quote prepare ngắn → đọc Inventory ngoài transaction → khoá header/policy lại và
  recheck version/state/mapping trước persist. Policy rows khoá SHARE theo ID tăng
  dần, cấu hình dùng FOR UPDATE; không giữ lock khi gọi HTTP.
- Đọc appraisals/quotes dùng RepeatableRead. SQL CHECK bảo vệ trọng lượng/hàm lượng,
  giá/khấu trừ/tiền không âm, công thức line và decision fields. Triggers bảo vệ
  immutable revisions/lines/approved header, maker-checker và line source mapping.
  Deferred constraint trigger kiểm số dòng đúng mọi món và sum(lines)=total ở commit;
  audit/request lỗi rollback toàn bộ approval. Partial indexes/triggers là custom
  SQL; không dùng db push để thay migration.

### Docker/migration verification thực tế

Project `jewelry-phase72-acceptance`, PostgreSQL 16.15, database `phase72_test`, port
127.0.0.1:55433, volume mới `jewelry-phase72-acceptance_appraisal_pg`, memory limit
384 MiB, init script read-only. Env mới private trong `/tmp/jewelry-phase72.kecccagy`,
không đọc `.env` dev cho migration. Không dùng DB/volumes Phase 6 chứa bằng chứng.
Không bật RabbitMQ, full services hoặc build Docker images. Ban đầu còn khoảng
854 MiB RAM available/swap gần đầy; cuối test available 1971 MiB, swap 783/1024 MiB.
PostgreSQL healthy, memory 44,57 MiB/384 MiB, OOM=false, restartCount=0 tại mẫu đo;
không ghi nhận WSL disconnect. Không dùng các số này làm peak/soak/load guarantee.

Đã xác minh resolved Compose config, current_database/current_user service roles,
mount, port, volume trước ghi/migrate. Inventory 10 migrations và Sales 10 migrations
đến 7.1 trên DB mới; tạo ba phiếu 7.1 DRAFT/PENDING_APPRAISAL/CANCELLED và items/audit;
sau đó deploy migration 7.2. Tổng **21 migrations applied** (Inventory 10, Sales 11),
**21 SHA-256 checksums khớp SQL gốc**. Schema assertions/unique/FK/precision/triggers
thực tế PASS; compatibility giữ nguyên old state/weights/audit. Status sau deploy
cần dùng config/env test riêng; tuyệt đối không deploy/reset DB dev/production.

### Kết quả kiểm thử

Lệnh dùng PATH Node v24.22.2 từ nvm; không full monorepo tests/build. Bằng chứng
đã lọc ở [phase7-appraisal-evidence.md](phase7-appraisal-evidence.md); cách tái hiện
ở [tests/buyback-appraisal/README.md](../tests/buyback-appraisal/README.md).

| Lệnh / phạm vi | Kết quả |
| --- | --- |
| `pnpm --filter @jewelry/sales test:buyback-appraisal` | **12/12 PASS**, 0 skipped: validation/Decimal/rounding/source/config/permissions/controller |
| `pnpm --filter @jewelry/sales test:buybacks` | **18/18 PASS** regression intake; hai assertion enum cũ đã cập nhật đúng state mới |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON apps/gateway/src/proxy/buybacks.test.ts` | **1/1 PASS**, route mới private; internal bị chặn |
| `node --env-file=<private-tests.env> tests/buyback-appraisal/appraisal.integration.mjs` | **18/18 PASS**, PostgreSQL thật + internal pricing HTTP thật, không fake DB locks |
| Build contracts/Sales/Inventory; typecheck contracts/Sales/Inventory/Gateway | PASS packages liên quan; Sales build kiểm TypeScript, không full monorepo |
| Prisma format/generate/validate Sales | PASS; validate chỉ bổ trợ, migration thực đã apply riêng |
| ESLint/Prettier code trực tiếp thay đổi; diff whitespace | PASS |
| OpenAPI generator check và validate Sales/Inventory/Auth/Shop | PASS; Auth/Shop chỉ đồng bộ error enum dùng chung (Auth còn thiếu 13 mã cũ, cộng 4 mã mới), không đổi logic Phase 6 |

| Scenario | DB assertions và phạm vi | Kết quả |
| --- | --- | --- |
| MIG-01 | Ba phiếu 7.1 giữ state, item weights, audit versions và activeQuoteId null sau migration | PASS |
| DB-01 | Nhiều món, hai appraisal revisions, APPRAISED/version đúng, số đo ban đầu giữ nguyên | PASS |
| DB-02 | Hai appraisers cùng version: một thắng, một VERSION_CONFLICT; một revision/audit | PASS |
| DB-03 | Stale version không thêm appraisal/request key/audit | PASS |
| DB-04 | Snapshot buy rate/policy/source chính xác; amounts 2.499.000+1.998.000=4.497.000; line immutable | PASS |
| DB-05 | Đổi policy/MetalPrice giữa quote và approve không đổi lines/total đã duyệt; SQL sửa total bị chặn | PASS |
| DB-06 | Sửa appraisal supersede quote, activeQuoteId null, không approve cũ; quote mới dùng revision mới | PASS |
| DB-07 | Hai managers cùng version: một approval, một audit/version increment/approved quote | PASS |
| DB-08 | Edit vs approve: chỉ một mutation thắng; không duyệt revision đã bị invalidated | PASS |
| DB-09 | STAFF/wrong branch/self maker kể cả ADMIN bị chặn; không side effects | PASS |
| DB-10 | Inject audit failure trong transaction thật: quote/header/request/audit rollback | PASS |
| DB-11 | Mô phỏng mất response sau commit, retry cùng identity trả original approval; không audit/key trùng | PASS |
| DB-12 | APPROVED không đổi payment/order/outbox/JewelryItem/receipt/movement counts; intake không sửa được | PASS |
| DB-13 | Incomplete/DRAFT/CANCELLED bị chặn, REJECTED giữ reason/audit, terminal không duyệt lại | PASS |
| DB-14 | Inventory thiếu buyPrice: lỗi nghiệp vụ, không quote/audit/header update hoặc sell-price fallback | PASS |
| DB-15 | Concurrent ADMIN policy CAS: một thắng, một conflict, audit mỗi version đúng một bản | PASS |
| DB-16 | PostgreSQL chặn duplicate APPROVED, sửa terminal header, orphan FK và total thiếu lines | PASS |
| DB-17 | UUID item/policy/quote viết hoa hợp lệ vẫn nhận đúng bản ghi và duyệt đúng một quote | PASS |

Regression cuối còn tái hiện item UUID viết hoa hợp lệ bị nhầm thành thiếu policy;
đã chuẩn hoá UUID item/policy trước matching/hash và quoteId trước approval comparison
trong service mới. DB-17 cùng full PostgreSQL rerun 18/18 PASS.

Đã sửa lỗi schema mới do `.omit()` trên refined Zod object và refinement số chạy
trên chuỗi không hợp lệ gây BigInt exception; giữ strict validation, không nới test.
Runner HTTP nhẹ ban đầu thiếu production exception filter làm DB-14 sai envelope;
sau đăng ký đúng filter, rerun PASS. Hai assertions Task 7.1 từng giả định APPROVED
không tồn tại được cập nhật sang state ngoài phạm vi PAYOUT và enum 7.2; regression
18/18 PASS. Có một lần unit regression được khởi chạy khi DB chưa xong; đã báo rõ
và chạy lại regression sau DB, không dùng fake concurrency làm bằng chứng PostgreSQL.

### Giới hạn còn lại và chuẩn bị Task 7.3

- Chưa chạy full Gateway→Sales JWT HTTP E2E. Quyền được kiểm ở service/real DB,
  controller metadata và route unit; không gọi đó là full authentication E2E PASS.
- Retry sau mất response là mô phỏng bỏ kết quả đã commit rồi gọi lại, chưa fault
  inject network đúng cửa sổ commit. Concurrency là các race nhỏ thực, không stress/load.
- Chưa UI kiểm định, kết nối máy đo/assay, xác minh tem/xuất xứ/quyền sở hữu hoặc
  audit pagination API đầy đủ. Revision/audit cũ vẫn giữ trong DB; GET giới hạn
  current appraisals, latest 50 quotes và list 100 policies như mô tả.
- ADMIN chịu trách nhiệm ánh xạ đúng tuổi kim loại vào metalId/buyPrice và mức khấu
  trừ; phần mềm không chứng nhận hàm lượng thực tế. Không tự tạo dữ liệu ngân hàng.
- Task 7.3 cần thiết kế payout riêng tham chiếu **approved quote bất biến**, xác minh
  tài khoản/người nhận, quyền thực hiện, idempotency giao dịch, timeout/reconciliation
  và audit; không coi APPROVED là đã trả tiền. Cần giữ maker-checker và chốt nghiệp
  vụ huỷ/hoàn tiền/thời hạn quote trước vận hành. Không viết payout trong 7.2.
- Nhập kho/BOUGHT_BACK/PENDING_MELT, chống tái mua ở cấp giao dịch, đổi vàng, báo cáo
  và Phase 8 vẫn ngoài phạm vi. Phase 6 PARTIAL không đổi thành DONE.

Runner đóng HTTP/Prisma clients bằng finally; dừng chỉ PostgreSQL task sau khi hoàn
tất, giữ test volume/log/fixtures để điều tra, không down -v/prune. Không dừng main
project, không xoá evidence Phase 6. Không commit/push hoặc chuyển branch.


### Files Task 7.2

- `apps/gateway/src/proxy/buybacks.test.ts`
- `apps/inventory/src/catalog/internal-buyback-price.controller.ts`
- `apps/inventory/src/catalog/metals.service.ts`
- `apps/inventory/src/inventory.module.ts`
- `apps/sales/package.json`
- `apps/sales/prisma/migrations/20261109140000_buyback_appraisal/migration.sql`
- `apps/sales/prisma/schema.prisma`
- `apps/sales/src/buybacks/buyback-appraisal.controller.ts`
- `apps/sales/src/buybacks/buyback-appraisal.service.ts`
- `apps/sales/src/buybacks/buyback-price.client.ts`
- `apps/sales/src/buybacks/buyback-pricing.ts`
- `apps/sales/src/buybacks/buybacks.module.ts`
- `apps/sales/test/buyback-appraisal.test.mjs`
- `apps/sales/test/buybacks.test.mjs`
- `docs/api/auth.openapi.yaml`
- `docs/api/inventory.openapi.yaml`
- `docs/api/sales.openapi.yaml`
- `docs/api/shop.openapi.yaml`
- `docs/phase7-appraisal-evidence.md`
- `docs/phase7-progress.md`
- `infra/phase7/compose.appraisal-test.yml`
- `libs/contracts/src/buyback-api.ts`
- `libs/contracts/src/buyback-appraisal-api.ts`
- `libs/contracts/src/error-codes.ts`
- `libs/contracts/src/index.ts`
- `libs/contracts/src/openapi.ts`
- `tests/buyback-appraisal/README.md`
- `tests/buyback-appraisal/appraisal.integration.mjs`
- `tests/buyback-appraisal/compatibility.sql`
- `tests/buyback-appraisal/schema-assertions.sql`
