# inventory-service

Kim loại và giá, danh mục, phiếu nhập, tồn kho (giai đoạn 3A). Mỗi luồng gồm các bước, file và hàm chứa chúng, bảng bị ghi, tình huống đồng thời. Quyết định nghiệp vụ: `CLAUDE.md` mục 9; đặc tả API: `docs/api/inventory.openapi.yaml`.

**Quy ước:** chỉ vàng và bạc; mọi món theo tem (mỗi chiếc một `JewelryItem`); tồn kho = số chiếc `IN_STOCK`. Tiền `Decimal(15,2)` (đồng), trọng lượng `Decimal(12,4)` (chỉ), trong JSON là chuỗi thập phân. Quyền theo chi nhánh đọc từ token (`src/common/branch-access.ts`).

| File                               | Nội dung                                          |
| ---------------------------------- | ------------------------------------------------- |
| `src/catalog/metals.service.ts`    | Kim loại, giá hiện tại, lịch sử, nhập giá         |
| `src/catalog/catalog.service.ts`   | Danh mục, mẫu, biến thể                           |
| `src/receipts/receipts.service.ts` | Phiếu nhập: tạo nháp, dòng, duyệt                 |
| `src/stock/stock.service.ts`       | Danh sách chiếc, tra theo mã tem kèm giá          |
| `src/branch/branch-events.ts`      | Consumer `branch.created`, `branch.updated` → kho |
| `src/pricing/pricing.ts`           | Hàm tính giá và làm tròn (duy nhất)               |
| `src/common/`                      | Quyền chi nhánh, `AuditLog`, lỗi dùng chung       |

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

1. Tạo nháp cho kho của chi nhánh (MANAGER, STAFF chi nhánh đó, hoặc ADMIN): `create`. Chi nhánh chưa có kho → `404`.
2. Thêm, xoá dòng (mỗi dòng một chiếc, một mã tem): `addLine`, `removeLine`. Mỗi lần tăng `version` của phiếu bằng UPDATE có điều kiện `status = DRAFT`.
3. **Duyệt** (MANAGER hoặc ADMIN, kèm `version`): `approve` → `createStock`. Trong MỘT transaction: đổi phiếu sang `APPROVED`, tạo `JewelryItem` `IN_STOCK`, ghi `StockMovement` và `AuditLog`.

**Bảng ghi:** `GoodsReceipt`, `GoodsReceiptLine`, `JewelryItem`, `StockMovement`, `AuditLog`.

**Đồng thời:** hai người duyệt cùng phiếu. Bước đầu là UPDATE có điều kiện `id`, `version`, `status = DRAFT`: Postgres khoá dòng phiếu, bên đến sau thấy 0 dòng nên chỉ một bên tạo hàng. 0 dòng → đọc lại: đã `APPROVED` → `409 INVALID_STATE`, còn nháp nhưng lệch `version` → `409 VERSION_CONFLICT`. Mã tem trùng hàng đã có (unique `JewelryItem.tagCode`) → hoàn tác, `400` kèm các mã trùng. Deadlock → `runWithLockRetry` chạy lại tối đa 3 lần. Thêm hoặc xoá dòng khoá chính dòng phiếu nên không chen vào giữa lúc đang duyệt.

## Tồn kho

`stock.service.ts`: `list` (theo chi nhánh, biến thể, trạng thái, phân trang), `byTag` (mã tem kèm giá hiện tại). Người không phải ADMIN bắt buộc nêu chi nhánh của mình. Giá vốn chỉ ADMIN và MANAGER thấy. Chỉ đọc.

## Kho theo chi nhánh

`branch-events.ts`, đăng ký ở `app.module.ts`. `branch.created` tạo kho, `branch.updated` cập nhật tên và trạng thái. Một câu `INSERT ... ON CONFLICT ("branchId")` nên đúng dù thư đến trùng, đến lệch thứ tự (`updated` trước `created`), hay nhiều instance chạy song song. Consumer cơ sở của `libs/common` lo `ProcessedEvent`, retry và DLQ.

## Test

- `src/pricing/pricing.test.ts`: tính giá, làm tròn.
- `tests/inventory` (`pnpm test:inventory`, Postgres thật): duyệt song song, duyệt sai `version`, `branch.created` trùng.
