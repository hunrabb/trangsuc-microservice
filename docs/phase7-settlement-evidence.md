# Phase 7 Task 7.3 — settlement và đổi trang sức

Cập nhật 2026-11-09 trên `feat/sales-pos`; không commit/push. Đây là phần backend
Task 7.3. Phase 6 vẫn PARTIAL, Phase 7 còn Task 7.4/7.5.

## Nghiệp vụ và API

Sales sở hữu `BuybackSettlement` theo phiếu và quote `APPROVED` bất biến. Tạo
settlement trực tiếp chỉ lập ý định chi trả. Nhân viên ghi chứng từ và bằng chứng
thủ công; MANAGER đúng chi nhánh hoặc ADMIN, khác người lập và người ghi tiền,
xác nhận đã kiểm tiền mặt/chuyển khoản và đã nhận món cũ. Không có kết nối ngân hàng,
không tự chuyển tiền, hoàn tiền hoặc tự coi yêu cầu chuyển khoản là thành công.
`confirmationNote` và verification reference giữ bằng chứng xác nhận, audit không
chép nội dung chứng từ. Chỉ hoàn tất sau bước xác nhận.

Gateway prefix `/api/admin/sales/branches/{branchId}/buybacks`:

| Method | Suffix | Tác dụng |
| --- | --- | --- |
| POST | `/{id}/settlements` | Lập settlement trực tiếp từ quote đã duyệt |
| POST | `/{id}/exchanges` | Lập exchange, giữ tem Inventory và chốt giá bán |
| GET | `/{id}/settlements` | Xem settlement gần nhất của phiếu |
| POST | `/{id}/settlements/{settlementId}/payment` | Ghi chứng từ, chưa xác nhận tiền |
| POST | `/{id}/settlements/{settlementId}/confirm` | Quản lý xác nhận tiền và bàn giao |
| POST | `/{id}/settlements/{settlementId}/cancel` | Hủy trước khi ghi tiền; nhả hold |

Mọi POST dùng `Idempotency-Key` và version, kiểm branch/role ở Sales; response
`Cache-Control: no-store`. Body strict không nhận giá/actor/trạng thái từ client.
`CASH` và `BANK_TRANSFER` đều bắt buộc ghi reference, evidence, verification
reference và note. Payment reference unique toàn Sales settlement.

```text
DIRECT:   AWAITING_PAYMENT → PAYMENT_RECORDED → SETTLED
EXCHANGE: RESERVING → AWAITING_PAYMENT → PAYMENT_RECORDED → FULFILLING → SETTLED
                       ↘ CANCELLING → CANCELLED         ↘ RECONCILIATION_REQUIRED
```

`RESERVING` có thể bị hủy sau lỗi giữ hàng xác định; `CANCELLING` retry nhả hàng.
`RECONCILIATION_REQUIRED` giữ nguyên chứng từ và exchangeId để worker retry tối đa
5 lần; sau đó cần đối soát thủ công. Không tự giải phóng hàng đã `PROTECTED`/`CONSUMED`
hoặc tạo refund. Settlement `SETTLED`/`CANCELLED` là terminal. Mọi chuyển trạng
thái có version CAS + audit cùng transaction. PostgreSQL có partial unique một
settlement chưa hủy/phiếu, unique creation key, payment reference, trade-in quote
line và order ID; trigger chặn sửa snapshot/terminal, CHECK bắt buộc bằng chứng.

Exchange dùng Inventory giữ một `JewelryItem` `IN_STOCK` theo mã tem trong giao dịch
row lock/CAS, cạnh tranh cùng hàng với POS và Online. Hold ACTIVE tối đa 15 phút;
worker nhả hold hết hạn. Sau xác nhận tiền, Inventory `PROTECTED` rồi `CONSUMED`
idempotent, cập nhật SOLD, một stock movement `Exchange`, và `stock.changed`
outbox. Giá bán được Inventory tính từ MetalPrice sellPrice và snapshot item;
Sales dùng Decimal: `difference = saleAmount − approvedAmount`, dương là
`CUSTOMER_PAYS`, âm `STORE_PAYS`, 0 `NONE`, `amountDue = |difference|`.
Ví dụ 18.000.000 − 12.000.000 = khách trả 6.000.000 VND. Giá quote và giá bán
snapshot không đổi sau thời điểm tạo exchange.

Sau Inventory consume, Sales tạo trong **một transaction** `Order(COMPLETED)`
với ID cố định bằng settlement ID, OrderItem, `TradeInItem` snapshot, order history,
`order.paid` outbox và trạng thái SETTLED. Nếu giao dịch Sales lỗi hoặc timeout,
settlement vào đối soát, worker dùng cùng ID để khôi phục. Nếu hold đã hết hạn
hoặc Inventory không phản hồi, không tạo Order/`order.paid`; phải kiểm tra hàng và
tiền thực tế trước can thiệp. Không có distributed transaction xuyên hai DB.
Report nhận `order.paid` như **doanh thu bán món mới theo gross sale price**;
payout thu mua trực tiếp không tạo doanh thu. Báo cáo lãi/chi phí thu mua thuộc 7.4.

## Migration và kiểm chứng

Migration **mới**: Sales `20261109150000_buyback_settlement`,
`20261109152000_settlement_integrity`, `20261109153000_settlement_strict_checks`;
Inventory `20261109150000_exchange_hold`. Không sửa migration đã áp dụng trước 7.3.
Ba migration Sales tách bổ sung FK, trigger và CHECK explicit vì PostgreSQL CHECK
coi NULL là UNKNOWN; `1530` đã áp dụng thành công trên DB thử nghiệm sau khi sửa
điều kiện CANCELLED trước khi giữ hàng. Prisma `migrate status` trên DB test báo
Sales 14/14 và Inventory 11/11 migration up to date. Không chạy migration trên
DB dev/prod.

Docker project `jewelry-phase73-acceptance` ở
`infra/phase7/compose.settlement-test.yml`: PostgreSQL 16 port localhost 55434,
RabbitMQ 4.4 localhost 5673/15673, tên/volume/tài khoản riêng, không đụng project
chính hoặc evidence Phase 6. Runner xác nhận database, user, schema và port trước
khi ghi. Test dùng real PostgreSQL, Inventory HTTP thật, broker RabbitMQ thật;
không dùng DB mock để suy diễn concurrency. Cuối test chỉ dừng hai container
riêng; OOM=false, restartCount=0, volume/log/fixture còn giữ. Chi tiết tái chạy ở
[README](../tests/buyback-settlement/README.md).

| Phạm vi | Kết quả |
| --- | --- |
| Unit contracts/authorization/Decimal | 4/4 PASS |
| Gateway route private | 1/1 PASS |
| PostgreSQL + Inventory HTTP | 19/19 PASS |
| RabbitMQ publisher confirm + Report dedupe | 3/3 PASS |
| Contracts/Sales/Inventory/Report/Gateway build/typecheck liên quan | PASS |
| OpenAPI validate; ESLint/Prettier các file sửa | PASS |

PostgreSQL cases gồm quote đã/chưa duyệt, same-key và concurrent key khác,
payment reference unique, maker-checker, audit rollback, Decimal dương/âm/0,
giá đóng băng, completed order/trade-in, retry một lần xuất/đơn/event, hai exchange
tranh một tem, POS/Online tranh tem, mất response reserve, Inventory unavailable,
hold hết hạn sau ghi tiền và race với confirm, lỗi Sales sau Inventory SOLD và khôi
phục, worker instance mới tiếp tục reservation bị gián đoạn, SQL CHECK chứng từ/
quote immutable, hủy và nhả hàng. RabbitMQ phát thật qua publisher
confirms; duplicate `order.paid` và `stock.changed` có một ProcessedEvent/record
Report; direct payout không sinh revenue.

Đã sửa lỗi Decimal âm/zero (không dùng `isPositive()` cho +0) và điều kiện SQL
CHECK nullable. Lần đầu migration `1530` trên DB test bị CHECK chặn một fixture
CANCELLED trước khi giữ hàng; đã resolve rolled-back riêng DB test, sửa SQL rồi
deploy thành công. Không reset dữ liệu.

Chưa kiểm thử full Gateway→Sales JWT HTTP, trình duyệt, tích hợp ngân hàng,
người nhận chuyển khoản/đối soát ngân hàng thật, máy đo/kiểm định vật lý, crash
process thật đúng cửa sổ hai DB hoặc stress dài hạn. Test mất response/commit là
fault injection trên real DB; worker retry được gọi trong test nhưng chưa chứng
minh restart process độc lập. Vận hành phải đối chiếu chứng từ và bàn giao thực tế;
sau 5 lần retry trạng thái cần người xử lý. Task 7.4 sẽ nhập vàng cũ vào Inventory
theo chứng từ đã xác nhận, chống mua lại một món và xây báo cáo thu mua; không
được coi item cũ đã nhập kho ở 7.3.

## Files Task 7.3

- Sales: `apps/sales/prisma/schema.prisma`, migrations
  `20261109150000_buyback_settlement`, `20261109152000_settlement_integrity`,
  `20261109153000_settlement_strict_checks`;
  `apps/sales/src/buybacks/buyback-settlement.service.ts`,
  `buyback-settlement.controller.ts`, `buyback-settlement-recovery.worker.ts`,
  `exchange-client.ts`, `buybacks.module.ts`, `apps/sales/package.json`,
  `apps/sales/test/buyback-settlement.test.mjs`.
- Inventory: `apps/inventory/prisma/schema.prisma`, migration
  `20261109150000_exchange_hold`, `apps/inventory/src/stock/exchange-holds.service.ts`,
  `internal-exchange.controller.ts`, `exchange-expiry.worker.ts`,
  `apps/inventory/src/inventory.module.ts`.
- Contracts/Gateway/API: `libs/contracts/src/buyback-settlement-api.ts`,
  `exchange-internal-api.ts`, `index.ts`, `openapi.ts`,
  `apps/gateway/src/proxy/buybacks.test.ts`, `docs/api/sales.openapi.yaml`,
  `docs/api/inventory.openapi.yaml`.
- Evidence: `tests/buyback-settlement/settlement.integration.mjs`,
  `rabbit.integration.mjs`, `README.md`,
  `infra/phase7/compose.settlement-test.yml`, `docs/phase7-progress.md` và file này.

Working tree còn các thay đổi **chưa commit của Task 7.2** từ trước Task 7.3; không
reset/restore/ghi đè chúng, không commit/push/chuyển branch.
