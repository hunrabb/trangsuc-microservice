# Tách PostgreSQL theo service — tiến độ

**Trạng thái: CUTOVER SUCCESS cho development (2026-11-10).** Stack `jewelry` hiện chạy Auth, Inventory, Sales, Report trên bốn PostgreSQL/volume độc lập. `docker compose up` mặc định đã dùng cấu hình mới; PostgreSQL `jewelry` và volume `jewelry_pg_data` cũ vẫn nguyên, các role ứng dụng trên nguồn được khóa `NOLOGIN` để tránh ghi nhầm. Không commit/push, không xóa volume.

## Cutover thực tế ngày 2026-11-10

- Trước chuyển đổi: branch `feat/sales-pos` với thay đổi Phase 7 chưa commit được giữ nguyên; Docker Engine healthy, đĩa WSL còn khoảng 947 GiB, RAM 3.8 GiB và 1 GiB swap gần đầy. Bốn app chính đã dừng trước khi task bắt đầu; PostgreSQL nguồn `jewelry` 11 MB, Auth/Inventory/Sales/Report có 8/19/8/10 bảng. `preflight.sql`: 0 FK xuyên schema, 0 trigger xuyên schema, không có view xuyên service. Không có session ứng dụng ghi trên nguồn. Bốn role `*_user` của nguồn bị chuyển `NOLOGIN` sau khi lưu globals; `postgres` vẫn đọc được để backup. Không reset WSL/Docker.
- Backup cuối đặt ở `/home/hung/jewelry-cutover-backups/2026-11-10` (quyền thư mục 700, file 600), **ngoài Git và Docker volume**: `final.full.dump` 112947 byte, bốn `final.<service>.dump`, `source-globals.sql` lấy trước khi khóa role, TOC, SHA-256 và metadata. Kiểm tra `sha256sum -c` và `pg_restore --list` PASS. Restore full backup cuối trên PostgreSQL độc lập `--network none`, data directory tmpfs, `--single-transaction --exit-on-error` PASS; 45 bảng, số dòng và checksum từng bảng khớp nguồn. Container tmpfs thử restore đã dừng, không dùng/xóa volume.
- Đã build tuần tự từ source hiện tại 5 runtime image (`gateway`, `auth`, `inventory`, `sales`, `report`) và 4 migration image; cả 9 PASS. `docker-compose.yml` mặc định nay dùng 4 DB, `docker-compose.legacy.yml`/`.legacy.override.yml` lưu cấu hình cũ cho rollback. `docker-compose.override.yml` chỉ publish DB mới lên loopback 15433–15436. Các `apps/{auth,inventory,sales,report}/.env` cho host dev đã đổi sang DB/shadow riêng; bản trước lưu trong thư mục backup private, và Prisma Client xác nhận cả 8 URL đúng DB/user.
- Bốn volume đích `jewelry_{auth,inventory,sales,report}_pg_data` ban đầu không tồn tại, được tạo riêng và kiểm tra mount/DB/user trước restore. Restore trước migration khớp **45/45 bảng** gồm `_prisma_migrations`, số dòng và checksum; catalog PK/unique/FK/index/sequence/routine/trigger khớp nguồn. Migration image chạy đúng DB, lần lượt đạt **3/13/14/7** migration, 0 failed/rollback, mọi checksum khớp file SQL. Sau migration, **41/41 bảng nghiệp vụ gốc** vẫn khớp ở các cột nguồn; các cột/bảng mới do migration được giữ đúng Prisma. Owner object thuộc user của service, mỗi DB không có role đăng nhập của service khác; chỉ extension `plpgsql`, không có sequence/default privilege bất thường.
- Runtime bốn service và Gateway healthy với `DATABASE_URL` đúng DB riêng; Backoffice/Storefront healthy. Smoke Gateway qua loopback trước khi mở cổng 3000: Auth password login/ADMIN role, branch event Auth→Inventory/ProcessedEvent, Inventory read, Buyback/Sales/Report read, public catalog và POS từ chối tem thiếu hàng. POS tạo dấu recovery `Order CANCELLED` và Report `CANCELLED/revenue=0.00`, không có OrderItem, món SOLD hay thanh toán; đây là hành vi đúng. Hai account smoke đã `LOCKED`, mật khẩu xóa và refresh token thu hồi; hai branch smoke đã deactivate. Sau đó Gateway 3000, Backoffice 8080, Storefront 8081 đều HTTP 200.
- RabbitMQ cũ giữ nguyên volume. Trước bật Sales có 3 thư `metal_price.changed` chờ; sau bật, 3 `ProcessedEvent` tương ứng xuất hiện trong `sales_db`, queue về 0. Các worker catalog/chốt kho tiếp tục tạo snapshot/outbox theo lịch. Lúc đối soát cuối, mọi outbox đều `PUBLISHED`, queue và DLQ bằng 0. Inventory vẫn đúng **2 món `IN_STOCK`**, 0 `SOLD`, 0 movement bán; Sales có 2 order smoke `CANCELLED`, 0 payment/buyback; Report 2 tombstone `CANCELLED` với tổng revenue 0, 0 buyback fact. Khác biệt sau khởi động được giải thích bởi fixture/worker và đã đối soát; không có dữ liệu nguồn bị ghi sau freeze.
- Thời gian ngừng phục vụ trước cutover không đo được vì các app đã dừng khi task bắt đầu; không có cửa sổ dịch vụ đang phục vụ bị cắt chủ động trong task này. Sau mở cổng, Docker và 4 DB/service đều healthy. Lần kiểm tra cuối: RAM 3.8 GiB, khả dụng 1.0 GiB; swap 1.0 GiB, còn 125 MiB; đĩa còn 947 GiB. Dữ liệu mới đã phát sinh ở bốn DB sau khi bật worker/smoke, nên **không được tự động đổi về DB cũ**; cần đối soát ngược theo runbook nếu rollback.

## Lịch sử acceptance trên project test (2026-11-09)

Chi tiết và bằng chứng trong [database-separation-acceptance.md](database-separation-acceptance.md). Bốn DB test đã chạy tuần tự, healthy; bốn Docker migrate job từ migration image hiện tại PASS. SQL/image/source checksum của 3/13/14/7 migrations khớp; 41 bảng nghiệp vụ phục hồi giữ số dòng/checksum trước khi tạo fixture. Test Prisma Client đúng DB/role và từ chối truy cập chéo.

Chạy backend thật trên project test: Auth, Inventory và Gateway container; Sales và Report từ build source hiện tại trên WSL do swap 1 GiB đã đầy khi build Docker runtime Sales. RabbitMQ riêng. HTTP qua Gateway **11 nhóm PASS**, thêm ba hướng Exchange dương/âm/0 PASS. SQL xác nhận buyback settlement, `PENDING_MELT`, Report fact và không tạo trùng món cũ. Bốn ca dừng từng DB test và phục hồi readiness PASS. RabbitMQ test dừng/bật lại: Auth outbox giữ sự kiện, Inventory nhận sau khi broker phục hồi; replay cùng event ID không tạo warehouse thứ hai. Replay `buyback.settled` cũng không tăng số món cũ hoặc fact Report.

Đã sửa cấu hình **overlay acceptance** dùng IPv4 `eth0` WSL cho Gateway → Sales/Report thay vì `host.docker.internal`, vì đường này gây `503` tạm thời sau outage. Tại thời điểm 2026-11-09 DB-13A–E, ma trận quyền và Docker runtime build đầy đủ còn thiếu; Task A và cutover ngày 2026-11-10 đã hoàn tất các gate cần thiết cho development. Không commit/push hoặc xóa volume.

Sau acceptance, các tiến trình/container thuộc project test đã `stop` để trả RAM; bốn volume test vẫn còn. PostgreSQL và RabbitMQ chính vẫn healthy.

## Kiến trúc và cấu hình

| Service | DB container mới | DB / schema | Volume mới | Cổng dev/test (loopback) |
|---|---|---|---|---|
| Auth | `auth-postgres` | `auth_db` / `auth` | `auth_pg_data` | 15433 |
| Inventory | `inventory-postgres` | `inventory_db` / `inventory` | `inventory_pg_data` | 15434 |
| Sales | `sales-postgres` | `sales_db` / `sales` | `sales_pg_data` | 15435 |
| Report | `report-postgres` | `report_db` / `report` | `report_pg_data` | 15436 |

`docker-compose.db-separated.yml` vẫn là cấu hình staging; `docker-compose.yml` nay là bản development đã cutover, project `jewelry`. Override dev chỉ publish bốn cổng DB tới `127.0.0.1`; bản chính không publish DB ra host. Mỗi app và `*-migrate` có URL tới đúng hostname/DB/schema. Mỗi container có volume data riêng. User ứng dụng `*_user` chỉ được tạo trong instance tương ứng; `postgres` là user quản trị, không truyền vào app. Tên schema cũ được giữ để tương thích Prisma và SQL viết tay. Shadow DB riêng (`*_shadow`) phục vụ `prisma migrate dev`; `migrate deploy` không cần shadow DB.

Root `.env` và credential không đổi; bốn `apps/*/.env` cho host dev đã được cập nhật URL sang DB mới sau backup private. Các `.env.example` hiện mô tả bốn DB; bảng URL và rollback nằm trong [runbook](database-migration-runbook.md). Bộ test legacy hardcode cổng 5432 không được chạy với DB chính cũ.

## Phụ thuộc xuyên database

- `preflight.sql` chạy read-only trên PostgreSQL legacy: **0 foreign key xuyên schema**, **0 trigger gọi hàm ở schema service khác**, không có view trong bốn schema.
- Rà soát migration và code SQL: Sales có nhiều hàm/trigger và câu SQL ghi rõ `"sales"`, đều nằm trong schema Sales; không thấy truy vấn/transaction trực tiếp cập nhật hai schema service. Sales lấy thông tin Inventory bằng HTTP nội bộ; Report nhận snapshot/sự kiện qua RabbitMQ; các service ghi outbox trong DB của mình.
- Kết luận giới hạn: code scan và catalog tại thời điểm kiểm tra không phát hiện phụ thuộc SQL xuyên service. Cần chạy lại preflight trước cutover vì code/migration còn thay đổi chưa commit.

## Bằng chứng test restore và migration (giai đoạn chuẩn bị)

- Docker Engine 29.9.2 khả dụng; RAM WSL khoảng 3.9 GiB, swap 1 GiB. Giai đoạn restore chưa bật toàn bộ microservice và không load test. Container chính `jewelry-postgres-1` và `jewelry-rabbitmq-1` vẫn chạy; các app chính đã dừng khi sao lưu.
- PostgreSQL nguồn được xác minh là DB `jewelry`, kích thước 11 MB. `test-restore.sh` chỉ chạy `pg_dump` trên container nguồn, lưu bốn archive custom format trong thư mục `/tmp/jewelry-db-separation.LXU8kbr5` (quyền 700). Không tạo backup chứa dữ liệu nhạy cảm trong Git. Script kiểm tra nguồn thuộc project `jewelry`, từ chối chạy nếu app chính còn ghi, và từ chối restore đè DB test có bảng.
- Bốn volume test mới có tiền tố `jewelry-db-separation-test_`; không sử dụng các volume Phase 6/7. `pg_restore --single-transaction --exit-on-error` thành công, gồm `_prisma_migrations`, `OutboxEvent`, `ProcessedEvent` và các đối tượng SQL thuộc schema. **Trước migration mới**, số bảng nguồn/đích là Auth 8, Inventory 19, Sales 8, Report 10; số dòng và checksum của **từng bảng** khớp.
- Mức độ dữ liệu nguồn cần đọc đúng: Auth có 4 user/13 refresh token; Inventory có 2 jewelry item/3 outbox; Report có 23 processed event. Sales có **0 order**, Report có **0 order revenue**; schema nguồn chưa có các bảng payment/buyback mới. Sau restore đã tạo fixture trong DB test và chạy HTTP acceptance cho các luồng này.
- `prisma migrate deploy` chạy tuần tự từ code hiện tại trên cổng loopback của DB test: Auth 3 migration đã có, không pending; Inventory áp dụng 6 migration còn thiếu (tổng 13); Sales áp dụng 8 (tổng 14); Report áp dụng 1 (tổng 7). Tất cả thoát mã 0. Docker job `auth-migrate` cũng chạy thành công trên DB test và báo đúng `auth_db`/`auth-postgres`.
- Prisma Client được `generate` và app được `nest build` tuần tự cho cả bốn service từ source hiện tại. `test-prisma-clients.mjs` PASS 4/4: client query được model nghiệp vụ, đúng database/user, số migration thành công khớp 3/13/14/7, và không truy cập được schema của service khác.
- Catalog sau migration: Auth 8 bảng/18 index/14 constraint; Inventory 24/65/61; Sales 29/79/135, thêm 8 routine và 12 trigger; Report 12/27/30. Metadata nguồn được ghi lại bằng `catalog-check.sql` (Auth 8/18/14, Inventory 19/48/41, Sales 8/18/16, Report 10/22/18). Số đối tượng tăng đúng chiều sau migration; không bỏ object nguồn.
- `test-outage.sh` lần lượt dừng Auth DB rồi Inventory DB **trong project test**. Mỗi lần, ba DB còn lại vẫn `SELECT 1` được; DB bị dừng được bật lại và healthy. Đây là kiểm thử cô lập hạ tầng, chưa phải kiểm thử nghiệp vụ khi một DB mất kết nối.
- Cuối giai đoạn restore, bốn DB test tạm dừng để trả RAM; **giai đoạn acceptance đã bật lại**, chạy migration/HTTP/fault isolation và giữ nguyên volume. PostgreSQL và RabbitMQ chính vẫn healthy.

## Rủi ro còn lại

- Một số integration test cũ/CI còn giả định DB legacy; không dùng chúng để ghi vào DB cũ sau cutover. Task A đã kiểm DB-13A–E, concurrency và RBAC trên project test; DB-13C dùng redelivery tương đương, chưa chèn ACK-loss đúng thời điểm mạng.
- Bốn DB cùng nằm trên một Docker host, nên lỗi host/ổ đĩa vẫn ảnh hưởng cả bốn. Cấu hình hiện dùng một mật khẩu quản trị `POSTGRES_PASSWORD` cho bốn instance; user ứng dụng đã tách riêng. Trước production cần cấp mật khẩu quản trị riêng/rotate an toàn và lập kế hoạch backup/failover cho từng instance.
- Backup cutover cuối đã lưu ngoài Docker volume, nhưng vẫn cùng WSL disk/host; chưa có bản sao ngoại máy. Nguồn không có đơn hàng/thanh toán/buyback trước migration; đối chiếu nghiệp vụ chỉ dựa trên fixture test mới.

## Theo dõi sau cutover

Theo [runbook](database-migration-runbook.md): giữ backup/volume cũ và role nguồn `NOLOGIN`, theo dõi RAM/swap, outbox/DLQ và backup định kỳ cho bốn DB mới. Không chạy `down -v`, `--remove-orphans`, reset hoặc xóa volume cũ. Nếu cần rollback sau khi đã có dữ liệu mới, dừng ghi rồi đối soát/sao chép phần phát sinh; không chỉ đổi URL ngược.
