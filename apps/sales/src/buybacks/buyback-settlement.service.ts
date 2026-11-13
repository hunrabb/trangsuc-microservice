import { createHash, randomUUID } from 'node:crypto';
import {
  BusinessError,
  outbox,
  runWithLockRetry,
  violatedUniqueIndex,
  type AuthUser,
} from '@jewelry/common';
import {
  createSettlementSchema,
  createExchangeSchema,
  recordSettlementPaymentSchema,
  confirmSettlementPaymentSchema,
  cancelSettlementSchema,
  settlementViewSchema,
  idempotencyKeySchema,
  ROUTING_KEYS,
  buybackSettledEventSchema,
  type CreateSettlement,
  type CreateExchange,
  type RecordSettlementPayment,
  type ConfirmSettlementPayment,
  type CancelSettlement,
  type ExchangeHold,
  type SettlementView,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma, type BuybackSettlement } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertOrderBranch } from '../core/order-record';
import { ExchangeClient } from './exchange-client';

type Tx = Prisma.TransactionClient;
const missing = () => new BusinessError('NOT_FOUND', 'Không tìm thấy settlement', 404);
const conflict = () => new BusinessError('VERSION_CONFLICT', 'Settlement đã thay đổi', 409);
const invalid = () =>
  new BusinessError('INVALID_STATE', 'Trạng thái settlement không cho phép', 409);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function manager(user: AuthUser, branchId: string) {
  assertOrderBranch(user, branchId);
  if (
    !user.branches.some(
      (r) =>
        (r.role === 'ADMIN' && r.branchId === null) ||
        (r.role === 'MANAGER' && r.branchId === branchId),
    )
  )
    throw new BusinessError('FORBIDDEN', 'Chỉ quản lý chi nhánh hoặc ADMIN xác nhận tiền', 403);
}
function present(row: BuybackSettlement): SettlementView {
  return settlementViewSchema.parse({
    id: row.id,
    intakeId: row.intakeId,
    quoteId: row.quoteId,
    branchId: row.branchId,
    kind: row.kind,
    status: row.status,
    version: row.version,
    method: row.method,
    approvedAmount: row.approvedAmount.toFixed(2),
    saleAmount: row.saleAmount?.toFixed(2) ?? null,
    difference: row.difference?.toFixed(2) ?? null,
    direction: row.direction,
    amountDue: row.amountDue?.toFixed(2) ?? null,
    tagCode: row.tagCode,
    reservationId: row.reservationId,
    reservationExpiresAt: row.reservationExpiresAt?.toISOString() ?? null,
    paymentReference: row.paymentReference,
    paymentEvidence: row.paymentEvidence,
    paymentRecordedBy: row.paymentRecordedBy,
    paymentConfirmedBy: row.paymentConfirmedBy,
    paymentConfirmedAt: row.paymentConfirmedAt?.toISOString() ?? null,
    confirmationNote: row.confirmationNote,
    orderId: row.orderId,
    failureCode: row.failureCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

@Injectable()
export class BuybackSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: ExchangeClient,
  ) {}
  private write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runWithLockRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          return fn(tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
  }
  private async locked(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM "sales"."BuybackSettlement" WHERE id=${id}::uuid FOR UPDATE`;
    return tx.buybackSettlement.findUnique({ where: { id } });
  }
  private async audit(
    tx: Tx,
    row: BuybackSettlement,
    actorId: string | null,
    action: string,
    status: BuybackSettlement['status'],
    detail: unknown,
  ) {
    await tx.buybackSettlementAudit.create({
      data: {
        settlementId: row.id,
        actorId,
        action,
        fromStatus: row.status,
        toStatus: status,
        fromVersion: row.version,
        toVersion: row.version + 1,
        detail: json(detail),
      },
    });
  }
  private async advance(
    tx: Tx,
    row: BuybackSettlement,
    actorId: string | null,
    action: string,
    status: BuybackSettlement['status'],
    data: Prisma.BuybackSettlementUncheckedUpdateManyInput = {},
    detail: unknown = {},
  ) {
    const updated = await tx.buybackSettlement.updateMany({
      where: { id: row.id, version: row.version, status: row.status },
      data: { ...data, status, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw conflict();
    await this.audit(tx, row, actorId, action, status, detail);
    return tx.buybackSettlement.findUniqueOrThrow({ where: { id: row.id } });
  }
  private async addStockEvent(tx: Tx, row: BuybackSettlement) {
    if (
      row.status !== 'SETTLED' ||
      !row.paymentConfirmedAt ||
      !row.paymentConfirmedBy ||
      !row.direction ||
      !row.amountDue
    )
      throw invalid();
    const lines = await tx.buybackQuoteLine.findMany({
      where: { quoteId: row.quoteId },
      orderBy: { id: 'asc' },
    });
    if (
      !lines.length ||
      !lines
        .reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0))
        .equals(row.approvedAmount)
    )
      throw invalid();
    const payload = buybackSettledEventSchema.parse({
      version: 1,
      settlementId: row.id,
      intakeId: row.intakeId,
      quoteId: row.quoteId,
      branchId: row.branchId,
      kind: row.kind,
      approvedAmount: row.approvedAmount.toFixed(2),
      saleAmount: row.saleAmount?.toFixed(2) ?? null,
      direction: row.direction,
      amountDue: row.amountDue.toFixed(2),
      settledAt: row.updatedAt.toISOString(),
      confirmedBy: row.paymentConfirmedBy,
      createdBy: row.createdBy,
      lines: lines.map((line) => ({
        quoteLineId: line.id,
        intakeItemId: line.itemId,
        metalId: line.metalId,
        metalKind: line.metalKind,
        acceptedWeight: line.acceptedWeight.toFixed(4),
        purityPerMille: line.purityPerMille.toFixed(4),
        amount: line.amount.toFixed(2),
      })),
    });
    await outbox.add(tx, {
      eventType: ROUTING_KEYS.BUYBACK_SETTLED,
      aggregateType: 'BuybackSettlement',
      aggregateId: row.id,
      payload,
    });
  }
  /** Bù những SETTLED trước khi rollout 7.4 hoặc đã commit nhưng thiếu event. */
  async ensureStockEvent(id: string): Promise<void> {
    await this.write(async (tx) => {
      const row = await this.locked(tx, id);
      if (!row || row.status !== 'SETTLED') return;
      const prior = await tx.outboxEvent.findFirst({
        where: { aggregateId: id, eventType: ROUTING_KEYS.BUYBACK_SETTLED },
        select: { id: true },
      });
      if (!prior) await this.addStockEvent(tx, row);
    });
  }
  private async command(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    id: string,
    key: string,
    input: unknown,
    fn: (tx: Tx, row: BuybackSettlement) => Promise<BuybackSettlement>,
  ) {
    assertOrderBranch(user, branchId);
    id = id.toLowerCase();
    key = idempotencyKeySchema.parse(key);
    const requestHash = hash(input);
    return this.write(async (tx) => {
      const row = await this.locked(tx, id);
      if (!row || row.branchId !== branchId || row.intakeId !== intakeId.toLowerCase())
        throw missing();
      const prior = await tx.buybackSettlementRequest.findUnique({
        where: {
          settlementId_actorId_idempotencyKey: {
            settlementId: id,
            actorId: user.id,
            idempotencyKey: key,
          },
        },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
        return present(row);
      }
      const result = await fn(tx, row);
      const view = present(result);
      await tx.buybackSettlementRequest.create({
        data: {
          settlementId: id,
          actorId: user.id,
          idempotencyKey: key,
          requestHash,
          result: json(view),
        },
      });
      return view;
    });
  }
  async createDirect(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    key: string,
    input: CreateSettlement,
  ) {
    return this.create(
      user,
      branchId,
      intakeId,
      key,
      'DIRECT',
      createSettlementSchema.parse(input),
    );
  }
  async createExchange(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    key: string,
    input: CreateExchange,
  ) {
    return this.create(
      user,
      branchId,
      intakeId,
      key,
      'EXCHANGE',
      createExchangeSchema.parse(input),
    );
  }
  private async create(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    key: string,
    kind: 'DIRECT' | 'EXCHANGE',
    body: CreateSettlement | CreateExchange,
  ): Promise<SettlementView> {
    assertOrderBranch(user, branchId);
    intakeId = intakeId.toLowerCase();
    key = idempotencyKeySchema.parse(key);
    const creationHash = hash({ kind, ...body });
    const result = await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "sales"."BuybackIntake" WHERE id=${intakeId}::uuid AND "branchId"=${branchId}::uuid FOR UPDATE`;
      const intake = await tx.buybackIntake.findFirst({ where: { id: intakeId, branchId } });
      if (!intake) throw missing();
      const prior = await tx.buybackSettlement.findUnique({
        where: {
          intakeId_createdBy_creationKey: { intakeId, createdBy: user.id, creationKey: key },
        },
      });
      if (prior) {
        if (prior.creationHash !== creationHash)
          throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
        return prior;
      }
      if (intake.status !== 'APPROVED' || !intake.activeQuoteId) throw invalid();
      if (intake.version !== body.version) throw conflict();
      const active = await tx.buybackSettlement.findFirst({
        where: { intakeId, status: { not: 'CANCELLED' } },
      });
      if (active) throw invalid();
      const quote = await tx.buybackQuote.findFirst({
        where: { id: intake.activeQuoteId, intakeId, status: 'APPROVED' },
      });
      if (!quote) throw invalid();
      const row = await tx.buybackSettlement.create({
        data: {
          id: randomUUID(),
          intakeId,
          quoteId: quote.id,
          branchId,
          kind,
          status: kind === 'DIRECT' ? 'AWAITING_PAYMENT' : 'RESERVING',
          method: body.method,
          approvedAmount: quote.total,
          saleAmount: null,
          difference: null,
          direction: kind === 'DIRECT' ? 'STORE_PAYS' : null,
          amountDue: kind === 'DIRECT' ? quote.total : null,
          tagCode: kind === 'EXCHANGE' ? (body as CreateExchange).tagCode : null,
          createdBy: user.id,
          creationKey: key,
          creationHash,
        },
      });
      await tx.buybackSettlementAudit.create({
        data: {
          settlementId: row.id,
          actorId: user.id,
          action: 'CREATED',
          fromStatus: null,
          toStatus: row.status,
          fromVersion: null,
          toVersion: 1,
          detail: json({ kind, quoteId: quote.id, amount: quote.total.toFixed(2) }),
        },
      });
      return row;
    });
    if (result.status === 'RESERVING') return this.reserveStep(result.id);
    return present(result);
  }
  private async reserveStep(id: string): Promise<SettlementView> {
    const row = await this.prisma.buybackSettlement.findUniqueOrThrow({ where: { id } });
    if (row.status !== 'RESERVING' || !row.tagCode) return present(row);
    let hold: ExchangeHold;
    try {
      hold = await this.inventory.reserve(id, row.branchId, row.tagCode);
    } catch (error) {
      if (
        error instanceof BusinessError &&
        ['ITEM_NOT_AVAILABLE', 'METAL_PRICE_NOT_SET', 'INVALID_STATE'].includes(error.code)
      ) {
        return this.write(async (tx) => {
          const current = await this.locked(tx, id);
          if (!current || current.status !== 'RESERVING') return present(current ?? row);
          return present(
            await this.advance(tx, current, null, 'RESERVATION_FAILED', 'CANCELLED', {
              failureCode: error.code,
            }),
          );
        });
      }
      return present(row); // timeout: same exchangeId is recovered without another reservation
    }
    if (hold.status !== 'ACTIVE' || hold.branchId !== row.branchId || hold.tagCode !== row.tagCode)
      return present(row);
    const sale = new Prisma.Decimal(hold.price);
    const difference = sale.sub(row.approvedAmount);
    const direction = difference.gt(0) ? 'CUSTOMER_PAYS' : difference.lt(0) ? 'STORE_PAYS' : 'NONE';
    return this.write(async (tx) => {
      const current = await this.locked(tx, id);
      if (!current || current.status !== 'RESERVING') return present(current ?? row);
      return present(
        await this.advance(
          tx,
          current,
          null,
          'RESERVED',
          'AWAITING_PAYMENT',
          {
            saleAmount: sale,
            difference,
            direction,
            amountDue: difference.abs(),
            reservationId: hold.exchangeId,
            reservationExpiresAt: hold.expiresAt ? new Date(hold.expiresAt) : null,
            saleSnapshot: json(hold),
          },
          { itemId: hold.itemId, salePrice: hold.price, difference: difference.toFixed(2) },
        ),
      );
    });
  }
  async get(user: AuthUser, branchId: string, intakeId: string): Promise<SettlementView | null> {
    assertOrderBranch(user, branchId);
    const row = await this.prisma.buybackSettlement.findFirst({
      where: { intakeId, branchId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? present(row) : null;
  }
  async record(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    id: string,
    key: string,
    input: RecordSettlementPayment,
  ) {
    const body = recordSettlementPaymentSchema.parse(input);
    try {
      return await this.command(
        user,
        branchId,
        intakeId,
        id,
        key,
        { action: 'record', ...body },
        async (tx, row) => {
          if (row.version !== body.version) throw conflict();
          if (row.status !== 'AWAITING_PAYMENT') throw invalid();
          // Evidence is a human receipt / bank reference; only confirmation attests actual cash flow.
          return this.advance(
            tx,
            row,
            user.id,
            'PAYMENT_RECORDED',
            'PAYMENT_RECORDED',
            {
              paymentReference: body.reference,
              paymentEvidence: body.evidence,
              paymentRecordedBy: user.id,
            },
            {
              direction: row.direction,
              amount: row.amountDue?.toFixed(2),
            },
          );
        },
      );
    } catch (error) {
      if (violatedUniqueIndex(error)?.includes('paymentReference'))
        throw new BusinessError('PAYMENT_REFERENCE_CONFLICT', 'Mã chứng từ đã được dùng', 409);
      throw error;
    }
  }
  async confirm(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    id: string,
    key: string,
    input: ConfirmSettlementPayment,
  ) {
    manager(user, branchId);
    const body = confirmSettlementPaymentSchema.parse(input);
    const view = await this.command(
      user,
      branchId,
      intakeId,
      id,
      key,
      { action: 'confirm', ...body },
      async (tx, row) => {
        if (row.version !== body.version) throw conflict();
        if (row.status !== 'PAYMENT_RECORDED' || !row.paymentReference || !row.paymentEvidence)
          throw invalid();
        if (user.id === row.createdBy || user.id === row.paymentRecordedBy)
          throw new BusinessError(
            'BUYBACK_SEPARATE_APPROVER_REQUIRED',
            'Người xác nhận phải khác người lập và ghi nhận tiền',
            403,
          );
        const status = row.kind === 'DIRECT' ? 'SETTLED' : 'FULFILLING';
        const updated = await this.advance(
          tx,
          row,
          user.id,
          'PAYMENT_CONFIRMED',
          status,
          {
            paymentConfirmedBy: user.id,
            paymentConfirmedAt: new Date(),
            verificationReference: body.verificationReference,
            confirmationNote: body.note,
          },
          {
            direction: row.direction,
            amount: row.amountDue?.toFixed(2),
          },
        );
        if (updated.status === 'SETTLED') await this.addStockEvent(tx, updated);
        return updated;
      },
    );
    if (view.kind === 'EXCHANGE' && ['FULFILLING', 'RECONCILIATION_REQUIRED'].includes(view.status))
      return this.fulfill(view.id);
    return view;
  }
  async cancel(
    user: AuthUser,
    branchId: string,
    intakeId: string,
    id: string,
    key: string,
    input: CancelSettlement,
  ) {
    const body = cancelSettlementSchema.parse(input);
    const view = await this.command(
      user,
      branchId,
      intakeId,
      id,
      key,
      { action: 'cancel', ...body },
      async (tx, row) => {
        if (row.version !== body.version) throw conflict();
        if (row.status !== 'RESERVING' && row.status !== 'AWAITING_PAYMENT') throw invalid();
        if (row.kind === 'DIRECT')
          return this.advance(
            tx,
            row,
            user.id,
            'CANCELLED',
            'CANCELLED',
            {},
            { reason: body.reason },
          );
        return this.advance(
          tx,
          row,
          user.id,
          'CANCELLING',
          'CANCELLING',
          {},
          { reason: body.reason },
        );
      },
    );
    if (view.status === 'CANCELLING') return this.releaseStep(view.id);
    return view;
  }
  private async releaseStep(id: string): Promise<SettlementView> {
    try {
      await this.inventory.release(id);
    } catch {
      return present(await this.prisma.buybackSettlement.findUniqueOrThrow({ where: { id } }));
    }
    return this.write(async (tx) => {
      const row = await this.locked(tx, id);
      if (!row || row.status !== 'CANCELLING') return present(row!);
      return present(await this.advance(tx, row, null, 'RESERVATION_RELEASED', 'CANCELLED'));
    });
  }
  private async markReview(id: string, code: string): Promise<SettlementView> {
    return this.write(async (tx) => {
      const row = await this.locked(tx, id);
      if (!row || !['FULFILLING', 'RECONCILIATION_REQUIRED'].includes(row.status))
        return present(row!);
      if (row.status === 'RECONCILIATION_REQUIRED' && row.failureCode === code) return present(row);
      return present(
        await this.advance(
          tx,
          row,
          null,
          'RECONCILIATION_REQUIRED',
          'RECONCILIATION_REQUIRED',
          { failureCode: code },
          { code },
        ),
      );
    });
  }
  async fulfill(id: string): Promise<SettlementView> {
    const row = await this.prisma.buybackSettlement.findUniqueOrThrow({ where: { id } });
    if (row.status === 'SETTLED') return present(row);
    if (
      !['FULFILLING', 'RECONCILIATION_REQUIRED'].includes(row.status) ||
      !row.paymentConfirmedAt ||
      !row.saleSnapshot
    )
      throw invalid();
    let hold: ExchangeHold;
    try {
      const current = await this.inventory.state(id);
      if (!current) return this.markReview(id, 'INVENTORY_HOLD_MISSING');
      if (current.status === 'ACTIVE') await this.inventory.protect(id);
      hold = await this.inventory.consume(id);
      if (
        hold.status !== 'CONSUMED' ||
        hold.itemId !== (row.saleSnapshot as { itemId: string }).itemId
      )
        return this.markReview(id, 'INVENTORY_SNAPSHOT_MISMATCH');
    } catch (error) {
      return this.markReview(
        id,
        error instanceof BusinessError ? error.code : 'INVENTORY_UNAVAILABLE',
      );
    }
    try {
      return await this.write(async (tx) => {
        const current = await this.locked(tx, id);
        if (!current || current.status === 'SETTLED') return present(current!);
        if (
          !['FULFILLING', 'RECONCILIATION_REQUIRED'].includes(current.status) ||
          !current.paymentConfirmedAt ||
          !current.saleAmount
        )
          throw invalid();
        const snapshot = current.saleSnapshot as unknown as ExchangeHold;
        const quoteLines = await tx.buybackQuoteLine.findMany({
          where: { quoteId: current.quoteId },
        });
        if (!quoteLines.length) throw invalid();
        // Order + trade-in + paid event and settlement decision share one Sales transaction.
        const order = await tx.order.create({
          data: {
            id: current.id,
            code: `EX-${current.id}`,
            branchId: current.branchId,
            customerId: (
              await tx.buybackIntake.findUniqueOrThrow({ where: { id: current.intakeId } })
            ).customerId,
            status: 'COMPLETED',
            idempotencyKey: `EX-${current.id}`,
            requestHash: current.creationHash,
            requestedTagCodes: [snapshot.tagCode],
            total: current.saleAmount,
            createdBy: current.createdBy,
            items: {
              create: [
                {
                  jewelryItemId: snapshot.itemId,
                  tagCode: snapshot.tagCode,
                  productName: snapshot.productName,
                  metalWeight: new Prisma.Decimal(snapshot.weight),
                  laborFee: new Prisma.Decimal(snapshot.laborFee),
                  metalPriceAtSale: new Prisma.Decimal(snapshot.metalSellPricePerChi),
                  price: new Prisma.Decimal(snapshot.price),
                  costPrice: new Prisma.Decimal(snapshot.costPrice),
                  variantId: snapshot.variantId,
                  metalId: snapshot.metalId,
                },
              ],
            },
          },
          include: { items: true },
        });
        await tx.tradeInItem.createMany({
          data: quoteLines.map((line) => ({
            orderId: order.id,
            quoteLineId: line.id,
            intakeItemId: line.itemId,
            metalId: line.metalId,
            acceptedWeight: line.acceptedWeight,
            amount: line.amount,
          })),
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: null,
            toStatus: 'COMPLETED',
            changedBy: current.paymentConfirmedBy!,
          },
        });
        await outbox.add(tx, {
          eventType: ROUTING_KEYS.ORDER_PAID,
          aggregateType: 'Order',
          aggregateId: order.id,
          payload: {
            channel: 'POS',
            orderId: order.id,
            branchId: order.branchId,
            code: order.code,
            total: order.total.toFixed(2),
            tagCodes: [snapshot.tagCode],
            paidAt: current.paymentConfirmedAt.toISOString(),
            items: order.items.map((item) => ({
              tagCode: item.tagCode,
              variantId: item.variantId,
              metalId: item.metalId,
              productName: item.productName,
              metalWeight: item.metalWeight.toFixed(4),
              price: item.price.toFixed(2),
              costPrice: item.costPrice.toFixed(2),
            })),
          },
        });
        const settled = await this.advance(tx, current, null, 'SETTLED', 'SETTLED', {
          orderId: order.id,
          failureCode: null,
        });
        await this.addStockEvent(tx, settled);
        return present(settled);
      });
    } catch {
      // Inventory may already have committed SOLD. Retain payment evidence and the
      // fixed exchangeId for a bounded retry; never release or invent a refund.
      return this.markReview(id, 'SALES_COMMIT_UNCERTAIN');
    }
  }
  async recover(id: string): Promise<void> {
    const row = await this.prisma.buybackSettlement.findUnique({ where: { id } });
    if (!row || row.recoveryAttempts >= 5) return;
    if (row.status === 'RESERVING') await this.reserveStep(id);
    else if (row.status === 'CANCELLING') await this.releaseStep(id);
    else if (row.status === 'FULFILLING' || row.status === 'RECONCILIATION_REQUIRED')
      await this.fulfill(id);
    else return;
    await this.write(async (tx) => {
      const current = await this.locked(tx, id);
      if (
        current &&
        ['RESERVING', 'CANCELLING', 'FULFILLING', 'RECONCILIATION_REQUIRED'].includes(
          current.status,
        ) &&
        current.recoveryAttempts < 5
      )
        await this.advance(tx, current, null, 'RECOVERY_ATTEMPT', current.status, {
          recoveryAttempts: { increment: 1 },
        });
    });
  }
}
