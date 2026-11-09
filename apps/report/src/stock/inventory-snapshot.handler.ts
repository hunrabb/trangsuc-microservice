import { createHash } from 'node:crypto';
import { PermanentError } from '@jewelry/common';
import { type EventEnvelope, inventorySnapshotClosedPayloadSchema } from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';

/** Ghi bản chốt đúng một lần; event đến sai thứ tự vẫn được lưu theo ngày để API kiểm tra đủ mốc. */
export async function recordInventorySnapshot(
  payload: unknown,
  context: { tx: Prisma.TransactionClient; envelope: EventEnvelope },
): Promise<void> {
  const parsed = inventorySnapshotClosedPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentError('Sự kiện inventory.snapshot.closed không hợp lệ');
  const close = parsed.data;
  const payloadHash = createHash('sha256').update(JSON.stringify(close)).digest('hex');
  if (new Set(close.rows.map((row) => row.variantId)).size !== close.rows.length) {
    throw new PermanentError('Bản chốt kho chứa biến thể trùng');
  }
  await context.tx.inventorySnapshotBatch.createMany({
    data: [
      {
        id: close.closeId,
        localDate: close.localDate,
        warehouseId: close.warehouseId,
        branchId: close.branchId,
        payloadHash,
        capturedAt: new Date(close.capturedAt),
        previousCapturedAt: close.previousCapturedAt ? new Date(close.previousCapturedAt) : null,
      },
    ],
    skipDuplicates: true,
  });
  const stored = await context.tx.inventorySnapshotBatch.findUniqueOrThrow({
    where: {
      localDate_warehouseId: { localDate: close.localDate, warehouseId: close.warehouseId },
    },
  });
  if (
    stored.id !== close.closeId ||
    stored.branchId !== close.branchId ||
    stored.payloadHash !== payloadHash ||
    stored.capturedAt.toISOString() !== close.capturedAt
  ) {
    throw new PermanentError('Bản chốt kho mâu thuẫn với dữ liệu đã nhận');
  }
  await context.tx.inventorySnapshot.createMany({
    data: close.rows.map((row) => ({
      localDate: close.localDate,
      warehouseId: close.warehouseId,
      batchId: close.closeId,
      variantId: row.variantId,
      sku: row.sku,
      metalId: row.metalId,
      metalCode: row.metalCode,
      metalKind: row.metalKind,
      onHand: row.onHand,
      weight: row.weight,
      value: row.value,
      received: row.received,
      receivedWeight: row.receivedWeight,
      receivedValue: row.receivedValue,
      released: row.released,
      releasedWeight: row.releasedWeight,
      releasedValue: row.releasedValue,
      sold: row.sold,
      soldWeight: row.soldWeight,
      soldValue: row.soldValue,
    })),
    skipDuplicates: true,
  });
}
