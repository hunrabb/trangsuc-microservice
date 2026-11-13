# Cấu hình demo Giai đoạn 3

Không deploy NestJS ở giai đoạn này. ConfigMaps là cấu hình đích cho Giai đoạn 4; resource-profiles là dữ liệu planning, không phải scheduler enforcement trên business Deployments chưa tạo.

Mỗi service dùng `jewelry-common` + `<service>-config`, Secret `<service>-runtime-creds` key DATABASE_URL, Secret `rabbitmq-demo-app` key RABBITMQ_URL. Migration Jobs chỉ dùng `<service>-migration-creds`, không credentials Compose.

User node UID/GID1000, fsGroup1000. Mount Secret read-only/defaultMode0440. Mọi service đọc `jwt-verification` item public.pem tại `/run/secrets/jwt-public/public.pem`. **Chỉ Auth** mount `auth-jwt-signing` item private.pem tại `/run/secrets/jwt-private/private.pem`. Không mount private JWT vào service khác.

PostgreSQL CA: Secret CNPG `jewelry-pg-ca`, **chỉ project item ca.crt**, path `/run/secrets/postgres/ca.crt`; không mount cả Secret vì có thể gồm CA private key. Runtime URL dùng pg sslrootcert/verify-full; migrate URL dùng Prisma sslcert/require/strict. Tất cả URL có schema riêng và host jewelry-pg-rw.jewelry-demo.svc.cluster.local.

`auth-config-probe.yaml` chỉ là Pod kiểm tra cấu hình của Auth bằng Node/openssl, không chạy NestJS. Probe đã xóa sau PASS; không đưa vào overlay thường trực. Image gateway chỉ tái sử dụng Node filesystem, không chạy gateway entrypoint. Credentials/keypair demo mới nằm trong Kubernetes Secrets, không YAML Git; không chạy lại sinh key/password để reconcile một cluster đang có dữ liệu.

GOOGLE_CLIENT_ID hiện là placeholder vô hiệu, Google login chưa thể kiểm chứng. Khi cần Google OAuth demo phải cung cấp Client ID demo hợp lệ; không lấy keys/credentials cũ. App upstream URLs chỉ resolve khi Services tương ứng được tạo trong Giai đoạn 4.

`runtime-db-probe.yaml` là test Nodepg sau migrations: own-schema/TLS4service và24 cross-DB connection attempts phải bị từ chối; không chạy NestJS, đã cleanup. Không đưa vào overlay thường trực.
