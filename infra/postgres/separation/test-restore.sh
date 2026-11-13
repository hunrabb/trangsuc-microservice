#!/usr/bin/env bash
# Read-only dump từ jewelry-postgres-1; restore CHỈ vào project test riêng.
# Chạy từ thư mục gốc: bash infra/postgres/separation/test-restore.sh
set -euo pipefail
umask 077

cd "$(dirname "$0")/../../.."
compose=(docker compose --env-file .env -p jewelry-db-separation-test -f infra/postgres/separation/compose.test.yml)
source_container=jewelry-postgres-1

if [ "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}' "$source_container")" != 'jewelry:postgres' ]; then
  echo 'Nguồn không phải PostgreSQL legacy của project jewelry; dừng.' >&2
  exit 1
fi

# Dữ liệu nguồn cần ổn định để so sánh từng schema; không dừng hoặc sửa container thật.
running=$(docker ps --format '{{.Names}}')
for app in auth inventory sales report gateway; do
  if printf '%s\n' "$running" | grep -Fxq "jewelry-$app-1"; then
    echo "jewelry-$app-1 còn chạy; dừng ghi theo runbook trước khi sao lưu thử." >&2
    exit 1
  fi
done

backup_dir=$(mktemp -d /tmp/jewelry-db-separation.XXXXXXXX)
echo "Backup test lưu ở $backup_dir (quyền riêng tư 700; không đưa vào Git)."

for service in auth inventory sales report; do
  target="$service-postgres"
  archive="$backup_dir/$service.dump"
  echo "Sao lưu schema $service từ PostgreSQL legacy (chỉ đọc)."
  docker exec "$source_container" sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --schema "$1"' sh "$service" > "$archive"
  test -s "$archive"
  echo "Khởi động $target trong project jewelry-db-separation-test."
  "${compose[@]}" up -d --wait "$target"
  "${compose[@]}" cp "$archive" "$target:/tmp/$service.dump" >/dev/null

  "${compose[@]}" exec -T "$target" sh -s -- "$service" <<'SH'
set -eu
service="$1"
database="${service}_db"
tables=$(psql -X -At -U "$POSTGRES_USER" -d "$database" -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname = '$service'")
if [ "$tables" != 0 ]; then
  echo "DB test $database đã có bảng; từ chối restore chồng dữ liệu." >&2
  exit 1
fi
# Schema đã được init tạo và thuộc app user; bỏ đúng mục CREATE SCHEMA trong TOC.
pg_restore -l "/tmp/$service.dump" \
  | sed -E "/^[0-9]+; [0-9]+ [0-9]+ SCHEMA - $service /s/^/;/" \
  > "/tmp/$service.list"
pg_restore -U "$POSTGRES_USER" --role="${service}_user" --no-owner --no-acl \
  --single-transaction --exit-on-error -L "/tmp/$service.list" \
  -d "$database" "/tmp/$service.dump"
SH

  # Đối chiếu từng bảng, bao gồm outbox/processed events/_prisma_migrations.
  table_list=$(docker exec "$source_container" sh -c \
    'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT tablename FROM pg_tables WHERE schemaname = '\''$1'\'' ORDER BY tablename"' sh "$service")
  source_tables=$(printf '%s\n' "$table_list" | sed '/^$/d' | wc -l)
  target_tables=$("${compose[@]}" exec -T "$target" sh -c \
    'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM pg_tables WHERE schemaname = '\''$1'\''"' sh "$service" | tr -d '\r')
  if [ "$source_tables" != "$target_tables" ]; then
    echo "Sai số bảng $service: nguồn=$source_tables đích=$target_tables" >&2
    exit 1
  fi

  while IFS= read -r table; do
    [ -n "$table" ] || continue
    safe_table=${table//\"/\"\"}
    query="SELECT count(*), md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) FROM \"$service\".\"$safe_table\" t"
    source_result=$(docker exec "$source_container" sh -c \
      'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$query")
    target_result=$("${compose[@]}" exec -T "$target" sh -c \
      'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$query" | tr -d '\r')
    if [ "$source_result" != "$target_result" ]; then
      echo "Khác dữ liệu bảng $service.$table (số dòng/checksum)." >&2
      exit 1
    fi
  done <<< "$table_list"
  echo "$service: PASS $source_tables bảng, số dòng và checksum từng bảng khớp."
done

echo 'PASS: bốn schema đã restore vào bốn DB test độc lập; dữ liệu PostgreSQL legacy không bị ghi.'
