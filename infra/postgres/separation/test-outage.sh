#!/usr/bin/env bash
# Chỉ dừng DB trong project test cố định; không đụng jewelry-postgres-1.
set -euo pipefail
cd "$(dirname "$0")/../../.."
compose=(docker compose --env-file .env -p jewelry-db-separation-test -f infra/postgres/separation/compose.test.yml)
stopped=''
recover() {
  if [ -n "$stopped" ]; then
    "${compose[@]}" start "$stopped" >/dev/null
  fi
}
trap recover EXIT

for failed in auth inventory; do
  stopped="$failed-postgres"
  "${compose[@]}" stop "$stopped"
  for healthy in auth inventory sales report; do
    [ "$healthy" = "$failed" ] && continue
    value=$("${compose[@]}" exec -T "$healthy-postgres" sh -c \
      'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"' | tr -d '\r')
    [ "$value" = 1 ] || { echo "$healthy-postgres không còn truy cập được" >&2; exit 1; }
  done
  echo "Dừng $stopped: 3 DB test còn lại truy vấn được."
  "${compose[@]}" start "$stopped"
  "${compose[@]}" up -d --wait "$stopped" >/dev/null
  value=$("${compose[@]}" exec -T "$stopped" sh -c \
    'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"' | tr -d '\r')
  [ "$value" = 1 ] || { echo "$stopped chưa hồi phục" >&2; exit 1; }
  echo "$stopped hồi phục: PASS."
  stopped=''
done
