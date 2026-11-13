#!/usr/bin/env python3
"""Static wiring check; does not start containers or print DATABASE_URL/passwords."""
import json
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]
SERVICES = ("auth", "inventory", "sales", "report")


def config(*files, project=True):
    args = ["docker", "compose", "--env-file", ".env"]
    if project:
        args.extend(("-p", "jewelry-db-separation-test"))
    for file in files:
        args.extend(("-f", file))
    args.extend(("config", "--format", "json"))
    result = subprocess.run(args, cwd=ROOT, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


main = config("docker-compose.db-separated.yml")
assert config("docker-compose.db-separated.yml", project=False)["name"] == "jewelry-db-separation-staging"
assert "postgres" not in main["services"], "Legacy DB phải nằm sau profile"
volumes = set()
for service in SERVICES:
    db_name = f"{service}_db"
    db_service = f"{service}-postgres"
    db = main["services"][db_service]
    assert db["environment"]["POSTGRES_DB"] == db_name
    assert db["environment"]["SERVICE_SCHEMA"] == service
    assert db["environment"]["SERVICE_DB_USER"] == f"{service}_user"
    assert not db.get("ports"), f"{db_service} không được publish port ở cấu hình chính"
    assert db.get("healthcheck"), f"{db_service} cần healthcheck"
    volume = next(v["source"] for v in db["volumes"] if v["target"] == "/var/lib/postgresql/data")
    volumes.add(volume)
    for app in (service, f"{service}-migrate"):
        job = main["services"][app]
        url = urlparse(job["environment"]["DATABASE_URL"])
        assert (url.username, url.hostname, url.path, parse_qs(url.query)) == (
            f"{service}_user", db_service, f"/{db_name}", {"schema": [service]}
        ), f"{app} trỏ sai DB"
        assert db_service in job["depends_on"], f"{app} phải chờ DB của mình"
        assert "postgres" not in job["depends_on"], f"{app} còn phụ thuộc DB legacy"

assert len(volumes) == 4, "Bốn DB phải có bốn volume riêng"
assert "pg_data" not in volumes, "Volume legacy không được mount vào DB mới"
test = config("infra/postgres/separation/compose.test.yml")
assert set(test["services"]) == {f"{service}-postgres" for service in SERVICES}
for service, port in zip(SERVICES, (15433, 15434, 15435, 15436)):
    published = test["services"][f"{service}-postgres"]["ports"]
    assert len(published) == 1
    assert published[0]["host_ip"] == "127.0.0.1" and published[0]["published"] == str(port)

print("PASS: 4 DB, 4 volume, 8 URL app/migrate đúng, health/deps đúng, test chỉ mở loopback")
