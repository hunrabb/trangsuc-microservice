#!/usr/bin/env python3
"""Read-only per-table comparison of legacy data against migrated test DBs."""

import json
import subprocess

PROJECT = "jewelry-db-separation-test"
SOURCE = "jewelry-postgres-1"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def label(container, key):
    return json.loads(run("docker", "inspect", container))[0]["Config"]["Labels"].get(key)


def query(container, sql):
    return run(
        "docker", "exec", container, "sh", "-c",
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c "$1"',
        "sh", sql,
    )


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


assert label(SOURCE, "com.docker.compose.project") == "jewelry"
assert label(SOURCE, "com.docker.compose.service") == "postgres"
running = set(run("docker", "ps", "--format", "{{.Names}}").splitlines())
assert not {f"jewelry-{service}-1" for service in ("auth", "inventory", "sales", "report", "gateway")} & running

total = 0
for service in ("auth", "inventory", "sales", "report"):
    target = f"{PROJECT}-{service}-postgres-1"
    assert label(target, "com.docker.compose.project") == PROJECT
    assert label(target, "com.docker.compose.service") == f"{service}-postgres"
    assert query(target, "SELECT current_database()") == f"{service}_db"
    tables = query(SOURCE, f"SELECT tablename FROM pg_tables WHERE schemaname={literal(service)} ORDER BY tablename").splitlines()
    for table in tables:
        # migrate deploy intentionally adds rows here; verify its contents/checksums separately.
        if table == "_prisma_migrations":
            continue
        cols = query(
            SOURCE,
            "SELECT column_name FROM information_schema.columns "
            f"WHERE table_schema={literal(service)} AND table_name={literal(table)} ORDER BY ordinal_position",
        ).splitlines()
        target_cols = set(query(
            target,
            "SELECT column_name FROM information_schema.columns "
            f"WHERE table_schema={literal(service)} AND table_name={literal(table)}",
        ).splitlines())
        assert set(cols) <= target_cols, (service, table, "original column missing")
        # Compare only original columns; a migration may have appended new columns.
        projection = "jsonb_build_object(" + ",".join(
            f"{literal(col)},to_jsonb(t)->{literal(col)}" for col in cols
        ) + ")"
        sql = (
            "SELECT count(*), md5(COALESCE(string_agg(md5(" + projection + "::text),"
            "'' ORDER BY md5(" + projection + "::text)),'')) "
            f"FROM {ident(service)}.{ident(table)} t"
        )
        before, after = query(SOURCE, sql), query(target, sql)
        assert before == after, (service, table, "count/checksum mismatch")
        total += 1
    print(f"{service}: {len(tables) - 1} original data tables retained with matching rows/checksums")

print(f"PASS: {total} legacy tables unchanged after test restore and migrations")
