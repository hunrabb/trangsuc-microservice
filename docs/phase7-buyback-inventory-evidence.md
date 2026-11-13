# Task 7.4 — quyết định thiết kế và bằng chứng

Cập nhật 2026-11-09, branch `feat/sales-pos`. Chỉ Task 7.4; Phase 6 vẫn PARTIAL.

## Quyết định tái sử dụng trước khi sửa code

Inventory đã có một `JewelryItem`/tem, kho một-một theo chi nhánh, `GoodsReceipt`
với từng dòng vật lý, `StockMovement` unique theo nguồn/món/loại và `AuditLog`.
Phiếu nhập thường chuyển món thẳng sang `IN_STOCK`; POS và Online chỉ bán/giữ
`IN_STOCK`. Vì vàng cũ chưa được phân loại để bán, Task 7.4 sẽ dùng chính
`JewelryItem`/`GoodsReceipt`/`StockMovement`/audit, thêm origin `BOUGHT_BACK`,
status `PENDING_MELT`, movement `BUYBACK` và khoá nguồn settlement/item. Không
dùng `IN_STOCK`, không công khai danh mục hay tự tạo sản phẩm bán được. Biến thể
giữ hộ nội bộ, inactive và unpublished, chỉ để đáp ứng quan hệ kim loại hiện có;
nó không biến món cũ thành một hàng bán. Chưa triển khai quy trình phân loại/bán
lại của Task 7.5.

Sales chỉ phát `buyback.settled` trong cùng transaction xác nhận SETTLED (direct)
hoặc hoàn tất order exchange. Payload v1 là snapshot quote line đã duyệt, giá vốn
từng dòng bằng `BuybackQuoteLine.amount`; tổng phải bằng approvedAmount. Inventory
kiểm tra schema, chi nhánh/kho/metal và khoá nguồn trong transaction tạo receipt,
items, movements, audit và outbox `buyback.stocked`. Event duplicate hoặc hai
consumer cạnh tranh trả về cùng kết quả. Report lưu riêng fact settlement và fact
item stocked, có thể tính thiếu/đủ theo settlement bất kể thứ tự nhận sự kiện;
không cộng vào `OrderRevenue`. RabbitMQ/outbox/ProcessedEvent và DLQ hiện có
được dùng lại, không tạo service mới.

## Triển khai

- Sales ghi `buyback.settled` vào outbox cùng transaction chuyển `SETTLED`. Direct
  cần xác nhận tiền/bàn giao; exchange cần hoàn tất order sau giữ và xác nhận món
  mới. Worker recovery quét settlement `SETTLED` thiếu event để bù dữ liệu cũ.
- Inventory nhận snapshot v1 qua RabbitMQ, kiểm tra schema, tổng Decimal, loại
  kim loại và kho chi nhánh đang hoạt động. Một transaction tạo `GoodsReceipt`
  APPROVED, từng `GoodsReceiptLine`, `JewelryItem` PENDING_MELT, movement BUYBACK,
  audit, `ProcessedEvent` và outbox `buyback.stocked`. Advisory lock theo
  settlement, ID receipt = settlement ID, ID món = quote line ID, tem
  `BB-<quoteLineId>`; unique indexes trên settlement/quote line/tem. Replay cùng
  nguồn trả về kết quả cũ; snapshot khác bị từ chối. Kho lỗi giữ settlement
  `SETTLED` và event được retry/DLQ, không huỷ khoản tiền đã thanh toán.
- Giá vốn của từng món = `BuybackQuoteLine.amount` trong snapshot đã duyệt;
  tổng giá vốn = `approvedAmount`. Không đọc lại MetalPrice khi nhập; chênh lệch
  đổi hàng thuộc settlement, không cộng vào giá vốn vàng cũ.
- Report nhận độc lập `buyback.settled` và `buyback.stocked`, lưu fact riêng và
  so khớp từng quote line. API `GET /api/admin/reports/buybacks?from=&to=&branchId=`
  dùng `reportFilter`: MANAGER cần chi nhánh được gán, ADMIN xem được các chi
  nhánh quan sát được. Ngày theo `Asia/Ho_Chi_Minh`. Kết quả gồm số settlement,
  số món, giá trị mua, chi direct, số exchange và chênh lệch hai chiều, giá trị
  đã nhận kho, tồn chờ xử lý cộng dồn, cùng `PENDING_STOCK`, `MISMATCH` hoặc
  `SETTLEMENT_EVENT_MISSING`. `OrderRevenue` chỉ nhận `order.paid` của món mới;
  direct buyback không tạo order hoặc doanh thu.

Migration mới: Inventory `20261109160000_buyback_enums`,
`20261109161000_buyback_stock` (nguồn gốc, trạng thái, CHECK và unique indexes);
Report `20261109160000_buyback_facts` (hai fact độc lập). Không sửa migration cũ.
Không tạo service mới, không truy cập DB chéo service. Category/variant giữ hộ
nội bộ là inactive và unpublished, chỉ đáp ứng FK hiện có; SQL CHECK buộc món
thu mua luôn PENDING_MELT trong phạm vi Task 7.4.

## Kiểm thử và bằng chứng

Docker Compose project `jewelry-phase74-acceptance` dùng PostgreSQL 16 và
RabbitMQ riêng, DB `phase74_test`, port `127.0.0.1:55435` và `5674`, volume và
credentials sinh riêng. Chỉ áp migration vào DB này; không dùng DB dev/prod.
File env test mode 0600 nằm trong thư mục private ghi ở
`/tmp/phase74-session-dir` (file này chỉ chứa đường dẫn, không chứa mật khẩu).
Container được kiểm tra healthy và OOM=false. Không xóa volume evidence.

| Nhóm | Kết quả | Nội dung chính |
| --- | --- | --- |
| Contracts, Sales, Inventory, Report build | PASS | Build mục tiêu sau migration/Prisma generate |
| Unit/hồi quy Sales settlement | 4/4 PASS | DTO, Decimal, xác nhận tiền và quyền duyệt |
| Unit/hồi quy Inventory Online | 10/10 + 8/8 PASS | Giữ món, thanh toán và không bán sai trạng thái |
| Unit/hồi quy Report cũ | 4/4 + 1/1 PASS | Báo cáo kho và doanh thu online |
| Gateway route | 20/20 PASS | `/api/admin/reports/buybacks` vào Report/backoffice |
| PostgreSQL + internal Inventory HTTP | 12/12 PASS | Chưa thanh toán không nhập; 1/nhiều món; concurrent/duplicate; rollback; kho inactive rồi retry; snapshot giá; chặn POS/exchange; Report sai thứ tự, đối soát và quyền chi nhánh |
| RabbitMQ + PostgreSQL | 3/3 PASS | Outbox publisher confirm, hai consumer và fact; delivery trùng; broker gián đoạn và consumer restart |
| Report unit cho stock nhận ở ngày sau | 1/1 PASS | Snapshot sai vẫn hiện MISMATCH dù ngày settlement nằm ngoài bộ lọc |
| OpenAPI validate/generate check, ESLint, Prettier, git diff check | PASS | Hợp đồng và định dạng liên quan Task 7.4 |

Chạy lại trên test DB đã chuẩn bị:

```bash
node --env-file="$(cat /tmp/phase74-session-dir)/tests.env" tests/buyback-stock/stock.integration.mjs
node --env-file="$(cat /tmp/phase74-session-dir)/tests.env" tests/buyback-stock/rabbit.integration.mjs
```

Hai script từ chối URL ngoài `phase74_test`/loopback và xác minh DB role trước
khi ghi. Chạy tuần tự: script PostgreSQL tạo fixture SETTLED còn pending cho
Rabbit script. Rabbit script chỉ dừng/khởi động container có Compose project
label `jewelry-phase74-acceptance`, sau đó xác minh event pending vẫn còn, số
lần gửi chưa tăng và phục hồi publish thành công. Không chạy song song với các
consumer app khác trên cùng test queue.

Lỗi phát hiện khi chạy: PostgreSQL `pg_advisory_xact_lock()` trả `void` không
được Prisma adapter decode qua `$queryRaw`; đã ép `::text` trong handler Inventory
và Report. Test đầu thất bại ở vị trí này, sau sửa 12/12 PASS.
Trong lần rà soát cuối, phát hiện Report chỉ đối chiếu snapshot khi ngày
settlement nằm trong bộ lọc; stock đến sau ở ngày khác có thể bị bỏ sót
`MISMATCH`. Đã sửa để kiểm tra cả settlement liên quan ngoài ngày lọc và thêm
unit regression 1/1 PASS.

## Giới hạn kiểm chứng và phạm vi sau 7.4

- Tiền/bàn giao vẫn là xác nhận thủ công của 7.3; không xác minh chuyển khoản
  với ngân hàng hoặc quyền sở hữu vật lý ngoài bằng chứng nhân viên nhập.
- Mã tem khách đưa khi intake là tham chiếu chưa được xác minh, không dùng làm
  tem nội bộ. Unique constraint chống nhập lại cùng nguồn settlement/quote line;
  nhận diện một vật lý được đưa qua hai phiếu khác nhau cần quy trình xác minh
  ngoài phạm vi 7.4. Roadmap vẫn ghi mục này chưa triển khai.
- Giá trị tồn chờ xử lý phản ánh `buyback.stocked` đã tới Report. Trạng thái
  khác PENDING_MELT/luồng xử lý vàng cũ và tính lợi nhuận thuộc chính sách và
  Task 7.5, chưa được tự suy diễn từ chênh lệch đổi hàng.
- Chưa kiểm chứng deployment thật hoặc test tải lớn; Phase 6 vẫn PARTIAL.
- `DB-13` trong `tests/buyback-stock/stock.integration.mjs` kiểm tra worker Sales
  bù event cho SETTLED nhưng **NOT VERIFIED**: sau các ca PASS ở trên, phiên WSL
  bị khởi tạo lại, thư mục `/tmp` chứa env test mất và Docker Desktop không còn
  kết nối. Không chạy lại hoặc dọn volume/container khi không xác minh được đích;
  dữ liệu test đã ghi trước đó không bị xoá bởi Task này. Sau khi Docker hoạt
  động lại, cần tạo lại env riêng rồi chạy DB-13 trên `phase74_test` trước khi
  coi ca này là PASS.

File chính của Task 7.4: `libs/contracts/src/buyback-inventory-events.ts`,
`libs/contracts/src/{events,inventory-api,index}.ts`, `infra/rabbitmq/definitions.json`,
`apps/sales/src/buybacks/{buyback-settlement.service,buyback-settlement-recovery.worker}.ts`,
`apps/inventory/src/receipts/buyback-receipts.handler.ts`,
`apps/inventory/src/app.module.ts`, `apps/inventory/prisma/{schema.prisma,migrations/20261109160000_buyback_enums,migrations/20261109161000_buyback_stock}`,
`apps/report/src/buybacks/*`, `apps/report/src/{app.module,orders/reports.controller}.ts`,
`apps/report/prisma/{schema.prisma,migrations/20261109160000_buyback_facts}`,
`docs/api/report.openapi.yaml`, `docs/phase7-progress.md`,
`infra/phase7/compose.buyback-stock-test.yml`, `tests/buyback-stock/*`,
`apps/report/test/buyback-reports.test.mjs`, `apps/report/package.json`.

## Task 7.5A — chẩn đoán sau WSL reset (2026-11-09)

**Kết quả: BLOCKED; DB-13 chưa PASS.** Đây là chẩn đoán mới, tách biệt với
12/12 PostgreSQL và 3/3 RabbitMQ đã PASS trong Task 7.4 trước khi WSL reset.
Không tạo fixture, không khởi động worker, không chạy SQL mới hoặc thay đổi
database/volume trong Task 7.5A.

| Hạng mục | Quan sát đọc-only |
| --- | --- |
| Branch/worktree | `feat/sales-pos`; các thay đổi 7.2–7.4 còn uncommitted, không reset/restore/commit |
| Docker CLI/context | Docker Desktop Windows CLI; context cấu hình `desktop-linux`, endpoint `npipe:////./pipe/dockerDesktopLinuxEngine` |
| Docker Engine | `docker version` ngoài sandbox thất bại: named pipe `dockerDesktopLinuxEngine` không tồn tại; không thể list container/project/volume hoặc đọc DB |
| WSL | `wsl.exe --list --verbose`, `powershell.exe` và `docker context ls` từ WSL cùng lỗi `UtilBindVsockAnyPort:317`; `/var/run/docker.sock` không tồn tại |
| Log | Docker VM `init.log` có các lỗi WSL `UtilAcceptVsock`/`vsock_assign_transport` trước đó; chưa chứng minh được nguyên nhân gốc của lần mất kết nối hiện tại |
| Tài nguyên | `free -h`: 3,8 GiB RAM tổng, khoảng 1,7 GiB khả dụng; swap 1 GiB gần như trống. Không có bằng chứng OOM hiện tại |
| Dữ liệu cũ | Compose xác định project `jewelry-phase74-acceptance`, DB `phase74_test`, volumes khai báo `buyback_pg` và `buyback_rabbit` (tên Compose dự kiến `jewelry-phase74-acceptance_buyback_pg`/`_buyback_rabbit`); file VHDX Docker vẫn có nhưng không chứng minh được từng named volume hay dữ liệu bên trong |
| Credentials | `/tmp/phase74-session-dir` không còn; không dùng credentials dev/prod, không đổi mật khẩu DB test khi chưa kiểm tra dữ liệu cũ |

| Kịch bản DB-13 | Trạng thái | Lý do |
| --- | --- | --- |
| A — worker phát hiện event thiếu và Inventory nhận món | BLOCKED | Không kết nối DB/broker test để tạo fixture và chạy worker |
| B — chạy lại worker không tạo trùng | BLOCKED | Phụ thuộc A và database assertions thật |
| C — Inventory đã ghi thành công, phản hồi mất | BLOCKED | Không có consumer/DB test để mô phỏng phát lại và kiểm số bản ghi |
| D — Inventory tạm ngừng | BLOCKED | Không thể xác định/điều khiển đúng container test hoặc kiểm outbox/DLQ |
| E — settlement nhiều món | BLOCKED | Không tạo/đối chiếu được fixture nhiều món trên PostgreSQL test |

**SQL assertions mới đã chạy: không có.** Trạng thái Sales settlement/outbox,
Inventory receipt/items/movements, Report facts và Rabbit ProcessedEvent trước
và sau Task 7.5A đều **NOT VERIFIED**; dữ liệu test cuối cùng đã được xác nhận
ở Task 7.4 (12/12 + 3/3), nhưng chưa thể xác nhận hiện còn nguyên. Script
`tests/buyback-stock/stock.integration.mjs` có DB-13 chỉ kiểm worker tái tạo
outbox một lần; chưa chứng minh end-to-end Inventory cho A–E. Không ghi PASS cho
bất kỳ ca nào từ review code.

Khi Docker Desktop/WSL interop hoạt động lại, bước an toàn tiếp theo là đọc
`docker context`, `docker ps -a`, `docker volume ls` và Compose project label;
xác nhận đúng `phase74_test`, migrations và dữ liệu cũ trước khi khôi phục env
test từ nguồn an toàn. Sau đó chạy worker + consumer tối thiểu, assertion SQL
cho settlement ID/quote line ID, tem, giá vốn, `BOUGHT_BACK`/`PENDING_MELT`,
receipt, movement, outbox và `ProcessedEvent` trước/sau retry. Nếu credentials
cũ không khôi phục được, dùng **project/database test mới độc lập** và giữ
nguyên volume evidence cũ. Không chỉnh cấu hình WSL hệ thống, factory reset
Docker, prune hoặc `down -v` để vượt blocker.

Task 7.5A chỉ cập nhật hai file tài liệu này; không sửa code nghiệp vụ, không
triển khai 7.5B/Phase 8 và không commit/push.

**Kiểm tra lại theo yêu cầu Task 7.5A (2026-11-09):** `docker version`,
`docker ps -a` lọc project và `docker volume ls` lọc project đều không kết nối
được named pipe `dockerDesktopLinuxEngine`; `wsl.exe --list --verbose` và
`docker context ls` vẫn lỗi `UtilBindVsockAnyPort:317`. Context trong cấu hình
vẫn là `desktop-linux`, `/var/run/docker.sock` không tồn tại, env index trong
`/tmp` vẫn thiếu. File VHDX và Docker log không có mốc sửa đổi mới so với lần
chẩn đoán trước; RAM khả dụng khoảng 1,8 GiB, swap gần như trống. Vì không
truy cập được Engine, không thể xác minh container, named volumes, migrations,
dữ liệu cũ hoặc chạy SQL/worker. DB-13A–E tiếp tục **BLOCKED**; chưa có lỗi
nghiệp vụ mới được tái hiện hay sửa.

## Task A — kiểm chứng DB-13 trên bốn PostgreSQL test độc lập (2026-11-09)

Trạng thái `BLOCKED` của Task 7.5A ở trên là lịch sử của môi trường cũ.
Docker đã hoạt động lại; Task A dùng project test mới
`jewelry-db-separation-test`, bốn DB/volume riêng cho Auth, Inventory, Sales,
Report và RabbitMQ test. Không dùng lại `phase74_test`, không ghi DB chính hoặc
xóa volume Phase 6/7. `task-a-db13.mjs` xác minh label, cổng, role và tên DB
trước fixture, gọi Gateway và Sales recovery worker thật, tiêu thụ qua
RabbitMQ/Inventory/Report thật, rồi đối soát SQL theo settlement/event ID.

| Case | Kết quả | SQL/worker evidence |
| --- | --- | --- |
| DB-13A — event thiếu | PASS | Với settlement mới đã `SETTLED`, xóa riêng outbox **chưa publish** khi broker/Inventory test dừng; `BuybackSettlementRecoveryWorker.scan()` tạo lại đúng một `buyback.settled`. |
| DB-13B — worker chạy lại | PASS | Quét lần hai vẫn một outbox; khi phát sự kiện, một `ProcessedEvent` tại Inventory/Report, không nhập kho trùng. |
| DB-13C — response/ACK mất | PASS cho redelivery tương đương | Publish lại cùng envelope/event ID đồng thời hai lần **sau commit**; Inventory vẫn ba món, một receipt, ba movement, một audit và một processed event; Report vẫn một stock fact/processed event. Chưa ép mất ACK thực ở đúng thời điểm mạng. |
| DB-13D — Inventory offline | PASS | Dừng riêng container Inventory test; Sales vẫn `SETTLED`, outbox `PUBLISHED`, Inventory chưa có món. Bật lại Inventory: đúng một món và một processed event, receipt/facts đều một. |
| DB-13E — nhiều món | PASS | Ba món có ba tem, quote line và intake item riêng; ba receipt line/movement, một receipt, một audit; tổng cost `17,970,000.00` bằng số duyệt. |

Snapshot đọc SQL của settlement `982b3ac5-1026-40f9-b287-9ca185e1f7c5`:
Sales `SETTLED`, `recoveryAttempts=0`, outbox `buyback.settled=PUBLISHED` đúng
một; Inventory `JewelryItem=3`, `count(distinct tagCode)=3`,
`count(distinct sourceQuoteLineId)=3`, `GoodsReceipt=1`,
`ProcessedEvent=1`; Report `BuybackStockFact=1`, `ProcessedEvent=1`.
Settlement offline `d5981501-9753-4463-8f2c-496cd3026614` hồi phục đúng
một món. Các assertion trong harness còn kiểm `PENDING_MELT/BOUGHT_BACK`,
receipt line, movement, audit, settlement fact và số tiền. Test được chạy tuần
tự, giữ dữ liệu fixture để điều tra; không phát hiện bug backend trong Task A.
