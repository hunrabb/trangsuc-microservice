# Acceptance bốn PostgreSQL độc lập — test 2026-11-09, cutover dev 2026-11-10

**Kết luận hiện tại: CUTOVER SUCCESS cho development ngày 2026-11-10.** Bốn DB chính đã restore/migrate, runtime images và smoke PASS; DB legacy/volume còn nguyên. Phần kiểm thử project test ngày 2026-11-09 dưới đây là bằng chứng lịch sử tại thời điểm chưa cutover. Không coi kết quả này là xác nhận HA hoặc production readiness.

## Môi trường và ranh giới an toàn

- Docker Engine 29.9.2, Compose 5.6.1; project riêng `jewelry-db-separation-test`. Bốn volume `jewelry-db-separation-test_{auth,inventory,sales,report}_pg_data` riêng, tất cả còn nguyên. `jewelry-postgres-1`/`jewelry-rabbitmq-1` và các volume Phase 6/7 không bị dừng/xóa/ghi test.
- `compose.test.yml` + `compose.migrate-test.yml` + `compose.acceptance.yml` tạo bốn PostgreSQL, broker và backend. `compose.hybrid.yml` là lớp **chỉ dùng cho acceptance khi RAM thấp**: Auth/Inventory/Gateway trong Docker; Sales/Report chạy từ `dist` vừa build trên WSL, kết nối cổng DB/broker test loopback. Gateway test `127.0.0.1:13000`, RabbitMQ test `127.0.0.1:15677`, DB test `127.0.0.1:15433`–`15436`. Cấu hình Gateway hybrid dùng `ACCEPTANCE_HOST_IP` là IPv4 `eth0` WSL tại thời điểm chạy; không hardcode IP vào Compose. Tất cả script ghi dữ liệu xác minh label, cổng và volume test trước khi kết nối.
- Auth: `auth-postgres` / `auth_db` / `auth_user` / schema `auth`; Inventory: `inventory-postgres` / `inventory_db` / `inventory_user` / `inventory`; Sales: `sales-postgres` / `sales_db` / `sales_user` / `sales`; Report: `report-postgres` / `report_db` / `report_user` / `report`. Cả bốn DB có healthcheck PASS; đăng nhập chéo DB bằng role ứng dụng bị từ chối 4/4.
- Ảnh migration đã kiểm tra hash SQL source-vs-image: Auth `df5caf6e2582`, Inventory `c1b09818e7d2`, Sales `56dd293c37fe`, Report `5236f680bfed`. Auth/Inventory runtime build hiện tại: `f42b06d7d459`/`f5a4a8154d6`; Gateway image `43bfa1e7a2ae` (source route không đổi). Sales Docker runtime build bị ngắt để tránh quá tải khi WSL dùng hết swap; Sales/Report acceptance dùng `dist` build từ source hiện tại, không lấy image runtime cũ làm bằng chứng.

## Migration và dữ liệu

| Service | Bảng | Migration đã áp dụng / checksum khớp | Index | Constraint | Kết quả |
|---|---:|---:|---:|---:|---|
| Auth | 8 | 3/3 | 18 | 14 | PASS |
| Inventory | 24 | 13/13 | 65 | 61 | PASS |
| Sales | 29 | 14/14 | 79 | 135 | PASS |
| Report | 12 | 7/7 | 27 | 30 | PASS |

Bốn Docker `*-migrate` job chạy trên DB đúng service, không pending/failed/rollback/checksum mismatch. `verify-acceptance-db.py` kiểm tra lại sau HTTP test vẫn PASS. `compare-restored-data.py` trước khi tạo fixture xác nhận số dòng/checksum của **41 bảng nghiệp vụ** và các cột nguồn khớp legacy sau migration; trước migration, 45 bảng kể cả migration history khớp. DB nguồn thiếu order/payment/buyback nên fixture mới chỉ được tạo trong DB test. PostgreSQL dùng UUID cho các khóa nghiệp vụ; kiểm tra catalog thấy 0 sequence/identity. `preflight.sql` trên legacy: 0 FK xuyên schema, 0 trigger gọi hàm xuyên schema.

## HTTP, RabbitMQ và lỗi có kiểm soát

`http-acceptance.mjs` chạy request thật qua Gateway, xác minh trạng thái SQL ở bốn DB, không mock repository. Bản chạy đầy đủ **11 nhóm PASS**: Gateway/DB target; Auth login sai/đúng, refresh và `/me`; Auth branch event sang Inventory; danh mục, giá, nhập kho và hai món; POS idempotency, chống bán lại, thanh toán; POS cancel/release; `order.completed` sang Report và HTTP daily; public catalog, checkout idempotency/guest tracking/reservation; thanh toán online thủ công và bank ref duy nhất; buyback tiếp nhận/kiểm định/báo giá/maker-checker; settlement trực tiếp và món cũ `PENDING_MELT`/Report. Thử bán món `PENDING_MELT` qua POS trả `409`, trạng thái món không đổi.

Chạy chế độ `--buyback-only` thêm **3 kịch bản Exchange PASS** với chênh lệch `CUSTOMER_PAYS`, `STORE_PAYS`, `NONE`. Mỗi ca giữ và bán đúng một món mới, nhập đúng một món cũ, settlement/fact Report đúng một; kiểm tra SQL sau mỗi ca. Người lập/kiểm định/báo giá không thể tự duyệt (`403`); người lập/ghi nhận thanh toán không thể tự xác nhận (`403`). Đây là kiểm thử thanh toán thủ công với chứng từ test, không phải xác minh ngân hàng tự động.

`fault-isolation.mjs` **4/4 PASS**: dừng lần lượt từng PostgreSQL trong project test; service sở hữu DB trả readiness `503`, ba DB còn lại healthy, Gateway `/api/ping` vẫn `200`; bật lại DB, DB và service cùng trở lại `200`. Đây là bằng chứng cô lập database và phục hồi readiness, chưa chứng minh mọi nghiệp vụ phụ thuộc chéo tiếp tục hoạt động khi DB khác lỗi.

`broker-outage.mjs` PASS: dừng **broker test**; tạo branch qua Gateway vẫn commit vào Auth và có outbox chưa phát, Inventory chưa tạo warehouse; bật broker lại, outbox thành `PUBLISHED`, Inventory tạo một warehouse và một `ProcessedEvent`. Phát lại cùng envelope/event ID lên RabbitMQ thật: số warehouse và `ProcessedEvent` vẫn bằng một. Phát lại `buyback.settled` đã xuất bản: số món cũ ở Inventory và fact ở Report không tăng, mỗi consumer giữ một `ProcessedEvent`. SQL Sales sau các luồng HTTP cho thấy outbox `PUBLISHED=32`, không còn pending tại thời điểm chụp. Chưa phát lại `order.completed` riêng.

SQL đối soát cuối (trên **test DB**):

```sql
-- sales_db: sales."BuybackSettlement"
-- DIRECT|SETTLED|STORE_PAYS=5; EXCHANGE|SETTLED|CUSTOMER_PAYS=1;
-- EXCHANGE|SETTLED|STORE_PAYS=1; EXCHANGE|SETTLED|NONE=1
-- inventory_db: inventory."JewelryItem" WHERE "sourceSettlementId" IS NOT NULL
-- BOUGHT_BACK|PENDING_MELT=8; count(*)=8, count(DISTINCT "sourceQuoteLineId")=8
-- report_db: report."BuybackSettlementFact" và "BuybackStockFact"
-- 8 settlement facts / 8 stock facts, gồm ba hướng Exchange.
```

Số liệu SQL trên được chụp **trước** lần chạy bổ sung kiểm thử `PENDING_MELT`, vì fixture tiếp tục được tạo trong project test; chạy lại SQL sẽ có số lớn hơn. Bản script kiểm tra mỗi settlement mới theo ID, nên không dựa vào tổng tích lũy.

## FAIL ban đầu, sửa và giới hạn

- Bản đầu tiên của bài online payment FAIL vì kiểm tra `CONFIRMED` ngay khi đơn vừa vào `PAYMENT_PROCESSING`; SQL cho thấy worker đã chuyển sang `CONFIRMED`. Sửa bài test chờ trạng thái cuối, sau đó PASS.
- Sau ca DB outage, Gateway hybrid tạm trả `SERVICE_UNAVAILABLE` khi proxy qua `host.docker.internal` tới Sales WSL, trong khi Sales `/health/ready=200`. Kiểm tra từ container tới IP `eth0` WSL trả `200`; đổi **overlay acceptance** sang `ACCEPTANCE_HOST_IP` hiện thời, chạy lại 11 nhóm HTTP PASS. Cấu hình production/staging không thay đổi.
- Sales/Report khởi động với pool=2 bị từ chối theo cấu hình tối thiểu consumer 15; launcher acceptance đặt pool=15. Đây là lỗi cấu hình harness, không sửa quy tắc pool của app.
- WSL 3.8 GiB RAM/1 GiB swap; sau build swap đã đầy, `free` còn khoảng 1.2 GiB available, `/` còn 947 GiB. Snapshot Docker test: bốn DB khoảng 25–45 MiB mỗi container, Auth ~110 MiB, Inventory ~192 MiB, Gateway ~70 MiB, RabbitMQ ~190 MiB; Sales/Report chạy trên host nên không nằm trong `docker stats`. CPU Rabbit/Inventory tăng khi replay rồi giảm, không chạy load test. Chưa đo định lượng startup time hoặc connection peak có kiểm soát. Build Sales runtime Docker đã dừng khi swap đầy; không coi bộ Docker runtime 4 app là PASS.
- Sau khi lấy bằng chứng, đã dừng **chỉ** các container/tiến trình acceptance để trả RAM; bốn volume test còn nguyên. Main `jewelry-postgres-1` và `jewelry-rabbitmq-1` vẫn healthy. WSL available tăng khoảng 1.9 GiB; swap vẫn đã cấp phát, không reset WSL.

## Task A — DB-13, concurrency và RBAC (2026-11-09)

Chạy tuần tự `task-a-concurrency-rbac.mjs`, `task-a-db13.mjs`, `task-a-reserve-race.mjs` trên project `jewelry-db-separation-test`. Mỗi script kiểm tra Compose label, bốn volume/cổng DB test, `current_database()` và `current_user` trước khi tạo fixture; Auth/Inventory/Gateway và RabbitMQ test là service thật, Sales/Report dùng bản `dist` hiện tại trên WSL do giới hạn RAM. Request đi qua Gateway test và JWT do Auth ký; ADMIN đăng nhập bằng HTTP, MANAGER/STAFF được tạo trong Auth DB và cấp session/token bằng chính `SessionService`/`AccessTokenService` của Auth. Không ghi vào DB dev/chính. Các dòng test được giữ nguyên để đối soát; không reset/xóa volume.

| Case | Kết quả | Bằng chứng hành vi và dữ liệu |
|---|---|---|
| DB-13A: thiếu event | PASS | Dừng Inventory và broker **test**, chỉ xóa outbox chưa publish của settlement fixture mới; worker Sales thật quét và tạo lại đúng 1 `buyback.settled`. |
| DB-13B: chạy lại worker | PASS | Quét lần hai: vẫn đúng 1 event; sau khi broker/Inventory hồi phục, Inventory có đúng số món và 1 `ProcessedEvent`. |
| DB-13C: ACK/response mất | PASS cho bất biến phát lại | Sau khi Inventory commit, publish đồng thời hai bản của cùng envelope/event ID qua RabbitMQ thật; không tăng món, receipt, audit, fact hoặc `ProcessedEvent`. **Chưa chèn lỗi làm rơi ACK ở đúng cửa sổ thời gian mạng**; phép thử này chứng minh xử lý redelivery tương đương, không chứng minh bản thân transport fault. |
| DB-13D: Inventory offline | PASS | Sales vẫn `SETTLED`, outbox `PUBLISHED` khi Inventory service test dừng và Inventory có 0 món; sau restart nhận đúng 1 món/receipt/fact/processed event. |
| DB-13E: nhiều món | PASS | Settlement ba món có đúng 3 JewelryItem `BOUGHT_BACK/PENDING_MELT`, 3 tem, 3 quote line, 3 intake item, 1 receipt, 3 receipt line và 3 stock movement; tổng giá vốn bằng `approvedAmount`. |

Concurrency là các request đồng thời thật: hai request giữ cùng tem qua Exchange đều được tạo nhưng chỉ một settlement `AWAITING_PAYMENT`, một `CANCELLED`, một `ExchangeHold ACTIVE`, món `RESERVED`, không có order/doanh thu; hai POS cùng tem cho `[201,409]` và một món `SOLD`; hai xác nhận payment POS cho `[200,409]`, một `order.paid` và một `OrderRevenue`; hai tạo settlement cho `[201,409]`, một settlement còn hiệu lực và một audit `CREATED`; hai xác nhận settlement cho `[200,409]`, một audit `PAYMENT_CONFIRMED` và một `buyback.settled`; hai duyệt quote cho `[200,409]`, một quote `APPROVED`/audit; hai delivery RabbitMQ cùng event ID không nhập kho hay cộng fact hai lần. Tất cả **PASS**.

RBAC qua Gateway **PASS**: unauthenticated `401`; STAFF/manager chi nhánh khác không đọc/sửa dữ liệu chi nhánh A (`403`); STAFF không tạo price policy, duyệt quote hoặc xác nhận settlement (`403`); manager lập/định giá không tự duyệt (`403`), người ghi nhận payment không tự xác nhận (`403`); `userId` giả mạo bị từ chối `400`, `branchId` khác quyền `403`; intake `APPROVED` hoặc đã `SETTLED` không sửa được (`409`). ADMIN hợp lệ đi qua các bước quản trị/duyệt; MANAGER cùng chi nhánh xác nhận payment hợp lệ.

SQL đối soát theo ID fixture, tránh lệ thuộc tổng tích lũy trong DB test:

```text
Sales settlement 982b3ac5-1026-40f9-b287-9ca185e1f7c5: SETTLED, recoveryAttempts=0;
  buyback.settled outbox=1/PUBLISHED, PAYMENT_CONFIRMED audit=1.
Inventory cùng settlement: JewelryItem=3, distinct tagCode=3, distinct sourceQuoteLineId=3,
  distinct sourceIntakeItemId=3, costPrice SUM=17,970,000 VND;
  GoodsReceipt=1, GoodsReceiptLine=3, StockMovement BUYBACK=3, buyback.received audit=1.
Inventory ProcessedEvent=1; Report ProcessedEvent=1, BuybackSettlementFact=1,
  BuybackStockFact=1. Settlement offline d5981501-9753-4463-8f2c-496cd3026614
  hồi phục thành 1 món và 1 processed event.
Exchange reserve dbfae3c4-24e0-4221-94b3-091c72d18296:
  Sales AWAITING_PAYMENT; Inventory ExchangeHold ACTIVE, món RESERVED;
  request còn lại CANCELLED; order/revenue=0.
```

Lỗi trong lượt chạy đầu chỉ thuộc harness: helper HTTP so `200` với `status:null` thay vì bỏ kiểm tra status, và assertion giữ hàng đòi `IN_STOCK` thay vì `RESERVED`. Đã sửa, chạy lại PASS; không phát hiện lỗi backend cần vá trong phạm vi Task A. Một câu SQL đọc-only ban đầu dùng nhầm tên cột outbox và field Prisma; đã sửa truy vấn và thu được snapshot trên. Không dùng kết quả truy vấn lỗi làm bằng chứng.

Sau Task A đã dừng chỉ các process Sales/Report host và các container trong project acceptance; bốn volume PostgreSQL test và volume RabbitMQ test vẫn còn. `docker ps` còn `jewelry-postgres-1` và `jewelry-rabbitmq-1`, cả hai healthy; Docker Engine vẫn dùng được. WSL có 3.8 GiB RAM, khoảng 1.9 GiB available sau khi dừng test; swap 1 GiB vẫn gần đầy (khoảng 1.1 MiB trống), không reset WSL hoặc Docker. Các script `node --check` và `git diff --check` PASS. Không commit/push.

## Giới hạn còn lại của acceptance

- DB-13C chưa chèn lỗi ACK/response rơi chính xác trong cửa sổ sau commit; đã xác minh redelivery cùng event ID và bất biến dữ liệu. Không chạy soak/load test hoặc mọi interleaving có thể có.
- Chưa kiểm tra lại cùng bank reference với **idempotency key khác**, thời hạn reservation 30 phút, tất cả thao tác quản lý nhân viên, buyback từ chối/điều chỉnh, report export và tính tổng doanh thu bằng SQL độc lập cho tất cả loại đơn. Những mục này ngoài phạm vi Task A.
- Bốn DB vẫn cùng một Docker host nên lỗi host/storage chung chưa được cô lập. Backup cuối cutover đã được tạo và restore thử ngày 2026-11-10 (xem dưới), nhưng chưa có backup ngoại máy; cần backup định kỳ và đổi credential quản trị phù hợp trước production.

## Bằng chứng cutover development — 2026-11-10

| Gate | Kết quả và bằng chứng |
|---|---|
| Nguồn/freeze | `jewelry-postgres-1` / DB `jewelry` / volume `jewelry_pg_data`, 11 MB; 8/19/8/10 bảng theo schema. Không có app/session ứng dụng ghi; bốn role ứng dụng trên nguồn chuyển `NOLOGIN`. Preflight 0 FK/trigger xuyên schema. |
| Backup/restore | `/home/hung/jewelry-cutover-backups/2026-11-10`: full dump 112947 byte, bốn schema archive, globals trước freeze, TOC, SHA-256, metadata; quyền 700/600, ngoài Git/volume. Restore full archive trong PostgreSQL tmpfs `--network none` PASS, 45/45 bảng cùng số dòng/checksum. |
| Runtime | Build tuần tự 5 image Gateway/Auth/Inventory/Sales/Report và 4 migration image từ source hiện tại: 9/9 PASS. Bốn app và Gateway cùng Backoffice/Storefront healthy. |
| Restore/SQL | Bốn volume mới riêng; trước migration 45/45 bảng kể cả history khớp nguồn theo row count/checksum, PK/unique/FK/index/sequence/routine/trigger khớp. Sau migration 41/41 bảng nghiệp vụ gốc khớp ở cột nguồn; migration Auth/Inventory/Sales/Report = 3/13/14/7, 0 lỗi, checksum SQL khớp. Không có owner sai hoặc role đăng nhập chéo trong bốn DB. |
| URL/traffic | Auth/Inventory/Sales/Report trỏ `auth-postgres/auth_db`, `inventory-postgres/inventory_db`, `sales-postgres/sales_db`, `report-postgres/report_db`; host `.env` và shadow URL cũng xác nhận bằng Prisma. Gateway smoke trước trên `127.0.0.1:13000`, sau chuyển cổng 3000. |
| Smoke | Auth login/role và branch event → Inventory, Inventory read, POS read/từ chối hàng thiếu, public catalog, Buyback/Sales/Report read đều PASS; Backoffice 8080/Storefront 8081 HTTP 200. Hai fixture admin đã khóa/xóa password/thu hồi refresh, hai branch deactivate. |
| Broker/data phát sinh | 3 thư `metal_price.changed` cũ được Sales xử lý đúng một lần; queue/DLQ cuối bằng 0, outbox cuối đều `PUBLISHED`. Hai order smoke `CANCELLED`, 0 item/payment/buyback, Inventory 2 món `IN_STOCK`, Report 2 dấu `CANCELLED` revenue 0. Worker catalog/chốt kho tạo outbox/snapshot theo lịch. |

Compose mặc định nay dùng bốn DB; cấu hình legacy lưu ở `docker-compose.legacy.yml`/`.legacy.override.yml`. PostgreSQL cũ vẫn healthy với volume nguyên vẹn và role app `NOLOGIN`. Sau khi consumer/smoke đã ghi dữ liệu mới, **rollback không còn là đổi URL đơn thuần**: phải dừng ghi, đối soát phần phát sinh và bảo toàn cả hai phía. Lần kiểm tra cuối: WSL có 3.8 GiB RAM, khoảng 1.0 GiB khả dụng; swap 1.0 GiB còn 125 MiB; đĩa còn 947 GiB. Docker Engine và toàn bộ container runtime/DB vẫn healthy; migration lỗi dở dang trên bốn DB bằng 0. Dịch vụ đã dừng trước khi task bắt đầu nên không có số đo downtime cutover đang phục vụ. Không commit/push/xóa volume.
