#!/usr/bin/env python3
"""Read-only catalog and migration verification for the isolated four-DB project."""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROJECT = "jewelry-db-separation-test"
EXPECTED = {
    "auth": ("auth_db", 8, {"User", "Branch", "RefreshToken", "_prisma_migrations"}),
    "inventory": ("inventory_db", 24, {"JewelryItem", "Warehouse", "MetalPrice", "ExchangeHold", "StockMovement", "OutboxEvent", "_prisma_migrations"}),
    "sales": ("sales_db", 29, {"Order", "OnlinePayment", "BuybackIntake", "BuybackSettlement", "OutboxEvent", "_prisma_migrations"}),
    "report": ("report_db", 12, {"OrderRevenue", "BuybackSettlementFact", "BuybackStockFact", "ProcessedEvent", "_prisma_migrations"}),
}


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def query(container, sql):
    return run(
        "docker", "exec", container, "sh", "-c",
        'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -c "$1"',
        "sh", sql,
    )


for service, (database, expected_count, required_tables) in EXPECTED.items():
    container = f"{PROJECT}-{service}-postgres-1"
    info = json.loads(run("docker", "inspect", container))[0]
    labels = info["Config"]["Labels"]
    assert labels.get("com.docker.compose.project") == PROJECT
    assert labels.get("com.docker.compose.service") == f"{service}-postgres"
    assert info["State"]["Health"]["Status"] == "healthy"
    assert any(
        mount.get("Name") == f"{PROJECT}_{service}_pg_data"
        and mount.get("Destination") == "/var/lib/postgresql/data"
        for mount in info["Mounts"]
    )

    actual_database = query(container, "SELECT current_database()")
    assert actual_database == database, (service, actual_database)
    tables = set(filter(None, query(
        container,
        f"SELECT tablename FROM pg_tables WHERE schemaname='{service}' ORDER BY tablename",
    ).splitlines()))
    assert len(tables) == expected_count, (service, len(tables), expected_count)
    assert required_tables <= tables, (service, required_tables - tables)

    migrations = query(
        container,
        f'SELECT migration_name, checksum, (finished_at IS NOT NULL)::int, '
        f'(rolled_back_at IS NOT NULL)::int FROM "{service}"."_prisma_migrations" ORDER BY migration_name',
    ).splitlines()
    local = sorted((ROOT / "apps" / service / "prisma" / "migrations").glob("*/migration.sql"))
    assert len(migrations) == len(local), (service, len(migrations), len(local))
    for row in migrations:
        name, checksum, finished, rolled_back = row.split("|")
        sql_file = ROOT / "apps" / service / "prisma" / "migrations" / name / "migration.sql"
        assert sql_file.is_file(), (service, name)
        assert checksum == hashlib.sha256(sql_file.read_bytes()).hexdigest(), (service, name, "checksum")
        assert (finished, rolled_back) == ("1", "0"), (service, name, "failed")

    catalog = query(container, f"""
        SELECT
          (SELECT count(*) FROM pg_indexes WHERE schemaname='{service}'),
          (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='{service}'),
          (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{service}' AND c.relkind='S')
    """)
    print(f"{service}: {database}, {len(tables)} tables, {len(migrations)} checksummed migrations, indexes/constraints/sequences={catalog}")

print("PASS: four isolated DBs, required tables, migration history and source checksums")
