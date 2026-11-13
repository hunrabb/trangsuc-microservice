# inventory-service

Kim loại và giá, danh mục, phiếu nhập, tồn kho (giai đoạn 3A). Mỗi luồng gồm các bước, file và hàm chứa chúng, bảng bị ghi, tình huống đồng thời. Quyết định nghiệp vụ: `CLAUDE.md` mục 9; đặc tả API: `docs/api/inventory.openapi.yaml`.

**Quy ước:** chỉ vàng và bạc; mọi món theo tem (mỗi chiếc một `JewelryItem`); tồn kho = số chiếc `IN_STOCK`. Tiền `Decimal(15,2)` (đồng), trọng lượng `Decimal(12,4)` (chỉ), trong JSON là chuỗi thập phân. Quyền theo chi nhánh đọc từ token (`src/common/branch-access.ts`).

| File                                     | Nội dung                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `src/catalog/metals.service.ts`          | Kim loại, giá hiện tại, lịch sử, nhập giá                          |
| `src/catalog/catalog.service.ts`         | Danh mục, mẫu, biến thể                                            |
| `src/receipts/receipts.service.ts`       | Phiếu nhập: tạo nháp, dòng, duyệt                                  |
| `src/stock/stock.service.ts`             | Danh sách chiếc, tra theo mã tem kèm giá                           |
| `src/stock/item-sales.service.ts`        | Báo giá, trừ kho, trả kho cho sales (POS), chống bán trùng một tem |
| `src/stock/internal-stock.controller.ts` | Cửa vào HTTP nội bộ `/internal/stock/*`                            |
| `src/stock/label.controller.ts`          | Dữ liệu in tem (`getLabel` ở `stock.service.ts`)                   |
| `src/branch/branch-events.ts`            | Consumer `branch.created`, `branch.updated` → kho                  |
| `src/pricing/pricing.ts`                 | Hàm tính giá và làm tròn (duy nhất)                                |
| `src/common/`                            | Quyền chi nhánh, `AuditLog`, lỗi dùng chung                        |

## Giá kim loại

1. ADMIN nhập giá: `createPrice` trong `metals.service.ts`. Dòng `MetalPrice` (chỉ ghi thêm), `AuditLog` và outbox `metal_price.changed` trong MỘT transaction.
2. Giá hiện tại: `findCurrentPrice`: dòng có `effectiveFrom` mới nhất `<= now()` (giờ của Postgres). Chưa có → `409 METAL_PRICE_NOT_SET`.

**Đồng thời:** hai ADMIN nhập cùng lúc thì cả hai dòng được ghi; "mới nhất" do `effectiveFrom` (rồi `createdAt`) quyết định. Không sửa giá cũ.

## Tính giá

`computeItemPrice` = trọng lượng × giá bán ra + tiền công, làm tròn nửa lên tới 1.000 đồng MỘT lần ở cuối. Dùng `Decimal`, không dùng `number`. Chỉ để xem; giá chốt khi bán do sales ghi vào hoá đơn.

## Danh mục, mẫu, biến thể

`catalog.service.ts`. Chỉ ADMIN ghi. Sửa gửi `version`: `updateMany({ where: { id, version } })`, 0 dòng thì `404` hoặc `409 VERSION_CONFLICT`. Không xoá, chỉ đặt `isActive = false`.

**Đồng thời:** trùng `code`, `name`, `sku` do unique chặn, bắt `P2002` đúng index, trả `400` kèm `details.fields`.

## Phiếu nhập

1. ADMIN chọn chi nhánh nhận hàng và tạo phiếu nháp cho kho của chi nhánh: `create`. Chi nhánh chưa có kho → `404`.
2. Thêm, xoá dòng (mỗi dòng một chiếc, một mã tem): `addLine`, `removeLine`. Mỗi lần tăng `version` của phiếu bằng UPDATE có điều kiện `status = DRAFT`.
3. **Duyệt** (chỉ ADMIN, kèm `version`): `approve` → `createStock`. Trong MỘT transaction: đổi phiếu sang `APPROVED`, tạo `JewelryItem` `IN_STOCK`, ghi `StockMovement` và `AuditLog`.

**Bảng ghi:** `GoodsReceipt`, `GoodsReceiptLine`, `JewelryItem`, `StockMovement`, `AuditLog`.

**Đồng thời:** hai người duyệt cùng phiếu. Bước đầu là UPDATE có điều kiện `id`, `version`, `status = DRAFT`: Postgres khoá dòng phiếu, bên đến sau thấy 0 dòng nên chỉ một bên tạo hàng. 0 dòng → đọc lại: đã `APPROVED` → `409 INVALID_STATE`, còn nháp nhưng lệch `version` → `409 VERSION_CONFLICT`. Mã tem trùng hàng đã có (unique `JewelryItem.tagCode`) → hoàn tác, `400` kèm các mã trùng. Deadlock → `runWithLockRetry` chạy lại tối đa 3 lần. Thêm hoặc xoá dòng khoá chính dòng phiếu nên không chen vào giữa lúc đang duyệt.

## Tồn kho

`stock.service.ts`: `list` (theo chi nhánh, biến thể, trạng thái, phân trang), `byTag` (mã tem kèm giá hiện tại). Người không phải ADMIN bắt buộc nêu chi nhánh của mình. Giá vốn chỉ ADMIN và MANAGER thấy. Chỉ đọc.

## API nội bộ cho POS (3B)

Các binding `order.created`, `order.paid`, `order.cancelled` đã có trong topology. `stock/pos-order-events.ts`
kiểm `channel = POS` rồi ack qua consumer chung (vẫn ghi ProcessedEvent): kho đã được đổi qua HTTP nên không
trừ hay trả lần thứ hai. Payload ngoài POS hiện chưa được hỗ trợ.

Đường `/internal/stock/*`, chỉ gọi được trong mạng Docker: gateway không bao giờ chuyển tiếp `/internal/*`, nên không kiểm token. Controller là [internal-stock.controller.ts](src/stock/internal-stock.controller.ts), toàn bộ logic ở [item-sales.service.ts](src/stock/item-sales.service.ts). Schema yêu cầu và kết quả: `libs/contracts/src/inventory-internal-api.ts`.

`GET /internal/stock/orders/{orderId}` (`getOrderState`) trả dấu `released` và tem đang `SOLD`
cho đúng `orderId` trong snapshot `REPEATABLE READ`. Sales dùng kết quả này khi phục hồi đơn quá
lease; kết quả chỉ là đọc, thao tác release/deduct tiếp theo vẫn phải dùng khoá theo orderId.

### Báo giá: `POST /internal/stock/quote` (`quoteItems`)

Sales gửi danh sách mã tem (tối đa 100). Các bước:

1. Đọc các chiếc theo mã tem, kèm kho (để biết chi nhánh) và biến thể (để biết kim loại): `quoteItems`.
2. Tra giá bán ra hiện tại của từng kim loại, mỗi kim loại một lần: `loadSellPrices` (dùng `findCurrentPrice` của `metals.service.ts`).
3. Với từng mã tem, trả "còn bán được" hay không và lý do (`NOT_FOUND`, `WRONG_BRANCH`, `NOT_IN_STOCK`); nếu còn bán được thì kèm trọng lượng, tiền công, giá kim loại, giá tính bằng `computeItemPrice`: `quoteOneItem`.

Bảng bị ghi: không có. Chỉ đọc và không khoá, nên kết quả có thể cũ ngay sau đó; muốn giữ hàng thật phải gọi `deduct`. Kim loại chưa có giá thì `metalSellPricePerChi` và `price` là `null`.

### Trừ kho: `POST /internal/stock/deduct` (`deductItemsForOrder`)

Sales gửi `orderId`, `branchId`, danh sách mã tem. Tất cả hoặc không có gì, trong MỘT transaction (có `runWithLockRetry` và `lock_timeout` 3 giây). Các bước theo thứ tự:

1. **Khoá theo `orderId`** trong `StockOrderOperation` trước khi khoá chiếc. Nếu `releasedAt` đã có, trả `409 INVALID_STATE`; một `deduct` đến muộn sau `release` không thể bán lại bằng đơn đã huỷ: `lockOrderOperation`.
2. **Khoá** các chiếc theo mã tem, sắp theo `id`, rồi đọc lại trạng thái mới nhất: `lockAndLoadItemsByTag`.
3. **Kiểm tra mã tem** có tồn tại và thuộc kho chi nhánh này không, sai thì `409 ITEM_NOT_AVAILABLE` kèm các mã tem: `assertEveryTagExistsInBranch`.
4. **Xem đơn này đang ở đâu** dựa trên các dòng đã khoá: `checkOrderProgress`.
   - Mọi chiếc đã `SOLD` cho chính `orderId` này: đây là lần gọi lặp, trả kết quả cũ (`replayed = true`) từ giá đã chốt trên từng chiếc: `buildStoredResult`.
   - Một phần thuộc đơn này, hoặc đơn này đang giữ chiếc khác: cùng `orderId` khác nội dung, `422 IDEMPOTENCY_KEY_REUSED`.
   - Có chiếc không còn `IN_STOCK` (đã bán cho đơn khác): `409 ITEM_NOT_AVAILABLE` kèm mã tem.
5. **Kiểm tra lịch sử cũ**: `assertOrderWasNotReleasedBefore` chặn đơn đã có movement `RELEASE` trước khi bảng `StockOrderOperation` được thêm.
6. **Giữ hàng**: `reserveItems`. Với từng chiếc: lấy giá kim loại hiện tại (chưa có giá thì `409 METAL_PRICE_NOT_SET`), tính giá, rồi `markItemAsSold` bằng UPDATE có điều kiện `WHERE id = ? AND status = 'IN_STOCK'`, ghi đơn và giá chốt vào chiếc đó. Kết quả thêm `productName` để sales chép tên mẫu vào hoá đơn mà không đọc chéo schema.
7. **Ghi sổ kho** `StockMovement` loại `SALE` (`recordMovements`) và **ghi outbox** `stock.changed` lý do `SOLD` (`queueStockChangedEvent`).

Bảng bị ghi: `StockOrderOperation`, `JewelryItem` (`status`, `orderId`, `soldAt`, giá chốt, `version`), `StockMovement`, `OutboxEvent`.

**Đồng thời:**

- _Hai đơn cùng mua một tem:_ chiếc đó bị khoá ở bước 1. Đơn đến sau chờ đơn trước xong, rồi thấy `SOLD` ở bước 3 và nhận `409`. Đúng một đơn thành công.
- _Vì sao khoá theo `id`:_ hai đơn mua cùng một nhóm tem theo thứ tự khác nhau (đơn A: tem 1 rồi 2, đơn B: tem 2 rồi 1) sẽ khoá chéo nhau và deadlock. Cùng sắp theo `id` thì cả hai khoá theo cùng một thứ tự, nên chỉ chờ chứ không vòng tròn.
- _Cùng `orderId` gọi hai lần song song:_ lần sau chờ khoá, rồi thấy các chiếc đã `SOLD` cho chính `orderId` này (bước 3) và trả kết quả cũ. Không trừ kho hai lần, sổ kho không ghi trùng, chỉ phát một sự kiện.
- _Lớp bảo vệ thứ hai:_ UPDATE ở bước 5 vẫn có điều kiện `status = 'IN_STOCK'`; 0 dòng thì hoàn tác. Sổ kho có unique (`refType`, `refId`, `jewelryItemId`, `type`) và ghi bằng `skipDuplicates`.
- Deadlock còn sót lại: `runWithLockRetry` chạy lại tối đa 3 lần; vẫn lỗi hoặc chờ khoá quá 3 giây thì `503`.

### Trả kho: `POST /internal/stock/release` (`releaseItemsForOrder`)

Sales gửi `orderId` khi đơn thất bại hoặc bị huỷ. Trong MỘT transaction:

1. Khoá `StockOrderOperation` theo `orderId`, rồi khoá các chiếc đang giữ bởi đơn này theo `id`: `lockOrderOperation`, `lockAndLoadItemsByOrder`.
2. Không còn chiếc nào `SOLD`: ghi `releasedAt` trong cùng transaction, trả danh sách rỗng, không phát sự kiện. Dấu này chặn `deduct` đến muộn kể cả khi release đến trước commit.
3. Với từng chiếc `SOLD`: về `IN_STOCK`, xoá đơn và giá chốt, bằng UPDATE có điều kiện `status = 'SOLD' AND orderId = ?`: `markItemAsInStock`.
4. Ghi sổ kho loại `RELEASE`, outbox `stock.changed` lý do `RELEASED`, và `releasedAt` trong cùng transaction.

Bảng bị ghi: `StockOrderOperation`, `JewelryItem`, `StockMovement`, `OutboxEvent`.

**Đồng thời:** `release` và `deduct` cùng đơn khoá cùng dòng `StockOrderOperation` trước các chiếc. Nếu `deduct` commit trước, `release` chờ rồi trả hàng. Nếu `release` commit trước, `deduct` thấy `releasedAt` và bị chặn. Hai `release` song song không ghi trùng. Chiếc đã release vẫn bán lại được cho đơn khác.


## In tem: `GET /jewelry-items/{tagCode}/label` (`getLabel`)

Đọc chiếc, mẫu, biến thể, kim loại (`stock.service.ts`), tra giá bán ra hiện tại, tính giá tạm tính bằng `computeItemPrice`. Chỉ trả JSON (mã tem, tên mẫu, biến thể, SKU, tên kim loại đã gồm tuổi, trọng lượng, giá bán ra / chỉ, giá tạm tính); frontend dựng tem. Kim loại chưa có giá thì hai trường giá là `null`, không báo lỗi. Không ghi bảng nào.

## Kho theo chi nhánh

`branch-events.ts`, đăng ký ở `app.module.ts`. `branch.created` tạo kho, `branch.updated` cập nhật tên và trạng thái. Một câu `INSERT ... ON CONFLICT ("branchId")` nên đúng dù thư đến trùng, đến lệch thứ tự (`updated` trước `created`), hay nhiều instance chạy song song. Consumer cơ sở của `libs/common` lo `ProcessedEvent`, retry và DLQ.

## Test

- `src/pricing/pricing.test.ts`: tính giá, làm tròn.
- `tests/inventory` (`pnpm test:inventory`, Postgres thật): duyệt song song, duyệt sai `version`, `branch.created` trùng; hai đơn tranh một tem (10 vòng), `deduct` lặp cùng `orderId`, `release` trước hoặc sau commit `deduct`.

## Chốt tồn kho đêm (Phase 5.2)

`InventoryCloseWorker` trong `src/stock/inventory-close.worker.ts` chạy mỗi phút, chỉ làm việc
từ 00:05 đến 00:59 giờ Việt Nam để chốt ngày trước. `InventoryDailyClose` lưu bản chốt bất biến
theo kho/ngày; cùng transaction phát `inventory.snapshot.closed` qua outbox cho Report.
Unique ngày/kho và advisory lock chống chạy trùng giữa nhiều instance. Nếu toàn bộ khung giờ
thất bại, ngày đó thiếu bản chốt; không lấy tồn hiện tại dựng lại ngày cũ. Movement dùng
`RECEIPT`, `RELEASE`, `SALE`; `COUNT_MISSING` chỉ là dữ liệu lịch sử của chức năng đã gỡ.

Quyền phiếu nhập: chỉ ADMIN được xem danh sách/chi tiết, tạo nháp, thêm/xoá dòng và duyệt. STAFF/MANAGER vẫn xem tồn kho theo quyền chi nhánh; không truy cập API phiếu nhập.

## Tổng hợp tồn kho theo biến thể

Trang Tồn kho có hai chế độ theo mẫu/biến thể và theo mã tem, drilldown giữ đúng chi nhánh. API đọc mới `GET /api/admin/inventory/items/summary` bắt buộc `branchId`. Xem [quy tắc đếm và kiểm chứng](../../docs/stock-summary.md). Không thay đổi schema hay quy tắc bán theo tem.
