# Runbook chuyển PostgreSQL chung sang bốn instance

**Cutover development đã thực hiện thành công ngày 2026-11-10.** `docker-compose.yml` mặc định nay chạy project `jewelry` với bốn PostgreSQL độc lập; `docker-compose.db-separated.yml` vẫn là cấu hình staging. File `docker-compose.legacy.yml` và `.legacy.override.yml` giữ nguyên cấu hình cũ để điều tra/rollback có kiểm soát. DB/volume cũ chưa bị xóa; bốn role ứng dụng trên DB cũ đang `NOLOGIN`. Không chạy lại bước restore trên DB mới đã có dữ liệu.

## Trạng thái vận hành và rollback hiện tại

- DB cũ: container `jewelry-postgres-1`, database `jewelry`, volume `jewelry_pg_data`; chỉ `postgres` còn đăng nhập. Bốn DB mới: `jewelry-{auth,inventory,sales,report}-postgres-1`, database `<service>_db`, volume `jewelry_<service>_pg_data`. `docker compose up` mặc định bỏ qua `postgres` legacy vì profile `legacy-db`; không dùng `--remove-orphans` hay `down -v`.
- Backup cuối, globals trước freeze, TOC/SHA-256/metadata và bản gốc của bốn host `.env` nằm riêng tại `/home/hung/jewelry-cutover-backups/2026-11-10` (700/600). Đã restore thử full dump độc lập và đối chiếu 45 bảng; backup vẫn cùng WSL host nên cần bản sao ngoại máy trước khi coi là phương án khôi phục trước lỗi host.
- Ba thư `metal_price.changed` chờ trước cutover đã được Sales xử lý trên DB mới. Smoke còn tạo hai account ADMIN đã khóa, hai branch đã deactivate và hai POS order `CANCELLED` với doanh thu 0. Worker catalog/chốt kho cũng ghi thêm event/snapshot. **DB cũ đã lạc hậu**; không tự chạy lệnh mở khóa role hay Compose legacy để chuyển traffic về cũ.
- Nếu phải rollback từ trạng thái hiện tại: đóng Gateway/API và dừng toàn bộ worker trước; sao lưu bốn DB mới và RabbitMQ hiện tại; đối chiếu/sao chép các giao dịch mới theo ID và event, gồm Auth/Inventory/Sales/Report, outbox và processed events. Chỉ sau khi xác nhận không mất giao dịch mới, dùng cấu hình legacy và script `/home/hung/jewelry-cutover-backups/2026-11-10/unfreeze-source.sh` để mở lại role nguồn. Script chỉ phục hồi quyền đăng nhập, **không** đồng bộ dữ liệu. Nếu chưa chứng minh được, giữ cả hai bộ DB và hệ thống bảo trì.
- `apps/{auth,inventory,sales,report}/.env` cho `pnpm dev` đã đổi sang loopback 15433–15436 với shadow DB riêng; root `.env` giữ nguyên credential. Kiểm tra bằng Prisma Client đã PASS 8 URL. Không chạy integration test cũ hardcode 5432 lên DB nguồn.

## Sơ đồ kết nối

| Service / migrate job | Host trong Compose | Database | Schema | Dev/test loopback |
|---|---|---|---|---|
| `auth`, `auth-migrate` | `auth-postgres:5432` | `auth_db` | `auth` | `127.0.0.1:15433` |
| `inventory`, `inventory-migrate` | `inventory-postgres:5432` | `inventory_db` | `inventory` | `127.0.0.1:15434` |
| `sales`, `sales-migrate` | `sales-postgres:5432` | `sales_db` | `sales` | `127.0.0.1:15435` |
| `report`, `report-migrate` | `report-postgres:5432` | `report_db` | `report` | `127.0.0.1:15436` |

Ví dụ URL của Sales trong container: `postgresql://sales_user:<SALES_DB_PASSWORD>@sales-postgres:5432/sales_db?schema=sales`. Password luôn lấy từ môi trường, không ghi vào repo. Dev dùng URL cùng user/DB/schema nhưng thay hostname/port bằng loopback ở bảng; `apps/{auth,inventory,sales,report}/.env.example` đã trỏ tới bốn DB mới. Shadow URL cho `prisma migrate dev` là `<service>_shadow` trên cùng host/port DB service; migration job `migrate deploy` không dùng shadow. Cấu hình `docker-compose.yml` không publish bốn cổng DB ra host; `docker-compose.override.yml` chỉ mở chúng trên loopback cho dev. Overlay staging `docker-compose.db-separated.dev.yml` là đường test riêng, có RabbitMQ tại 15674 (AMQP)/15675 (management).

## Checklist đã dùng trước khi chạm dữ liệu thật

1. Ghi lại branch, `git status`, version image, Docker Engine, RAM/swap, danh sách project/volumes. Đảm bảo các thay đổi Phase 7 chưa commit và volume bằng chứng Phase 6/7 được giữ nguyên.
2. Chạy lại `infra/postgres/separation/preflight.sql` trên DB nguồn. Nếu có FK/view/function/trigger xuyên schema, dừng để thiết kế luồng API/event/snapshot thay thế; không bỏ constraint tùy tiện. Kiểm tra thêm job CLI, seed, giao dịch SQL xuyên service và quyền role.
3. Hoàn tất acceptance bốn app + RabbitMQ trên project test; xác nhận hiện trạng tại [tiến độ](database-separation-progress.md). Kiểm tra migration image được build từ source hiện tại, không dùng image cũ chỉ vì tag `:dev` trùng tên.
4. Chuẩn bị dung lượng backup ở vị trí **ngoài Git**, quyền truy cập tối thiểu; kiểm tra khả năng restore. Backup từng schema riêng và backup toàn DB nguồn để dự phòng các dependency không được `pg_dump -n` tự kéo theo. Lưu checksum file, danh sách `pg_restore --list`, và số liệu nguồn. Backup `/tmp` của test chỉ là bằng chứng kỹ thuật, không là backup chính.
5. Chốt thời gian dừng ghi và kịch bản rollback. Không dùng DB/volume test Phase 6/7 đã lưu bằng chứng.

## Diễn tập trên project test độc lập

`infra/postgres/separation/compose.test.yml` có bốn DB và bốn volume với project cố định `jewelry-db-separation-test`; không có app hay RabbitMQ. Cổng 15433–15436 chỉ nghe loopback. `test-restore.sh` là bài test **một lần trên volume test còn trống**: kiểm tra container nguồn có nhãn `jewelry:postgres`, từ chối chạy nếu app chính còn ghi, `pg_dump` từng schema read-only, `pg_restore` single transaction vào DB test, so số bảng/số dòng/checksum từng bảng. Script từ chối restore chồng DB đã có bảng. Sau đó `test-migrations.mjs` dùng Prisma CLI từ source hiện tại vào đúng bốn cổng test; `test-outage.sh` chỉ stop/start Auth và Inventory DB test và tự bật lại DB nếu có lỗi. Cần project test mới cho lần diễn tập tiếp theo; không xóa volume test cũ chỉ để chạy lại.

Thứ tự lệnh trong một môi trường test **mới, chưa có bảng đích** (chạy từ gốc repo, Node/pnpm đúng phiên bản):

```bash
bash infra/postgres/separation/test-restore.sh
node infra/postgres/separation/test-migrations.mjs
for service in auth inventory sales report; do
  (cd "apps/$service" && pnpm exec prisma generate && pnpm build)
done
node infra/postgres/separation/test-prisma-clients.mjs
bash infra/postgres/separation/test-outage.sh
```

Không chạy lại lệnh restore trên project test đã có dữ liệu: script sẽ từ chối; giữ nguyên volume đó làm bằng chứng. Script backup test ghi file vào `/tmp` với quyền 700, vì vậy cần chuyển bản backup nào muốn lưu dài hạn sang kho lưu an toàn trước khi `/tmp` bị dọn.

`test-prisma-clients.mjs` kiểm tra read-only bốn Prisma Client sau khi đã build app từ source hiện tại: đúng DB/user/migration history, query model nghiệp vụ và chặn đọc schema service khác. Khi diễn tập đầy đủ, cần chạy API/Auth/Inventory/Sales/Report trên network test riêng, kiểm tra login/refresh/role/branch, giá và stock/reservation, POS/checkout/payment, thu mua/đổi hàng, Report doanh thu/tồn kho/buyback, RabbitMQ outbox/recovery/idempotency và app-level outage. Các test legacy đang trỏ cổng 5432 **không** được coi là bằng chứng cho bốn DB; không chạy chúng với DB chính trong lúc diễn tập.

## Quy trình cutover đã áp dụng (chỉ dùng lại trên đích mới, rỗng và đã kiểm tra)

1. **Dừng ghi:** chặn các API ghi ở gateway, dừng `auth`, `inventory`, `sales`, `report` và worker/CLI có thể ghi DB. Backoffice/storefront không tự ghi nhưng cần thông báo bảo trì. RabbitMQ có thể giữ thư durable; ghi lại số thư còn chờ. Không ack/purge queue để “làm sạch”. Xác nhận không còn kết nối ghi vào DB nguồn.
2. **Backup cuối:** lấy backup toàn DB nguồn và bốn archive schema theo snapshot ổn định; `pg_restore --list` phải đọc được, file có dung lượng, checksum lưu riêng. Giữ nguyên `jewelry_pg_data`. Không chạy `down -v`, `volume rm`, prune, reset WSL/Docker hoặc `--remove-orphans`.
3. **Khởi tạo đích:** với `-p jewelry -f docker-compose.db-separated.yml`, khởi động *chỉ* bốn service `*-postgres` tuần tự và đợi healthy. Chúng tạo `jewelry_auth_pg_data`, `jewelry_inventory_pg_data`, `jewelry_sales_pg_data`, `jewelry_report_pg_data`; không mount `jewelry_pg_data` của DB cũ. Xác minh database/schema/user/volume và backup của DB nguồn trước khi restore.
4. **Restore:** dùng quy trình đã chứng minh trong `test-restore.sh`, nhưng operator phải chỉ định **project chính `jewelry`** và backup cuối. Mỗi đích phải chỉ chứa schema rỗng do `service-init` tạo; từ chối restore nếu đã có bảng. Bỏ mục `CREATE SCHEMA` trong TOC, vì schema đích đã tồn tại; `pg_restore --no-owner --no-acl --role=<service>_user --single-transaction --exit-on-error` để app user sở hữu object. Đối chiếu từng bảng, `_prisma_migrations`, outbox, processed events, IDs/trạng thái đơn hàng, stock, payment, buyback, index/constraint/routine/trigger/sequence. Nếu khác, chưa cutover.
5. **Migration:** chạy bốn `*-migrate` trên DB đích, từng job một. Job phải log đúng `<service>_db` và `<service>-postgres`, không có migration lỗi. Xác nhận history/Prisma Client khớp source hiện tại và đối chiếu dữ liệu sau migration.
6. **Đổi kết nối:** sau gate mới chạy app theo từng service với `-p jewelry -f docker-compose.db-separated.yml`, `--no-deps` để không recreate RabbitMQ/DB ngoài ý muốn. Gateway được mở trên loopback 13000 để smoke rồi mới chuyển về 3000. Sau thành công, `docker-compose.yml` mặc định được cập nhật sang bốn DB, bản legacy giữ riêng; host `.env` của từng app được sao lưu rồi đổi sang loopback DB mới. Các service phải healthy, Gateway ping thành công.
7. **Acceptance:** thực hiện luồng Auth, Inventory, Sales, Report và cross-service như phần diễn tập; kiểm tra outbox pending được publish, consumer xử lý lại idempotent, đối chiếu số liệu báo cáo và kiểm tra một DB mất kết nối trên môi trường test (không stop DB chính). Giữ DB/volume cũ đến khi có mốc bàn giao và backup mới.

### Rollback

- **Chưa có write vào DB mới:** dừng app đang trỏ DB mới, mở khóa role nguồn bằng script đã lưu, dùng `docker-compose.legacy.yml` cùng `.legacy.override.yml` để khởi động lại app trên DB cũ, xác nhận dữ liệu/queue. Không xóa DB mới/cũ. Nhánh này **không còn áp dụng** sau cutover 2026-11-10 vì đã có event và fixture mới.
- **Đã có write vào DB mới:** DB cũ đã lạc hậu. Không chỉ đổi URL ngược; trước hết đóng ghi và lập kế hoạch đồng bộ ngược/reconcile từng service, bao gồm outbox/event IDs/stock/payment. Nếu không chứng minh được tính nhất quán, giữ hệ thống ở chế độ bảo trì và xử lý theo từng nghiệp vụ. Phải giữ cả hai bộ volume và backup để điều tra.

## Giới hạn vận hành

Bốn PostgreSQL vẫn ở cùng Docker host: lỗi host/disk là failure domain chung. Mỗi DB dùng user ứng dụng/mật khẩu riêng, nhưng hiện các instance dùng chung mật khẩu quản trị `POSTGRES_PASSWORD` để tương thích `.env` không bị sửa; trước production cần cấp admin credential riêng và kế hoạch rotate (đổi env trên volume đã có **không** tự đổi password PostgreSQL). Cần backup định kỳ, kiểm tra restore và nếu cần chịu lỗi host thì triển khai replication/failover riêng. Không tự coi việc tách container là HA.
