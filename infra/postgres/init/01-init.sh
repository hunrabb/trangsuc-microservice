#!/bin/bash
# Khởi tạo Postgres cho hệ thống. Image postgres chỉ chạy script này MỘT LẦN, khi volume pg_data còn trống.
# (Muốn chạy lại từ đầu: `docker compose down -v` — XOÁ toàn bộ dữ liệu.)
#
# Mọi mật khẩu lấy từ biến môi trường của container postgres (docker-compose.yml ← .env), không ghi cứng.
# Kết quả:
#   - 4 user: auth_user, inventory_user, sales_user, report_user (không phải superuser, không tạo được DB/role)
#   - 4 schema cùng tên service, mỗi schema thuộc (AUTHORIZATION) đúng user của nó
#   - schema public bị thu hết quyền của PUBLIC
#   - 1 database riêng làm "shadow database" cho `prisma migrate dev` ở máy dev
#
# Toàn bộ nằm trong subshell: nếu file không có quyền thực thi, entrypoint của image sẽ `source` nó
# thay vì chạy riêng, và `set -e/-u` không được phép rò vào shell của entrypoint.
(
  set -euo pipefail

  for name in POSTGRES_USER POSTGRES_DB SHADOW_DB_NAME \
    AUTH_DB_PASSWORD INVENTORY_DB_PASSWORD SALES_DB_PASSWORD REPORT_DB_PASSWORD; do
    if [ -z "${!name:-}" ]; then
      echo "init-db: thiếu biến môi trường ${name}" >&2
      exit 1
    fi
  done

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v main_db="$POSTGRES_DB" \
    -v shadow_db="$SHADOW_DB_NAME" \
    -v auth_pw="$AUTH_DB_PASSWORD" \
    -v inventory_pw="$INVENTORY_DB_PASSWORD" \
    -v sales_pw="$SALES_DB_PASSWORD" \
    -v report_pw="$REPORT_DB_PASSWORD" <<'SQL'

-- 1. User riêng cho từng service.
CREATE ROLE auth_user      LOGIN PASSWORD :'auth_pw';
CREATE ROLE inventory_user LOGIN PASSWORD :'inventory_pw';
CREATE ROLE sales_user     LOGIN PASSWORD :'sales_pw';
CREATE ROLE report_user    LOGIN PASSWORD :'report_pw';

-- 2. Mỗi schema thuộc về đúng một user. User khác không có quyền gì trên schema này
--    (không USAGE → SELECT sang schema khác báo "permission denied for schema ...").
CREATE SCHEMA auth      AUTHORIZATION auth_user;
CREATE SCHEMA inventory AUTHORIZATION inventory_user;
CREATE SCHEMA sales     AUTHORIZATION sales_user;
CREATE SCHEMA report    AUTHORIZATION report_user;

-- 3. Không ai được dùng schema public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE :"main_db" TO auth_user, inventory_user, sales_user, report_user;

-- 4. Database shadow cho `prisma migrate dev` (chỉ dùng ở máy dev; migrate deploy không cần).
--    Prisma tự xoá và tạo lại schema trùng tên trong DB này, nên mỗi user cần quyền CREATE trên DB shadow.
--    DB này không chứa dữ liệu thật.
CREATE DATABASE :"shadow_db";
REVOKE ALL ON DATABASE :"shadow_db" FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE :"shadow_db" TO auth_user, inventory_user, sales_user, report_user;

SQL

  echo "init-db: đã tạo 4 user, 4 schema và database shadow ${SHADOW_DB_NAME}"
)
