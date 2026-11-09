# Phase 6 — Runbook nghiệm thu 6.5B

**6.5B đã thực thi một phần ngày 2026-11-09** theo yêu cầu riêng của người dùng.
Xem [báo cáo/matrix](phase6-acceptance-report.md) và [bằng chứng](phase6-acceptance-evidence.md).
DB 11/11, live cases 12/12 qua targeted runs, 4 recovery stages PASS; browser và các
gate fault injection nâng cao vẫn NOT VERIFIED. Phase 6 PARTIAL, chưa production ready.

Các hướng dẫn dưới đây được chuẩn bị trong 6.5A; phần nào ghi “chưa chạy/không chạy
trong 6.5A” là lịch sử của 6.5A. Chỉ thực thi trên môi trường isolated có đủ tài nguyên.
Không chạy lại fixture cố định trên DB đã chứa fixture hoặc dùng credentials mới với
volume đã khởi tạo bằng credentials cũ. Phiên vừa chạy đã dừng containers và giữ dữ liệu.
Không có script nào tự bật full stack, migrate/reset database hoặc xoá volume.

Kết quả 6.5A và acceptance matrix nằm trong [phase6-progress.md](phase6-progress.md).
Giữ nguyên dữ liệu development/production, khoá đăng nhập và lịch sử migrations.

## 1. Phạm vi, thứ tự và tài nguyên

Tách thành ba lượt, không cần toàn bộ Compose của repo:

1. PostgreSQL test + Node runner: chạy hai integration script DB hiện có, tuần tự.
2. PostgreSQL + RabbitMQ test + Inventory/Sales/Gateway: HTTP, outbox, consumer,
   receipt, expiry, duplicate và crash/recovery. Auth/Report/Backoffice không cần
   khởi động cho các ca này; dùng cặp JWT test riêng. Đây không phải test đăng nhập
   nhân viên thật. Queue Report trên broker test có thể giữ thư chờ, không purge.
3. Giữ hạ tầng cần thiết, mở riêng Storefront; nghiệm thu bằng Chrome và mobile.

Config độc lập: `infra/phase6/compose.acceptance.yml`, project
`jewelry-phase6-acceptance`, PostgreSQL `127.0.0.1:55432`, AMQP `:55672`, management
`:55673`, volume `phase6_pg`/`phase6_rabbit` riêng theo project. Không dùng file Compose
chính/override hay `.env` development. Broker test là **instance riêng**, vhost `/`
trên instance test không phải vhost development.

Giới hạn container khai báo 384 MiB PostgreSQL / 512 MiB RabbitMQ; **chưa đo** và
không cam kết vừa RAM WSL hiện tại. Consumer cố định prefetch=10 và reserve pool=5:
**DATABASE_POOL_MAX tối thiểu 15** cho Inventory/Sales; không hạ xuống 2 để ép RAM.
Outbox batch mặc định 100, chưa có biến môi trường để tuỳ chỉnh các hằng này.
Nếu OOM, dừng ca và chuyển máy/CI phù hợp, không khởi động lại toàn bộ hệ thống.
Ca 200 đơn/20 chiếc để cuối cùng, chạy trên runner đủ tài nguyên, không thuộc 6.5A.

## 2. Tạo cấu hình test riêng (chỉ trong phiên 6.5B)

Từ root repo, Node/pnpm theo `.nvmrc`/packageManager. Thư mục mới giữ private key,
password, token và log test; không đưa vào Git/artifact công khai. Không đọc `.env`
hoặc private key hiện có. Khối này chỉ sinh file trong thư mục tạm mới.

```bash
export PHASE6_DIR="$(mktemp -d /tmp/jewelry-phase6.XXXXXX)"
chmod 700 "$PHASE6_DIR"
node --input-type=module <<'NODE'
import {randomBytes, generateKeyPairSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.PHASE6_DIR;
if(!dir?.startsWith('/tmp/jewelry-phase6.')) throw new Error('Use the new test directory');
const passwords=Object.fromEntries(['POSTGRES','AUTH','INVENTORY','SALES','REPORT','RABBIT_ADMIN','RABBIT_APP'].map(k=>[k,randomBytes(24).toString('hex')]));
const write=(name,values)=>writeFileSync(join(dir,name),Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
writeFileSync(join(dir,'public.pem'),keys.publicKey,{mode:0o600,flag:'wx'});
writeFileSync(join(dir,'private.pem'),keys.privateKey,{mode:0o600,flag:'wx'});
const db=s=>`postgresql://${s}_user:${passwords[s.toUpperCase()]}@127.0.0.1:55432/phase6_test?schema=${s}`;
const rabbit=`amqp://phase6_app:${passwords.RABBIT_APP}@127.0.0.1:55672/%2F`;
const common={NODE_ENV:'test',DATABASE_POOL_MAX:'15',RABBITMQ_URL:rabbit,JWT_PUBLIC_KEY_PATH:join(dir,'public.pem'),JWT_ISSUER:'phase6-acceptance',JWT_AUDIENCE_BACKOFFICE:'phase6-backoffice',JWT_AUDIENCE_SHOP:'phase6-shop'};
write('infra.env',Object.fromEntries(Object.entries(passwords).map(([k,v])=>[`PHASE6_TEST_${k}_PASSWORD`,v])));
write('inventory.env',{...common,PORT:'3092',DATABASE_URL:db('inventory')});
write('sales.env',{...common,PORT:'3093',DATABASE_URL:db('sales'),INVENTORY_URL:'http://127.0.0.1:3092'});
write('gateway.env',{...common,PORT:'3090',AUTH_URL:'http://127.0.0.1:3091',INVENTORY_URL:'http://127.0.0.1:3092',SALES_URL:'http://127.0.0.1:3093',REPORT_URL:'http://127.0.0.1:3094',TRUSTED_PROXIES:''});
write('tests.env',{PHASE6_TEST_EXECUTE:'I_ACKNOWLEDGE_ISOLATED_PHASE6_TEST',PHASE6_TEST_INVENTORY_URL:db('inventory'),PHASE6_TEST_SALES_URL:db('sales'),PHASE6_TEST_RABBITMQ_URL:rabbit,PHASE6_TEST_GATEWAY_URL:'http://127.0.0.1:3090',PHASE6_TEST_PRIVATE_KEY_PATH:join(dir,'private.pem'),ONLINE_TEST_INVENTORY_URL:db('inventory'),ONLINE_TEST_SALES_URL:db('sales'),PAYMENT_TEST_INVENTORY_URL:db('inventory'),PAYMENT_TEST_SALES_URL:db('sales'),PHASE6_TEST_INVENTORY_PSQL_URL:db('inventory').split('?')[0]});
write('broker-setup.env',{RABBITMQ_MANAGEMENT_URL:'http://127.0.0.1:55673',RABBITMQ_ADMIN_USER:'phase6_admin',RABBITMQ_ADMIN_PASSWORD:passwords.RABBIT_ADMIN,RABBITMQ_APP_USER:'phase6_app',RABBITMQ_APP_PASSWORD:passwords.RABBIT_APP});
console.log('Created private test configuration in',dir);
NODE
```

Không dùng `set -x`, không `cat` các file này vào log. Khởi động tiến trình bằng
`env -i` bên dưới để biến môi trường development đang export không lấn test config.
Các env URL bắt buộc, không có fallback về DB dev. Guard của script mới ép đúng
DB `phase6_test`, user/schema service, loopback và cổng test; HTTP chỉ cổng 3090.
Các script DB cũ chỉ kiểm tên DB có thành phần `test` và schema: dùng chính env test
đã tạo ở đây, không truyền URL tuỳ ý. Không chạy hai script DB cùng lúc.

## 3. PostgreSQL và migration readiness

**Chỉ sau khi chuyển sang phiên 6.5B được cho phép:**

```bash
docker compose --env-file "$PHASE6_DIR/infra.env" -f infra/phase6/compose.acceptance.yml up -d --wait postgres
pnpm --filter @jewelry/contracts build
pnpm --filter @jewelry/common build
pnpm --filter @jewelry/inventory db:generate
pnpm --filter @jewelry/sales db:generate
```

Chạy theo thứ tự service, Prisma tự áp dụng toàn bộ lịch sử tăng dần trong từng
thư mục, bao gồm Phase 4/5 tiên quyết; không chỉ chạy sáu SQL mới bằng tay:

```bash
(
  cd apps/inventory
  env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/inventory.env" node_modules/prisma/build/index.js migrate status
  env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/inventory.env" node_modules/prisma/build/index.js migrate deploy
)
(
  cd apps/sales
  env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/sales.env" node_modules/prisma/build/index.js migrate status
  env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/sales.env" node_modules/prisma/build/index.js migrate deploy
)
pnpm --filter @jewelry/inventory build
pnpm --filter @jewelry/sales build
pnpm --filter @jewelry/gateway build
```

`migrate status` có thể trả nonzero khi pending: đọc kết quả trước deploy, dừng nếu
có failed/checksum drift. Không `migrate reset`, `db push`, `resolve --applied` hoặc
sửa migration đã áp dụng. Sau deploy chạy lại status từng service và lưu bằng chứng.

| Thứ tự Phase 6 mỗi service | Inventory | Sales |
| --- | --- | --- |
| 6.1 — 20261109100000 | Product publish/image/version, Warehouse online=false, OnlineStockBuffer | CatalogProduct/Variant/Availability, FK Variant→Product, stock>=0 |
| 6.2 — 20261109110000 | Reservation/orderId unique; active fields CHECK; partial unique active item; FK vật lý | OnlineOrder token-hash/key unique; recovery index; item/order+physical ID unique, price>=0 |
| 6.3 — 20261109120000 | Enum PAID_HELD; payment identity/outcome/version; paid-fields CHECK | Enum payment states; OnlinePayment bank ref and actor/key unique; alias key unique; request/payment + payment/order FKs; payment amount>0/VND |

Readiness review 6.5A: publish/online mặc định false giữ an toàn dữ liệu cũ;
requestedItems/PII chỉ nằm bảng online mới; paymentAttempts mặc định 0; nullable
snapshot/payment ID không ép backfill giả; no cross-service FK. `activePaymentId`,
warehouseId/branchId và reference nghiệp vụ liên service kiểm trong code, không có
FK xuyên service. `OnlinePaymentAudit.paymentId` cũng là reference logic, không FK.
Enum PAID_HELD trong CHECK dùng cast text; không dùng enum value mới trong DML ở
cùng migration. **SQL apply/constraints/lock thực vẫn NOT VERIFIED** cho đến bước này.
Không chỉnh sáu migration cũ trong 6.5A, chưa xác nhận checksum ở môi trường khác.

## 4. Lượt DB-only — tái sử dụng test hiện có

Chưa bật broker hoặc application workers. Tránh worker hút OutboxEvent trong khi
script DB đang đọc/chuyển payload trực tiếp.

```bash
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/tests.env" tests/online-checkout/reservation.integration.mjs
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/tests.env" tests/online-payments/payment.integration.mjs
```

Đã có 4 ca checkout và 2 ca payment. Ca trùng key/ref, giữ hàng, POS-vs-online,
release-before-create, SOLD safeguard, expiry, paid callback/refund contention đều
assert DB cuối. Đây là PostgreSQL integration **không phải RabbitMQ integration**:
handler được gọi trực tiếp. Exit 2 là thiếu môi trường, không phải PASS/skipped đạt.
Script tự dọn theo UUID riêng khi fixture đã tạo thành công; lỗi giữa lúc setup
có thể để lại fixture. Nếu FAIL, giữ dữ liệu và điều tra, không xoá bảng/volume để
chạy lặp cho xanh. Không chạy các suite Phase 4/5 thay cho hai script này.

## 5. Lượt HTTP + RabbitMQ thật

```bash
docker compose --env-file "$PHASE6_DIR/infra.env" -f infra/phase6/compose.acceptance.yml up -d --wait rabbitmq
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/broker-setup.env" infra/rabbitmq/setup.mjs
```

Chỉ script setup test nhận credentials test trên cổng 55673. Topology lấy nguyên
`definitions.json`: product.snapshot/stock.availability_changed → sales.events;
order.created/cancelled/paid → inventory.events; stock.reserved/failed/expired và
stock.payment_result → sales.events; retry tiers 5s/30s/5m và DLQ. Không import vào
broker 5672/15672, không purge queue. Chưa cần Report consumer cho ca online.

Fixture mới, không overwrite, chỉ chấp nhận phase6_test/inventory_user:

```bash
node --env-file="$PHASE6_DIR/tests.env" --input-type=module <<'NODE'
import {spawnSync} from 'node:child_process';
import {requireAcknowledgement,databaseUrl} from './tests/phase6/test-environment.mjs';
requireAcknowledgement();databaseUrl(process.env.PHASE6_TEST_INVENTORY_URL,'inventory');
const result=spawnSync('psql',[process.env.PHASE6_TEST_INVENTORY_PSQL_URL,'-v','ON_ERROR_STOP=1','-f','tests/phase6/fixture.sql'],{stdio:'inherit'});
process.exit(result.status??1);
NODE
```

Fixture là mẫu/biến thể/chiếc duy nhất PH6ACCEPT; 1,25 chỉ × 2.000.000 + 100.000 =
2.600.000 VND theo hàm Inventory. Danh tính cố định nằm `test-environment.mjs` và SQL.
Đã tồn tại fixture thì dừng, không UPSERT/reset. Dữ liệu synthetic, không tiền thật.

Mở ba terminal hoặc quản lý ba PID cụ thể (không pkill/killall Node):

```bash
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/inventory.env" apps/inventory/dist/main.js >"$PHASE6_DIR/inventory.log" 2>&1 &
export PHASE6_INVENTORY_PID=$!
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/sales.env" apps/sales/dist/main.js >"$PHASE6_DIR/sales.log" 2>&1 &
export PHASE6_SALES_PID=$!
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/gateway.env" apps/gateway/dist/main.js >"$PHASE6_DIR/gateway.log" 2>&1 &
export PHASE6_GATEWAY_PID=$!
```

Nest bootstrap hiện bind 0.0.0.0:3090/3092/3093; chạy trên runner có network isolation/
firewall, không mở cổng này cho mạng công khai. Không sửa bootstrap/Auth để phục vụ test.
Kiểm tra GET health ở cổng service trực tiếp và Catalog qua Gateway; **health không
đi qua Gateway**. Chờ publisher/consumer cập nhật, không mock sản phẩm để bỏ qua:

```bash
curl --fail http://127.0.0.1:3092/health/ready
curl --fail http://127.0.0.1:3093/health/ready
curl --fail http://127.0.0.1:3090/api/shop/products/65000000-0000-4000-8000-000000000003
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/tests.env" tests/phase6/http-flow.integration.mjs
```

Script mới không tự boot/migrate/cleanup. Kiểm tra auth test-key trước checkout,
Catalog thực → hai POST cùng token/key → by-key → Inventory reservation thực →
role/branch receipt → hai MANAGER/actor khác nhau confirm cùng ref và replay actor đầu → Inventory PAID_HELD → CONFIRMED →
cấm guest cancel sau nhận tiền → REFUND_PENDING. Poll có timeout 90 giây; không
retry POST mù quáng. Token/key lưu file riêng mode 0600 trong `/tmp/phase6-access-*`,
chỉ in đường dẫn file, order/payment ID; không in token/header/key ngân hàng thật.
Không upload private file hoặc log chứa thông tin test-key vào artifact công khai.

Kết quả HTTP script là một ca flow tổng hợp, **không chứng minh browser hoặc ngân
hàng thật**. Có thể dùng file quyền tra cứu để nhập thủ công ở trang đơn Storefront.
Fixture và đơn được giữ để nghiệm thu browser/đối chiếu; không tự xoá dữ liệu cuối ca.

## 6. Scenario matrix và tiêu chí DB cuối

| Ca | Cách chạy ở 6.5B | Assertion bắt buộc |
| --- | --- | --- |
| 1 Catalog sync | Fixture + publisher tick + HTTP flow; đổi publish/giá từ API ADMIN hoặc Inventory test, đợi version mới | Sales không giá vốn/PII; stock version khớp; unpublish biến mất; event cũ không hồi sinh mẫu |
| 2 Checkout/reserve | HTTP flow thực | Một OnlineOrder + order.created; một active hold/chiếc; tổng = snapshot Inventory |
| 3 Hai khách một chiếc (A) | Ca 1 script reservation.integration | Chính xác một ACTIVE, một FAILED; không hai active item |
| 4 POS tranh Online (B) | Ca 2 script reservation.integration | SOLD XOR RESERVED; bên thua không trừ/giữ chiếc |
| 5 Expiry | Ca 3 script reservation.integration; live chờ TTL/worker trên fixture mới | ACTIVE→EXPIRED, item IN_STOCK, Sales CANCELLED; không nhả SOLD/PAID_HELD |
| 6 Manual receipt (D) | HTTP flow với hai MANAGER/actor khác nhau, cùng bankTxnRef | Một receipt/event thu tiền; alias keys trỏ cùng payment; code 403 sai role/branch |
| 7 Duplicate receipt | Ca 1 payment.integration và HTTP flow | Unique bank ref, actor/key, payment alias; key khác body 422, ref khác order 409 |
| 8 Payment/expiry race (E/G) | Ca 2 payment.integration; chạy cả thứ tự expiry thắng/payment thắng trên fixture mới | Tiền đã nhận luôn có row; review/refund khi mất hold; không tự tìm chiếc thay thế, không nhả paid hold |
| 9 Rabbit duplicate (F) | redeliver script bên dưới; lặp original eventId và kiểm DB | ProcessedEvent một row/consumer/event; hold/receipt không đổi, outbox kết quả không nhân nghiệp vụ |
| 10 Crash/recovery | Kill đúng PID Sales sau commit POST/receipt; restart với cùng env; GET by-key/token cũ, chờ worker | Một order/payment; outbox resend, paid retry cùng paymentId; timeout không bị coi là chưa nhận tiền |
| 11 Reconcile/refund | HTTP flow và ca callback/refund script payment.integration | REFUND_PENDING không hồi CONFIRMED do ack muộn; hàng đã nhận tiền không tự release; audit đầy đủ |
| 12 Storefront→Gateway | Checklist Chrome bên dưới trên live fixture mới | Request qua proxy Gateway; giá request không do client; trạng thái từ server, không UI tự PAID |

Bổ sung C — hai POST cùng idempotency key: DB-only ca 4 + HTTP flow. Key cùng token
khác body phải 422; token khác không xem/by-key/huỷ được đơn cũ. HTTP flow chuẩn bị
hai actor MANAGER khác nhau và một replay actor đầu; trước runtime vẫn NOT VERIFIED.

Chọn event fixture từ OutboxEvent trong DB test (product.snapshot hoặc order.*).
Không dùng event ID hoặc payload từ dev. Sau đó mới thực hiện:

```bash
PHASE6_TEST_EVENT_SERVICE=inventory PHASE6_TEST_EVENT_ID='<UUID outbox fixture>' PHASE6_TEST_AGGREGATE_ID='65000000-0000-4000-8000-000000000003' \
  node --env-file="$PHASE6_DIR/tests.env" tests/phase6/redeliver.integration.mjs
```

Script chỉ đọc outbox đã chọn, kiểm aggregate ID, publish nguyên eventId hai lần
bằng publisher confirm/mandatory vào broker test. **CONFIRMED publication không phải
PASS business dedup**; sau đó phải đếm ProcessedEvent/rows vật lý. Duplicate publish
cũng không thay thế fault injection “DB commit nhưng chưa ack”. Ca redelivery thật
cần dừng consumer đúng cửa sổ rồi restart; nếu không kiểm soát được cửa sổ, ghi
NOT VERIFIED, không kết luận ngẫu nhiên từ một lần kill.

Dùng psql trên kết nối **service tương ứng** (URL psql bỏ `?schema=...`) để lưu bằng
chứng, ví dụ sau flow với `:order_id`/`:event_id` lấy từ output không chứa token:

```sql
-- Inventory connection
SELECT id,status,"expiresAt","paymentId","paymentOutcome","paymentVersion"
 FROM inventory."StockReservation" WHERE "orderId" = :'order_id'::uuid;
SELECT "jewelryItemId",count(*) FROM inventory."StockReservationItem"
 WHERE "isActive" GROUP BY "jewelryItemId" HAVING count(*)>1; -- phải 0
SELECT status FROM inventory."JewelryItem"
 WHERE id='65000000-0000-4000-8000-000000000007'; -- RESERVED sau paid/refund request
SELECT count(*) FROM inventory."ProcessedEvent" WHERE "eventId"=:'event_id'::uuid;
-- Sales connection
SELECT id,status,total,"activePaymentId","needsReview" FROM sales."OnlineOrder" WHERE id=:'order_id'::uuid;
SELECT id,status,amount,"inventoryVersion" FROM sales."OnlinePayment" WHERE "orderId"=:'order_id'::uuid;
SELECT action,"fromStatus","toStatus" FROM sales."OnlinePaymentAudit" WHERE "orderId"=:'order_id'::uuid ORDER BY "createdAt";
SELECT count(*) FROM sales."ProcessedEvent" WHERE "eventId"=:'event_id'::uuid;
```

Crash case cần lưu access file trước POST; tạo fixture mới cho từng nhánh không
thể hoàn nguyên. Dùng `kill -TERM "$PHASE6_SALES_PID"`, chỉ khi PID đúng tiến trình
test đã ghi; restart đúng lệnh/env ở trên. SIGTERM không chứng minh crash đột ngột;
ca hard crash/ack-loss cần orchestration/fault hook riêng trên runner 6.5B, không
thêm backdoor fault endpoint vào production. Rabbit retry 5s/30s/5m có thể mất hơn
90 giây: tách ca recovery khỏi HTTP flow và ghi mốc thời gian, DLQ theo correlationId.

200 đơn/20 chiếc: chưa có load runner Phase 6 tự động. Chuẩn bị fixture 20 chiếc,
200 token/key độc lập, assert đúng 20 hold, 180 thất bại và partial unique không
vi phạm. Chạy qua service/consumer có kiểm soát, không tắt Gateway rate limit để
bắn 200 request cùng một IP rồi gọi 429 là “hết hàng”. Đây vẫn là gate NOT VERIFIED.

## 7. Browser acceptance (không chạy trong 6.5A)

Vite hiện proxy `/api` về cổng 3000. Cho phiên test dùng cổng 3090 **mà không sửa
config production** bằng config tạm nằm trong thư mục app (không commit):

```bash
node --input-type=module <<'NODE'
import {writeFileSync} from 'node:fs';
writeFileSync('apps/storefront/vite.phase6.local.mjs', `import {mergeConfig} from 'vite';
import base from './vite.config.ts';
export default mergeConfig(base,{server:{proxy:{'/api':'http://127.0.0.1:3090'}}});
`, {flag:'wx'});
NODE
pnpm --filter @jewelry/storefront dev --config vite.phase6.local.mjs
```

Chỉ tạo file nếu chưa tồn tại, không ghi đè thay đổi của người khác; nếu có sẵn,
đọc trước hoặc chọn tên tạm khác. Xoá **chỉ file tạm do phiên test vừa tạo** khi xong.
Không sửa Gateway/production route để phục vụ browser test. Mở `localhost:5174`.
Không tự chạy server/browser từ Task 6.5A. Ghi rõ tên Chrome/OS/viewport/ngày/người
kiểm tra và ảnh chụp không chứa token/PII/keys thật.

| Viewport / thiết bị | Checklist |
| --- | --- |
| Chrome desktop 1440×900, 1280×800 | Home, Catalog ảnh thật/placeholder, search/filter/sort/page, Back/Forward giữ URL, detail/variant đúng giá |
| Tablet 768×1024 | Grid/sidebar, form không chồng, giỏ và summary, menu/nút dễ bấm |
| Mobile 390×844, 360×800 | Menu mở/đóng/Escape, không tràn ngang, input không zoom, vùng bấm, thông báo giỏ không che CTA |
| Bàn phím và zoom 200% | Skip link, Tab/focus, radio/quantity/form labels, lỗi focus đúng trường, filter/pagination focus vùng kết quả |
| Cart | Add/update/remove, refresh, storage blocked, unpublish/hết hàng chặn checkout, không POST reservation lúc thêm giỏ |
| Checkout | Sai phone/address/email, double click, timeout/offline/reload; cùng token/key/body, GET by-key trước retry, chưa rõ không tạo đơn mới |
| Payment/tracking | PENDING→AWAITING_PAYMENT, TTL 0 chưa tự huỷ, PAYMENT_PROCESSING/review/refund/confirmed đúng backend; không QR/bank giả hoặc tự PAID |
| Quyền riêng tư | Sai token/order 404, token không URL/Network query/log; sessionStorage giới hạn; sửa token nhập sai; clipboard blocked có lưu riêng; hết hạn ẩn dữ liệu |
| Trạng thái lỗi | API 404/429/503, ảnh lỗi, Catalog rỗng, polling dừng hợp lý và có retry, terminal không spin vô hạn |

Ni/trọng lượng, danh mục đầy đủ, bank instructions/QR và receipt upload chỉ được
nghiệm thu nếu backend cung cấp dữ liệu có thẩm quyền. Hiện các mục đó thiếu,
không tạo mock/ảnh sản phẩm ngẫu nhiên để chụp ảnh nghiệm thu.

## 8. Kết thúc và điều kiện DONE

- Lưu migration status, test count/exit code, DB assertions, thời gian event/recovery,
  role/branch checks, bản ghi browser QA và lỗi còn mở. Không đưa private access,
  secrets/test signing key vào Git hoặc log công khai.
- Dừng đúng ba PID test và Storefront do phiên này tạo, rồi `docker compose ... stop`
  với **đúng file/project test**. Không `down -v`, prune, purge hoặc xoá dữ liệu dev.
- Các script DB cũ tự cleanup theo UUID. Fixture live cố ý giữ để browser/forensics;
  trước khi tái sử dụng phải dừng workers, rà owned order/reservation/payment/outbox/
  ProcessedEvent/catalog/fixture IDs, kể cả daily-close phát sinh trong khung giờ
  đêm. Chỉ dọn đúng graph fixture, trong transaction, abort nếu có foreign reference.
  Không reset tất cả bảng hay import lại topology để “sửa” kết quả test đỏ.
- Không bật lại workers trên DB đã dọn trong khi broker còn sự kiện fixture cũ.
  Giữ môi trường test cho điều tra nếu chưa có thủ tục dọn scoped được kiểm chứng.
- Phase 6 chỉ DONE sau integration/races/browser đạt và các khoảng trống roadmap
  được triển khai hoặc được chủ dự án chấp nhận rõ bằng phạm vi nghiệm thu khác:
  customer account, provider/webhook, hướng dẫn ngân hàng/QR/receipt khách,
  PACKING/SHIPPING/COMPLETED, hoàn tiền thực. Manual receipt + REFUND_PENDING chưa
  thay thế các yêu cầu này. Hiện **chưa đủ điều kiện nghiệm thu toàn bộ Phase 6**.


## 9. Ghi nhận thực thi 6.5B và các script mới

Migrations đã chạy thực tế: Inventory 10 migrations đến paid_reservations, Sales
9 migrations đến online_payments; danh sách đầy đủ và checksums ở báo cáo/evidence.
**Không dùng nguyên lệnh Sales deploy toàn bộ lịch sử ở mục 3 trên checkout hiện tại:**
repo còn migration buyback Phase 7. Phiên này dùng config Prisma tạm trỏ vào schema
repository và thư mục tạm chỉ chứa bản sao nguyên byte 9 migrations Sales đến Phase 6,
kèm migration_lock.toml. Review tự động không cho deploy Phase 7; không sửa lịch sử
migration để vượt review. Status Sales “up to date” chỉ cho tập Phase 6 đó.

Trước mỗi lần migrate, kiểm tra config hiệu lực chỉ tới 127.0.0.1:55432/phase6_test,
role/schema tương ứng và không có failed/drift. Config tạm của phiên không gọi
`process.loadEnvFile('.env')`. Không dùng Prisma default datasource từ dev.

Ngoài hai DB scripts và HTTP flow ở trên, đã thêm các scripts sau. Mọi lệnh đều
phải dùng `env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/tests.env"`.
Không tự boot/migrate/reset hoặc cleanup graph fixture trong các scripts này.

```bash
# Sau H thành công: lấy orderId và privateAccessFile từ output, không in nội dung file.
# Biến dưới là UUID/path test đã thu được, không phải token/JWT.
export PHASE6_TEST_ORDER_ID='<UUID từ HTTP flow>'
export PHASE6_TEST_ACCESS_FILE='<privateAccessFile từ HTTP flow>'
env -i PATH="$PATH" HOME="$HOME" \
  PHASE6_TEST_ORDER_ID="$PHASE6_TEST_ORDER_ID" \
  PHASE6_TEST_ACCESS_FILE="$PHASE6_TEST_ACCESS_FILE" \
  PHASE6_TEST_LOG_DIR="$PHASE6_DIR" \
  node --env-file="$PHASE6_DIR/tests.env" tests/phase6/live-verification.integration.mjs

# Thay đổi fixture Inventory qua publisher/outbox/broker/Gateway thật.
env -i PATH="$PATH" HOME="$HOME" node --env-file="$PHASE6_DIR/tests.env" tests/phase6/catalog-live.integration.mjs
```

Với live-verification, truyền các UUID/path thực bằng biến shell đã đặt từ trước
hoặc trực tiếp trong `env -i`; không dùng placeholder để chạy. Script catalog tạo
thêm chiếc PH6CAT, đổi metal price synthetic, unpublish/republish, xoá đúng chiếc
mới khi không có reference rồi khôi phục giá. Không dùng trên fixture đã bị sửa
để thử các business scenarios khác. Lưu log và DB state nếu FAIL.

Broker outage: chỉ `compose ... stop rabbitmq` của acceptance; chạy
`broker-recovery.integration.mjs` với `PHASE6_TEST_RECOVERY_MODE=offline` và
`PHASE6_TEST_RECOVERY_FILE="$PHASE6_DIR/recovery.json"` truyền qua `env -i`; xác
nhận PENDING/outbox bền vững. Khôi phục `compose ... up -d --wait rabbitmq`, chạy
mode `recover` với cùng file. Đã PASS PENDING → PUBLISHED, order CANCELLED do hàng
đang paid-held, không payment mới. Không đổi schema enum thành SENT.

Consumer recovery: dừng đúng Sales PID đã ghi và xác minh `/proc/PID/cmdline` có
app path và test env path. Không pkill/killall. Chạy `consumer-recovery.integration.mjs`
mode `prepare`, recovery file mới `"$PHASE6_DIR/consumer-recovery.json"`. Script cố ý
xoá **chỉ projection CatalogProduct của fixture** trong Sales (variants cascade),
giữ Inventory source/order/payment, publish snapshot bằng publisher thật, assert
ProcessedEvent=0. Khởi động lại đúng Sales env test, append log cũ, chạy mode
`recover`: ProcessedEvent=1, snapshot/variant rebuild, public GET=200.
Đây là graceful restart/backlog test, không phải crash-before-ACK.

Chạy `http-security.integration.mjs` **cuối lượt live**: tối đa 125 GET tuần tự,
dừng khi gặp 429; không load test. Sẽ dùng budget catalog GET của Gateway test,
không chạy catalog poll ngay sau đó rồi hiểu nhầm 429 là catalog lỗi.

SQL `tests/phase6/schema-assertions.sql` guard current_database=phase6_test và kiểm
migration count 10/9, index/owner/ref/precision; chỉ dùng trên đúng DB acceptance
đã xác minh, qua container test hoặc test connection. Các SELECT liệt kê FKs/CHECKs/
indexes/checksums để lưu bằng chứng; cần đối chiếu checksum SQL gốc riêng.

Phiên này còn giữ một invalid version=0 event trong sales.events.dlq và observer
queue, Report events chưa consume. Đó là fixture lỗi test và bằng chứng permanent
DLQ, không phải payment production hay retry exhaustion. Đã sửa fixture stale-event
sang version lịch sử dương và thêm schema validation trước publish. Không purge.

Khi hết lượt live: dừng workers test trước khi chạy DB regression (workers có thể
hút outbox fixture DB). Hai suites cuối PASS 6+5. Dừng containers bằng `stop`, giữ
volumes. Không chạy lại toàn bộ acceptance trên các live fixtures đã terminal.
Browser checklist mục 7 vẫn cần thực hiện trên runner đủ RAM. Chưa có evidence
crash đúng cửa sổ ACK/commit, retry exhaustion, Inventory outage sau nhận tiền,
network response-loss, browser/mobile hoặc 200/20. Giới hạn provider/bank/account/
fulfilment/refund ở mục 8 vẫn áp dụng; không tuyên bố Phase 6 DONE.
