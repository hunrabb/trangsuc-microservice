# Phase 6.5B — báo cáo nghiệm thu thực tế

Ngày 2026-11-09, branch `feat/sales-pos`. **Phase 6: PARTIAL, chưa production ready.**
Đã thực sự chạy PostgreSQL/RabbitMQ Docker và Inventory/Sales/Gateway Node; không
chỉ review code. Chưa hoàn thành tất cả acceptance gates. Không triển khai Phase 7–9.
Bằng chứng đã lọc: [phase6-acceptance-evidence.md](phase6-acceptance-evidence.md).

## Môi trường và an toàn

- Kiểm tra `git status --short`, branch và hướng dẫn trước mọi thao tác ghi.
  Có nhiều thay đổi Phase 4–7 chưa commit; không reset/restore/clean/switch/commit/push.
- Project `jewelry-phase6-acceptance`, chỉ dùng `infra/phase6/compose.acceptance.yml`.
  PostgreSQL 16.15: `127.0.0.1:55432/phase6_test`, schema/role Inventory và Sales riêng.
  RabbitMQ 4.4.0-management: AMQP 55672, management 55673, user/key/password test mới.
- Volume thực: `jewelry-phase6-acceptance_phase6_pg`,
  `jewelry-phase6-acceptance_phase6_rabbit`; network acceptance riêng, không external.
  Chỉ mount read-only script init; không mount thư mục dữ liệu môi trường chính.
- Đã xác minh trực tiếp `current_database()=phase6_test`, schema inventory/sales,
  user fixture `inventory_user`, mount, health, port và volume trước migration.
- Project chính `jewelry` có PostgreSQL/RabbitMQ đang chạy ở 5432/5672/15672.
  Không ghi DB, đổi cấu hình, restart/stop hay xoá volume/container chính.
  CLI ban đầu trong sandbox báo permission denied/thiếu Compose; ngoài sandbox
  Compose v5.6.1 hoạt động. Một lần `docker info` timeout 15s; không quy kết OOM.
- Env/private key/log riêng trong `/tmp/jewelry-phase6.oYLXx8`; không đưa credentials
  vào Git. Node v24.22.2 có sẵn qua nvm, login PATH ban đầu thiếu Node/pnpm.
  Backend chạy trực tiếp lần lượt ở 3092/3093/3090, không build toàn monorepo.
- Giới hạn PostgreSQL 384 MiB, RabbitMQ 512 MiB. Ban đầu RAM available 991 MiB,
  swap 1012/1024 MiB; khi chạy đủ backend có mẫu available 433 MiB, swap gần/full.
  Container cuối lượt live healthy, OOM=false, restarts=0; không thấy WSL disconnect.
  Có chủ động stop/start broker, không phải tự restart. Không đo peak liên tục/CPU SLA.

## Migrations thực tế

Inventory đã deploy 10 migration theo thứ tự:

```text
20261106120000_outbox
20261107090000_outbox_next_attempt
20261107150000_inventory_core
20261107170000_inventory_stock_sale
20261107180000_inventory_stock_count
20261108170000_stock_order_operation
20261108230000_inventory_daily_close
20261109100000_public_catalog
20261109110000_online_reservations
20261109120000_paid_reservations
```

Sales đã deploy 9 migration theo thứ tự:

```text
20261106120000_outbox
20261107090000_outbox_next_attempt
20261108150000_sales_pos
20261108180000_pos_customer
20261108210000_pos_recovery_index
20261108220000_pos_report_snapshots
20261109100000_public_catalog
20261109110000_online_checkout
20261109120000_online_payments
```

Automatic approval review từ chối lệnh Sales deploy toàn bộ lịch sử vì có Phase 7.
Đã dùng phương án an toàn được review chỉ ra: bản sao **nguyên byte** 9 migrations
đến Phase 6 trong thư mục tạm, config tạm, không sửa file migrations repository.
`20261109130000_buyback_intake` chưa áp dụng. Status “up to date” của Sales chỉ áp
dụng tập Phase 6 này; không tuyên bố full current-schema/Phase 7 compatibility PASS.
Không còn thao tác bị review chặn cần approval trong phạm vi thực thi đã chọn.

Status sau deploy: Inventory 10 và Sales Phase 6 9 đều up to date; 19 applied checksum
SHA-256 trùng SQL gốc. SQL inspection xác nhận partial unique active item, bank ref/key
uniques, FKs, CHECKs, recovery indexes, DECIMAL(20,2)/nullability. Có kiểm rollback thực;
chưa có ca DML âm cho từng constraint/default. Không sửa migration đã áp dụng, không
`db push`, `reset`, `resolve` hay migration DB dev.

## Kết quả và cách đọc bằng chứng

- PostgreSQL integration: **11/11 PASS**, checkout 6 và payment 5, final rerun sau
  khi tắt application workers; fixture có DB preconditions và assertions sau thao tác.
- Live tests: **12/12 đạt qua các lượt có mục tiêu**: HTTP flow 1, live hậu kiểm 5,
  catalog 4, Gateway security/rate limit 2. Đây không phải 12 browser E2E tests.
- Recovery: **4/4 script stages PASS**: broker offline/recover, consumer prepare/recover.
  Đếm riêng stage, không cộng thành bốn saga độc lập.
- Hai FAIL ban đầu do test mới: stale event version=0 không hợp lệ, và assertion
  dùng enum SENT thay vì PUBLISHED. Giữ cả log FAIL và log targeted rerun PASS.
  Không có backend bug được tái hiện cần sửa; không sửa production code/policy.
- Static contract tests **8/8 PASS**; build tuần tự 5 packages, Prisma generate 2,
  ESLint/Prettier integration scripts PASS. Không rerun toàn bộ unit suite cũ;
  không dùng kết quả unit/static thay bằng chứng integration.

Các tên lệnh dưới đây đều chạy với `env -i`, PATH Node và `--env-file` test mới,
chỉ kết nối acceptance. Mã lệnh rút gọn dùng trong matrix:

| Mã | Lệnh/script và evidence |
| --- | --- |
| DBC | `node tests/online-checkout/reservation.integration.mjs`; checkout-final.log |
| DBP | `node tests/online-payments/payment.integration.mjs`; payment-final.log |
| H | `node tests/phase6/http-flow.integration.mjs`; http.log |
| L | `node tests/phase6/live-verification.integration.mjs`; live-initial.log + stale.log |
| C | `node tests/phase6/catalog-live.integration.mjs`; catalog.log |
| S | `node tests/phase6/http-security.integration.mjs`; http-security.log |
| B | `node tests/phase6/broker-recovery.integration.mjs`, mode offline/recover; broker-*.log |
| R | `node tests/phase6/consumer-recovery.integration.mjs`, mode prepare/recover; consumer-*.log |
| SQL | `psql -v ON_ERROR_STOP=1 < tests/phase6/schema-assertions.sql`; schema-final.log + checksum assertion |
| Q | Management queue metrics và AMQP get+nack/requeue đúng invalid event; broker-diagnostics.log |

### Database/concurrency matrix

Môi trường tất cả dòng DBC/DBP là PostgreSQL Docker thật, handler nội bộ được gọi
trực tiếp; **không phải broker delivery**. DB-05 chưa phải injected network timeout.

| ID | Mục tiêu | Lệnh/evidence | Kết quả | DB assertions | MQ assertions | Fix / giới hạn còn lại |
| --- | --- | --- | --- | --- | --- | --- |
| DB-01 | Hai online tranh một chiếc | DBC ca 1 | PASS | IN_STOCK/no hold ban đầu; cuối ACTIVE=1, FAILED=1, active item=1 | Không dùng broker | Không chứng minh HTTP loser trả 409; thiết kế dùng async failed reservation |
| DB-02 | POS vs online | DBC ca 2 | PASS | SOLD XOR RESERVED, chỉ một bên thắng | Không dùng broker | Không stress/load nhiều vòng |
| DB-03 | Checkout cùng key đồng thời | DBC ca 4; H | PASS | Hai kết quả cùng order; một outbox; Inventory chốt 2.600.000 | H reserve/ack thật | Không chứng minh phân tán nhiều Gateway |
| DB-04 | Hai key trên cùng món | DBC ca 6 | PASS | Hai order, ACTIVE=1, FAILED=1, active item=1 | Outbox handoff trực tiếp | Broker đã có ca checkout riêng |
| DB-05 | Network timeout sau commit | DBC ca 6 | NOT VERIFIED | Mô phỏng bỏ kết quả commit rồi retry: cùng order, một outbox PASS | Không dùng broker | Chưa fault-inject HTTP response loss đúng cửa sổ commit |
| DB-06 | Expiry vs payment | DBP ca 2 | PASS | ACTIVE ban đầu; hết hạn rồi contend; REJECTED, PAYMENT_REVIEW, reconciliation, không SOLD | Ack handler trực tiếp | Chưa orchestration worker/broker tại cùng cửa sổ |
| DB-07 | Hai nhân viên xác nhận receipt | DBP ca 1; H hai MANAGER khác ID; L | PASS | Một payment, một MANUAL_RECEIPT_VERIFIED audit, một order.paid | Paid/result ProcessedEvent thật | Replay alias không cộng tiền |
| DB-08 | Hai đơn dùng bank reference chung | DBP ca 3 | PASS | Hai receipt ban đầu chưa có; một thắng, một PAYMENT_REFERENCE_CONFLICT; loser không payment/audit/alias/outbox | Không dùng broker | Không dùng bank thật |
| DB-09-I | Rollback Inventory giữa transaction | DBC ca 5 | PASS | Hold/outbox đã tạo trong tx rồi throw; sau rollback không hold/item/outbox, item IN_STOCK; retry thành công | Không dùng broker | Fault ở test runner |
| DB-09-S | Rollback payment/idempotency/audit/outbox | DBP ca 5 | PASS | Inject lỗi outbox sau payment/audit; order AWAITING_PAYMENT, activePaymentId=null, payment/alias/audit/outbox=0; retry tạo một receipt | Không dùng broker | Proxy test quanh Prisma transaction; không thêm endpoint lỗi |
| DB-10 | Expiry bảo vệ paid hold | DBP ca 4; L | PASS | PAID_HELD, paymentId đúng, active item=1, JewelryItem RESERVED sau unpaid expiry | L xác minh state live | Chưa paid-hold 3 ngày worker thực |
| SCHEMA-01 | Migration/constraints | SQL | PASS | 19 applied checksums, partial unique/FK/CHECK/index/precision, không duplicate owner/ref | N/A | Chưa DML âm cho từng constraint; Sales chỉ Phase 6 |

### RabbitMQ/distributed matrix

Môi trường là broker Docker acceptance + PostgreSQL + Node backend thật, trừ dòng
được ghi chỉ DB. Mọi failure injection đều có bước khôi phục, không chạm project chính.

| ID | Mục tiêu | Lệnh/evidence | Kết quả | DB assertions | MQ assertions | Fix / giới hạn còn lại |
| --- | --- | --- | --- | --- | --- | --- |
| MQ-TOPO | Topology/kết nối | setup.mjs; Q | PASS | Readiness DB up | 2 exchanges, 16 queues, 27 bindings; app connection | Không import broker chính |
| MQ-01 | Sales order → Inventory giữ hàng | H; L | PASS | Order AWAITING_PAYMENT, đúng total/item; hold ACTIVE rồi PAID_HELD | order.created/stock.reserved/order.paid/result thật | Không browser/bank |
| MQ-02 | Inventory giữ hàng rồi Sales crash trước ghi nhận | Chưa có runner đúng cửa sổ | NOT VERIFIED | Không có state/crash assertion ca này | Chưa inject | SIGTERM restart không thay bằng chứng này |
| MQ-03 | Tạo order lúc broker offline | B offline/recover | PASS | PENDING + một outbox khi offline; sau recover CANCELLED do hết hàng, payment=0 | PENDING → PUBLISHED sau restart | Không hàng nào bị bán lại |
| MQ-04 | Delivery duplicate | L duplicate order.paid | PASS | ProcessedEvent inventory=1, paymentVersion không tăng, refund state không đảo | Publisher confirm hai lần, consumer dedup | Chỉ event đã chọn; không mọi routing key |
| MQ-05 | Consumer crash trước ACK | Chưa có fault hook đúng cửa sổ | NOT VERIFIED | N/A | Chưa crash/ack-loss | Không suy từ duplicate publish |
| MQ-06 | Consumer restart xử lý backlog | R | PASS | Projection bị xoá trước; ProcessedEvent=0 → 1, variant=1, version >= source | Outbox PUBLISHED khi Sales offline; restart consume | Graceful SIGTERM, không hard crash |
| MQ-07 | Verified payment lúc Inventory không phản hồi | Chưa chạy | NOT VERIFIED | Không có state timeout/reconciliation thực cho ca này | Chưa inject Inventory outage | Gate mở |
| MQ-08 | Expired trước payment qua broker | DBP ca 2 chỉ DB | NOT VERIFIED | DB review/reconciliation PASS ở DB-06 | Chưa transport ca riêng | Không tính DB test thành MQ PASS |
| MQ-09 | Late event sau terminal | L duplicate sau REFUND_PENDING | NOT VERIFIED | Duplicate cũ không đảo refund đã PASS | Dedup event cũ đã PASS | Chưa late event có eventId mới qua handler terminal |
| MQ-10 | Retry hết giới hạn | Chưa chạy tier exhaustion | NOT VERIFIED | N/A | Topology có retry 5s/30s/5m | Chưa xác minh NACK/retry exhaustion thực |
| MQ-PERM | Invalid payload vào DLQ | L initial; Q | PASS | Không assert DB riêng cho invalid event | Event 444dfdb0-21d2-409b-b211-d7ab817669d6 trong sales.events.dlq, get rồi requeue giữ bằng chứng | Lỗi fixture version=0; không thay thế MQ-10 |

### Catalog matrix

| ID | Mục tiêu | Lệnh/evidence | Kết quả | DB assertions | MQ assertions | Fix / giới hạn còn lại |
| --- | --- | --- | --- | --- | --- | --- |
| CAT-01 | Publish sản phẩm hợp lệ | H; C ca 1 | PASS | Inventory fixture/source, Sales projection | Outbox → broker → projection → Gateway trả inStock, 2.600.000 | Fixture synthetic |
| CAT-02 | Unpublish/republish | C ca 3 | PASS | Update Inventory thực | Snapshot tombstone: Gateway 404 rồi 200 | Không browser |
| CAT-03 | Đổi giá | C ca 2 | PASS | sellPrice 2.000.000 → 2.100.000; khôi phục sau test | Gateway estimatedPrice 2.725.000 | Không client tính giá |
| CAT-04 | Đổi tồn | C ca 1/4 | PASS | Tạo chiếc PH6CAT mới; xoá đúng chiếc khi không có reference | inStock true → false | Giữ fixture chính phục vụ điều tra |
| CAT-05 | Reserved/sold projection | H; C ca 4 | NOT VERIFIED | Reserved chính giữ đúng, public hết hàng PASS | Reserved không còn stock | Chưa test SOLD → projection riêng |
| CAT-06 | Duplicate catalog snapshot | Chưa ca riêng | NOT VERIFIED | Stale version gate đã kiểm | Duplicate order.paid không thay catalog duplicate | Gate mở |
| CAT-07 | Event sai thứ tự/version | L stale targeted rerun | PASS | ProcessedEvent=1; name/version mới không bị ghi đè | Publish snapshot version lịch sử hợp lệ | Initial version=0 là lỗi test, đã sửa |
| CAT-08 | Consumer restart | R | PASS | Projection rebuild/version/variant đúng | Backlog được consume | Không crash trước ACK |
| CAT-09 | Broker offline riêng catalog | B chỉ order + broker | NOT VERIFIED | Chưa assert riêng catalog event trong outage | Generic reconnect PASS | Không suy rộng B |
| CAT-10 | Backfill khi thiếu snapshot | R | PASS | Xoá đúng fixture projection; source giữ nguyên; projection được dựng lại | Inventory publisher thật phát outbox, Sales consume | Test nội bộ, không public backfill API |

### Gateway HTTP và payment matrix

Tất cả H/L/C/S đi qua `http://127.0.0.1:3090`; không bypass Gateway cho public behavior.
JWT test-key riêng kiểm role/branch; chưa test đăng nhập nhân viên qua Auth thật.

| ID | Mục tiêu | Lệnh/evidence | Kết quả | DB assertions | MQ assertions | Giới hạn |
| --- | --- | --- | --- | --- | --- | --- |
| HTTP-01 | Public catalog GET | H/C | PASS | Projection thật | Snapshot thật | Một fixture |
| HTTP-02 | Filters | L | PASS | Catalog source có fixture | N/A | Giá/metal/search/page kết hợp trả rỗng; chưa toàn bộ tổ hợp/sort |
| HTTP-03 | Product detail | H/C | PASS | Variant/giá đúng | Projection thật | Không browser |
| HTTP-04 | Valid checkout | H/L | PASS | Một order/hold đúng | Saga thật | Không fulfilment |
| HTTP-05 | Out of stock | L | PASS | CANCELLED, FAILED hold, reservationItem=0, payment=0 | reserve_failed thật | API async trả 202 trước kết quả |
| HTTP-06 | Duplicate checkout key | H/L | PASS | Cùng order ID, một receipt/owner cuối | Saga thật | Một Gateway |
| HTTP-07 | Guest tracking | H/L | PASS | Order/private view đúng, no-store | Ack thật | Capability còn giới hạn TTL/revoke đã ghi ở 6.5A |
| HTTP-08 | Token sai | H/L | PASS | Không lộ order | N/A | 404 |
| HTTP-09 | Guest khác truy cập | L | PASS | Capability khác bị 404 | N/A | Không browser storage test |
| HTTP-10 | Rate limiting | S | PASS | N/A | N/A | 119 GET được chấp nhận trước 429 trong budget hiện tại; single-process memory limiter |
| HTTP-11 | Internal endpoint không public | H/S | PASS | Không tạo dữ liệu | N/A | Bốn route/encoding được thử; không full pentest |
| HTTP-12 | Role hợp lệ confirm | H/L | PASS | Hai MANAGER cùng branch, một payment/audit | Paid ack thật | ADMIN đã auth private product GET; chưa ADMIN confirm riêng |
| HTTP-13 | STAFF bị từ chối | H | PASS | Trước confirm receipt thật; cuối chỉ một valid audit | N/A | 403 |
| HTTP-14 | MANAGER khác branch bị từ chối | H | PASS | Không thêm receipt cuối | N/A | 403 |
| HTTP-15 | MANAGER đúng branch | H | PASS | Một receipt đúng amount/currency | Inventory PAID_HELD → CONFIRMED | Synthetic evidenceRef, không bank thật |
| HTTP-16 | Retry backend timeout | Chưa injected response/timeout | NOT VERIFIED | DB-05 simulated retry PASS | N/A | Chưa HTTP timeout đúng cửa sổ |
| PAY-REFUND | Refund request chỉ pending | H/L | PASS | Order/payment REFUND_PENDING; audit có; item RESERVED | Duplicate paid không đảo refund | Chưa hoàn tiền thực |
| PAY-MISMATCH | Sai amount/currency live | Chưa ca riêng | NOT VERIFIED | Schema/check tồn tại | N/A | Unit/static không thay HTTP negative tests |
| OBS-01 | Correlation + structured/redacted logs | L | PASS | N/A | Các event log có correlation theo thiết kế | Correlation ID Gateway/Sales trùng; Authorization/Cookie/token không trong captured request logs; không chứng minh mọi error path |
| OBS-02 | Resource stability phiên nhỏ | Docker health/stats | PASS | PostgreSQL ready | RabbitMQ ready | Mẫu đo, không stress/soak/peak RAM |

### Browser, load và product gates

| ID | Mục tiêu | Kết quả | Evidence / bước tiếp |
| --- | --- | --- | --- |
| BR-01 | Home | NOT VERIFIED | Không bật Storefront/browser; dùng checklist runbook |
| BR-02 | Catalog/detail | NOT VERIFIED | HTTP PASS không thay visual/browser |
| BR-03 | Cart/reload/storage | NOT VERIFIED | Chưa thao tác browser |
| BR-04 | Checkout/double-submit | NOT VERIFIED | HTTP concurrent key PASS; chưa double-click browser |
| BR-05 | Pending payment/tracking | NOT VERIFIED | Chưa browser |
| BR-06 | Loading/error/empty | NOT VERIFIED | Chưa browser |
| BR-07 | Mobile/responsive | NOT VERIFIED | Chưa Chrome mobile viewport |
| BR-08 | Guest token/PII trong browser | NOT VERIFIED | Runtime server logs đã kiểm; chưa URL/history/storage/clipboard |
| LOAD-01 | 200 đơn/20 chiếc | NOT VERIFIED | Không chạy load trên máy RAM/swap hạn chế |
| PRODUCT-01 | Provider/webhook | NOT VERIFIED | Chưa triển khai; manual receipt không thay provider |
| PRODUCT-02 | Bank account/QR/receipt khách | NOT VERIFIED | Chưa có API/hướng dẫn có thẩm quyền; không chế dữ liệu bank |
| PRODUCT-03 | Customer account | NOT VERIFIED | Guest capability không thay account/login |
| PRODUCT-04 | Fulfilment/refund thực | NOT VERIFIED | CONFIRMED/REFUND_PENDING không thay PACKING/SHIPPING/COMPLETED/REFUNDED |

## Lỗi, thay đổi và handoff

Không phát hiện lỗi backend Phase 6 có bằng chứng cần sửa trong các ca đã chạy.
Hai lỗi test harness mới đã được tái hiện, sửa tối thiểu và targeted rerun PASS:
version=0 → version lịch sử dương, thêm payload validation trước publish; enum
SENT → PUBLISHED. Không sửa test để chấp nhận sai trạng thái nghiệp vụ; giữ log đỏ.
Không thay POS/Inventory/Report production code nên không rerun full Phase 4/5 suites;
POS contention đã chạy trực tiếp trên PostgreSQL.

File của phiên này:

- `tests/online-checkout/reservation.integration.mjs`: DB preconditions, rollback,
  lost-result retry và different-key protection.
- `tests/online-payments/payment.integration.mjs`: DB preconditions, bank-reference
  contention, paid-hold protection, receipt/audit/key/outbox rollback.
- `tests/phase6/live-verification.integration.mjs`: hậu kiểm DB, duplicate/stale events,
  out-of-stock, privacy/correlation logs.
- `tests/phase6/catalog-live.integration.mjs`: Inventory updates → public catalog thật.
- `tests/phase6/broker-recovery.integration.mjs`: offline/recover stages.
- `tests/phase6/consumer-recovery.integration.mjs`: restart/backfill stages.
- `tests/phase6/http-security.integration.mjs`: internal routes và rate limit.
- `tests/phase6/schema-assertions.sql`: guard test DB, schema/invariant inspection.
- `docs/phase6-acceptance-report.md`, `docs/phase6-acceptance-evidence.md`,
  `docs/phase6-progress.md`, `docs/phase6-acceptance-runbook.md`.

Đã dừng đúng PID Node test sau khi kiểm `/proc/PID/cmdline`. Đã dùng Compose **stop**
riêng acceptance; giữ container/network/volumes test và log phục vụ điều tra. Không
purge queue hoặc xoá volume. DLQ giữ invalid fixture; Report queue giữ sự kiện chưa
consume vì không chạy Report. Không bật workers lại rồi tái sử dụng fixture cũ một
cách mù quáng; runbook có hướng dẫn scoped cleanup/runner mới. Private access/key/env
trong `/tmp` chỉ là bằng chứng local, có thể mất sau reboot; không upload công khai.

Trước production cần hoàn tất các dòng NOT VERIFIED bắt buộc trên runner đủ RAM,
đặc biệt crash/ACK-loss, payment outage, retry exhaustion, HTTP timeout và browser;
chốt provider/bank/account/fulfilment/refund hoặc phạm vi nghiệm thu được chủ dự án
chấp thuận rõ. Chưa đủ điều kiện Phase 6 DONE hoặc production ready.
