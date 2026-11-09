# Phase 6 — Online sales: Tasks 6.1–6.5B

Ngày cập nhật: 2026-11-09 (Việt Nam). Branch `feat/sales-pos`.

**Task 6.1: DONE trong phạm vi triển khai backend, unit tests và kiểm tra tĩnh.**

**Task 6.2: DONE trong phạm vi Cart contract, backend reservation/checkout, unit tests và kiểm tra tĩnh.**
Xem mục Task 6.2 bên dưới; concurrency PostgreSQL và vận hành RabbitMQ vẫn **NOT VERIFIED**.
Migration/deployment và integration PostgreSQL/RabbitMQ: **NOT VERIFIED**.
**Task 6.3: PARTIAL so với roadmap thanh toán tự động; nhánh xác nhận thủ công được
cho phép đã triển khai và unit/static PASS.** Chưa chọn provider/ngân hàng webhook;
không khẳng định có xác minh tiền hoặc hoàn tiền tự động. Xem mục Task 6.3 cuối file.

**Task 6.4: PARTIAL về nghiệm thu thực tế; Storefront đã triển khai, unit/component và static checks ghi ở mục Task 6.4.**
API ngân hàng/QR/receipt khách chưa có; tích hợp live và visual/browser QA vẫn NOT VERIFIED.

**Task 6.5A: PASS trong phạm vi source review, regression/contract tests và static validation bên dưới.**
**Task 6.5B: PARTIAL — đã chạy Docker PostgreSQL/RabbitMQ và HTTP integration thật ngày 2026-11-09.**
DB 11/11 PASS; live cases 12/12 đạt qua targeted runs; 4 recovery stages PASS.
Browser, crash/ACK-loss, retry exhaustion, payment outage và HTTP timeout còn NOT VERIFIED.
**Phase 6 CHƯA DONE/chưa production ready.** Xem [báo cáo/matrix 6.5B](phase6-acceptance-report.md)
và [bằng chứng thực thi](phase6-acceptance-evidence.md). Các mục 6.1–6.5A bên dưới
là ghi nhận lịch sử, “chưa chạy” trong các mục đó không mô tả kết quả phiên 6.5B.

Không tuyên bố toàn bộ Phase 6 hoặc Phase 5 hoàn thành. Giữ nguyên thay đổi Phase 4/5
chưa commit; không commit, push, reset, restore, clean hoặc đổi branch.

## Acceptance criteria Phase 6 theo roadmap

Nguồn: `docs/ke-hoach.md` mục Giai đoạn 6; `docs/thiet-ke.md` mục 7.6.

| Tiêu chí | Trạng thái |
| --- | --- |
| Catalog công khai trong Sales; Inventory phát `product.snapshot`, `stock.availability_changed`; tự cập nhật giá và có replay toàn bộ | Task 6.1: IMPLEMENTED; unit/static PASS; integration NOT VERIFIED |
| Danh sách/chi tiết, tìm kiếm, phân trang, danh mục/kim loại/giá, sắp xếp, hình ảnh/SKU/giá/tồn | Task 6.1: IMPLEMENTED; unit/static PASS |
| Không công khai hàng chưa publish/ngừng dùng, không lộ giá vốn/thông tin nội bộ | Task 6.1: IMPLEMENTED; unit PASS |
| Tài khoản khách, `/api/shop/auth/*`, cookie `rt_shop`, liên kết Customer | NOT STARTED; ngoài phạm vi Task 6.2 được yêu cầu trong phiên tiếp theo |
| Saga đơn online, chọn kho/chiếc cụ thể và chốt giá/giữ hàng, chống trùng và huỷ đến sớm | Task 6.2 IMPLEMENTED; unit/static PASS; DB concurrency NOT VERIFIED |
| Hết hạn giữ hàng và đơn PENDING quá 10/30 phút | Task 6.2 IMPLEMENTED; unit PASS; vận hành thực tế NOT VERIFIED |
| Thanh toán online, chống trùng và race nhận tiền/hết hạn | Task 6.3: manual receipt IMPLEMENTED; webhook NOT IMPLEMENTED; DB/RabbitMQ NOT VERIFIED |
| Storefront React: catalog/detail/cart/checkout/polling/manual payment/tracking | Task 6.4 IMPLEMENTED; unit/component/static checks bên dưới; live/browser NOT VERIFIED |
| Đóng gói/giao hàng/hoàn tiền thật | NOT STARTED; không diễn giải CONFIRMED thành đã giao |
| 200 đơn tranh 20 chiếc, race hết hạn/nhận tiền, webhook trùng | NOT VERIFIED; thuộc các task sau |

## Triển khai Task 6.1

- Không có database Catalog riêng: ba bảng `CatalogProduct`, `CatalogVariant`,
  `CatalogAvailability` nằm trong schema Sales. Không đọc chéo database service.
- Inventory vẫn là nguồn chính và dùng lại `computeItemPrice`/`findCurrentPrice`.
  Giá tham khảo là giá thấp nhất của chiếc `IN_STOCK` thuộc kho được bật online,
  với số còn bán `max(0, IN_STOCK - buffer)` tính riêng từng kho/biến thể.
  RESERVED/SOLD không góp vào số này; không có giá kim loại hiệu lực thì không báo còn hàng.
- Mặc định `Product.publishedOnline=false`, `Warehouse.acceptsOnlineOrders=false`,
  buffer bằng 0. ADMIN chủ động publish và bật kho; category/product/variant/metal
  phải active. Mẫu tắt publish/active phát tombstone và tồn 0.
- Worker Inventory quét lúc khởi động và mỗi 30 giây, xử lý tuần tự theo lô 50 mẫu,
  đọc từng lô tối đa 500 chiếc, transaction Serializable theo mẫu, advisory lock và
  `catalogVersion` riêng tăng dần. Outbox ghi cùng transaction với version.
  Mẫu lỗi không chặn các mẫu khác; CLI trả lỗi nếu có mẫu chưa phát được.
- Cách đồng bộ định kỳ bao phủ cả thay đổi POS, nhập kho, buffer, publish và giá kim
  loại đến thời điểm hiệu lực, không sửa logic POS/recovery worker. Đây là eventual
  consistency: 30 giây là chu kỳ quét thông thường, không phải SLA tối đa.
- Sales consumer dùng consumer/ProcessedEvent chung; version gate bằng upsert SQL
  có điều kiện. Snapshot cũ/trùng không thay variants. Tồn tới trước sản phẩm vẫn
  được lưu; version khác product chưa được coi là còn hàng. Binding giá kim loại
  cũ được ack, Sales chỉ nhận giá đã tính từ snapshot Inventory.
- Snapshot sản phẩm cũ hơn 2 phút không trả ra; tồn thiếu/cũ/lệch version trả
  `inStock=false`. Hàng hết không bị báo còn bán, giá không khả dụng là `null`.
- Response chỉ ánh xạ trường công khai; không có costPrice/buyPrice/tagCode,
  warehouseId/orderId, audit, actor hoặc trường định giá nội bộ.
- Không giữ hàng, không chốt giá giao dịch và không có API nhận giá từ frontend.
  Giá/tồn phải được Inventory kiểm tra lại khi checkout ở task sau.
- Query strict Zod, page 1–10000, pageSize 1–50; search tối đa 100 ký tự;
  tiền không âm dạng chuỗi, minPrice <= maxPrice; sort theo allowlist.
  SQL tham số hoá; `%`, `_`, `\` trong search được escape.
- `categoryId` là danh mục/loại trang sức hiện có (nhẫn, dây chuyền…);
  `metalKind` là GOLD/SILVER. Lọc giá/kim loại khớp cùng một biến thể;
  sắp xếp theo giá nhỏ nhất khớp bộ lọc, null cuối, id làm tie-breaker.
- Gateway dùng route `/api/shop/* → Sales /shop/*` đã có, không mở route internal.
  Thêm giới hạn GET/HEAD Catalog chung 120 request/phút/IP bằng RateLimitService
  hiện có; giữ xác thực/phân quyền Backoffice. Chỉ controller đọc Catalog có `@Public`.

## API

| Method | Gateway endpoint | Quyền / ý nghĩa |
| --- | --- | --- |
| GET | `/api/shop/products` | Public, query `page`, `pageSize`, `search`, `categoryId`, `metalKind`, `minPrice`, `maxPrice`, `sort` |
| GET | `/api/shop/products/:productId` | Public; UUID; 404 nếu không được công khai hoặc dữ liệu quá cũ |
| PATCH | `/api/admin/inventory/products/:productId` | ADMIN, route có sẵn; thêm `publishedOnline`, `imageUrl` HTTPS; giữ body `version` |
| PUT | `/api/admin/inventory/online-catalog/warehouses/:warehouseId` | ADMIN; `{ "acceptsOnlineOrders": true }` |
| PUT | `/api/admin/inventory/online-catalog/warehouses/:warehouseId/buffers/:variantId` | ADMIN; `{ "quantity": 2 }`, 0–1000000 |

Response mẫu có id, categoryId/categoryName, tên/mô tả, imageUrl (nullable), capturedAt,
variants (id, SKU, tên, metalKind, estimatedPrice, inStock), inStock chung của mẫu.
Danh sách có items/total/page/pageSize. Tối đa 200 variants/mẫu; mẫu vượt giới hạn
không được công khai. Description tối đa 10000 ký tự trong event; dữ liệu legacy
quá giới hạn làm publish lỗi và hết hiệu lực sau TTL, không cắt dữ liệu âm thầm.
OpenAPI: `docs/api/shop.openapi.yaml`, cập nhật phần ADMIN Inventory tương ứng;
components sinh từ shared Zod bằng generator, có `--only=inventory,shop`.

## Migration và vận hành chưa thực hiện

- Đã tạo migration `20261109100000_public_catalog` riêng ở Inventory và Sales.
  Prisma schema format và generate client PASS. Chưa áp dụng migration vào DB dev.
- Khi triển khai: kiểm tra lịch sử migration Phase 4/5 đang có, áp dụng migration đúng
  service/user, cập nhật hai binding mới trong `infra/rabbitmq/definitions.json` vào
  broker theo quy trình vận hành, rồi khởi động service. Không import/purge/reset
  broker hoặc chạy migration dev trong phiên này.
- Replay sau migration: trong `apps/inventory`, dùng
  `pnpm catalog:replay` với DATABASE_URL Inventory hợp lệ (sau build package).
  CLI chỉ tạo snapshot/outbox trong Inventory; worker outbox gửi và Sales nhận sau.
  Không chạy CLI replay trên dữ liệu dev trong phiên này.
- Sales nay có consumer nên DATABASE_POOL_MAX phải đáp ứng kiểm tra pool của
  MessagingModule hiện có; không thay cấu hình bảo vệ đó.

## Kiểm thử đã chạy

| Lệnh / phạm vi | Kết quả |
| --- | --- |
| `node apps/inventory/test/catalog.test.mjs` | PASS 6/6: giá từ Inventory, payload công khai, publish/active, SOLD không vào query, hết hàng/buffer, variant ngừng dùng, metadata quyền và cấu hình ADMIN |
| `node apps/sales/test/catalog.test.mjs` | PASS 9/9: validation, freshness, DTO an toàn, not-found, lệch version, list/filter/sort/pagination SQL, version gate, tồn đến trước product, payload sai và public metadata |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON apps/gateway/src/proxy/catalog.test.ts` | PASS 2/2: routing, internal traversal, quyền Backoffice và IP rate-limit chuẩn hoá |
| Typecheck Inventory, Sales, Gateway, Contracts | PASS |
| Lint Inventory, Sales, Gateway, Contracts | PASS |
| Build Contracts, Inventory, Sales | PASS; chỉ package trực tiếp thay đổi |
| Prisma format/generate Inventory, Sales | PASS |
| OpenAPI validate Inventory và Shop; generator check `--only=inventory,shop` | PASS sau sửa quote description YAML |
| `git diff --check` | PASS |

Tổng unit có mục tiêu: **17/17 PASS**, không có skipped tests.
Runner spawn test Gateway bị sandbox EPERM; chạy trực tiếp cùng file bằng Node PASS.
Prettier không hỗ trợ parser Prisma trong repo; dùng `prisma format` cho hai schema,
Prettier cho TS/MJS. Không chạy test toàn monorepo, test Phase 4/5, build toàn bộ,
hoặc khởi động Docker/WSL.

## Giới hạn chưa kiểm chứng

- **NOT VERIFIED:** migration SQL thực thi, HTTP qua Gateway/guards thật, RabbitMQ
  outbox → consumer, restart/replay và concurrency/version gate trên PostgreSQL thật.
  Unit mocks kiểm tra điều kiện SQL và mapping, không chứng minh DB/broker integration.
- Probe chỉ đọc ngoài sandbox xác nhận cổng dev 5432/5672 AVAILABLE; cổng test riêng
  55432/55672 ECONNREFUSED. Dev đang chạy không đồng nghĩa fixture integration mới
  đã sẵn sàng. Không đổi schema/dữ liệu dev hoặc tự bật môi trường test để báo PASS.
- Chưa kiểm tra tải/độ trễ quét lớn; worker phát lại cả snapshot/tồn mỗi lượt quét
  để duy trì freshness. Phải đo throughput/outbox trước triển khai tải lớn.
- Chưa có ni/size hoặc slug trong nguồn Inventory hiện tại; API dùng UUID và SKU,
  không tự suy diễn ni từ tên. Storefront vẫn là khung hiện có, chưa dựng UI Catalog.
- Catalog là dữ liệu tham khảo; việc vừa bán hết hoặc vừa unpublish có thể chưa phản
  ánh ngay trong khoảng trễ đồng bộ. Freshness không thay thế giữ hàng/chốt giá.
- Những phần Phase 5 còn chưa kiểm chứng vẫn giữ nguyên tại `docs/phase5-progress.md`.

## File sửa trong Task 6.1

- Inventory: `prisma/schema.prisma`, migration mới; `src/catalog/catalog.service.ts`,
  `catalog-publisher.ts`, `online-config.controller.ts`; `src/cli/catalog-replay.ts`,
  `src/inventory.module.ts`, `package.json`, `test/catalog.test.mjs`.
- Sales: `prisma/schema.prisma`, migration mới; `src/catalog/catalog-events.ts`,
  `catalog.service.ts`, `catalog.controller.ts`; `src/app.module.ts`, `package.json`,
  `test/catalog.test.mjs`.
- Gateway: `src/proxy/rate-limit-rules.ts`, `src/proxy/catalog.test.ts`.
- Contracts: `src/shop-api.ts`, `inventory-api.ts`, `events.ts`, `index.ts`, `openapi.ts`.
- Topology: `infra/rabbitmq/definitions.json` (hai binding Catalog bổ sung).
- OpenAPI/tooling: `docs/api/shop.openapi.yaml`, `docs/api/inventory.openapi.yaml`,
  `scripts/openapi-generate.mjs`, root `package.json` (validate thêm Shop).
- Tài liệu: `docs/phase6-progress.md`.

## Bàn giao lịch sử sau Task 6.1 (đã được yêu cầu mới thay thế)

Chỉ mô tả, **chưa triển khai**: CustomerAccount/Auth khách, liên kết Customer.accountId,
`/api/shop/auth/*`, cookie rt_shop và tách audience khách/nhân viên theo thiết kế.
Chạy integration Catalog trong môi trường riêng có migration/binding mới trước khi
coi đường đi thực tế đã được xác minh. Không triển khai giỏ hàng, checkout, thanh toán,
saga, frontend đầy đủ hoặc Phase 7 trong Task 6.1.


## Task 6.2 — Online Cart, Inventory Reservation & Checkout

Yêu cầu mới xác định Task 6.2 là giỏ hàng/giữ hàng/checkout. Ghi chú bàn giao cũ về
CustomerAccount ở trên không phải phạm vi đã thực hiện. Không triển khai auth khách,
thanh toán, shipping, Storefront UI đầy đủ hoặc Phase 7 trong phiên này.

**Trạng thái: DONE phần triển khai và kiểm thử có mục tiêu; integration NOT VERIFIED.**
Không tự migrate database development/production và không coi mock là bằng chứng
đã kiểm chứng tranh chấp PostgreSQL thật.

### Cart và truy cập checkout

- Giỏ nằm ở client, không tạo bảng/server-side cart. Shared contract `onlineCartSchema`
  và `canonicalCart` validate tối đa 20 biến thể, 1–10 chiếc/biến thể, tổng 50 chiếc;
  UUID hợp lệ, không trùng biến thể (kể cả UUID đổi hoa/thường), thứ tự canonical.
  Chỉ gửi giỏ ở lúc checkout; thêm vào giỏ không gọi Inventory và không giữ tồn.
  Chưa có UI hoặc code lưu giỏ trên trình duyệt trong task backend này.
- Body checkout chỉ có items, tên, số điện thoại, địa chỉ giao hàng, email tuỳ chọn.
  Zod strict từ chối giá, tổng tiền, giảm giá, trạng thái và trường lạ.
  Sales không dùng Catalog snapshot để quyết định giữ hàng hoặc tính giá giao dịch:
  Inventory kiểm tra publish/active/kho/buffer/giá hiện hành lúc giữ chiếc cụ thể.
- Guest checkout dùng capability `Authorization: Checkout <64 ký tự hex chữ thường>`.
  Client phải tạo 32 byte bằng crypto RNG trước POST đầu tiên, giữ token và key để
  retry/poll/huỷ (kể cả mất response). Không đưa token vào URL hoặc payload event.
  Sales chỉ lưu SHA-256 token; logging hiện có redact Authorization. Endpoint trả
  `Cache-Control: no-store`; response không trả địa chỉ, số điện thoại, email,
  token/hash/key, chi nhánh, kho hoặc ID chiếc vật lý. Sai token trả 404 khi tìm đơn.
- Idempotency unique `(accessHash, idempotencyKey)` và requestHash của body chuẩn hoá.
  Cùng token/key/nội dung → cùng ID; đổi nội dung → 422 IDEMPOTENCY_KEY_REUSED.
  Lookup theo key dùng header để khôi phục sau timeout trước khi biết ID.

### Service ownership và quyết định model

- Inventory sở hữu `StockReservation`/`StockReservationItem`; Sales sở hữu
  `OnlineOrder`/`OnlineOrderItem` trong database/schema hiện có của từng service.
  Không tạo database mới, không truy cập schema service khác từ application.
- Thiết kế chung có bảng Order dùng chung POS/online. Implementation POS hiện tại
  bắt buộc branchId/createdBy lúc tạo và gắn chặt enum/lease/recovery với POS.
  Task này dùng model OnlineOrder riêng trong Sales để giữ nguyên bất biến POS;
  không thêm actor/branch giả, không làm nullable rồi sửa toàn bộ POS/recovery.
  Đây là khác biệt có chủ đích so với sơ đồ bảng chung, không phải service mới.
- Các handler online dùng consumer/outbox/ProcessedEvent chung. Không có HTTP gọi
  Inventory ngoài luồng POS hiện có; không có distributed transaction.
- Payload POS `order.created`, `order.cancelled`, `order.paid` giữ nguyên; created và
  cancelled thêm nhánh WEBSITE qua union schema. Report ack huỷ WEBSITE chưa thu
  tiền mà không tạo/tác động doanh thu POS. Không phát order.paid trong task này.

### Reservation lifecycle, TTL và concurrency

- Business identity là orderId unique; mỗi reservation có UUID và snapshot từng
  jewelryItemId, variantId, SKU, tên mẫu, giá do Inventory tính. ACTIVE có expiresAt,
  warehouseId/branchId; RELEASED đến sớm được lưu bền vững dù chưa có items.
- Lifecycle: ACTIVE → RELEASED hoặc EXPIRED. FAILED là giữ không thành công.
  CONSUMED/PAYMENT_REVIEW là trạng thái bảo vệ, không bị expiration/release tự động.
  Task này chưa có đường consume/bán online hoặc xác nhận thanh toán.
- TTL **30 phút theo thiết kế**. Các mốc 30 phút/10 phút/retry 5 phút tập trung ở
  `libs/contracts/src/online-checkout.ts`. Deadline tính bằng clock PostgreSQL ở
  Sales khi tạo; Inventory lấy min(deadline đó, thời điểm xử lý + 30 phút), nên event
  trễ không mở thêm một cửa sổ giữ hàng mới. Kiểm deadline lại trước conditional update.
- Chọn một kho active/nhận online đủ toàn bộ giỏ sau buffer, ưu tiên tổng số còn
  online của các biến thể được yêu cầu giảm dần. Warehouse hiện chưa có code, nên
  dùng branchId rồi warehouseId làm tie-breaker ổn định, thay cho code trong sơ đồ.
- Khoá reservation theo orderId; chọn/khoá kho và metadata publish/active; khoá các
  chiếc IN_STOCK bằng FOR UPDATE SKIP LOCKED (bao gồm phần buffer). UPDATE sang
  RESERVED có điều kiện `status=IN_STOCK`, kiểm đủ số dòng. Partial unique index
  trên jewelryItemId WHERE isActive bảo vệ chỉ một reservation active cho một chiếc.
- POS vẫn khoá cùng JewelryItem và chỉ bán IN_STOCK; online chỉ chuyển IN_STOCK
  sang RESERVED. Hai bên không thể cùng chuyển một chiếc thành công nếu các khoá,
  conditional update và constraints hoạt động như PostgreSQL quy định. **Chưa xác
  minh race thật trong phiên này**, xem script integration bên dưới.
- Reserve không tạo SALE/RELEASE StockMovement vì chưa xuất/trả hàng vật lý.
  Snapshot chốt tồn vật lý tính cả IN_STOCK và RESERVED để không hụt hàng hay ghi
  doanh thu/xuất kho giả khi mới giữ hàng; test SQL mới kiểm tra riêng điều này.
- Release/expiry cùng khoá header và item; chỉ UPDATE RESERVED. Chiếc đã SOLD hoặc
  trạng thái vật lý không khớp được giữ nguyên và header chuyển PAYMENT_REVIEW;
  không tự nhả khi trạng thái bán chưa rõ. Lượt giữ CONSUMED/PAYMENT_REVIEW được bỏ qua.

### Luồng checkout, hết hạn và recovery

1. Sales transaction tạo OnlineOrder PENDING + outbox order.created WEBSITE.
   Chưa có giá chốt, tổng tiền null; chưa có thanh toán hoặc đơn bán thành công.
2. Inventory consumer transaction ghi ProcessedEvent, giữ hàng và snapshot giá bằng
   computeItemPrice/findCurrentPrice hiện có, phát stock.reserved hoặc
   stock.reserve_failed. Không còn publish/active/hàng/giá thì không giữ được giỏ.
3. Sales kiểm giỏ/số lượng/tổng snapshot; PENDING → AWAITING_PAYMENT, chép giá từ
   Inventory. Sự kiện cũ/trùng không tạo thêm dòng. Stock.reserved tới sau huỷ hoặc
   quá hạn không mở lại đơn, mà phát order.cancelled để nhả giữ hàng.
4. Khách huỷ: Sales chuyển CANCELLED có điều kiện và phát order.cancelled; Inventory
   nhả qua cùng khoá reservation. Huỷ tới trước created tạo tombstone RELEASED.
5. Worker Inventory mỗi phút, mỗi lượt tối đa 50 reservation ACTIVE đến hạn, dùng
   FOR UPDATE SKIP LOCKED, recheck giờ và release + stock.reservation_expired cùng
   transaction. Instance khác hoặc restart tiếp tục các dòng chưa commit.
6. Worker Sales mỗi phút, tối đa 50 đơn đến mốc. PENDING sau 10 phút đánh needsReview
   và phát lại created cùng business ID; retry mỗi 5 phút. Sau 30 phút hoặc hết hạn
   giữ hàng chuyển CANCELLED và phát huỷ. Khoá SKIP LOCKED phân công nhiều instance.

Sales luôn có đơn/outbox trước khi Inventory nhận created, nên không có đường giữ
hàng trước khi Sales lưu đơn. Inventory commit rồi Sales offline: reserved event
nằm trong outbox/queue; retry vẫn dùng cùng reservation và giá đã chốt. Nếu event
không tới được, recovery/deadline phía Sales và expiry phía Inventory kết thúc đơn
chưa thanh toán. Không sửa lease/POS recovery worker hoặc tự phục hồi bằng cách bán.

### API Task 6.2

| Method | Endpoint ở Gateway | Hành vi |
| --- | --- | --- |
| POST | `/api/shop/orders` | Authorization Checkout + Idempotency-Key; body CreateOnlineOrder; 202 với trạng thái hiện tại |
| GET | `/api/shop/orders/by-key` | Cùng hai header để tìm đơn khi mất response |
| GET | `/api/shop/orders/:orderId` | Token sở hữu; polling trạng thái |
| POST | `/api/shop/orders/:orderId/cancel` | Token sở hữu; huỷ idempotent trước thanh toán |

Không có Cart API hoặc HTTP reservation/internal endpoint mới. Gateway dùng route
shop → Sales có sẵn; giữ block internal và auth Backoffice. POST tạo/huỷ chung
10 request/phút/IP; GET/HEAD đơn chung 120 request/phút/IP, chuẩn hoá hoa/thường,
mã hoá và slash như cơ chế hiện có. Thiếu/sai định dạng header/body → 400; sai chủ
hoặc không có đơn → 404; key đổi nội dung → 422; rate limit → 429.
Thất bại reservation bất đồng bộ trả trong failureCode của đơn CANCELLED:
ITEM_NOT_AVAILABLE, PRICE_NOT_AVAILABLE, RESERVATION_RELEASED, RESERVATION_EXPIRED.
OpenAPI Shop có security scheme/header, request/response schema; Inventory OpenAPI
có schemas các event. Components sinh từ cùng Zod contracts.

### Migration, file và kiểm thử Task 6.2

Migration mới (đều **chưa áp dụng**):

- Inventory `20261109110000_online_reservations`: enum, reservation/header/items,
  check ACTIVE fields, FK tới JewelryItem và partial unique active item.
- Sales `20261109110000_online_checkout`: enum PENDING/AWAITING_PAYMENT/CANCELLED,
  OnlineOrder/items, unique capability/key và index phục hồi.
- Cần áp dụng cả migration Task 6.1 trên môi trường test/deploy trước Task 6.2.
  Các binding order.created/cancelled và stock.reserved/reserve_failed/expired đã có
  trong definitions; không tự thay topology broker đang chạy.

File mới/sửa trực tiếp trong Task 6.2:

- `libs/contracts/src/{online-checkout,events,error-codes,index,openapi}.ts`.
- Inventory schema/migration, `src/online/{reservations,order-events,reservation-expiry.worker}.ts`,
  `src/{app.module,inventory.module}.ts`, `src/stock/inventory-close.worker.ts`,
  `test/reservations.test.mjs`, `package.json` (test:online).
- Sales schema/migration, `src/online/{online-orders.service,online-orders.controller,online-order-events,online-recovery.worker}.ts`,
  `src/app.module.ts`, `test/online-checkout.test.mjs`, `package.json` (test:online).
- Gateway `src/proxy/{rate-limit-rules,checkout.test}.ts`.
- Report `src/orders/order-report.handler.ts`, `test/online-cancellation.test.mjs`:
  chỉ bỏ qua huỷ WEBSITE chưa thu tiền; không thay logic doanh thu POS.
- `docs/api/{shop,inventory}.openapi.yaml`, `docs/phase6-progress.md`,
  `tests/online-checkout/reservation.integration.mjs`.

Kết quả:

| Kiểm tra | Kết quả |
| --- | --- |
| `node apps/inventory/test/reservations.test.mjs` | PASS 10/10; lifecycle, retry, conditional guard, expiry, tombstone, SOLD protection và snapshot physical stock |
| `node apps/sales/test/online-checkout.test.mjs` | PASS 11/11; cart/input, capability, idempotency, giá/event, stale/expiry/cancel, recovery và giữ POS contracts |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON apps/gateway/src/proxy/checkout.test.ts` | PASS 2/2; route/header/private API và rate limit |
| `node apps/report/test/online-cancellation.test.mjs` | PASS 1/1; không ghi dữ liệu doanh thu POS khi huỷ WEBSITE |
| Lint/typecheck Contracts, Inventory, Sales, Report, Gateway | PASS |
| Build Contracts, Inventory, Sales, Report | PASS; tuần tự các package trực tiếp thay đổi |
| Prisma format/generate Inventory và Sales | PASS; không migrate DB |
| Validate OpenAPI Shop/Inventory + generated-schema check | PASS |
| `git diff --check`, Prettier mã/test trực tiếp thay đổi | PASS |
| `node tests/online-checkout/reservation.integration.mjs` | NOT VERIFIED; exit 2 vì thiếu ONLINE_TEST_INVENTORY_URL; không kết nối DB dev hoặc coi như skipped PASS |

**Tổng unit mới: 24/24 PASS ngay lần chạy đầu; không retry test để lấy PASS.**
Worker warning connection lost/offline là lỗi được chủ động đưa vào test recovery.
Không chạy lại các suite Phase 4/5/6.1 hoặc toàn monorepo, không load test, không
khởi động Docker Desktop/Compose/WSL, không chạy migration dev/prod hoặc commit/push.

### Integration đã chuẩn bị, chưa được kiểm chứng

Script `tests/online-checkout/reservation.integration.mjs` chỉ chấp nhận URL database
có thành phần tên `test`, với `?schema=inventory`/`?schema=sales`. Cần PostgreSQL test
đã chạy và đã áp dụng migrations trước; script không tạo DB/chạy migration/Docker.
Cung cấp `ONLINE_TEST_INVENTORY_URL` và `ONLINE_TEST_SALES_URL` bằng cơ chế secrets/env
của môi trường rồi chạy lệnh Node ở trên. Fixture dùng UUID riêng và cleanup theo ID.

Bốn ca đã viết, **chưa chạy**:

- Hai order online tranh một chiếc; đúng một ACTIVE, unique active item, retry không giữ hai lần.
- POS deduct và online reserve tranh cùng chiếc; chỉ một bên thắng.
- Huỷ đến sớm, expiry/release đồng thời, retry sau hết hạn và không nhả SOLD.
- Hai POST checkout cùng key trên PostgreSQL, chuyển outbox snapshot trực tiếp sang
  handler Sales, giá từ Inventory, token khác bị từ chối và không có order.paid.

Ngay cả khi script DB PASS, đường RabbitMQ thật (outbox confirm, queue, restart,
retry/DLQ) và HTTP Gateway/guards vẫn cần integration riêng; script chuyển event
trực tiếp giữa các handler để kiểm chứng DB/concurrency với phạm vi RAM nhỏ.
Giới hạn worker 50 đơn/lượt/phút, query chọn kho/khóa buffer và độ trễ outbox chưa
được đo tải. Không khẳng định đã kiểm chứng 200 đơn tranh 20 chiếc bằng unit mocks.

### Bàn giao lịch sử sau Task 6.2 (được cập nhật tại Task 6.3 bên dưới)

Webhook ngân hàng/xác minh chữ ký, BankTransaction unique, ghép đúng/thiếu/dư tiền,
Payment và order.paid, trạng thái sau thu tiền, race thanh toán với expiry, giữ lại
hoặc bù trừ khi tiền về trễ. Phải phối hợp qua cùng khoá reservation, kiểm expiresAt
và bảo vệ PAYMENT_REVIEW/CONSUMED trước khi cho phép thanh toán thật; không bật thu
tiền trên luồng unpaid-only Task 6.2 mà thiếu giao thức này. QR/đếm ngược thanh toán
và giao diện hoàn chỉnh cũng chưa làm. Dừng sau Task 6.2.


## Task 6.3 — Online Payment & Order Lifecycle

**Trạng thái: PARTIAL cho roadmap thanh toán tự động. Nhánh manual payment, trạng
thái đơn liên quan, giữ hàng trả tiền, recovery và refund-request đã triển khai.**
Unit 28/28, lint/typecheck/build/OpenAPI PASS; DB concurrency/RabbitMQ/HTTP thật
**NOT VERIFIED**. Không có provider/webhook ngân hàng đã được lựa chọn hoặc cấu hình.

### Phương thức và nguồn xác minh

- Thiết kế 4.3/roadmap dùng chuyển khoản (VietQR) và webhook, còn câu hỏi chọn ngân
  hàng/nhà cung cấp đang mở. Yêu cầu Task 6.3 cho phép xác nhận thủ công có phân quyền
  khi chưa có nguồn webhook đáng tin cậy; task này dùng nhánh đó.
- ADMIN toàn hệ thống hoặc MANAGER đúng chi nhánh của đơn phải thực sự kiểm chứng
  tiền vào tài khoản doanh nghiệp trên sao kê, rồi nhập bankTxnRef/evidenceRef.
  EvidenceRef là tham chiếu bằng chứng có thể đối soát; không phải kiểm chứng ngân
  hàng tự động. BankTxnRef cần namespace ngân hàng/tài khoản + reference gốc để tránh
  nhầm tham chiếu giữa các tài khoản; backend lưu unique toàn hệ thống.
- Chỉ nhận VND và đúng toàn bộ số tiền Inventory đã chốt. Chênh lệch/thiếu/dư tiền
  bị từ chối, không cộng gộp chuyển khoản hoặc âm thầm làm tròn. Đơn chưa có snapshot
  giá/reservation trả PAYMENT_RECONCILIATION_REQUIRED. Trường hợp không ghép được,
  sai số tiền hoặc chưa có snapshot phải đối soát sao kê ngoài luồng này; chưa có
  cơ chế nhập mọi giao dịch ngân hàng hoặc ghép giao dịch một phần.
- Không dùng nút khách “đã chuyển khoản”, QR, số tiền client gửi hoặc webhook chưa
  xác minh làm bằng chứng. Không tạo provider/secret giả hoặc endpoint thanh toán
  mock ở production. Route Gateway /webhooks/bank có sẵn nhưng Sales chưa có handler
  nhận tiền tại đó; không có webhook mới trong task này.
- Không tạo QR khi chưa có cấu hình tài khoản nhận thật; việc chọn provider,
  merchant/account, hợp đồng raw body/chữ ký/timestamp/replay và ACK vẫn chưa chốt.
  Không tuyên bố thanh toán ngân hàng thật đã được tích hợp tự động.

### Identity, dữ liệu và trạng thái

- Sales có OnlinePayment: ID riêng, orderId, bankTxnRef unique, amount/currency,
  evidenceRef, actor xác minh, receivedAt, trạng thái và inventoryVersion.
- Unique actorId/idempotencyKey bảo vệ lần xác nhận; OnlinePaymentRequest giữ mọi
  key đã trả thành công, kể cả key mới trỏ cùng giao dịch ngân hàng đã có. Cùng key
  đổi nội dung → 422; cùng ref/đơn/số tiền → cùng payment; ref dùng cho đơn khác →
  409. Các unique conflict được đọc lại sau rollback transaction thua.
- Cùng transaction: lưu receipt, alias key, chuyển trạng thái đơn, append audit và
  ghi outbox order.paid WEBSITE. Response chỉ sau commit. Actor/branch lấy từ token
  và đơn thật, không nhận từ body. Body strict không cho tự khai status.
- Payment RECEIVED nghĩa là nhân viên đã xác minh tiền. Order PAYMENT_PROCESSING
  nghĩa là đang chờ Inventory xác nhận có thể bảo vệ hàng. Sau Inventory ack mới
  thành payment INVENTORY_CONFIRMED và order CONFIRMED.
- CONFIRMED chưa phải COMPLETED. Theo thiết kế, RESERVED → SOLD ở SHIPPING, không
  phải lúc xác nhận tiền. Task này không tự chuyển SOLD, hoàn tất đơn hoặc phát
  order.completed khi chưa giao hàng. Các bước đóng gói/giao hàng chưa triển khai.
- Tiền tới sau CANCELLED/hết hạn: vẫn lưu receipt/receivedAt, chuyển REFUND_PENDING,
  không mở lại đơn, không phát order.paid để cố giữ hàng khác. Đây là yêu cầu xử lý
  hoàn tiền, chưa phải tiền đã hoàn. Thời điểm receivedAt là lúc nhân viên xác minh;
  không cho client backdate để vượt thời hạn giữ hàng.
- Một chuyển khoản thực thứ hai cùng số tiền có reference khác phải được lưu thành
  receipt REFUND_PENDING; không xác nhận đơn lần hai, không đổi activePaymentId hay
  trạng thái đơn chính đang xử lý/CONFIRMED.
- OnlinePaymentAudit append-only lưu actor, paymentId, hành động, trạng thái cũ/mới
  và lý do tại các mốc receipt, Inventory ack, hết retry và yêu cầu hoàn tiền.

### Consistency và race với reservation

- order.paid WEBSITE có paymentId/reservationId/orderId, amount, VND, receivedAt;
  không đưa bankTxnRef/evidenceRef/token/PII vào event. Payload POS giữ nguyên, thêm
  nhánh WEBSITE bằng union, không thay semantics thu tiền POS.
- Inventory dùng cùng khoá StockReservation theo orderId với reserve/release/expiry,
  sau đó khoá đúng các JewelryItem. Kiểm ID reservation, tổng tiền, trạng thái và
  deadline; chỉ bảo vệ khi vẫn ACTIVE và mọi chiếc vẫn RESERVED.
- Tiền được xác minh và event đến trước khi hết hạn → PAID_HELD, gia hạn đến
  receivedAt + 3 ngày như thiết kế. Các chiếc vẫn RESERVED và không được POS bán.
  Retry cùng paymentId trả snapshot cũ, không gia hạn lặp lại.
- Nếu expiry/release thắng hoặc event tới muộn → PAYMENT_REVIEW, trả kết quả bị từ
  chối. Không tự giữ lại chiếc khác, không lén khôi phục hàng đã hết hạn hoặc SOLD.
  Receipt thật vẫn ở Sales; đơn/payment chuyển đối soát và có đường request refund.
- Trong khoảng event chưa tới Inventory, expiry có thể thắng ở Inventory. Hệ thống
  xử lý bằng exception/đối soát, không giả định hai DB commit nguyên tử hoặc tự
  khẳng định còn hàng. Đây là lý do PAYMENT_PROCESSING khác CONFIRMED.
- PAID_HELD/PAYMENT_REVIEW/CONSUMED không bị luồng expiry/release chưa thanh toán
  giải phóng. Hết hạn giữ hàng đã trả tiền 3 ngày → PAYMENT_REVIEW, vẫn giữ hàng,
  phát kết quả version mới để nhân viên đối soát thay vì auto-release.
- stock.payment_result mang payment ID, reservation ID và version tăng dần của
  Inventory. Sales lock order và chỉ áp dụng version mới hơn; ack cũ không ghi đè
  trạng thái review mới hoặc REFUND_PENDING. Sai amount/currency/identity không được
  dùng để xác nhận. Kết quả hợp lệ đến muộn sau timeout có thể giải quyết review
  nếu chưa request refund và hold vẫn còn hiệu lực.
- Guest cancel sau nhận tiền trả INVALID_STATE, không phát huỷ để nhả hàng. Consumer
  expiry/failed cũ chỉ có thể huỷ đơn chưa có activePaymentId. Worker Sales xử lý
  PAYMENT_PROCESSING trước nhánh hết hạn đơn chưa thanh toán.

### Recovery và refund

- Sales worker quét mỗi phút, SKIP LOCKED và tối đa 50 đơn/lượt như cơ chế Task 6.2.
  Receipt đã commit nhưng event/ack bị mất: phát lại cùng payment ID, tối đa 5 retry
  sau event đầu tiên; mỗi lần cách 1 phút. Hết retry chuyển PAYMENT_REVIEW và payment
  RECONCILIATION_REQUIRED; không coi timeout là chưa nhận tiền hoặc PAYMENT_FAILED.
- Outbox/consumer confirm/retry/DLQ/ProcessedEvent hiện có tiếp tục đảm nhiệm vận
  chuyển. Receipt/outbox cùng transaction; Inventory hold/kết quả cùng transaction;
  Sales nhận ack/chuyển trạng thái/audit cùng transaction. Không có transaction xuyên DB.
- Worker restart đọc trạng thái bền vững và không tạo receipt/order thứ hai.
- Nhân viên có quyền xem receipt/đối soát và gọi refund-request. Request này chỉ ghi
  REFUND_PENDING và audit, idempotent theo trạng thái; không gọi ngân hàng, không
  nhả hold đã nhận tiền, không có API/enum/event xác nhận REFUNDED.
- Callback Inventory đến sau yêu cầu refund không mở lại CONFIRMED. Những trường
  hợp tiền đã nhận nhưng hàng không bảo đảm, extra transfer, event bị DLQ/hết retry,
  paid hold quá 3 ngày cần nhân viên xử lý. Chưa có tự động hoàn tiền hoặc API xác
  minh hoàn tiền thật; không được tự coi yêu cầu refund là đã chuyển tiền.

### API và bảo mật Task 6.3

Prefix ở Gateway: `/api/admin/sales/branches/:branchId/online-orders/:orderId/payments`.
Tất cả cần JWT backoffice + ADMIN toàn hệ thống/MANAGER đúng chi nhánh; không Public.

| Method | Suffix | Chức năng |
| --- | --- | --- |
| POST | `/confirm` | Idempotency-Key; bankTxnRef, amount chuỗi .00, currency VND, evidenceRef; ghi tiền nhận thủ công |
| GET | (prefix) | Tối đa 50 receipt mới nhất của đơn, gồm ref/bằng chứng chỉ dành cho nhân viên |
| POST | `/:paymentId/refund-request` | reason; ghi REFUND_PENDING, chưa hoàn tiền |

400 cho body/header sai, 401/403 cho auth/quyền, 404 cho đơn/branch/payment không
khớp, 409 PAYMENT_AMOUNT_MISMATCH/PAYMENT_REFERENCE_CONFLICT/PAYMENT_RECONCILIATION_REQUIRED,
422 IDEMPOTENCY_KEY_REUSED. Payment POST/refund dùng chung 20 request/phút/IP qua
RateLimitService Gateway hiện có, chuẩn hoá path. Không mở internal routes.
Guest token Task 6.2 chỉ xem đơn của chính họ; không thể dùng để xác nhận tiền hoặc
refund. Response no-store; Authorization đã được logger chung redact.

Report dispatch ack order.paid WEBSITE để không ghi receipt online vào doanh thu
POS trước giao hàng/hoàn tất; logic recordPaidOrder/backfill POS không thay đổi.
Báo cáo doanh thu online hoàn tất chưa nằm trong triển khai này.

### Migration, files và verification Task 6.3

Migration mới, **chưa áp dụng lên DB dev/prod**:

- Sales `20261109120000_online_payments`: thêm các status của Order online, payment
  identity/recovery, OnlinePayment, OnlinePaymentRequest, OnlinePaymentAudit; unique
  bank ref/key, check VND/amount dương, index theo orderId/thời gian.
- Inventory `20261109120000_paid_reservations`: PAID_HELD, payment identity/outcome/
  version/receivedAt và CHECK dữ liệu cần có cho paid hold.
- Giữ nguyên migration Task 6.1/6.2, không sửa migration cũ. Cần triển khai đủ schema
  của các task trước và binding stock.payment_result → sales.events trước khi vận hành.
  Chỉ cập nhật definitions trong repo; chưa import topology vào broker đang chạy.

File trực tiếp mới/sửa:

- Contracts: `src/online-payment.ts`, `online-checkout.ts`, `events.ts`, `error-codes.ts`,
  `index.ts`, `openapi.ts`.
- Sales: schema/migration, `src/payments/{online-payments.service,online-payments.controller,payment-inventory-events,payment-recovery}.ts`,
  `src/online/{online-orders.service,online-recovery.worker}.ts`, `src/app.module.ts`,
  `test/online-payments.test.mjs`, `package.json` (test:online-payments).
- Inventory: schema/migration, `src/online/{payment-events,order-events,reservation-expiry.worker,reservations}.ts`,
  `test/paid-reservations.test.mjs`, `package.json` (test:online-payments).
- Gateway: `src/proxy/{rate-limit-rules,payments.test}.ts`.
- Report: `src/orders/paid-order-dispatch.ts`, `src/app.module.ts`, `test/online-paid.test.mjs`.
- Topology: `infra/rabbitmq/definitions.json`; OpenAPI `docs/api/{sales,inventory,shop}.openapi.yaml`.
- Integration: `tests/online-payments/payment.integration.mjs`; tài liệu file này.

| Kiểm thử/kiểm tra | Kết quả |
| --- | --- |
| `node apps/sales/test/online-payments.test.mjs` | PASS 17/17: role/branch, receipt, sai tiền/currency, key/ref/alias, late/extra transfer, callback/phiên bản, refund, timeout/recovery và metadata controller |
| `node apps/inventory/test/paid-reservations.test.mjs` | PASS 8/8: paid hold, replay, expiry/release trước/sau payment, SOLD/conflict, amount, paid TTL và payment identity |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON apps/gateway/src/proxy/payments.test.ts` | PASS 2/2: private route và normalized rate limit |
| `node apps/report/test/online-paid.test.mjs` | PASS 1/1: receipt WEBSITE không ghi doanh thu POS |
| Lint/typecheck Contracts, Sales, Inventory, Gateway, Report | PASS |
| Build Contracts, Sales, Inventory, Report | PASS; package trực tiếp thay đổi, tuần tự |
| Prisma format/generate Sales và Inventory | PASS; không migrate DB |
| Validate OpenAPI Sales/Inventory/Shop và generated-schema check | PASS |
| Prettier mã/test trực tiếp sửa và git diff --check | PASS |
| `node tests/online-payments/payment.integration.mjs` | NOT VERIFIED; exit 2 vì thiếu PAYMENT_TEST_INVENTORY_URL; không dùng DB dev fallback |

Tổng unit mới: **28/28 PASS lần đầu, không chạy lại nhóm đã PASS**. Warning DB outage
trong test worker là lỗi được chủ động đưa vào để kiểm tra phục hồi. Không chạy test
Phase 4/5/6.1/6.2 toàn suite, không full monorepo test/build, không load test hoặc
khởi động Docker/Desktop/Compose/WSL. Không migrate DB dev/prod hoặc commit/push.

### Integration và quyết định chưa được kiểm chứng

Script mới chỉ chấp nhận DB tên có thành phần `test` và schema service tương ứng;
không tạo DB hoặc migrate. Cần PostgreSQL test đã chạy, migrations đã áp dụng,
`PAYMENT_TEST_INVENTORY_URL` và `PAYMENT_TEST_SALES_URL`. Hai ca có mục tiêu đã viết:

1. Hai xác nhận cùng key/reference, receipt/outbox một lần, Inventory ack, tranh chấp
   refund-request/callback không phục hồi đơn; hàng vẫn RESERVED/PAID_HELD.
2. Expiry và payment event cạnh tranh: không tự bán chiếc thay thế, không mất bản ghi
   tiền, kết quả đối soát. Chạy bằng lệnh Node ở bảng trên khi môi trường sẵn sàng.

**NOT VERIFIED:** SQL migrations/unique/row-lock thật, race PostgreSQL, RabbitMQ
confirm/retry/restart/DLQ, HTTP/JWT/Gateway end-to-end và vận hành manual bằng sao kê
thật. Script DB chuyển event trực tiếp giữa handler, không chứng minh RabbitMQ.
Chưa đo tải hoặc cam kết SLA; không coi mocks là bằng chứng concurrency production.

Chưa chốt provider/ngân hàng/account nhận, chữ ký/timestamp/raw body, nguồn chứng minh
refund hoặc ghép giao dịch lệch số tiền. Vì vậy không đánh dấu toàn bộ thanh toán tự
động hay Phase 6 hoàn tất. Shipping/COMPLETED và báo cáo online hoàn tất vẫn chưa có;
không được diễn giải CONFIRMED thành đã giao hàng.

### Bàn giao sang Task 6.4 tại thời điểm kết thúc Task 6.3

Storefront UI dùng Catalog, giỏ, checkout token, polling và trạng thái thanh toán đã
có; hiển thị rõ PAYMENT_PROCESSING/CONFIRMED/PAYMENT_REVIEW/REFUND_PENDING. Không thêm
nút khách tự xác nhận PAID và không giả báo đã hoàn tiền. Muốn QR/ngân hàng tự động
phải chốt cấu hình/provider và bổ sung integration chính thức; backend fulfilment
phải có điều kiện SHIPPING trước SOLD/COMPLETED theo thiết kế. Không triển khai
Task 6.4, Task 6.5 Final Integration hoặc Phase 7 trong phiên Task 6.3 này.


## Task 6.4 — Premium Jewelry Storefront (React)

Ngày 2026-11-09, tiếp tục trên `feat/sales-pos`. **PARTIAL cho nghiệm thu thực tế**:
đã hoàn tất phần UI và tích hợp contracts/API hiện có, kiểm thử có mục tiêu; chưa
chứng minh giao dịch end-to-end hoặc nghiệm thu bằng trình duyệt/thiết bị thật.
Không triển khai Task 6.5, Phase 7, customer-account API hay backend fulfilment.

### UI/UX và các màn hình

- Thiết kế riêng cho khách: ivory/cream, champagne gold, charcoal; tiêu đề serif,
  nội dung tiếng Việt, khoảng trắng, ảnh sản phẩm làm trọng tâm. SVG icon, không emoji.
  Hero là hình khối trang trí CSS, không phải ảnh sản phẩm giả. Không hardcode sản
  phẩm, địa chỉ, chứng nhận, khuyến mãi, tài khoản ngân hàng hoặc QR.
- Header/footer/menu điện thoại, badge số lượng giỏ, skip link, breadcrumb, focus
  rõ, nhãn form, lỗi theo trường, live announcements và giảm animation theo hệ
  điều hành. Toast thêm giỏ có nút đóng và tự ẩn sau 12 giây.
- Layout thay đổi ở 1150/850/600/360 px, ảnh lỗi/thiếu dùng placeholder thống nhất,
  thẻ sản phẩm hai cột trên điện thoại; checkout một cột, input 16 px, vùng bấm
  quantity ít nhất 44 px. Nội dung và tên API dài được cho phép xuống dòng.
- Home chỉ hiển thị sản phẩm API và danh mục quan sát được từ các sản phẩm đó;
  không gán nhãn “nổi bật” khi API chưa hỗ trợ. Lối vào vàng/bạc dùng filter thật.
- Catalog có search, danh mục, GOLD/SILVER, khoảng giá, sort, phân trang 12 sản
  phẩm; đồng bộ URL, explicit Apply, không request theo từng phím. Khi đổi bộ lọc
  hoặc trang, chuyển focus/scroll về vùng kết quả. Có loading/empty/error/retry và
  URL không hợp lệ. Dropdown danh mục chỉ gồm danh mục trong trang kết quả hiện
  tại, được ghi rõ; chưa có API taxonomy công khai để liệt kê toàn bộ danh mục.
- Detail hiển thị ảnh, mô tả, tên, SKU, tên biến thể, chất liệu, giá/tồn từ DTO;
  không dựng ni/trọng lượng khi chưa được API cung cấp. Chọn biến thể, 1–10 chiếc;
  lựa chọn không còn khả dụng hoặc không có giá không thêm được vào giỏ.
- Giỏ dùng giá API hiện tại để tính tổng **tham khảo** bằng bigint, không số thực.
  Refresh vẫn giữ lựa chọn; item unpublish/404/thiếu biến thể/hết hàng hoặc lỗi
  kiểm tra sẽ chặn bước tiếp theo và cho phép bỏ món/chọn lại.
- Checkout có thông tin nhận hàng, tóm tắt giỏ, lỗi theo trường, kết quả chưa rõ
  và truy hồi. Trang đơn có tổng/giá từng chiếc, mã đơn, 7 trạng thái backend,
  needsReview, đếm ngược theo expiresAt, kiểm tra lại và huỷ đơn chưa thanh toán.
- CONFIRMED chỉ là đã xác nhận tiền/sản phẩm; không phải SHIPPING/COMPLETED.
  REFUND_PENDING chỉ chờ xử lý, không báo đã hoàn tiền. Khi đồng hồ về 0, chỉ
  yêu cầu cập nhật trạng thái; không tự huỷ/chuyển trạng thái trên frontend.

### Routes và API đã tích hợp

| Route Storefront | Nội dung |
| --- | --- |
| `/` | Home, chất liệu, danh mục quan sát được, sản phẩm API |
| `/bo-suu-tap` | Catalog; URL search/categoryId/metalKind/minPrice/maxPrice/sort/page |
| `/san-pham/:productId` | Chi tiết và lựa chọn biến thể |
| `/gio-hang` | Giỏ client, kiểm tra lại giá/tồn |
| `/dat-hang` | Form checkout hoặc phục hồi yêu cầu đã lưu |
| `/don-hang` | Các yêu cầu trong tab, nhập quyền tra cứu riêng |
| `/don-hang/:orderId` | Theo dõi đơn đã có token trong phiên |
| `/huong-dan` | Các bước mua, thanh toán và bảo vệ quyền tra cứu |
| `*` | Trang không tìm thấy với lối quay lại Catalog |

| Method | API Gateway | Client |
| --- | --- | --- |
| GET | `/api/shop/products` | list, query validated bằng shopQuerySchema |
| GET | `/api/shop/products/:id` | detail/cart, UUID validated |
| POST | `/api/shop/orders` | createOnlineOrderSchema; Authorization Checkout + Idempotency-Key |
| GET | `/api/shop/orders/by-key` | Truy hồi cùng token/key sau timeout/reload |
| GET | `/api/shop/orders/:id` | Token đơn riêng, polling có giới hạn |
| POST | `/api/shop/orders/:id/cancel` | Token đơn riêng; chỉ hiện với PENDING/AWAITING_PAYMENT |

Không đổi Gateway, backend, contracts hoặc OpenAPI ở Task 6.4 vì dùng nguyên API
đã công bố. Không gọi API internal/admin hoặc lấy bearer/cookie Backoffice.

### Cart, checkout state và bảo mật

- React Router + TanStack Query cùng phiên bản Backoffice đã có; state React
  Context nhỏ cho cart/vault. Query chia sẻ theo product ID, cache đọc 30 giây
  (home 60 giây), tối đa 1 retry cho GET lỗi mạng/5xx; không retry 4xx/429.
- API client cùng origin `/api/shop`, credentials omit, no-store, redirect error,
  timeout 12 giây, hỗ trợ AbortSignal; validate request/response shared Zod.
  Thông báo lỗi được ánh xạ tiếng Việt, không phản chiếu message/stack nội bộ.
- localStorage `jewelry.storefront.cart.v1` chỉ có productId/variantId/quantity,
  phiên bản và hạn 7 ngày; không lưu giá, PII hoặc token. Giới hạn dùng lại
  onlineCartSchema: 20 biến thể khác nhau, 10 chiếc/biến thể, 50 chiếc tổng.
- sessionStorage `jewelry.storefront.checkout.v1` giữ tối đa 5 quyền tra cứu,
  tối đa 72 giờ tính từ lúc tạo/import, đóng tab hết phiên; polling không gia hạn.
  Token 32 byte crypto random; UUID cho attempt/key, lưu thành công **trước POST**.
  Nếu storage bị chặn/đầy, không gửi POST và hướng dẫn cho phép lưu rồi tải lại.
- Token chỉ trong header Authorization, không ở URL/query/React Query key,
  không logging/analytics. Chỉ copy vào clipboard khi khách chủ động bấm; input
  nhập lại token là password. Token/key không lưu vào localStorage. Có lựa chọn chủ động hiện mã để tự sao
  chép nếu Clipboard API không được phép; mặc định mã không có trong DOM trang đơn.
- PII của request chỉ tạm giữ ở sessionStorage để retry đúng payload; xoá ngay
  khi có order ID; với yêu cầu chưa rõ kết quả, hết quyền resend sau 30 phút và
  loại PII ở lần đọc/dọn vault kế tiếp (TTL được kiểm tra khi truy cập, không có
  tác vụ nền của browser khi tab đóng). Sau mốc đó giữ
  quyền GET by-key nhưng không cung cấp resend thiếu payload. Khi hết hạn 72 giờ,
  purge credential, ẩn dữ liệu đã cache, ngừng đọc/copy/huỷ bằng phiên hết hạn.
  Đây là hạn lưu ở frontend, không phải API revoke/giới hạn hiệu lực token server.
- Coordinator có latch đồng bộ chống hai lần bấm trước React render. POST không
  retry tự động. Timeout/5xx không được gọi là đặt hàng thất bại; giữ token/key/body,
  GET by-key và cho khách chủ động gửi lại **cùng yêu cầu** trong 30 phút.
  GET 404 không chứng minh POST trước đã thất bại, không xoá identity/tạo đơn mới.
- Yêu cầu chưa rõ kết quả luôn được ưu tiên trước các quyền tra cứu import khác;
  không cho reset/quên/evict để bắt đầu checkout mới. Sau khi có đơn, khách theo
  dõi/huỷ; muốn đặt đơn khác sau CANCELLED/CONFIRMED phải chọn rõ ràng tại trang đơn.
  Không tự xoá giỏ hoặc coi hàng đã mua vì POST trả thành công.
- Poll PENDING 3 giây, AWAITING_PAYMENT/PAYMENT_PROCESSING 5 giây, PAYMENT_REVIEW
  15 giây; dừng tự poll khi lỗi hoặc CANCELLED/CONFIRMED/REFUND_PENDING, có nút
  cập nhật. Mỗi quyền import có cache identity riêng, không dùng dữ liệu đơn trước
  để hiển thị cho token mới. Private query gcTime=0, không persist query cache.

### Manual payment và blocker nghiệp vụ

Backend hiện chưa có response/config có thẩm quyền cho tài khoản nhận/QR và chưa
có endpoint khách gửi receipt. Trang AWAITING_PAYMENT hiển thị số tiền, mã đơn,
đếm ngược, thông báo chờ hướng dẫn chính thức. Không tận dụng tài khoản POS, không
nút “Tôi đã trả tiền”, không webhook giả, không tự tạo payment/refund receipt.

**BLOCKER cho trải nghiệm chuyển khoản trọn vẹn:** cần nguồn hướng dẫn ngân hàng/
QR có thẩm quyền và API chứng từ khách nếu nghiệp vụ yêu cầu. Chỉ tích hợp khi API
được bổ sung chính thức; không sửa backend trong phiên Storefront để giả lập.

### Files và chạy riêng Storefront

Files mới:

- `apps/storefront/src/api/shop.ts` — API client và safe error mapping.
- `apps/storefront/src/state/{catalog,cart,checkout}.ts`, `store.tsx` — query,
  giá tham khảo, giỏ, vault và coordinator.
- `apps/storefront/src/components/{ui,layout}.tsx` — primitives, ảnh, thẻ, menu/footer.
- `apps/storefront/src/pages/{home,catalog,product,cart,checkout,orders,guide}.tsx`.
- `apps/storefront/test/storefront.test.mjs` — unit và render component SSR thực.
- `apps/storefront/.env.example` — chỉ cấu hình nhãn thương hiệu công khai.

Files sửa: `apps/storefront/{package.json,tsconfig.json,vite.config.ts,Dockerfile,index.html}`,
`apps/storefront/src/{App.tsx,styles.css}`, importer Storefront trong `pnpm-lock.yaml`
và tài liệu này. Giữ nguyên các thay đổi chưa commit của task trước.

Chạy `pnpm --filter @jewelry/storefront dev` (cổng 5174) khi cần xem; Gateway hiện
cấu hình ở localhost:3000. Nhãn mặc định “Trang sức” do repo chưa có thương hiệu
cụ thể; đặt `VITE_STORE_NAME` trong `apps/storefront/.env.local` hoặc môi trường
lúc dev/build. Docker có build arg cùng tên, không phải secret. Ảnh từ API; font
Be Vietnam Pro/Playfair Display qua Google Fonts, có fallback Arial/Georgia khi
không truy cập mạng. Không có analytics hoặc API URL từ input khách.

Vite resolve public package entry `@jewelry/contracts` sang source ESM của chính
workspace package để tree-shake contracts không dùng; không import xuyên app/deep
package, không đổi build CommonJS của services. Bản build giảm JS từ ~879 KB /
213 KB gzip xuống ~464 KB / 139 KB gzip; không thêm UI framework trang trí.
Docker build contracts trước Storefront; **chưa build/run Docker image**.

### Verification Task 6.4

Kết quả cập nhật sau khi kiểm tra trực tiếp; không thay bằng mock trong production.
Test fixtures chỉ ở `apps/storefront/test/`.

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm --filter @jewelry/storefront test` | 34 ca lần đầu: 32 PASS, 2 lỗi fixture SSR error state; đã sửa retryOnMount trong test harness và chạy lại riêng 2 ca: PASS 2/2 |
| Ca bổ sung needsReview và auth 403 component | PASS 2/2; needsReview là ca mới thứ 35, auth là ca đã sửa fixture cho đúng 403 |
| Sửa token nhập sai cho cùng order ID | PASS 1/1 (ca mới thứ 36), auth tracking chạy lại có mục tiêu PASS; forOrder dùng quyền import mới nhất, không mắc kẹt token cũ |
| Sau chỉnh layout/filter focus | PASS 2/2 riêng catalog renders và responsive navigation |
| Tổng unit/component | 36/36 đã PASS qua các lượt có mục tiêu; không chạy lại cả suite đã PASS |
| Responsive component | SSR landmarks/menu/filter controls + CSS breakpoint/focus/reduced-motion assertions; không thay thế thử tương tác/visual trên browser |
| Storefront typecheck/lint/build và format | PASS: tsc, eslint, Vite production build riêng Storefront; Prettier và git diff --check |
| Live API/Gateway checkout, PostgreSQL/RabbitMQ, migration | NOT VERIFIED; không khởi động stack, không migrate hoặc chạy lại test backend |
| Browser visual/touch/keyboard, clipboard/storage policy thật | NOT VERIFIED; phiên này không có công cụ trình duyệt/Chromium để nghiệm thu |

Các nhóm đã kiểm tra: data API/DTO và response chứa internal field bị từ chối;
URL search/filter/page hợp lệ/sai; ảnh an toàn/placeholder; tiền chính xác; thêm/
bỏ/cập nhật giỏ/giới hạn/refresh/hết hàng; form shared schema và field labels;
identity persist-before-POST, timeout/reload/retry exact identity, GET by-key404,
double-submit một POST, storage failure không POST, TTL/PII purge; trạng thái tiền/
refund/review; authorized tracking/error 403, missing token và menu responsive SSR.

Chưa chứng minh: layout thực trên 360/390/768/1440 px, trình đọc màn hình, focus
sau toggle/pagination, nhiều tab, refresh/clipboard chính sách browser thật, TTL
đồng hồ bị chỉnh, real HTTP failover/rate-limit và saga/receipt/expiry cạnh tranh.
Không đánh dấu integration PASS, không coi unit mocks là kiểm chứng concurrency.

### Bàn giao Task 6.5 — chưa triển khai

- Chuẩn bị môi trường test riêng, migration và topology theo tài liệu 6.1–6.3;
  integration thật catalog → checkout → reservation → manual payment → tracking.
- Kiểm tra timeout/reload/by-key, race hai khách cùng chiếc, receipt trùng, expiry/
  late payment/recovery; giữ các tiêu chí 200 đơn/20 chiếc của roadmap chưa được
  xác minh. Không thực hiện trong phiên Task 6.4.
- Browser QA trên các viewport, bàn phím, mobile menu, URL history, cart refresh,
  quyền clipboard/storage và token hết hạn; chốt branding/ảnh sản phẩm thật.
- Chốt hướng dẫn thanh toán có thẩm quyền/receipt API nếu cần; provider/webhook,
  customer account, fulfilment/SHIPPING/COMPLETED là phần chưa có của roadmap,
  không được tự đánh dấu đã hoàn tất.


## Task 6.5A — Low-RAM verification và chuẩn bị 6.5B

Ngày 2026-11-09, branch `feat/sales-pos`, giữ nguyên thay đổi chưa commit Phase 4–6.
**PASS trong phạm vi 6.5A**: review có giới hạn các luồng Phase 6, sửa hai lỗi cụ
thể, thêm regression/contract tests và static checks. Không kết luận concurrency
hoặc tích hợp thực từ source/unit mocks. **Chưa chạy bất kỳ ca 6.5B nào**, kể cả
script trả thiếu môi trường; chỉ kiểm tra cú pháp bằng `node --check`.

### Lỗi phát hiện và sửa

1. **Giá và stock trên thẻ Catalog không theo cùng biến thể với bộ lọc API.**
   Sales list lọc/sắp xếp theo biến thể khớp metalKind/minPrice/maxPrice, nhưng
   response vẫn có mọi biến thể để dùng DTO chung. Storefront trước đây lấy giá
   thấp nhất/stock chung. Ví dụ vàng 1.000.000,25 và bạc 500.000: lọc vàng tối thiểu
   900.000 vẫn hiển thị giá bạc 500.000, hoặc báo còn khi chỉ bạc còn hàng.
   Đã tái hiện bằng 2 regression tests FAIL trước fix, PASS sau fix. Thẻ nay dùng
   matchingVariants để chọn giá **tham khảo có sẵn trong API** và stock của đúng
   biến thể khớp; bounds dùng bigint giữ chính xác phần lẻ. Không tính lại giá bán,
   không đổi API/Sales/Inventory/POS và không redesign UI.
2. **OpenAPI thiếu security trên hai PUT cấu hình online Inventory.** Không có
   security toàn cục trong spec Inventory, nên hai operation bị mô tả như public,
   dù controller có Roles ADMIN và Gateway audience backoffice. Contract test
   controller/Gateway/OpenAPI đã phát hiện mismatch. Bổ sung Bearer security và
   x-audience store-backoffice cho warehouse online và buffer; test PASS. Đây là
   lỗi mô tả API, không phải phát hiện bypass authorization runtime.

### Review luồng nghiệp vụ và service ownership

- Home/Catalog/Detail gọi đúng GET `/api/shop/products`; filter/query shared Zod;
  Cart chỉ lưu ID/quantity và re-read API. Giá tham khảo/snapshot eventual consistent
  không phải reservation, checkout body strict không nhận giá/tổng tiền/status.
- Sales create canonical cart/body, hash request, hash capability token; transaction
  tạo OnlineOrder + outbox. Unique accessHash/key xử lý double POST; key đổi nội dung
  422. Timeout có GET by-key; frontend latch, giữ identity, không tự tạo key mới để
  retry. Không xoá giỏ hoặc coi POST thành đã mua.
- Inventory reserve dùng đúng schema event, orderId tombstone/unique, kho đủ cả giỏ,
  online buffer, publish/active, lock chiếc và conditional IN_STOCK→RESERVED; chốt
  giá bằng computeItemPrice/findCurrentPrice. Snapshot Catalog không quyết định giá.
- stock.reserved được Sales kiểm giỏ/tổng/thời gian rồi lưu snapshot riêng trong
  Sales; event hết hạn/huỷ không huỷ đơn đã có activePaymentId. Consumer + outbox
  giao dịch trong DB service sở hữu; không app đọc chéo schema/database.
- Receipt chỉ ADMIN/MANAGER đúng chi nhánh thật của order; row lock trên OnlineOrder,
  unique bank ref, actor/key và bảng alias. Tiền đã ghi nhận đi PAYMENT_PROCESSING,
  đợi Inventory lock cùng reservation với expiry/release; đúng hold mới PAID_HELD.
  Ack theo payment/reservation/amount/currency/version; callback cũ không đảo trạng
  thái mới; callback sau refund request không khôi phục CONFIRMED.
- Tiền đến muộn hoặc giao dịch bổ sung được ghi để đối soát/refund request, không
  tự chuyển hoàn tiền thành công. Guest cancel sau nhận tiền bị chặn. Paid hold
  hết 3 ngày chuyển review, không tự nhả hàng đã nhận tiền hoặc xuất kho/SOLD.
- Online workers dùng row lock + SKIP LOCKED, 50 order/lượt và transaction ngắn;
  không có lease riêng cho toàn saga. Lease OutboxWorker là lease phát thư, không
  phải bằng chứng consumer/HTTP đã xử lý đúng một lần. ProcessedEvent cùng tx với
  handler; transient/deadlock retry qua cơ chế messaging, hết tier có DLQ/recovery.
  Source chứng minh cơ chế hiện hữu, chưa chứng minh vận hành thật.

### Concurrency A–G: source evidence và gate runtime

| Scenario | Cơ chế/source đã review | Trạng thái runtime và bước kế tiếp |
| --- | --- | --- |
| A — hai online cùng chiếc | reservations.ts: lock header/kho/chiếc, SKIP LOCKED, UPDATE IN_STOCK có điều kiện; partial unique one_active_item | NOT VERIFIED; reservation.integration ca 1 trên PostgreSQL riêng |
| B — POS và online | item-sales.service.ts + reservations.ts cùng khoá JewelryItem, chỉ chuyển từ IN_STOCK; không sửa POS | NOT VERIFIED; reservation.integration ca 2, assert SOLD XOR RESERVED |
| C — cùng checkout key | OnlineOrder accessHash/key unique; requestHash; transaction order/outbox, retry đọc cùng row | NOT VERIFIED đồng thời DB; DB ca 4 + HTTP flow hai POST |
| D — hai nhân viên receipt | lock OnlineOrder, unique bankTxnRef/actor-key/alias và transactional receipt/outbox | NOT VERIFIED; DB payment ca 1 và HTTP flow chuẩn bị hai actor MANAGER khác nhau |
| E — expiry và payment | cùng lock StockReservation; PAID_HELD không unpaid release; result/review bảo vệ tiền nhận | NOT VERIFIED; DB payment ca 2 + worker/broker live fixture |
| F — event trùng/redelivery | ProcessedEvent unique cùng tx; business identity/version gate; outbox confirm + retry/DLQ | NOT VERIFIED broker; redeliver helper chỉ chuẩn bị publish, còn cần DB assertions/ack-loss |
| G — xác nhận tiền muộn | Sales ghi receipt REFUND_PENDING hoặc Inventory REJECTED/review; không cấp chiếc khác | NOT VERIFIED; expiry-first/payment-first + late receipt trên test DB |

### Security và frontend review

Gateway rewrite/path traversal, audience Backoffice, forward capability header,
strip x-user-*; no-store cho private order/payment; logging redact Authorization/
cookie; mass assignment strict body; nguồn giá/tồn Inventory; response public
allowlist không có cost/PII/hash/key/internal IDs đều đã đối chiếu source/contracts.
ADMIN config và manual receipt không được chuyển thành Public. Error code frontend
được map thông điệp an toàn; 404 không phân biệt order không tồn tại/sai token,
429 không auto retry, 5xx/timeout chỉ retry GET có giới hạn. Không phản chiếu stack.

Storefront Home/Catalog/Detail/Cart/Checkout/Pending/Tracking có state loading/empty/
error/unavailable; responsive theo code, form labels/focus, giữ key khi timeout,
không mock product/bank/QR, không self-confirm PAID và không báo REFUNDED. Các phần
này đã unit/component tested ở 6.4; **không chạy lại nguyên nhóm 36 ca** trong 6.5A.
Lỗi Catalog mới có 2 ca riêng. Browser tương tác, độ tương phản/visual/clipboard/
storage/URL history thật vẫn NOT VERIFIED. Không dùng source review thay browser QA.

Token ở sessionStorage tối đa 72 giờ, request PII loại khi biết order ID hoặc lần
đọc vault sau 30 phút, không vào URL/analytics/query key. Mã có thể được khách chủ
động sao chép/hiện; scope là capability riêng từng đơn. Đây là TTL lưu phía client,
**không có server-side revoke/TTL token được triển khai**. Sau khi đóng tab/mất
storage cần mã đã lưu riêng; mất identity của checkout chưa rõ kết quả là giới
hạn của guest session, không được coi request cũ đã thất bại. Rate limit bộ nhớ
chỉ theo một Gateway; scale nhiều instance cần cơ chế dùng chung theo thiết kế.
Không thay Auth architecture để giải quyết các quyết định vận hành này ở 6.5A.

### Acceptance matrix

PASS dưới đây chỉ áp dụng mức bằng chứng ghi trong cột tương ứng. “Implemented”
không đồng nghĩa unit/integration/browser tested hoặc production ready.

| Hạng mục | Kết quả | Mức bằng chứng / file-test | Rủi ro còn lại | Kiểm chứng tiếp |
| --- | --- | --- | --- | --- |
| API method/path/DTO/security | PASS | 6.5A contract tests, 11 controller operations và 6 Storefront API calls; OpenAPI schema sync/validation | Không chứng minh Nest/HTTP guards runtime | HTTP flow + role/branch tests 6.5B |
| Catalog giá/stock theo filter | PASS | Implemented + 2 regression unit/SSR mới; state/catalog.ts, components/ui.tsx, pages/catalog.tsx | Snapshot vẫn trễ, ảnh/visual chưa browser | Chrome với mẫu nhiều biến thể |
| Public response/no mass assignment | PASS | 6.5A contract rejection tests; strict checkout/payment DTO, source present allowlist | Logger/deploy/network runtime chưa kiểm | HTTP response/log audit test env |
| Gateway internal protection/rate rule | PASS | Pure route/normalization contract tests; headers/source review | Chưa test HTTP normalization/IP thật, multi-instance memory rate limit | Live Gateway request matrix |
| Catalog sync | NOT VERIFIED | Implemented; 6.1 unit 17/17 là bằng chứng lịch sử, không rerun; event schema/binding mới kiểm 6.5A | DB apply, outbox/broker/version race | Fixture live + publisher/consumer + duplicate |
| Checkout/reserve/expiry/recovery | NOT VERIFIED | Implemented; 6.2 unit 24/24 lịch sử; source locks/constraints reviewed | Race/rollback/crash trên DB thật | Bốn ca DB checkout + HTTP/worker |
| Manual payment/refund request | NOT VERIFIED | Implemented; 6.3 unit 28/28 lịch sử; schemas/roles/source reviewed | Receipt/expiry/late ack race thực chưa chạy | Hai ca DB payment + hai actor HTTP |
| Provider/webhook/bank instructions/QR/receipt khách | PARTIAL | Manual receipt có; các API/cấu hình có thẩm quyền/provider còn thiếu | Chưa có hành trình chuyển khoản tự phục vụ trọn vẹn | Chốt nghiệp vụ/provider/API trước nghiệm thu |
| CustomerAccount/customer login | PARTIAL | NOT IMPLEMENTED so với roadmap; guest capability chỉ là phạm vi đã làm | Chưa đáp ứng tiêu chí account của Phase 6 | Phạm vi triển khai hoặc chấp nhận khác phải được quyết định rõ |
| PACKING/SHIPPING/COMPLETED, hoàn tiền thật | PARTIAL | NOT IMPLEMENTED; CONFIRMED/REFUND_PENDING không thay thế | Chưa thể vận hành fulfilment/hoàn tiền end-to-end | Thiết kế/triển khai/nghiệm thu riêng; không làm Phase 7 |
| Storefront responsive/UX thật | NOT VERIFIED | Implemented + 36 tests lịch sử; 2 SSR regression mới; code review | Không có browser/touch/screenreader evidence | Browser checklist runbook |
| Migrations readiness | PASS | Static review 6 migration + Prisma validate 2 schema, không sửa migration | Chưa kiểm checksum/applied SQL/unique/FK thực | status/deploy DB test theo runbook |
| 200 đơn/20 chiếc, broker crash/redelivery | NOT VERIFIED | Plan và helper chuẩn bị; chưa có runtime/load proof | Gate chính về giữ hàng/tiền vẫn mở | Runner đủ tài nguyên và fault orchestration có kiểm soát |
| Production ready/toàn Phase 6 DONE | PARTIAL | Có code và unit/static; không integration/browser/real bank proof | Các gate trên chưa đạt, tính năng roadmap còn thiếu | Hoàn tất điều kiện DONE dưới đây |

Các lỗi FAIL đã xác định ở lượt đầu đều có fix/test PASS; không giữ một lỗi đỏ rồi
ghi toàn bộ PASS. Không suy diễn “không phát hiện bypass trong source” thành đã
pentest hoặc không còn lỗ hổng production.

### Test/check thực hiện trong 6.5A

| Lệnh / phạm vi | Kết quả |
| --- | --- |
| `node --test-name-pattern='6.5A' apps/storefront/test/storefront.test.mjs` | 2 regression mới: FAIL 2/2 trước fix; PASS 2/2 sau fix; không chạy cả suite cũ |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/phase6/contracts.test.mjs` | 7 ca ban đầu: 6 PASS, 1 FAIL do hai PUT Inventory thiếu security; chạy lại riêng controller methods sau fix PASS 1/1 |
| Ca guard môi trường mới, chạy riêng `--test-name-pattern='prepared integration guards'` | PASS 1/1, không network; chỉ import helper pure và parse Compose YAML |
| Tổng unit/component/contract mới | **10/10 đã PASS qua các lượt có mục tiêu**: 2 Storefront + 8 contract/guard; không cộng lại 105 tests lịch sử thành tests phiên này |
| `node --check` 4 integration scripts (2 cũ + HTTP/redeliver mới) | Syntax only, không execute script, không tính là integration PASS |
| Storefront lint/typecheck/build; ESLint tests/phase6; Prettier mã trực tiếp sửa | PASS; build JS ~465 KB, gzip ~139 KB |
| OpenAPI validate Inventory/Sales/Shop + generator `--check --only=inventory,sales,shop` | PASS |
| Prisma validate Inventory/Sales | PASS 2/2 schema; static only, không connect/migrate DB |
| 3 JavaScript recipes trong runbook và diff/whitespace | Syntax PASS, chỉ node --check; không tạo key/env hoặc execute recipe; whitespace PASS |
| 6.5B DB/RabbitMQ/HTTP/browser/load | **NOT RUN / NOT VERIFIED theo yêu cầu**, không probe/boot services hoặc dùng DB dev fallback |

### File thay đổi trong Task 6.5A

- `apps/storefront/src/state/catalog.ts`: matching variants và reference-price bounds.
- `apps/storefront/src/components/ui.tsx`: ProductCard giá/stock theo filter.
- `apps/storefront/src/pages/catalog.tsx`: truyền query đã validate vào card.
- `apps/storefront/test/storefront.test.mjs`: 2 regression mới có tiền tố 6.5A.
- `docs/api/inventory.openapi.yaml`: Bearer + audience cho 2 operation cấu hình online.
- `tests/phase6/contracts.test.mjs`: đối chiếu API/controller/Gateway/OpenAPI/events/
  topology, DTO public và guard môi trường; hoàn toàn không services.
- `tests/phase6/test-environment.mjs`: pure guards opt-in và đúng test role/schema/
  host/port/database; fixture identity, không tự mở kết nối.
- `infra/phase6/compose.acceptance.yml`: chỉ PostgreSQL/RabbitMQ test, cổng/volume riêng.
- `tests/phase6/fixture.sql`: fixture test mới, một transaction, guard DB/user, fail
  khi đã tồn tại; không reset/upsert hoặc sửa migration.
- `tests/phase6/http-flow.integration.mjs`: chuẩn bị live API + broker flow, hai actor
  receipt, by-key/private auth/refund request; không tự boot/migrate hoặc cleanup.
- `tests/phase6/redeliver.integration.mjs`: chuẩn bị publish hai lần cùng eventId
  lấy từ outbox fixture được chọn; confirm publication không thay DB assertion.
- `docs/phase6-acceptance-runbook.md` và file tiến độ này.

Không thêm dependency, không sửa backend service/POS/recovery/Auth hoặc migration,
không đổi lockfile/package manifests ở Task 6.5A. Không reset/restore/clean/switch
branch/commit/push. Toàn bộ file của task trước vẫn được giữ nguyên ngoài các sửa
mở rộng có mục tiêu nêu trên.

### Chuẩn bị 6.5B và điều kiện Phase 6 DONE

Runbook [phase6-acceptance-runbook.md](phase6-acceptance-runbook.md) có lệnh cụ thể
sinh cấu hình/key test riêng, infrastructure tối thiểu, thứ tự migration, reuse
hai DB integration scripts, fixture/live Gateway + RabbitMQ, duplicate/redelivery,
crash/recovery, SQL assertions và checklist Chrome/mobile. Những lệnh đó **chưa
thực thi**. Syntax/static guards không bảo đảm các helper mới chạy đúng trên môi
trường thật; cần nghiệm thu chính các helper ở lần 6.5B đầu tiên.

Để Phase 6 DONE cần: migration/test env thật đạt; A–G và 200/20 đúng DB cuối; outbox/
consumer/retry/DLQ/restart có bằng chứng; HTTP security branch/token và browser flow
đạt; chốt nguồn bank instructions/QR/receipt/provider; hoàn tất các phần roadmap
customer account/fulfilment/refund thực còn thiếu hoặc chủ dự án chấp nhận rõ phạm
vi nghiệm thu khác. **Hiện chưa đủ điều kiện nghiệm thu toàn Phase 6 hoặc production.**
Không tự chuyển Phase 7 hoặc đánh dấu Phase 5 hoàn thành.


## Task 6.5B — thực thi Docker integration ngày 2026-11-09

**Kết quả PARTIAL.** Đã dùng project `jewelry-phase6-acceptance` riêng: PostgreSQL
16.15 trên 55432/DB `phase6_test`, RabbitMQ 4.4.0 trên 55672/55673, volume/network/
credentials/key test riêng. Không ghi vào DB/volume chính, không đổi `.env` đang dùng.
Inventory/Sales/Gateway chạy Node tuần tự cổng 3092/3093/3090; không full-stack build.

- Migrations thực: Inventory 10/10; Sales chỉ 9/9 đến Phase 6. Cả 19 checksums trùng
  SQL gốc, status up to date trong phạm vi đã chọn. Automatic review đã từ chối
  deploy gồm Phase 7; dùng bản sao nguyên byte chỉ đến Phase 6 được cho phép.
  Không áp dụng buyback migration; full schema/Phase 7 compatibility chưa được chứng minh.
- PostgreSQL integration **11/11 PASS** (6 checkout, 5 payment): same-item race,
  POS contention, same/different keys, lost-result retry simulation, receipt/ref
  uniqueness, expiry race, paid-hold protection, rollback Inventory và Sales
  payment/alias/audit/outbox. Có DB assertions, không chỉ status HTTP.
- Live cases **12/12 đạt qua targeted runs**: một HTTP saga tổng hợp, 5 hậu kiểm
  DB/MQ/HTTP/log, 4 catalog update cases, 2 Gateway security/rate-limit cases.
  Hai FAIL ban đầu là lỗi fixture/assertion test mới, đã giữ evidence và rerun riêng.
- **4 recovery stages PASS**: broker offline/restart, consumer dừng/restart/backlog/
  projection backfill. Duplicate event không đổi paid-hold/refund state. Permanent
  invalid-version event vào DLQ đã kiểm và giữ nguyên thư; **chưa retry exhaustion**.
- Correlation Gateway→Sales, structured logs, redaction Authorization/Cookie/guest
  token đã kiểm ở các request thu được; không khẳng định mọi error path.
- Contract/static **8/8 PASS**; build/generate và lint/format integration scripts PASS.
  Không chạy lại toàn bộ unit suite lịch sử và không gọi browser E2E là PASS.
- Browser **NOT VERIFIED**: khi đủ backend RAM available có mẫu 433 MiB, swap gần
  đầy. Container healthy, OOM=false/restarts=0; không quy kết OOM/WSL disconnect.
- Không phát hiện backend bug cần sửa trong phạm vi đã chạy. Chỉ bổ sung tests,
  schema assertions và tài liệu; không sửa business policy, migration hay Phase 7–9.
- Đã dừng đúng test PIDs và containers acceptance; giữ volumes/queue/log/fixture
  để đối chiếu. PostgreSQL/RabbitMQ project chính vẫn chạy, không bị dừng.

[Matrix từng scenario, migrations và danh sách file](phase6-acceptance-report.md)
phân biệt PASS/NOT VERIFIED và giới hạn từng bằng chứng. Các gate còn mở: hard
crash đúng cửa sổ commit/ACK, MQ-02/05/07/08/09/10, HTTP timeout thực, catalog duplicate/
SOLD/outage riêng, browser/mobile, 200/20 trên runner đủ tài nguyên. DB lost-result
simulation không thay network timeout. Payment provider/webhook, bank/QR/receipt
khách, customer account, fulfilment và refund thực vẫn thiếu; không tự nghiệm thu
roadmap hoặc chuyển Phase 7. Không đủ điều kiện production ready.
