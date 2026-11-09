# Phase 6.5B — bằng chứng thực thi ngày 2026-11-09

Log được chọn từ `/tmp/jewelry-phase6.oYLXx8`; không bao gồm env, key, access file hoặc HTTP headers. DB và broker chỉ thuộc acceptance project. Log đầu tiên có hai lỗi fixture/assertion được giữ, xem báo cáo nghiệm thu.

## checkout-final.log

```text
✔ PostgreSQL: two online orders compete for one physical item, unique active hold and idempotent retry (444.099737ms)
✔ PostgreSQL: POS deduction versus online reservation cannot both win (258.354177ms)
✔ PostgreSQL: release before create, expiration retries and SOLD safeguard (464.087728ms)
✔ PostgreSQL: concurrent checkout same key, outbox handoff, Inventory price and no paid event (382.882851ms)
✔ 6.5B DB-09: reservation failure rolls back item, hold and outbox together (432.175602ms)
✔ 6.5B DB-04/05: lost checkout result retry and different keys cannot double reserve (497.005285ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2526.778977
```

## payment-final.log

```text
✔ PostgreSQL: duplicate receipt, Inventory acknowledgement and refund/callback contention are idempotent (569.45394ms)
✔ PostgreSQL: expired reservation versus paid event never sells a replacement or drops received money (377.11029ms)
✔ 6.5B DB-08: same bank reference cannot pay two different orders (333.236039ms)
✔ 6.5B DB-10: unpaid expiry cannot release a verified paid hold (417.920733ms)
✔ 6.5B DB-09: receipt outbox failure rolls back payment, key alias, audit and order (262.257174ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1984.925403
```

## http.log

```text
{"result": "PASS", "scope": "real HTTP and asynchronous broker flow; no browser or real bank", "orderId": "35017bd4-00a9-413f-8d4d-238b30cbe276", "paymentId": "5a912f44-9221-45ec-9967-b7d2f1a8efff"}
```

## live-initial.log

```text
✔ LIVE-DB: paid HTTP flow has exactly one receipt, audit, paid hold and physical owner (524.876ms)
✔ LIVE-MQ: duplicate order.paid delivery leaves payment version and refund state unchanged (1566.094085ms)
✖ LIVE-MQ: stale catalog event is processed without overwriting newer snapshot (45622.68914ms)
✔ LIVE-HTTP: catalog filters, private no-store, cross-guest denial and out-of-stock checkout (1469.418911ms)
✔ LIVE-LOG: correlation crosses Gateway/Sales; capability, JWT and cookie are redacted (319.980966ms)
ℹ tests 5
ℹ suites 0
ℹ pass 4
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 49597.791686

✖ failing tests:

test at tests/phase6/live-verification.integration.mjs:143:9
✖ LIVE-MQ: stale catalog event is processed without overwriting newer snapshot (45622.68914ms)
  Error: Live assertion timed out
      at poll (file:///home/hung/trangsuc-microservice/tests/phase6/live-verification.integration.mjs:75:9)
      at async TestContext.<anonymous> (file:///home/hung/trangsuc-microservice/tests/phase6/live-verification.integration.mjs:157:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      at async file:///home/hung/trangsuc-microservice/tests/phase6/live-verification.integration.mjs:143:3
```

## stale.log

```text
✔ LIVE-MQ: stale catalog event is processed without overwriting newer snapshot (1062.568315ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1136.643074
```

## catalog.log

```text
✔ CAT-01: fresh stock is projected through outbox/broker into public API (782.558208ms)
✔ CAT-02: updated Inventory metal price reaches Catalog without client price calculation (715.994584ms)
✔ CAT-03: unpublish removes product, republish restores latest snapshot (1197.761582ms)
✔ CAT-04: removal of remaining stock projects unavailable while paid physical item stays reserved (435.840767ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3237.608373
```

## http-security.log

```text
✔ HTTP-11: Gateway denies internal routes and encoded traversal over real HTTP (171.851285ms)
{"rateLimit":"429 observed","acceptedBefore429":119,"scope":"single test Gateway, sequential requests"}
✔ HTTP-10: public catalog rate limiter returns 429 within configured 120/minute budget (2744.841299ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2953.768089
```

## broker-offline.log

```text
{"result":"PASS","stage":"offline durable order/outbox","orderId":"4ce4335a-9bf0-4273-8839-84c9c7e9d74e","outboxStatus":"PENDING"}
```

## broker-recover-initial.log

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'PUBLISHED'
- 'SENT'

    at file:///home/hung/trangsuc-microservice/tests/phase6/broker-recovery.integration.mjs:80:12
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5) {
  generatedMessage: true,
  code: 'ERR_ASSERTION',
  actual: 'PUBLISHED',
  expected: 'SENT',
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v24.22.2
```

## broker-recover.log

```text
{"result":"PASS","stage":"broker restart and outbox recovery; item remains held by paid order","orderId":"4ce4335a-9bf0-4273-8839-84c9c7e9d74e"}
```

## consumer-prepare.log

```text
{"result":"PASS","stage":"consumer offline, projection absent, confirmed event retained","eventId":"30e6cd64-3ada-4f1b-9d9d-cd806950cd6b"}
```

## consumer-recover.log

```text
{"result":"PASS","stage":"consumer restart drains backlog and rebuilds missing catalog projection","eventId":"30e6cd64-3ada-4f1b-9d9d-cd806950cd6b","version":24}
```

## inventory-status.log

```text
Loaded Prisma config from ../../../tmp/jewelry-phase6.oYLXx8/inventory.config.ts.

Prisma schema loaded from apps/inventory/prisma/schema.prisma.
Datasource "db": PostgreSQL database "phase6_test", schema "inventory" at "127.0.0.1:55432"

10 migrations found in prisma/migrations

Database schema is up to date!
```

## sales-status.log

```text
Loaded Prisma config from ../../../tmp/jewelry-phase6.oYLXx8/sales.config.ts.

Prisma schema loaded from apps/sales/prisma/schema.prisma.
Datasource "db": PostgreSQL database "phase6_test", schema "sales" at "127.0.0.1:55432"

9 migrations found in prisma/migrations

Database schema is up to date!
```

## broker-diagnostics.log

```text
{
  "result": "PASS",
  "scope": "permanent invalid version routed to DLQ, preserved via nack/requeue; not retry exhaustion",
  "eventId": "444dfdb0-21d2-409b-b211-d7ab817669d6",
  "queues": [
    {
      "name": "inventory.events",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "inventory.events.dlq",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "inventory.events.retry.30s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "inventory.events.retry.5m",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "inventory.events.retry.5s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.dlq.observer",
      "messages": 1,
      "ready": 1,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.events",
      "messages": 5,
      "ready": 5,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.events.dlq",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.events.retry.30s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.events.retry.5m",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "report.events.retry.5s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "sales.events",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "sales.events.dlq",
      "messages": 1,
      "ready": 1,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "sales.events.retry.30s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "sales.events.retry.5m",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    },
    {
      "name": "sales.events.retry.5s",
      "messages": 0,
      "ready": 0,
      "unacked": 0,
      "consumers": 0
    }
  ]
}
```

## Schema/checksum và tài nguyên

`schema-assertions.sql` chạy thành công trước và sau live tests. Cả 19 checksum SHA-256 trong `_prisma_migrations` trùng file SQL gốc. Inventory 10/10 và Sales Phase 6 9/9 applied; Phase 7 không áp dụng.

Trước cleanup: PostgreSQL healthy, OOM=false, restarts=0, 40.71 MiB/384 MiB; RabbitMQ healthy, OOM=false, restarts=0, 108.9 MiB/512 MiB. RAM available đo được 433–609 MiB khi chạy đủ backend; swap 1023–1024/1024 MiB. Đây là các mẫu đo, không phải đo peak liên tục. Không ghi nhận WSL disconnect hoặc container OOM trong phiên.

Static contract suite: 8 tests, PASS 8, FAIL 0. ESLint và Prettier các integration scripts PASS. Build tuần tự contracts/common/Inventory/Sales/Gateway và Prisma generate Inventory/Sales PASS. Không chạy lại toàn bộ unit suite.

## Cleanup và kiểm tra cuối

- Đã SIGTERM đúng Gateway/Sales/Inventory acceptance PIDs sau khi xác minh cmdline.
- Compose stop xác nhận cả PostgreSQL và RabbitMQ acceptance Stopped; không down -v.
- `docker ps` sau cleanup chỉ còn `jewelry-postgres-1` và `jewelry-rabbitmq-1` chạy,
  vẫn đúng 5432/5672/15672 như trước lượt test. Không có listener 3090/3092/3093/
  55432/55672/55673; các listener chính 3000/3001/3004 còn nguyên.
- RAM available sau cleanup 1040 MiB; swap 1023/1024 MiB. Giữ test volumes/network/
  containers dừng và log để điều tra, không purge hoặc xoá volume.
- Syntax PASS 11 JS files và 11 bash recipes trong runbook; recipes chỉ bash -n,
  không được tự thực thi bởi bước kiểm tra syntax.
- Evidence được kiểm không chứa generated passwords hoặc service connection URLs
  có credentials từ env test. Env/private key/private access files không được copy.
