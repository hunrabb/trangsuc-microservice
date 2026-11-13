# Migration Jobs Giai đoạn 3

Auth → Inventory → Sales → Report, chạy tuần tự trên jewelry-demo/jewelry-pg-rw. Image hiện tại đã đối chiếu schema/migration_lock/mọi migration.sql/prisma.config.ts/wait-for-postgres.mjs và Prisma7.10.1 với working tree. migration-images.lock.json ghi Docker IDs, alias theo content ID, history checksums và bảng/constraints thực tế.

Image aliases `phase3-<DockerID prefix>` được load vào Worker1, imagePullPolicy Never, không pull từ registry ngoài và không build lại. Secret `<service>-migration-creds` riêng, non-root1000, CA chỉ ca.crt. activeDeadline180s/backoffLimit0; không tự retry/reset/db push. Không dùng credentials/DB Compose.

Các Job đã Complete được giữ để review, không đưa vào overlay reconcile. Apply lại cùng Job Complete sẽ không chạy lại migration; không delete/recreate Jobs mù quáng. Source/migration/image thay đổi phải đối chiếu và phê duyệt quy trình tương ứng. Không chạy migration từ application replica.

Số history: Auth4, Inventory13, Sales15, Report7; checksums khớp SQL source, finished_at đủ, không rolled_back. Tables/constraints được kiểm chứng, runtime đã bị revoke quyền sửa _prisma_migrations. Không seed dữ liệu thật. Đã kiểm tra các DROP CONSTRAINT thay thế/ALTER DROP NOT NULL trong lịch sử trên schema demo trống, không DROP DATABASE/TABLE/COLUMN/TRUNCATE hoặc reset.
