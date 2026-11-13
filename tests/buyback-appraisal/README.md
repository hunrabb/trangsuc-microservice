# Task 7.2 PostgreSQL acceptance

Chỉ PostgreSQL Docker test và Inventory pricing HTTP nhẹ trên loopback; không
khởi động toàn bộ services/RabbitMQ hoặc chạm database chính. Runner gọi Sales
services thật qua Prisma và Inventory controller/MetalsService thật qua HTTP.
Không phải full Gateway/JWT E2E hoặc bằng chứng production ready.

1. Kiểm tra Git, RAM, Docker projects/ports/volumes; giữ DB evidence Phase 6.
2. Tạo credentials test mới trong thư mục `/tmp` mode 0700, env mode 0600.
3. Dùng `infra/phase7/compose.appraisal-test.yml`, project
   `jewelry-phase72-acceptance`, database `phase72_test`, loopback port `55433`,
   volume `jewelry-phase72-acceptance_appraisal_pg`. Không dùng `.env` dev.
4. Xác minh `current_database()`, service role và mount/health trước migration.
5. Prisma config tạm trỏ vào schema/migrations của đúng app, datasource lấy env
   test; không gọi loadEnvFile('.env'). Deploy Inventory, rồi Sales **đến 7.1**
   bằng thư mục tạm chứa bản sao nguyên byte migrations cũ + migration_lock.toml.
6. Chạy `compatibility.sql` bằng sales_user trong container test; file tự guard DB/
   role và dừng nếu 7.2 đã tồn tại. Fixtures mới, không UPSERT/overwrite/reset.
7. Deploy migration 7.2 `20261109140000_buyback_appraisal`, status và checksum.
8. Build/generate tuần tự chỉ packages cần thiết; chạy unit và integration tuần tự.

Runner bắt buộc env:

```text
PHASE72_TEST_EXECUTE=I_ACKNOWLEDGE_ISOLATED_PHASE72_TEST
PHASE72_TEST_SALES_URL=postgresql://sales_user:<test-password>@127.0.0.1:55433/phase72_test?schema=sales
PHASE72_TEST_INVENTORY_URL=postgresql://inventory_user:<test-password>@127.0.0.1:55433/phase72_test?schema=inventory
```

Dùng `env -i PATH="$PATH" HOME="$HOME" node --env-file=<private-tests.env>
 tests/buyback-appraisal/appraisal.integration.mjs` (cùng một lệnh shell). Node từ
nvm v24.22.2 nếu login PATH thiếu. Không in URLs/passwords, không bật `set -x`.
Runner từ chối thiếu opt-in hoặc URL khác host/port/db/schema/role đã chỉ định và
kiểm actual database/user trước ghi fixture. Fixture PH72 được giữ để điều tra;
không reset bảng để chạy xanh. `--test-name-pattern` cho phép rerun mục tiêu.

MIG-01 và DB-01…DB-17 kiểm compatibility, kiểm định nhiều món, concurrency/version,
Decimal snapshots, policy/market change, invalidation, concurrent approval/edit,
role/branch/maker-checker, rollback audit, retry và không phát sinh payment/stock.
Các ca cuối kiểm incomplete/rejected/terminal, thiếu nguồn giá, policy CAS và
DB-level unique/immutable/FK/deferred totals và UUID uppercase hợp lệ. Fake audit-failure injection chỉ nằm
trong runner quanh Prisma transaction thật; không thêm endpoint lỗi vào production.

Chạy `schema-assertions.sql` trong container test sau integration và đối chiếu
21 checksum với SQL gốc. Giữ log đã lọc, không upload env/key/PII.

Kết thúc: HTTP app và Prisma clients được đóng ở `finally`; dừng **chỉ** container
PostgreSQL task bằng Compose `stop`, giữ volume và evidence. Không prune/down -v,
không dừng project chính hoặc bật RabbitMQ. Xem `docs/phase7-progress.md` cho kết
quả thực tế, những giới hạn đã kiểm và kế hoạch 7.3; không tự chạy 7.3.
