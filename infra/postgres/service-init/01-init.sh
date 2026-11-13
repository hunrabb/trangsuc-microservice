#!/bin/bash
# Chỉ chạy trên volume mới của một service; không đụng volume PostgreSQL legacy.
(
  set -euo pipefail

  : "${POSTGRES_USER:?}"
  : "${POSTGRES_DB:?}"
  : "${SHADOW_DB_NAME:?}"
  : "${SERVICE_DB_USER:?}"
  : "${SERVICE_SCHEMA:?}"
  : "${SERVICE_DB_PASSWORD:?}"

  case "$SERVICE_SCHEMA:$SERVICE_DB_USER:$POSTGRES_DB:$SHADOW_DB_NAME" in
    auth:auth_user:auth_db:auth_shadow|\
    inventory:inventory_user:inventory_db:inventory_shadow|\
    sales:sales_user:sales_db:sales_shadow|\
    report:report_user:report_db:report_shadow) ;;
    *) echo 'service-init: cấu hình service/database không khớp' >&2; exit 1 ;;
  esac

  psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v main_db="$POSTGRES_DB" \
    -v shadow_db="$SHADOW_DB_NAME" \
    -v app_user="$SERVICE_DB_USER" \
    -v app_schema="$SERVICE_SCHEMA" \
    -v app_pw="$SERVICE_DB_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw';
CREATE SCHEMA :"app_schema" AUTHORIZATION :"app_user";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE :"main_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"main_db" TO :"app_user";
CREATE DATABASE :"shadow_db";
REVOKE ALL ON DATABASE :"shadow_db" FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE :"shadow_db" TO :"app_user";
SQL
  echo "service-init: đã khởi tạo schema $SERVICE_SCHEMA trong $POSTGRES_DB"
)
