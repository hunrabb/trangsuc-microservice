#!/usr/bin/env python3
"""Compare every migration SQL file packaged in Docker images with current source."""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


for service in ("auth", "inventory", "sales", "report"):
    image = f"jewelry/{service}-migrate:dev"
    info = json.loads(run("docker", "image", "inspect", image))[0]
    packaged = run(
        "docker", "run", "--rm", "--read-only", "--network", "none",
        "--entrypoint", "sh", image, "-c",
        "cd /app && find prisma/migrations -name migration.sql -type f -exec sha256sum {} +",
    )
    actual = {Path(path).parent.name: digest for digest, path in (line.split("  ", 1) for line in packaged.splitlines())}
    local = {
        path.parent.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ROOT / "apps" / service / "prisma" / "migrations").glob("*/migration.sql")
    }
    assert actual == local, (service, "image/source migration SQL mismatch")
    print(f"{service}: image={info['Id'][:19]}, migrations={len(local)}, latest={max(local)}: PASS")

print("PASS: all four migrate images package current migration SQL")
