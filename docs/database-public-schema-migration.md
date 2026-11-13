# Chuyển bốn database sang schema `public` — BLOCKED

Ngày kiểm tra: 2026-11-10. Branch: `feat/sales-pos`. **Development chưa chuyển schema.** Bốn database và volume development vẫn nguyên trạng; không đổi URL, source runtime, migration history, Compose, `.env`, không commit/push. Các thay đổi Phase 7 đã có từ trước trong working tree được giữ nguyên.

## Hiện trạng và khảo sát

| Service | Database hiện tại | Schema hiện tại | Bảng | Index | Enum | Routine | Migration thành công |
|---|---|---|---:|---:|---:|---:|---:|
| Auth | `auth_db` | `auth` | 8 | 18 | 4 | 0 | 3 |
| Inventory | `inventory_db` | `inventory` | 24 | 65 | 11 | 0 | 13 |
| Sales | `sales_db` | `sales` | 29 | 79 | 12 | 8 | 14 |
| Report | `report_db` | `report` | 12 | 27 | 2 | 0 | 7 |

Catalog chỉ đọc cho thấy schema `public` của từng database không có table/index/sequence, routine hoặc enum ứng dụng. `_prisma_migrations` đang nằm trong schema riêng; cả bốn bảng không có migration lỗi/chưa hoàn tất. Các service còn dùng `?schema=<service>`, `DB_SCHEMA=<service>` và Prisma adapter `{ schema: DB_SCHEMA }`. SQL nghiệp vụ và Outbox có nhiều identifier ghi rõ schema. Sales có tám routine; thân một số routine tham chiếu `"sales".` nên đổi tên schema đơn thuần sẽ không đủ. Lịch sử migration cũng có SQL hardcode schema riêng, không thể sửa các file đã áp dụng mà không làm lệch checksum và đường nâng cấp.

`docker-compose.db-separated.yml` vẫn là staging; `docker-compose.yml` là development hiện hành. Cả bốn PostgreSQL development healthy khi khảo sát. User/volume mỗi service vẫn độc lập.

## Thử nghiệm thực tế trên bản sao Auth độc lập

Đã lấy `pg_dump -Fc` chỉ đọc từ `auth_db` development, lưu tại `/tmp/jewelry-public-auth.5dZIfG/source.dump` (thư mục tạo với quyền 700, file 600). `sha256sum -c` và `pg_restore -l` PASS. Restore toàn DB bằng `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` vào container thử nghiệm mới `jewelry-public-auth-copy-20261110`, bind mount data directory riêng trong cùng thư mục `/tmp`; không mount bất kỳ volume development/Phase 6/Phase 7 nào. Đây là bản sao thử kỹ thuật: restore bằng `postgres`, chưa tái tạo ownership/permission của `auth_user`.

Trên **bản sao Auth duy nhất**, trong một transaction có preflight `public` rỗng và đủ 8 bảng `auth`, đã chạy:

```sql
ALTER SCHEMA public RENAME TO public_before_auth_20261110;
ALTER SCHEMA auth RENAME TO public;
```

Sau `COMMIT`, `public._prisma_migrations` có đủ 3 migration thành công. So sánh số dòng và MD5 tính từ nội dung từng dòng (sắp theo hash) trước/sau cho **cả 8 bảng**, gồm `OutboxEvent`, `AuditLog`, `_prisma_migrations`, đều khớp. Số dòng tương ứng: `AuditLog` 25, `AuthIdentity` 1, `Branch` 4, `OutboxEvent` 7, `RefreshToken` 15, `User` 6, `UserBranch` 6, `_prisma_migrations` 3. Hash từng bảng được lưu trong `before.rows` và `after.rows` ở thư mục thử nghiệm; `diff -u` không có khác biệt. Container thử nghiệm đã **stop**, data directory và backup vẫn giữ lại; không xóa container hoặc dữ liệu.

Đây **chưa** là kết quả PASS cho Auth: chưa so sánh catalog PK/FK/index/enum/sequence/privilege đầy đủ, chưa kiểm `prisma migrate status` hoặc drift, chưa chạy Prisma Client bằng `auth_user`, và chưa có HTTP/integration test trên bản sao. Auth copy cũng không có role ứng dụng tương đương vì restore kỹ thuật dùng `postgres`.

## Chiến lược dự kiến và gate bắt buộc

Phương án khả thi cần được chứng minh tiếp trên bốn bản sao độc lập: khi `public` trống và không có dependency bất thường, đổi tên `public` cũ sang schema dự phòng rồi đổi schema service thành `public` trong một transaction. Cách này giữ nguyên OID/ID/dữ liệu, index, constraint, enum, sequence, trigger và `_prisma_migrations`. Phải chỉnh lại định nghĩa các routine Sales có tham chiếu schema cũ và kiểm tra mọi raw SQL, script, seed, backup/restore, CI, test, `search_path`, quyền sở hữu. Sau khi chứng minh, mới đổi `DB_SCHEMA`, Prisma adapter, URL app/migration/shadow, Compose và các SQL runtime sang `public`; lịch sử migration đã áp dụng phải giữ nguyên.

**Gate chưa đạt:** cần chứng minh Prisma replay/migrate từ database mới, `migrate status`, drift/shadow DB và nâng cấp tiếp sau chuyển. Đặc biệt, migration cũ dùng tên schema riêng và `_prisma_migrations` di chuyển cùng schema, nên không được mặc định rằng `prisma migrate dev` hoặc fresh install sẽ hoạt động khi chỉ thay `?schema=public`. Cần có đường bootstrap/migration chuyển tiếp được kiểm thử với Prisma 7 mà không sửa migration lịch sử. Cần test dữ liệu/cấu trúc/quyền trên cả bốn bản sao, build images, chạy smoke/integration Auth/Inventory/Sales/Report/RabbitMQ theo yêu cầu trước khi xét chuyển development.

## Lý do dừng và rollback

Máy có 3.8 GiB RAM; sau thử nghiệm Auth còn khoảng 1.3 GiB available nhưng swap 1.0 GiB chỉ còn 7.5–12 MiB. Theo điều kiện an toàn của task, đã dừng test nặng và container thử nghiệm, không bật thêm ba PostgreSQL test hoặc chạy Prisma/build/integration. CLI Prisma trên host cũng chưa chạy được do `pnpm` không nằm trong PATH của môi trường công cụ; không được coi là PASS. Bốn DB development vẫn healthy sau thử nghiệm.

Không cần rollback development vì chưa chạm dữ liệu/cấu hình development. Với bản sao Auth, có thể đảo hai tên schema trong một transaction **chỉ khi chưa có ghi mới**, hoặc restore lại dump vào một test DB mới; giữ nguyên dump, TOC và data directory để đối chiếu. Khi triển khai thật sau này, phải dừng toàn bộ writer, backup cuối có restore thử, đối chiếu từng DB và xác minh đường rollback trước khi mở ghi. Không dùng DB legacy chung làm rollback trực tiếp vì nó đã lạc hậu sau cutover 4 DB.

**Kết luận: BLOCKED — chưa đủ điều kiện an toàn để chuyển development sang `public`.**
