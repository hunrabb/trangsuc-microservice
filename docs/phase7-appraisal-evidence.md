# Task 7.2 — bằng chứng thực thi ngày 2026-11-09

Baseline `48e469a`, branch `feat/sales-pos`. Chỉ PostgreSQL Docker acceptance phase72_test:55433 và Inventory pricing HTTP nhẹ trên loopback. Không phải full Gateway/JWT E2E. Env/password/config có credentials và resolved Compose JSON không đưa vào tài liệu.

## unit-final.log

```text
$ node test/buyback-appraisal.test.mjs
✔ 7.2 appraisal validates precise weight/purity and rejects client actor/state/price (35.858741ms)
✔ 7.2 fineness is explicit per mille, never a floating point or inferred karat (1.171381ms)
✔ 7.2 policy needs explicit deduction and source mapping; no client market price (44.488375ms)
✔ 7.2 quote/decision DTOs reject duplicate lines, price injection and reasonless rejection (19.289681ms)
✔ 7.2 buyback math uses alloy buy price exactly once and explicit fixed VND deduction (17.096543ms)
✔ 7.2 rounding is HALF_UP per line, including exact tie and sub-threshold values (1.988708ms)
✔ 7.2 Decimal math preserves digits near large half-thousand boundaries (12.74867ms)
✔ 7.2 negative net/invalid inputs/storage overflow fail without a fabricated payout (3.803788ms)
✔ 7.2 forbidden role/branch is rejected before accessing DB or price provider (3.56035ms)
✔ 7.2 controller decision/config roles and private cache headers are present (14.023667ms)
✔ 7.2 Inventory source returns buy price with source identity, never sell price (2.437377ms)
✔ 7.2 Inventory missing rate fails; no default market quote is supplied (1.641554ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 233.978458
```

## intake-regression-sequential.log

```text
$ node test/buybacks.test.mjs
✔ create valid multi-item intake with precise weights and actor audit, no payment/stock/event access (30.411568ms)
✔ contracts reject mass assignment, appraised values, malformed/oversized intake and keys (18.112357ms)
✔ semantic invalid phone is rejected before transaction; existing customer gets contact snapshot only (4.786261ms)
✔ all actions deny unauthorized branch before database access (4.152746ms)
✔ actual row branch is scoped even for an authorized route, ADMIN can access other branch (5.093915ms)
✔ STAFF can view but cannot edit/submit/cancel another staff intake; MANAGER can edit (5.009701ms)
✔ DRAFT replace increments version and changes all lines atomically; old version cannot overwrite (6.048688ms)
✔ submission locks editing for all roles; only managers/admin cancel pending appraisal (7.652376ms)
✔ STAFF may cancel own DRAFT and ADMIN may submit branch intake (3.121161ms)
✔ CAS zero count cannot change items or append audit (3.528134ms)
✔ audit failure rolls back header, replaced items, and creation (3.901501ms)
✔ creation retries normalize phone/weights, return same current intake, never append a duplicate audit (1.793022ms)
✔ unique creation race recovers matching key, rejects mismatched body, does not swallow other constraints (1.515273ms)
✔ idempotency recovery is scoped to actor AND branch; same key for another actor creates independent intake (1.27873ms)
✔ query bounds and unknown filters rejected; inclusive date/status/branch filter with stable paginated order (9.705445ms)
✔ detail audit is bounded to 50 versions while stored history remains append-only (57.50314ms)
✔ controller is authenticated, branch-role guarded, no-store and matches generated strict contracts (16.879735ms)
✔ controller validates idempotency header before create or recovery service calls (1.485167ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 219.200113
```

## gateway-unit.log

```text
✔ buyback endpoints use existing backoffice Sales routing, never a public/admin alias (18.730267ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 103.010522
```

## integration-final.log

```text
✔ MIG-01: Task 7.1 DRAFT/PENDING/CANCELLED rows, items and audits survive migration (561.129618ms)
✔ DB-01: multiple items have distinct appraisal revisions and original measurements stay unchanged (1836.572326ms)
✔ DB-02: concurrent appraisers with the same header version have exactly one winner (691.544208ms)
✔ DB-03: stale version cannot append another appraisal, request key or audit (514.503787ms)
✔ DB-04: quote uses exact Decimal buy rate, configured deduction, immutable line snapshots and total (2782.473867ms)
✔ DB-05: policy/market changes between quote and approval preserve the approved snapshot (3497.995207ms)
✔ DB-06: changing appraisal supersedes the old quote; stale snapshot cannot be approved (4134.772694ms)
✔ DB-07: concurrent managers approve once; one approval audit and effective approved quote (1557.175824ms)
✔ DB-08: appraisal edit racing approval cannot approve data that was invalidated (1400.698011ms)
✔ DB-09: STAFF, wrong branch and self-approval including ADMIN are denied without side effects (1147.820169ms)
✔ DB-10: audit failure rolls back quote decision, header version and idempotency request together (1152.264884ms)
✔ DB-11: retry approval after lost response returns original decision without duplicate audit (1750.911187ms)
✔ DB-12: APPROVED only records pricing approval; payment, orders, outbox and stock remain unchanged (1293.531862ms)
✔ DB-13: incomplete/DRAFT/CANCELLED workflows cannot quote or approve; rejection records a reason (1161.8896ms)
✔ DB-14: missing Inventory buy price fails without a partial quote or invalidating existing appraisal (673.033477ms)
✔ DB-15: concurrent ADMIN policy revisions use CAS and retain one audit per version (777.714408ms)
✔ DB-16: PostgreSQL enforces approval uniqueness, immutable headers, FKs and deferred quote totals (2710.938936ms)
✔ DB-17: valid uppercase item/policy/quote UUIDs identify the same records (1409.174068ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29173.912218
```

## integration-negative.log

```text
✔ DB-13: incomplete/DRAFT/CANCELLED workflows cannot quote or approve; rejection records a reason (1545.625263ms)
✖ DB-14: missing Inventory buy price fails without a partial quote or invalidating existing appraisal (419.144069ms)
✔ DB-15: concurrent ADMIN policy revisions use CAS and retain one audit per version (864.488452ms)
✔ DB-16: PostgreSQL enforces approval uniqueness, immutable headers, FKs and deferred quote totals (3964.803083ms)
ℹ tests 4
ℹ suites 0
ℹ pass 3
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7102.534751

✖ failing tests:

test at tests/buyback-appraisal/appraisal.integration.mjs:559:9
✖ DB-14: missing Inventory buy price fails without a partial quote or invalidating existing appraisal (419.144069ms)
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false

  Caught error:

  BusinessError: Dịch vụ tạm thời không sẵn sàng, vui lòng thử lại sau
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async TestContext.<anonymous> (file:///home/hung/trangsuc-microservice/tests/buyback-appraisal/appraisal.integration.mjs:565:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      at async file:///home/hung/trangsuc-microservice/tests/buyback-appraisal/appraisal.integration.mjs:559:3 {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [BusinessError],
    expected: [Function (anonymous)],
    operator: 'rejects',
    diff: 'simple'
  }
```

## integration-price-source-fixed.log

```text
✔ DB-14: missing Inventory buy price fails without a partial quote or invalidating existing appraisal (572.797071ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 621.538679
```

## sales-status.log

```text
Loaded Prisma config from ../../../tmp/jewelry-phase72.kecccagy/sales.config.ts.

Prisma schema loaded from apps/sales/prisma/schema.prisma.
Datasource "db": PostgreSQL database "phase72_test", schema "sales" at "127.0.0.1:55433"

11 migrations found in prisma/migrations

Database schema is up to date!
```

## inventory-status.log

```text
Loaded Prisma config from ../../../tmp/jewelry-phase72.kecccagy/inventory.config.ts.

Prisma schema loaded from apps/inventory/prisma/schema.prisma.
Datasource "db": PostgreSQL database "phase72_test", schema "inventory" at "127.0.0.1:55433"

10 migrations found in prisma/migrations

Database schema is up to date!
```

## Migration, schema và tài nguyên

- Inventory 10 migrations, Sales 11 migrations (đến `20261109140000_buyback_appraisal`) applied; status up to date. Cả 21 checksum SHA-256 trong DB khớp SQL gốc.
- `tests/buyback-appraisal/schema-assertions.sql` chạy thành công: totals/uniques/active quote ownership FK/precision/compatibility; query liệt kê constraints và triggers được lưu ở private schema-final.log.
- Trước cleanup: PostgreSQL healthy, OOM=false, restartCount=0, 44.57 MiB / 384 MiB. RAM available 1971 MiB, swap 783/1024 MiB ở mẫu đo cuối. Không phải peak/soak benchmark.
- SQL fixture Task 7.1 được tạo trước migration 7.2; MIG-01 xác minh trạng thái/trọng lượng/audit cũ giữ nguyên. Không dùng lại DB evidence Phase 6.

## Lỗi và điều chỉnh trong lúc triển khai

- Unit ban đầu phát hiện `.omit()` trên refined Zod object và BigInt refinement chạy trên chuỗi sai cú pháp; đã sửa code mới, giữ validation nghiêm ngặt. Unit cuối 12/12 PASS.
- DB-14 ban đầu FAIL vì HTTP runner nhẹ không đăng ký GlobalExceptionFilter như production; negative log và targeted rerun được giữ ở trên. Không đổi assertion sang chấp nhận lỗi khác. Final integration 18/18 PASS.
- Hai assertion Task 7.1 cũ cố định enum trạng thái được cập nhật cho 7.2: APPROVED là hợp lệ, PAYOUT vẫn không hợp lệ. Regression cuối 18/18 PASS.
- Có một lần unit regression chạy chồng lúc DB còn đang chạy; đã chạy lại regression tuần tự sau DB, log được chọn là lượt chạy lại. Không có fake lock được dùng làm concurrency proof.

## Static checks

Build/generate contracts/Sales/Inventory và typecheck contracts/Sales/Inventory/Gateway PASS. Prisma Sales validate/format/generate PASS. ESLint/Prettier code thay đổi PASS. Generator check Sales/Inventory/Auth/Shop PASS; OpenAPI validator cả bốn spec trả valid=true. Auth/Shop chỉ đồng bộ shared error enum: Auth bổ sung 13 mã đã có trong contracts từ trước cùng 4 mã Task 7.2; Shop thêm 4 mã mới. Không chạy full monorepo tests/build hoặc load test.

## Cleanup và kiểm tra cuối

- HTTP runner và Prisma clients đã đóng bằng finally; các lượt integration đã kết thúc.
- Container `jewelry-phase72-acceptance-postgres-1` đã Stopped bằng Compose stop;
  giữ volume/network/fixtures và logs để điều tra. Không xóa volume hoặc dữ liệu.
- `docker ps` sau cleanup vẫn có `jewelry-postgres-1` và `jewelry-rabbitmq-1` tại
  các cổng chính 5432/5672/15672. Cổng 55433 đã đóng. Không khởi động RabbitMQ test,
  không bật lại DB evidence Phase 6.
- 30 files Task 7.2 đã kiểm tra; không có generated test passwords/private keys hoặc
  build artifacts trong thay đổi. Staging trống, HEAD vẫn 48e469a, branch feat/sales-pos;
  không commit/push/reset/restore hoặc chuyển branch.

## UUID regression trước fix

```text
✖ DB-17: valid uppercase item/policy/quote UUIDs identify the same records (2294.744998ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2381.955455

✖ failing tests:

test at tests/buyback-appraisal/appraisal.integration.mjs:637:9
✖ DB-17: valid uppercase item/policy/quote UUIDs identify the same records (2294.744998ms)
  BusinessError: Cần policy có hiệu lực cho từng món kiểm định
      at BuybackAppraisalService.quoteInputs (/home/hung/trangsuc-microservice/apps/sales/dist/buybacks/buyback-appraisal.service.js:257:23)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async /home/hung/trangsuc-microservice/apps/sales/dist/buybacks/buyback-appraisal.service.js:279:42
      at async Proxy._transactionWithCallback (/home/hung/trangsuc-microservice/node_modules/.pnpm/@prisma+client@7.10.1_prisma@7.10.1_@types+node@24.19.2_@types+react-dom@19.3.0_@types+_f29308a4d7ad013be37d690f9ce8ab9c/node_modules/@prisma/client/runtime/client.js:99:4854)
      at async runWithLockRetry (/home/hung/trangsuc-microservice/libs/common/dist/database/run-with-lock-retry.js:18:20)
      at async BuybackAppraisalService.quote (/home/hung/trangsuc-microservice/apps/sales/dist/buybacks/buyback-appraisal.service.js:274:26)
      at async TestContext.<anonymous> (file:///home/hung/trangsuc-microservice/tests/buyback-appraisal/appraisal.integration.mjs:641:13)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      at async file:///home/hung/trangsuc-microservice/tests/buyback-appraisal/appraisal.integration.mjs:637:3 {
    code: 'BUYBACK_POLICY_REQUIRED',
    httpStatus: 409,
    details: undefined
  }
```

Quote matching trước fix trả BUYBACK_POLICY_REQUIRED cho item UUID viết hoa hợp lệ.
Đã chuẩn hoá item/policy UUID trước matching/hash và quoteId trước so active quote.
Lượt PostgreSQL cuối 18/18 PASS, gồm DB-17. Không nới schema hoặc bỏ assertion.
