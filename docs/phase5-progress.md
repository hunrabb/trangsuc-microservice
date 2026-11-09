# Phase 5 — tiến độ

## Đã có trước lượt này

- Outbox/consumer chung có confirm, retry, DLQ, `ProcessedEvent` trong transaction.
- Sales POS phát `order.created`, `order.paid`, `order.cancelled`; Inventory phát `stock.changed` khi deduct/release.
- Report giữ bền vững `stock.changed` trong `DeferredStockEvent` (thay đổi Phase 4 chưa commit).

## Current status trước Task 5.4 (xem cập nhật cuối file)

- Branch: `feat/sales-pos`, vẫn tại commit `e168d50`; toàn bộ thay đổi Phase 4 và Phase 5 còn trong worktree, chưa commit/push.
- Shell là WSL2; Node 24.22.2 và pnpm 12.16.1 nằm ở `~/.nvm/versions/node/v24.22.2/bin` nhưng shell mới không tự thêm PATH. Docker cần quyền truy cập socket. PostgreSQL dev được bật riêng cho test; RabbitMQ đã chạy sẵn.

## Đã triển khai trong Phase 5

- [x] Chốt doanh thu POS khi nhận `order.paid` theo xác nhận của người dùng; `order.cancelled` là dấu chặn event lệch thứ tự.
- [x] Bổ sung snapshot giá vốn/biến thể/kim loại từ Inventory deduct vào Sales và payload `order.paid`.
- [x] Bảng `OrderRevenue`, `OrderLineSales` và consumer idempotent.
- [x] API `daily` và `top-products`, lọc ngày/chi nhánh, MANAGER đúng chi nhánh; OpenAPI mới.
- [x] Task 5.3A: xuất Excel doanh thu, top sản phẩm, nhập–xuất–tồn ở backend.
- [x] Màn hình báo cáo/nút Excel trong Backoffice (Task 5.5; giới hạn kiểm chứng ở cuối file).
- [x] Task 5.2: `InventorySnapshot` theo đêm và báo cáo nhập–xuất–tồn backend.
- [x] Màn hình DLQ cho ADMIN (Task 5.3B; chưa kiểm UI trình duyệt).
- [x] RabbitMQ integration cho ba eventId cùng đơn, event lệch thứ tự, payload sai → DLQ, Report restart, API và quyền.
- [x] Lint, typecheck, build, format, OpenAPI.

## Quyết định kỹ thuật

- Doanh thu POS ghi tại `order.paid` (đơn đã ở `COMPLETED`); ngày báo cáo tính theo `Asia/Ho_Chi_Minh`.
- Giá vốn là snapshot từ Inventory, không query chéo schema. Đơn cũ thiếu giá vốn hiện `cogs = null`, tránh báo lợi nhuận giả.
- Dùng unique `orderId` và `(orderId, tagCode)`; consumer ghi cùng `ProcessedEvent` trong một transaction. `createMany(skipDuplicates)` giải quyết race hai eventId khác nhau cùng `orderId` (đã tái hiện bằng test trước khi sửa).
- `order.cancelled` ghi tombstone nếu chưa có doanh thu, nên `order.paid` đến muộn không tạo doanh thu. Thư huỷ đến sau paid không xoá doanh thu vì POS chưa có hoàn tiền. Hai sự kiện terminal cùng một đơn là trạng thái không hợp lệ từ POS; Report giữ sự kiện terminal đã ghi đầu tiên.
- Hai API chỉ tổng hợp các đơn `PAID`; COGS/lợi nhuận nhóm là null nếu có đơn cũ thiếu snapshot. Không hứa cập nhật đồng bộ trong request bán hàng.

## File đã sửa trong lượt này

- `libs/contracts/src/events.ts`, `libs/contracts/src/inventory-internal-api.ts`, OpenAPI Inventory được sinh lại
- `apps/inventory/src/stock/item-sales.service.ts`
- `apps/sales/prisma/schema.prisma`, migration `20261108220000_pos_report_snapshots`, `apps/sales/src/core/order-store.ts`, `order-transactions.ts`
- `apps/report/prisma/schema.prisma`, migration `20261108221000_order_reporting`, `apps/report/src/orders/order-report.handler.ts`, `apps/report/src/app.module.ts`
- `infra/rabbitmq/definitions.json`
- `apps/report/src/orders/reports.controller.ts`, `reports.service.ts`, `apps/report/README.md`, `docs/api/report.openapi.yaml`, `package.json`, `README.md`
- `tests/messaging/src/messaging.test.ts`, `tests/messaging/src/support.ts`, `tests/sales/src/pos.test.ts`, `docs/phase5-progress.md`

## Verification

- PASS: `pnpm test:messaging` **28/28** trên PostgreSQL/RabbitMQ thật. Race `upsert` ban đầu fail một ca mới, đã đổi sang insert có `ON CONFLICT DO NOTHING`; suite cuối đạt.
- PASS: `pnpm test:sales` **15/15**; ca riêng xác nhận payload snapshot mới **1/1** đạt.
- PASS: `pnpm test:inventory` 13/13.
- PASS: `pnpm lint --concurrency=1` 15/15, `pnpm typecheck --concurrency=1` 27/27, `pnpm build --concurrency=1` 14/14, OpenAPI 4/4, format và `git diff --check` (kiểm tra cuối).
- Report restart đã kiểm tra với outage ngắn; chưa thực sự chờ 10 phút như ví dụ trong roadmap.

## Handoff và việc còn thiếu

- Ghi chú bàn giao Task 5.1: lúc đó phần báo cáo tồn kho và snapshot đêm chưa triển khai; Task 5.2 bên dưới đã bổ sung event snapshot từ Inventory. Xuất Excel, màn hình DLQ và lệnh dựng lại dữ liệu lịch sử vẫn chưa triển khai.
- Event `order.paid` cũ thiếu snapshot dòng bán; không tự backfill dữ liệu lịch sử. Sales cần công cụ phát lại theo khoảng ngày, và giá vốn của đơn cũ phải để null nếu không có snapshot.
- Sau Task 5.2: lệnh backfill sự kiện đã trả tiền từ Sales, API xuất Excel và màn hình DLQ theo roadmap. Không đọc trực tiếp DB service khác. Không commit/push; giữ nguyên thay đổi Phase 4 chưa commit.

## Task 5.2 — DONE (backend)

- Inventory sở hữu `InventoryDailyClose`: scheduler thử mỗi phút trong 00:05–00:59 `Asia/Ho_Chi_Minh`, chốt ngày vừa kết thúc. Mỗi kho/ngày có unique; advisory lock chặn nhiều instance, retry trong cửa sổ. Transaction giữ khoá SHARE ngắn trên `StockMovement` để đọc trạng thái `JewelryItem` và movement đã commit theo cùng ranh giới; lock timeout 150 ms nhường nghiệp vụ bán. Cùng transaction ghi bản chốt bất biến và event `inventory.snapshot.closed` vào outbox. Hết cửa sổ mà chưa chốt thì **thiếu ngày**, không dùng tồn hiện tại tạo lịch sử giả.
- `InventorySnapshotBatch` và `InventorySnapshot` trong Report là bản sao nhận qua RabbitMQ/consumer; unique ngày-kho-biến thể, `ProcessedEvent` và hash payload ngăn nhận trùng/mâu thuẫn. Event tới lệch thứ tự vẫn lưu theo nhãn ngày; API chỉ tính khi có chuỗi mốc liền nhau và cùng `capturedAt` nối tiếp.
- Tồn thực tế = số chiếc `IN_STOCK`. Đơn vị báo cáo: chiếc, chỉ (4 số lẻ), giá vốn đồng (2 số lẻ), nhóm theo chi nhánh/kho/biến thể/tuổi kim loại. Trong khoảng giữa hai lần chốt: nhập phiếu `RECEIPT`, trả kho `RELEASE`, xuất bán `SALE`; `COUNT_MISSING` chỉ ghi nhận thiếu khi kiểm kê, không đổi trạng thái nên không trừ tồn. Không có điều chuyển/điều chỉnh tồn trong Phase 5. Công thức đối soát từng chỉ tiêu: tồn đầu + receipt + release - sale = tồn cuối. Lệch hoặc thiếu mốc thì `complete=false`, `rows=[]`; không trả số giả.
- `GET /api/admin/reports/inventory-snapshots?date=&branchId=` và `GET /api/admin/reports/stock-movements?from=&to=&branchId=` qua gateway sẵn có. Dùng `reportFilter`: ADMIN toàn hệ thống, MANAGER chỉ chi nhánh được gán, STAFF không có quyền. ADMIN bỏ `branchId` chỉ thấy **các kho đã có bản chốt** (`OBSERVED_WAREHOUSES_ONLY`), không tuyên bố đã phủ mọi chi nhánh.
- File Task 5.2: `apps/inventory/prisma/schema.prisma`, migration `20261108230000_inventory_daily_close`, `src/stock/inventory-close.worker.ts`, `src/inventory.module.ts`, test trong `apps/inventory/test/`, `apps/inventory/package.json`; `libs/contracts/src/events.ts`; `infra/rabbitmq/definitions.json`; `apps/report/prisma/schema.prisma`, migration `20261108231000_inventory_snapshots`, `src/stock/inventory-snapshot.handler.ts`, `stock-reports.service.ts`, controller/module, test `apps/report/test/`, `apps/report/package.json`; `docs/api/report.openapi.yaml`, README Inventory/Report, tài liệu này.
- Kiểm chứng: `pnpm --filter @jewelry/contracts build/typecheck/lint`, `pnpm --filter @jewelry/inventory db:generate/typecheck/lint/build`, `pnpm --filter @jewelry/report db:generate/typecheck/lint/build` đều đạt. Sau build, chạy `pnpm --filter @jewelry/inventory test:close` (1 ca), `pnpm --filter @jewelry/report test:stock-reports` (4 ca), `pnpm --filter @jewelry/inventory test:close:integration` (1 ca) đều đạt. Integration PostgreSQL dev: hai lần gọi cùng ngày và hai lời gọi đồng thời chỉ một bản chốt, outbox đúng hai event, Report nhận lại cùng event không nhân đôi, biến động đúng một chiếc. Hai migration bổ sung đã áp dụng thành công lên DB dev, không dùng DB production; binding RabbitMQ dev đã nạp và đối chiếu. `pnpm openapi:validate` 4/4 hợp lệ. Không chạy full monorepo test/build.
- Chưa kiểm chứng scheduler chạy qua một đêm thật hoặc consumer Rabbit nhận event snapshot từ Inventory đang chạy; test tích hợp đã gọi handler trên PostgreSQL thật và đối chiếu binding Rabbit. Phiên chốt đầu tiên là mốc gốc nên không báo cáo kỳ trước nó. Nếu mất toàn bộ cửa sổ 00:05–00:59, ngày đó không có báo cáo đầy đủ; Task 5.2 không thêm backfill lịch sử. Khi Phase 6 thêm giữ hàng, điều chuyển hay điều chỉnh, cần mở rộng event/movement trước khi đưa chúng vào công thức.
- Phase 5 còn màn hình DLQ, lệnh dựng lại dữ liệu lịch sử và frontend báo cáo theo các task sau. Không commit/push; worktree Phase 4/5.1 được giữ nguyên.

## Task 5.3A — DONE (Excel backend)

- Ba API mới: `GET /api/admin/reports/daily.xlsx`, `/top-products.xlsx`, `/stock-movements.xlsx`. Nhận `from`, `to`, `branchId` như API JSON; controller dùng cùng `reportFilter` và `@Roles('MANAGER')`, nên ADMIN được xem theo chính sách hiện có, MANAGER chỉ chi nhánh được gán. Gateway đã có route `/api/admin/reports/*`; không sửa Gateway hay Auth.
- File Excel dùng chính `ReportsService.daily`, `topProducts`, `StockReportsService.movements`, không đọc database Sales/Inventory và không tính doanh thu/kho theo công thức riêng. Doanh thu thiếu COGS để trống số và ghi “Thiếu giá vốn”. Tồn kho thiếu snapshot/đối soát lệch ghi rõ trong sheet “Trạng thái dữ liệu”, không xuất số giả; sheet này cũng nêu phạm vi `OBSERVED_WAREHOUSES_ONLY` khi ADMIN không lọc chi nhánh.
- Định dạng `.xlsx` với header, bộ lọc, múi giờ Việt Nam, số chiếc/chỉ/giá vốn. Chuỗi bắt đầu bằng ký tự công thức được ép thành text; số thập phân quá lớn để Excel giữ chính xác được lưu dạng text. File chỉ nằm trong bộ nhớ, tên file chỉ chứa loại báo cáo và ngày; response có `Content-Type`, `Content-Disposition`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.
- Giới hạn do Gateway buffer response và timeout 10 giây: tối đa **31 ngày**, **1.000 dòng Excel**, nguồn tồn kho tối đa **2.000 dòng snapshot/batch**. Vượt giới hạn trả 400 hoặc 413, hướng dẫn thu hẹp bộ lọc; API JSON gốc không bị giới hạn mới. Không có job/queue, không có migration/event mới.
- File sửa/tạo: `apps/report/src/orders/report-export.service.ts`, `reports.controller.ts`, `reports.service.ts`, `src/stock/stock-reports.service.ts`, `src/app.module.ts`, `apps/report/package.json`, `apps/report/test/report-export.test.mjs`, `docs/api/report.openapi.yaml`, `apps/report/README.md`, tài liệu này, `pnpm-lock.yaml`. Thêm `exceljs@4.4.0`; trước đó repository chưa có thư viện XLSX.
- Kiểm chứng PASS: `pnpm --filter @jewelry/report lint`, `typecheck`, `build`, `test:excel-export` (**6/6**) và `pnpm openapi:validate` (**4/4**), `git diff --check`. Test đọc lại XLSX bằng ExcelJS, so dòng với API mock cùng nguồn, kiểm tra COGS null, thiếu snapshot, chống công thức, quyền ADMIN/MANAGER, ngày sai, header tải và giới hạn dữ liệu. Không chạy lại Sales/Inventory/Messaging hoặc toàn monorepo.
- Chưa có nút tải trên Backoffice vì chưa có trang báo cáo trong roadmap/task này. Vì Gateway hiện buffer toàn file với timeout 10 giây, export lớn hơn giới hạn đã bị chặn; nếu cần export lớn về sau phải thiết kế endpoint/stream Gateway riêng trong task khác.

## Task 5.3B — DONE với giới hạn quan sát lịch sử

- `libs/common/src/messaging/consumer.ts` gửi bản sao lỗi qua `dlx` (chờ confirm rồi mới ack thư gốc); topology thêm `report.dlq.observer` với ba binding DLQ. `apps/report/src/dlq/dlq-observer.ts` nhận bản sao vào `DeadLetterRecord` trên PostgreSQL và ack observer sau commit. API danh sách không gọi `basic.get` hoặc Management API; thư trong ba DLQ gốc không bị lấy ra chỉ để xem.
- ADMIN-only: `GET /api/admin/reports/dlq` (page/pageSize tối đa 50, lọc service/eventType/trạng thái đã từng có), `GET /api/admin/reports/dlq/:id`, `POST /api/admin/reports/dlq/:id/replay`. API chỉ trả metadata an toàn, không trả raw payload/header/exception. Backoffice có trang `/thu-loi`, lọc, chi tiết, xác nhận replay, trạng thái tải/rỗng/lỗi và thông báo chỉ xác nhận broker nhận bản sao. Gateway dùng route Report hiện có.
- Replay chỉ cho event schema hợp lệ có handler hiện tại ở Inventory hoặc Report; Sales chưa có consumer nên không replay. Destination cố định `domain.events` + eventType đã validate; payload và eventId nguyên bản. Claim trong transaction bằng điều kiện và lease 60 giây, tối đa ba lần, nhiều ADMIN/instance không gửi đồng thời. DLQ gốc luôn còn nguyên. `DlqReplayAttempt` là audit requested/republished/publish failed/unconfirmed/processing failed khi thư phát lại về DLQ; không ghi “đã xử lý thành công” từ publisher confirm. Không có retry tự động vô hạn.
- File Task 5.3B: `libs/contracts/src/{topology,error-codes,dlq-api,index}.ts`, `libs/common/src/messaging/{consumer,outbox-worker}.ts`, `infra/rabbitmq/definitions.json`, `apps/report/prisma/{schema.prisma,migrations/20261109090000_dlq_observer}`, `apps/report/src/dlq/*`, `apps/report/src/app.module.ts`, `apps/report/package.json`, `apps/report/test/dlq*.test.mjs`, `apps/backoffice/src/{App.tsx,layout/app-shell.tsx,api/dlq-endpoints.ts,pages/dlq-page.tsx,pages/dlq-view.ts,pages/dlq-view.test.ts}`, `docs/api/report.openapi.yaml`, `apps/report/README.md`, tài liệu này và lockfile.
- Đã nạp topology bổ sung vào RabbitMQ dev, migration Report lên PostgreSQL dev localhost. PASS: `test:dlq` **6/6**, `test:dlq:rabbit` **1/1** (DLQ gốc giữ thư, observer lưu bản sao; đã ack riêng thư test), `test:dlq:postgres` **1/1** (hai replay cùng lúc chỉ một publish, audit và raw gốc còn nguyên), frontend DLQ **2/2**, messaging/outbox/topology **24/24**. `lint`, `typecheck`, `build` đều đạt cho Contracts/Common/Report/Backoffice; OpenAPI **4/4**, `git diff --check` đạt. Backoffice build chỉ có cảnh báo chunk lớn đã có tính chất tối ưu hiệu năng, không làm build thất bại.
- Giới hạn: thư DLQ có trước binding observer không tự có trong Report DB, nên dashboard không phản ánh backlog lịch sử; không dùng thao tác đọc phá hủy để nhập lại. Không có tín hiệu consumer xử lý thành công xuyên service, nên trạng thái `REPUBLISHED` không đồng nghĩa đã xử lý. Nếu service crash sau broker nhận nhưng trước khi ghi audit, dòng `REQUESTED` có thể còn; hết lease có thể replay thủ công lại, `ProcessedEvent` chặn tác động nghiệp vụ trùng. Chưa kiểm tra UI trong trình duyệt; typecheck/build xác minh liên kết mã nguồn.
- Dọn môi trường: PostgreSQL dev bật riêng cho integration đã dừng, cổng 5432 trống. Ba DLQ và `report.dlq.observer` đều 0 thư sau test; `sales.events` còn 3 thư có sẵn từ trước và không bị chạm tới. RabbitMQ đang chạy từ trước nên được giữ nguyên.
- Phase 5 còn historical backfill và frontend báo cáo/Excel theo task sau; Task 5.3B không triển khai các phần đó.

## Task 5.4 — PARTIAL (2026-11-09)

### Repository và môi trường

- Giữ nguyên branch `feat/sales-pos` và toàn bộ worktree Phase 4/5 có sẵn. Không commit,
  push, reset, restore, clean, đổi branch, purge queue hay xoá volume. Không chạy backfill
  trên dữ liệu thật và không thay trạng thái đơn lịch sử.
- Đã đọc roadmap `docs/ke-hoach.md` §Giai đoạn 5, thiết kế §3.8/7.7, progress, Sales
  schema/snapshot/outbox và Report/Messaging liên quan. Quyết định `order.paid` tiếp tục
  có hiệu lực, tên `order.completed` trong roadmap là tài liệu cũ, không đổi code theo nó.
- Docker không dùng được: kiểm tra ban đầu báo không tìm thấy
  `dockerDesktopLinuxEngine`; runner integration riêng báo socket
  `unix:///var/run/docker.sock` không tồn tại. Không sửa Docker kéo dài hay đụng DB dev.

### Đã triển khai

- Sales `src/backfill/historical-orders.ts`, CLI `src/cli/report-backfill-export.ts`:
  producer-side export snapshot bất biến theo batch/keyset cursor (mặc định 100, max 500),
  lịch sử nhận tiền + outbox còn giữ được cho timestamp. Không query catalog/giá hiện tại.
  Đơn chưa trả tiền/thiếu lịch sử/thiếu dòng/lệch tổng được loại rõ lý do; vốn trước
  migration giữ null, không lấy default 0 làm vốn thật.
- Report `src/orders/{historical-backfill,backfill-file}.ts`, CLI `src/cli/report-backfill-import.ts`:
  mặc định dry-run/transaction READ ONLY, file stream và giới hạn size/batch, checkpoint
  theo SHA-256 + mode + line, audit từng dòng và summary. `--apply` là lựa chọn tường minh;
  không tự áp dụng. Lỗi hạ tầng dừng trước khi tiến checkpoint.
- Live/import dùng chung `validatePaidOrder`, `recordPaidOrder`, `paidOrderMatches`.
  Unique business `orderId` cùng `(orderId, tagCode)` bảo vệ ngay cả hai eventId khác nhau
  đến đồng thời; marker và doanh thu/dòng bán cùng transaction. Không update snapshot
  đã có, không âm thầm bổ sung dòng vào header partial. Khác tổng/giá/vốn/metadata/ngày
  hoặc tombstone được audit conflict, không ghi đè bản đúng bằng snapshot cũ/thiếu.
  Lợi nhuận nhóm thiếu COGS vẫn null. Hai timestamp khác mili-giây nhưng cùng ngày Việt
  Nam không làm dữ liệu mâu thuẫn; giữ timestamp ghi đầu.
- `tests/reporting/{compose.yml,init.sql,support.mjs,run.mjs,backfill.test.mjs,
  snapshot.test.mjs,recovery.test.mjs}`: hạ tầng test riêng DB `jewelry_phase54_test`,
  cổng 55432/55672, user từng schema; không dùng credential/volume dev. Có kịch bản
  concurrency + CLI checkpoint, Inventory close → outbox → RabbitMQ → Report,
  duplicate/missing/conflict và Report offline thực >=600s. Recovery không thuộc unit
  suite, không fake timer. Các script integration **IMPLEMENTED, NOT VERIFIED**.
- Không thêm migration/schema/API mới, không sửa gateway/Auth. Scripts package Sales/
  Report, README và danh sách lệnh CLAUDE được bổ sung; chi tiết ở
  [runbook](phase5-backfill-runbook.md).

### Kiểm chứng thực tế trong Task 5.4

- Unit backfill cuối PASS **11/11** (Sales 2, Report business 5, Report file/checkpoint 4): legacy vốn null, eligibility,
  dry-run không ghi, duplicate/live cùng đơn, conflict snapshot và không hạ cấp vốn,
  validate decimal/tem/tổng/giới hạn COGS. File/checkpoint dùng filesystem tạm thật:
  giới hạn batch, default dry-run, resume, quyền 0600, lỗi hạ tầng không tiến cursor,
  lỗi checkpoint sau callback mô phỏng commit có thể chạy lại, hash/mode sai bị chặn,
  input lỗi được audit. Business/transaction dùng mock, **không phải** chứng cứ PostgreSQL race.
- Report stock-reports PASS **4/4**: đối soát, thiếu snapshot, thiếu kho, lọc quyền/ngày.
- Report Excel PASS **6/6**: đọc XLSX thật, dữ liệu cùng nguồn API, COGS null/incomplete,
  chống công thức, precision, controller/filter/header và giới hạn.
- Sales/Report lint, typecheck và build có mục tiêu đã PASS. Không chạy full monorepo
  lint/typecheck/build/test; không chạy lại Auth/POS/Inventory/Messaging suites.
- `node tests/reporting/run.mjs backfill`: **BLOCKED** ngay khi Docker Compose up,
  không có daemon/socket; chưa chạy migration hay fixture. Không retry Docker kéo dài.
- Recovery **NOT VERIFIED/BLOCKED**: chưa chạy outage thực 10 phút. Snapshot qua RabbitMQ
  **NOT VERIFIED/BLOCKED** cùng nguyên nhân. Không coi test handler/DB của phiên trước
  hoặc script mới là bằng chứng đường truyền Rabbit đã đạt.
- Kiểm tra cuối PASS: Sales/Report `typecheck`, `build`; lint hai package và phần
  `tests/reporting`; Prettier trên mã/test mới và `git diff --check`. Sau khi tách IO
  checkpoint để test riêng, Report đã typecheck/build/lint lại và chạy đủ 9 unit Report
  + 2 unit Sales thành công. Không chạy lại các suite đã PASS không liên quan.
- Kiểm tra nhanh Docker trong lượt tiếp tục vẫn báo thiếu `dockerDesktopLinuxEngine`;
  không chạy lại integration khi chưa có daemon, không chờ giả rồi tuyên bố test 10 phút đạt.

### File Task 5.4 thay đổi/bổ sung

- Sales: `src/backfill/historical-orders.ts`, `src/cli/report-backfill-export.ts`,
  `test/historical-orders.test.mjs`, `package.json`, `README.md`.
- Report: `src/orders/order-report.handler.ts`, `src/orders/historical-backfill.ts`,
  `src/orders/backfill-file.ts`, `src/cli/report-backfill-import.ts`,
  `test/historical-backfill.test.mjs`, `test/backfill-file.test.mjs`, `package.json`, `README.md`.
- Integration riêng: `tests/reporting/compose.yml`, `init.sql`, `support.mjs`, `run.mjs`,
  `backfill.test.mjs`, `snapshot.test.mjs`, `recovery.test.mjs`.
- Tài liệu: `docs/phase5-progress.md`, `docs/phase5-backfill-runbook.md`, `CLAUDE.md`.
  Các thay đổi Phase 4/5 trước phiên này vẫn còn nguyên, không coi chúng là thay đổi mới
  của Task 5.4 khi bàn giao.

### Acceptance criteria đối chiếu

Status PASS chỉ áp dụng đúng phạm vi Verification mô tả; kết quả bàn giao từ phiên cũ
không được coi là vừa chạy lại. IMPLEMENTED/TESTED mô tả code/test, không thay thế bằng
chứng runtime khi criterion đòi hỏi broker hoặc trình duyệt.

| Criterion / nguồn | Implementation | Verification | Status |
|---|---|---|---|
| Sales phát paid/cancelled qua outbox; Inventory stock.changed (roadmap 5, paid thay completed đã chốt) | IMPLEMENTED, transaction outbox có sẵn | Bàn giao trước có integration; không chạy lại producer/runtime phiên này | NOT VERIFIED |
| OrderRevenue/OrderLineSales theo orderId, nhận trùng ba lần doanh thu không đổi (roadmap 5) | IMPLEMENTED, unique + chung handler live/backfill | TESTED unit duplicate; integration concurrency/Rabbit mới chưa chạy | NOT VERIFIED cho tiêu chí broker |
| Historical backfill theo service ownership (thiết kế 7.7, Task 5.4) | IMPLEMENTED, export/import, dry-run/cursor/audit | TESTED 11 unit gồm checkpoint/file thật; CLI/DB và Postgres concurrency script bị Docker chặn | NOT VERIFIED phần integration |
| Không ghi đè snapshot đúng bằng dữ liệu thiếu/cũ (Task 5.4) | IMPLEMENTED, compare/reject; không update | TESTED unit conflict dòng/vốn/chi nhánh/ngày/tombstone | PASS (unit) |
| Doanh thu/lợi nhuận theo ngày/chi nhánh/kênh, top sản phẩm (roadmap 5, thiết kế 3.8) | IMPLEMENTED daily/top; tuần/tháng có thể chọn khoảng nhưng chưa có group riêng | Excel test kiểm nguồn mock/controller, không phải truy vấn thật/HTTP | NOT VERIFIED runtime |
| InventorySnapshot mỗi đêm, tồn chiếc/chỉ theo tuổi kim loại (roadmap 5) | IMPLEMENTED scheduler/close và Report handler | Bàn giao có PostgreSQL; chưa qua đêm thật/Rabbit phiên này | NOT VERIFIED |
| Nhập–xuất–tồn, thiếu mốc không bịa dữ liệu (thiết kế 3.8) | IMPLEMENTED | TESTED 4 unit; đường broker mới chưa chạy | PASS (unit), NOT VERIFIED broker |
| Excel doanh thu/top/NXT (roadmap 5) | IMPLEMENTED backend 3 endpoint | TESTED 6 unit đọc XLSX thật, quyền/filter/header/giới hạn | PASS (backend unit) |
| ADMIN/MANAGER theo chi nhánh (Task 5.4) | IMPLEMENTED filter + guards | TESTED filter/controller unit; không chạy JWT/HTTP integration | NOT VERIFIED end-to-end |
| DLQ admin xem/phát lại an toàn (roadmap 5) | IMPLEMENTED API + trang /thu-loi + lease/audit | Bàn giao 5.3B báo đã test backend; phiên này chỉ review code, chưa browser | NOT VERIFIED phiên này |
| Message sai format vào DLQ, log correlationId (acceptance roadmap 5) | IMPLEMENTED consumer chung; test cũ có case này | Test cũ đã báo PASS; phiên này broker không có, không chạy lại | NOT VERIFIED phiên này |
| Report tắt 10 phút khi bán, bật lại tự đuổi kịp (acceptance roadmap 5) | IMPLEMENTED script đo >=600s thực, producer/outbox thật | Chưa chạy; Docker thiếu daemon/socket | NOT VERIFIED / BLOCKED |
| Snapshot Inventory → outbox → Rabbit → Report và replay (Task 5.4) | IMPLEMENTED integration có duplicate/missing/conflict | Chưa chạy; cùng Docker blocker | NOT VERIFIED / BLOCKED |
| Frontend báo cáo và nút Excel (handoff + yêu cầu kiểm tra Task 5.4) | NOT IMPLEMENTED, chưa có route/page báo cáo; trang DLQ riêng đã có | Đọc App.tsx/app-shell và source; chưa browser | FAIL / NOT IMPLEMENTED |
| Hàng tồn lâu (thiết kế 3.8; rộng hơn checklist roadmap 5) | NOT IMPLEMENTED | Không có API/module aging trong Report | FAIL / NOT IMPLEMENTED |
| Import metadata DLQ có trước observer (Task 5.4 cho phép ghi giới hạn) | Không triển khai import do thiếu cách đọc không tác động delivery | Đã đánh giá code/topology, runbook giữ nguyên backlog; không đọc queue thật | NOT IMPLEMENTED, giới hạn được ghi nhận |

### DLQ lịch sử, rủi ro và tiếp quản

- Ba DLQ `inventory.events.dlq`, `sales.events.dlq`, `report.events.dlq` trước binding
  observer không tự xuất hiện dashboard. Không dùng basic.get/Management get kể cả
  requeue để import: thao tác tạm lấy message có thể đổi delivery/order. Không purge,
  replay hàng loạt hay ack thư cũ. Xem runbook để đối chiếu queue depth và xử lý archive.
- Snapshot thiếu vốn/metadata không được tự nâng cấp khi đã ghi: bản giàu dữ liệu đến
  sau có thể bị conflict và cần đối soát riêng. Export cursor không phải snapshot xuyên
  cả run; chọn quá khứ đã ổn định, chạy lại cửa sổ nếu có late commit (dedup bảo vệ).
- Khi Docker hoạt động, build package liên quan theo runbook rồi chạy riêng ba mode:
  `node tests/reporting/run.mjs backfill`, `snapshot`, `recovery`. Recovery mất thực ít
  nhất 10 phút. Lưu output có offlineMs và kết quả đối chiếu, chỉ lúc đó nâng status.
- Sau integration, còn kiểm UI DLQ trên trình duyệt, làm frontend báo cáo/nút Excel
  trong task riêng và quyết định phạm vi hàng tồn lâu. Không triển khai dashboard mới
  trong Task 5.4. **Chưa đủ cơ sở tuyên bố Phase 5 hoàn tất/chuyển Phase 6.**

## Task 5.5 — DONE trong phạm vi triển khai/test bên dưới (2026-11-09)

### Dashboard và Excel

- Trang `/bao-cao` + menu và route guard `canViewReports`, giữ layout/theme hiện có.
  React/Mantine/TanStack Query dùng API thật qua gateway: daily, top-products,
  stock-movements. Không thêm mock vào production hoặc sửa API/schema Report.
- Lọc ngày/chi nhánh, tổng doanh thu, số hoá đơn, COGS/lợi nhuận, bảng ngày, top 20 và
  nhập–xuất–tồn. Tiền cộng bằng BigInt trên chuỗi, không dùng số thực cho tiền. Ngày
  Việt Nam, bảng cuộn trong khung, loading/lỗi/rỗng/thử lại riêng từng phần. Thiếu vốn
  giữ null; snapshot incomplete có cảnh báo/ngày thiếu và không dựng số tồn suy diễn.
  Toàn hệ thống ghi rõ chỉ phủ các kho đã có bản chốt.
- ADMIN chọn toàn hệ thống hoặc mọi chi nhánh qua các trang API Auth hiện có, kể cả
  chi nhánh đã ngừng (báo cáo lịch sử). MANAGER chỉ lấy chi nhánh có role MANAGER từ
  `/me`, không gọi danh sách toàn hệ thống; STAFF bị chặn trước mount. Cache key có
  user/scope/filter; không placeholder dữ liệu chi nhánh trước khi đổi quyền/bộ lọc.
  Backend filter/guards hiện có tiếp tục là cơ chế kiểm quyền thực.
- Ba nút `.xlsx` dùng cùng bộ lọc và `api.requestResponse`, dùng chính token/refresh
  flow của request JSON. Kiểm MIME/chữ ký ZIP, filename Content-Disposition (kể cả
  UTF-8) đã lọc ký tự/path/extension, fallback an toàn; lỗi HTTP/JSON không tải thành
  file. Có trạng thái tải/lỗi, thu hồi Object URL, không lưu token mới vào URL/storage.
  Cảnh báo/disable xuất quá 31 ngày; lỗi 413 hướng dẫn chọn ít ngày/chi nhánh hơn.

### Môi trường và integration

- Docker Engine **29.9.2**, Compose **v5.6.1** hoạt động. Lần đầu tải image
  `postgres:16.15-bookworm` bị credential helper Docker Desktop/WSL
  `UtilAcceptVsock / error getting credentials`; dùng tag cùng phiên bản
  `postgres:16.15` đã có cache và RabbitMQ 4.4.0-management đã có cache. Chỉ sửa image
  test compose, không chỉnh WSL/Docker config hệ thống, không reinstall/reset/xoá volume.
- Hạ tầng cô lập `jewelry-phase54-test`, Postgres 55432, Rabbit 55672, DB
  `jewelry_phase54_test`, user từng schema/credential test từ harness (không đọc DB URL
  thật). Kết nối cả hai thành công qua các bài test. Migrate deploy chỉ vào DB test;
  không chạy backfill, migration hay replay trên dữ liệu người dùng.
- **PASS PostgreSQL 1/1:** backfill/live transaction cùng order, chỉ một header/line,
  duplicate/id khác, snapshot thiếu không đè COGS đúng, CLI dry-run/checkpoint và cursor.
  Bổ sung ca rollback có kiểm soát sau khi ghi: doanh thu, dòng và ProcessedEvent đều
  không tồn tại sau rollback. Lần đạt khoảng 14,8 giây, không chạy lại nhóm đã PASS.
- **PASS Snapshot Rabbit E2E 1/1:** Inventory close thật → outbox worker production →
  Rabbit → EventConsumer production → PostgreSQL Report. Hai ngày/kho đúng, cùng ID
  và ID mới không nhân đôi, thiếu ngày trả incomplete, payload mâu thuẫn vào DLQ test
  và không sửa snapshot. Khoảng 3,5 giây. Thư lỗi fixture chỉ ở broker test.
- **PASS Recovery 1/1, thời gian thực:** `node tests/reporting/run.mjs recovery` đạt,
  **offlineMs = 600025.701292** (~600,026 giây), toàn bài ~601,999 giây. Không fake timer.
  Một đơn warm-up đã qua consumer trước khi dừng; ba đơn phát ở đầu/giữa/cuối outage,
  mỗi event gửi ba lần, backlog đúng 9 delivery khi chưa có consumer. Khởi động lại xử
  lý hết; thêm eventId khác cùng đơn vẫn không nhân doanh thu. Đối chiếu **4 OrderRevenue,
  4 OrderLineSales, doanh thu 400000.00, COGS 320000.00**, ProcessedEvent đủ các ID và
  queue chính về 0. Thời gian offline đo từ sau khi consumer/kết nối đã dừng.
- Log trong phiên: `/tmp/phase55-backfill.log`, `/tmp/phase55-snapshot.log`,
  `/tmp/phase55-recovery.log`. Dòng kết quả recovery:

  ```json
  {"recovery":"VERIFIED","stoppedAt":"2026-11-08T20:57:26.474Z","offlineMs":600025.701292,"recoveredAt":"2026-11-08T21:07:26.902Z","uniqueOrders":4,"revenue":"400000.00"}
  ```

  Timestamp JSON là UTC (tương ứng sáng 2026-11-09 ở Việt Nam). Cả ba bài dùng test
  fixture và dọn theo UUID của fixture; không chạy lại nhóm đã PASS.

### Kiểm tra frontend trong phiên này

- PASS **16/16**: download/API 6, permission/filter/tổng tiền 3, phân trang ADMIN 2,
  render SSR 5 (ca tồn kho đầy đủ bổ sung được chạy riêng, không chạy lại 4 ca đã đạt).
  Chỉ chạy lại nếu phần tương ứng thay đổi, không chạy Auth/POS/Messaging suites.
- Typecheck, lint, build Backoffice PASS sau thay đổi cuối về phân trang chi nhánh;
  build có cảnh báo JS bundle khoảng 746kB (>500kB) như các phiên trước, chưa làm code
  splitting trong task này. Không chạy build/lint/typecheck toàn monorepo.
- Prettier trên mã/test mới và `git diff --check` PASS. Tổng kiểm thử trong phạm vi
  Task 5.5: **frontend 16/16 + ba integration 3/3**. Không chạy lại unit backend,
  Auth/POS/Inventory/Messaging suites hoặc toàn monorepo.
- Test runner bị sandbox EPERM khi spawn Node, chạy cùng test ngoài sandbox thì được;
  đây là hạn chế môi trường, không sửa test để che lỗi.
- Chưa có kiểm tra tương tác/responsive/hộp tải native trong trình duyệt thực; render
  SSR và fetch/DOM mocks không được coi là bằng chứng browser end-to-end.

### File Task 5.5

- Backoffice: `src/pages/{reports-page,report-panels}.tsx`,
  `src/pages/report-view.ts`, `src/api/report-{types,endpoints,branches,download}.ts`,
  `src/api/api-client.ts`, `api-error.ts`, `messages.ts`, `src/auth/permissions.ts`,
  `src/App.tsx`, `src/layout/app-shell.tsx`, `package.json`, `README.md`.
- Tests frontend: `src/api/report-{download,branches}.test.ts`,
  `src/pages/report-view.test.ts`, `test/report-render.test.mjs`.
- Integration: `tests/reporting/backfill.test.mjs` (rollback),
  `tests/reporting/compose.yml` (tag image cùng version đã có cache).
- Tài liệu: `CLAUDE.md`, `docs/phase5-progress.md`.
  Giữ nguyên toàn bộ thay đổi chưa commit Phase 4/5, không commit/push/đổi branch.

### Acceptance mới nhất (ghi đè trạng thái bàn giao cũ ở Task 5.4)

| Criterion | Implementation | Verification Task 5.5 | Status |
|---|---|---|---|
| Dashboard doanh thu/ngày/top/NXT, bộ lọc, thiếu dữ liệu | IMPLEMENTED, API hiện có | Render SSR, pure logic, endpoint mocks | PASS trong phạm vi test; browser NOT VERIFIED |
| ADMIN/MANAGER/STAFF đúng scope giao diện | IMPLEMENTED route/menu/selection/query guard | Unit permission/filter và SSR từ chối STAFF | PASS frontend; không thay kiểm quyền backend |
| Ba Excel giữ filter/phiên/tên file an toàn | IMPLEMENTED, chung client refresh | 6 test API/download, lỗi HTTP/JSON, refresh đồng thời, cleanup URL | PASS test; native browser NOT VERIFIED |
| Backfill/live concurrency + rollback + unique/conflict | IMPLEMENTED trong Task 5.4 | PostgreSQL test riêng 1/1 | PASS |
| Inventory snapshot qua RabbitMQ và replay | IMPLEMENTED trong Task 5.2/5.4 | E2E test riêng 1/1 | PASS |
| Report tắt 10 phút khi bán, bật lại tự đuổi kịp | Script có từ 5.4 | 600025.701292ms offline thực, backlog 9, khôi phục đủ 4 đơn và không trùng doanh thu | PASS |
| Scheduler chốt qua một đêm thật | IMPLEMENTED scheduler | E2E gọi close trực tiếp, không chờ qua đêm | NOT VERIFIED |
| DLQ admin UI/replay, log correlationId thư sai format | IMPLEMENTED từ 5.3B | Không chạy lại suite/browser, giữ bằng chứng cũ; snapshot conflict mới vào DLQ test | NOT VERIFIED browser/sai format phiên này |
| Hàng tồn lâu (thiết kế 3.8, ngoài checklist hẹp Phase 5) | NOT IMPLEMENTED | Không triển khai trong 5.5 | FAIL / NOT IMPLEMENTED |
| Metadata DLQ có trước observer | Giữ giới hạn an toàn Task 5.4 | Không đọc/replay/purge DLQ thật | NOT IMPLEMENTED, giới hạn đã ghi |

Ba blocker integration của Task 5.4 đã được giải quyết. Task 5.5 hoàn tất phần triển
khai và kiểm thử được nêu trên. Sau kiểm thử, chỉ dừng hai container project
`jewelry-phase54-test`, không xoá container/volume hoặc purge queue; giữ nguyên dịch vụ
dev và dữ liệu người dùng. Thư DLQ fixture vẫn ở broker test, không đụng DLQ thật.

**Chưa tuyên bố Phase 5 hoàn tất toàn bộ phạm vi thiết kế:** còn kiểm tra UI thực trên
trình duyệt (tương tác bộ lọc, responsive, download), scheduler qua đêm thật, hàng tồn
lâu chưa triển khai và giới hạn metadata DLQ trước observer. Một số mục ngoài checklist
hẹp Phase 5 cần quyết định phạm vi riêng. Không mở rộng task để thực hiện chúng; dừng
sau Task 5.5, không triển khai Phase 6. Không commit/push/reset/restore/clean/đổi branch.
