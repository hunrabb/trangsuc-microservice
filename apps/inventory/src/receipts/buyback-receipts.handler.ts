import { createHash } from 'node:crypto';
import { outbox, PermanentError } from '@jewelry/common';
import {
  buybackSettledEventSchema,
  buybackStockedEventSchema,
  ROUTING_KEYS,
  type BuybackSettledEvent,
  type EventEnvelope,
} from '@jewelry/contracts';
import { Prisma } from '../generated/prisma/client';
import { writeAudit } from '../common/audit';

type Tx = Prisma.TransactionClient;
const uuid = (key: string) => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const holdingProductId = uuid('inventory:buyback:holding-product:v1');
const holdingCategoryName = '__BUYBACK_HOLDING__';
const decimal = (value: string) => new Prisma.Decimal(value);

function validate(value: unknown): BuybackSettledEvent {
  const parsed = buybackSettledEventSchema.safeParse(value);
  if (!parsed.success) throw new PermanentError('Snapshot buyback.settled sai định dạng');
  const data = parsed.data;
  if (
    new Set(data.lines.map((line) => line.quoteLineId)).size !== data.lines.length ||
    new Set(data.lines.map((line) => line.intakeItemId)).size !== data.lines.length ||
    data.lines.some(
      (line) =>
        decimal(line.acceptedWeight).lte(0) ||
        decimal(line.purityPerMille).lte(0) ||
        decimal(line.purityPerMille).gt(1000),
    ) ||
    !data.lines
      .reduce((sum, line) => sum.add(line.amount), decimal('0'))
      .equals(data.approvedAmount)
  )
    throw new PermanentError('Dòng thu mua trùng hoặc tổng không khớp quote');
  const due = decimal(data.amountDue);
  if (
    (data.kind === 'DIRECT' &&
      (data.saleAmount !== null ||
        data.direction !== 'STORE_PAYS' ||
        !due.equals(data.approvedAmount))) ||
    (data.kind === 'EXCHANGE' &&
      (data.saleAmount === null ||
        !decimal(data.saleAmount).minus(data.approvedAmount).abs().equals(due) ||
        (decimal(data.saleAmount).gt(data.approvedAmount)
          ? 'CUSTOMER_PAYS'
          : decimal(data.saleAmount).lt(data.approvedAmount)
            ? 'STORE_PAYS'
            : 'NONE') !== data.direction))
  )
    throw new PermanentError('Số tiền settlement không nhất quán');
  return data;
}

async function holdingVariants(tx: Tx, lines: BuybackSettledEvent['lines']) {
  const metalIds = [...new Set(lines.map((line) => line.metalId))].sort();
  const metals = await tx.metal.findMany({ where: { id: { in: metalIds } } });
  if (
    metals.length !== metalIds.length ||
    metals.some((metal) =>
      lines.some((line) => line.metalId === metal.id && line.metalKind !== metal.kind),
    )
  )
    throw new PermanentError('Kim loại thu mua không tồn tại hoặc sai loại');
  const category = await tx.category.upsert({
    where: { name: holdingCategoryName },
    create: { name: holdingCategoryName, isActive: false },
    update: {},
  });
  await tx.product.createMany({
    data: [
      {
        id: holdingProductId,
        categoryId: category.id,
        name: 'Hàng thu mua chờ phân loại',
        isActive: false,
        publishedOnline: false,
      },
    ],
    skipDuplicates: true,
  });
  const product = await tx.product.findUniqueOrThrow({ where: { id: holdingProductId } });
  if (product.categoryId !== category.id || product.isActive || product.publishedOnline)
    throw new PermanentError('Danh mục giữ hộ thu mua không an toàn');
  const variantIds = new Map(
    metalIds.map((id) => [id, uuid(`inventory:buyback:holding-variant:${id}`)]),
  );
  await tx.productVariant.createMany({
    data: metalIds.map((id) => ({
      id: variantIds.get(id)!,
      productId: holdingProductId,
      metalId: id,
      sku: `BB-HOLD-${id}`,
      name: 'Chờ phân loại',
      isActive: false,
      defaultLaborFee: '0',
    })),
    skipDuplicates: true,
  });
  const variants = await tx.productVariant.findMany({
    where: { id: { in: [...variantIds.values()] } },
  });
  if (
    variants.length !== metalIds.length ||
    variants.some(
      (variant) =>
        variant.productId !== holdingProductId ||
        variant.isActive ||
        variant.metalId !== metalIds.find((id) => variantIds.get(id) === variant.id),
    )
  )
    throw new PermanentError('Biến thể giữ hộ thu mua không an toàn');
  return variantIds;
}

/** Consumer transaction also owns ProcessedEvent. Receipt, items, movements, audit and outbox commit together. */
export async function receiveSettledBuyback(
  payload: unknown,
  { tx }: { tx: Tx; envelope: EventEnvelope },
) {
  const data = validate(payload);
  const lines = [...data.lines].sort((a, b) => a.quoteLineId.localeCompare(b.quoteLineId));
  const sourceHash = createHash('sha256')
    .update(JSON.stringify({ ...data, lines }))
    .digest('hex');
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('buyback.receipt'), hashtext(${data.settlementId}))::text AS lock`;
  const prior = await tx.goodsReceipt.findUnique({
    where: { sourceSettlementId: data.settlementId },
  });
  if (prior) {
    if (prior.sourceHash !== sourceHash || prior.source !== 'BUYBACK')
      throw new PermanentError('Settlement đã ghi kho với snapshot khác');
    return;
  }
  const warehouse = await tx.warehouse.findUnique({ where: { branchId: data.branchId } });
  if (!warehouse || !warehouse.isActive)
    throw new Error('Kho nhận thu mua chưa tồn tại hoặc đã ngừng hoạt động');
  const variantIds = await holdingVariants(tx, lines);
  const receivedAt = new Date();
  const receiptId = data.settlementId;
  await tx.goodsReceipt.create({
    data: {
      id: receiptId,
      code: `BB-${data.settlementId}`,
      warehouseId: warehouse.id,
      status: 'APPROVED',
      source: 'BUYBACK',
      sourceSettlementId: data.settlementId,
      sourceHash,
      note: null,
      createdBy: data.createdBy,
      approvedBy: data.confirmedBy,
      approvedAt: receivedAt,
    },
  });
  const items = lines.map((line) => ({
    ...line,
    jewelryItemId: line.quoteLineId,
    tagCode: `BB-${line.quoteLineId}`,
  }));
  await tx.goodsReceiptLine.createMany({
    data: items.map((item) => ({
      id: item.quoteLineId,
      receiptId,
      variantId: variantIds.get(item.metalId)!,
      tagCode: item.tagCode,
      weight: item.acceptedWeight,
      laborFee: '0',
      costPrice: item.amount,
      sourceIntakeItemId: item.intakeItemId,
      sourceQuoteLineId: item.quoteLineId,
      purityPerMille: item.purityPerMille,
    })),
  });
  await tx.jewelryItem.createMany({
    data: items.map((item) => ({
      id: item.jewelryItemId,
      tagCode: item.tagCode,
      variantId: variantIds.get(item.metalId)!,
      warehouseId: warehouse.id,
      weight: item.acceptedWeight,
      laborFee: '0',
      costPrice: item.amount,
      status: 'PENDING_MELT',
      origin: 'BOUGHT_BACK',
      sourceSettlementId: data.settlementId,
      sourceIntakeItemId: item.intakeItemId,
      sourceQuoteLineId: item.quoteLineId,
      purityPerMille: item.purityPerMille,
    })),
  });
  await tx.stockMovement.createMany({
    data: items.map((item) => ({
      jewelryItemId: item.jewelryItemId,
      warehouseId: warehouse.id,
      type: 'BUYBACK',
      toStatus: 'PENDING_MELT',
      refType: 'BuybackSettlement',
      refId: data.settlementId,
      createdBy: data.confirmedBy,
    })),
  });
  await writeAudit(tx, {
    actorId: data.confirmedBy,
    action: 'buyback.received',
    entityType: 'GoodsReceipt',
    entityId: receiptId,
    data: { settlementId: data.settlementId, itemCount: items.length },
  });
  const stocked = buybackStockedEventSchema.parse({
    version: 1,
    settlementId: data.settlementId,
    branchId: data.branchId,
    warehouseId: warehouse.id,
    receiptId,
    receivedAt: receivedAt.toISOString(),
    approvedAmount: data.approvedAmount,
    items,
  });
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.BUYBACK_STOCKED,
    aggregateType: 'GoodsReceipt',
    aggregateId: receiptId,
    payload: stocked,
  });
}
