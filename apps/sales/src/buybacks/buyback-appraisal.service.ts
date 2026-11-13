import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BusinessError,
  runWithLockRetry,
  violatedUniqueIndex,
  type AuthUser,
} from '@jewelry/common';
import {
  appraisalInputSchema,
  buybackAppraisalSchema,
  buybackPolicySchema,
  buybackQuoteInputSchema,
  buybackQuoteSchema,
  createBuybackPolicySchema,
  updateBuybackPolicySchema,
  idempotencyKeySchema,
  buybackDecisionSchema,
  rejectBuybackQuoteSchema,
  type AppraisalInput,
  type BuybackQuoteInput,
  type CreateBuybackPolicy,
  type UpdateBuybackPolicy,
  type BuybackQuote,
  type InventoryBuybackPrice,
} from '@jewelry/contracts';
import {
  Prisma,
  type BuybackIntake,
  type BuybackAppraisal,
  type BuybackPricePolicy,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertOrderBranch } from '../core/order-record';
import { BuybackPriceClient } from './buyback-price.client';
import { BUYBACK_ROUNDING, priceBuybackLine } from './buyback-pricing';

type Tx = Prisma.TransactionClient;
const missing = () =>
  new BusinessError('NOT_FOUND', 'Không tìm thấy dữ liệu thu mua tại chi nhánh', 404);
const state = () =>
  new BusinessError('INVALID_STATE', 'Trạng thái phiếu/báo giá không cho phép thao tác', 409);
const conflict = () =>
  new BusinessError('VERSION_CONFLICT', 'Dữ liệu đã đổi; tải lại phiên bản mới', 409);
const hash = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const json = (body: unknown) => JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
function manager(user: AuthUser, branchId: string) {
  assertOrderBranch(user, branchId);
  if (
    !user.branches.some(
      (r) =>
        (r.role === 'ADMIN' && r.branchId === null) ||
        (r.role === 'MANAGER' && r.branchId === branchId),
    )
  )
    throw new BusinessError(
      'FORBIDDEN',
      'Chỉ quản lý chi nhánh hoặc ADMIN được quyết định giá',
      403,
    );
}
function admin(user: AuthUser, branchId: string) {
  assertOrderBranch(user, branchId);
  if (!user.branches.some((r) => r.role === 'ADMIN' && r.branchId === null))
    throw new BusinessError('FORBIDDEN', 'Chỉ ADMIN được cấu hình policy thu mua', 403);
}
function appraisal(row: BuybackAppraisal) {
  return buybackAppraisalSchema.parse({
    ...row,
    measuredWeight: row.measuredWeight.toFixed(4),
    acceptedWeight: row.acceptedWeight.toFixed(4),
    purityPerMille: row.purityPerMille.toFixed(4),
    appraisedAt: row.appraisedAt.toISOString(),
  });
}
function policy(row: BuybackPricePolicy) {
  return buybackPolicySchema.parse({
    id: row.id,
    branchId: row.branchId,
    metalId: row.metalId,
    metalKind: row.metalKind,
    purityPerMille: row.purityPerMille.toFixed(4),
    label: row.label,
    deductionVndPerItem: row.deductionVndPerItem.toFixed(2),
    version: row.version,
    isActive: row.isActive,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  });
}

@Injectable()
export class BuybackAppraisalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prices: BuybackPriceClient,
  ) {}
  private write<T>(work: (tx: Tx) => Promise<T>) {
    return runWithLockRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          return work(tx);
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    );
  }
  private async header(tx: Tx, branchId: string, id: string, lock = false) {
    if (lock)
      await tx.$queryRaw`SELECT id FROM "sales"."BuybackIntake" WHERE id=${id}::uuid AND "branchId"=${branchId}::uuid FOR UPDATE`;
    const h = await tx.buybackIntake.findFirst({ where: { id, branchId } });
    if (!h) throw missing();
    return h;
  }
  private latest(tx: Tx, id: string) {
    return tx.$queryRaw<
      BuybackAppraisal[]
    >`SELECT DISTINCT ON ("itemId") * FROM "sales"."BuybackAppraisal" WHERE "intakeId"=${id}::uuid ORDER BY "itemId","intakeVersion" DESC`;
  }
  private async replay<T>(
    tx: Tx,
    id: string,
    actorId: string,
    key: string,
    requestHash: string,
  ): Promise<{ result: T } | null> {
    const prior = await tx.buybackRequest.findUnique({
      where: { intakeId_actorId_idempotencyKey: { intakeId: id, actorId, idempotencyKey: key } },
    });
    if (!prior) return null;
    if (prior.requestHash !== requestHash)
      throw new BusinessError('IDEMPOTENCY_KEY_REUSED', 'Key đã dùng cho nội dung khác', 422);
    return { result: prior.result as T };
  }
  private execute<T>(
    user: AuthUser,
    branchId: string,
    id: string,
    key: string,
    body: unknown,
    work: (tx: Tx, h: BuybackIntake) => Promise<T>,
  ) {
    assertOrderBranch(user, branchId);
    key = idempotencyKeySchema.parse(key);
    const requestHash = hash(body);
    return this.write(async (tx) => {
      const h = await this.header(tx, branchId, id, true);
      const prior = await this.replay<T>(tx, id, user.id, key, requestHash);
      if (prior) return prior.result;
      const result = await work(tx, h);
      await tx.buybackRequest.create({
        data: {
          intakeId: id,
          actorId: user.id,
          idempotencyKey: key,
          requestHash,
          result: json(result),
        },
      });
      return result;
    });
  }
  private check(h: BuybackIntake, version: number) {
    if (h.version !== version) throw conflict();
    if (!['PENDING_APPRAISAL', 'APPRAISED'].includes(h.status)) throw state();
  }
  private async advance(
    tx: Tx,
    h: BuybackIntake,
    user: AuthUser,
    status: BuybackIntake['status'],
    action: 'APPRAISED' | 'QUOTED' | 'APPROVED' | 'REJECTED',
    activeQuoteId: string | null,
  ) {
    const result = await tx.buybackIntake.updateMany({
      where: { id: h.id, branchId: h.branchId, version: h.version, status: h.status },
      data: { status, activeQuoteId, version: { increment: 1 } },
    });
    if (result.count !== 1) throw conflict();
    await tx.buybackIntakeAudit.create({
      data: {
        intakeId: h.id,
        branchId: h.branchId,
        actorId: user.id,
        action,
        fromStatus: h.status,
        toStatus: status,
        fromVersion: h.version,
        toVersion: h.version + 1,
      },
    });
  }
  private async quoteView(tx: Tx, id: string): Promise<BuybackQuote> {
    const q = await tx.buybackQuote.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { itemId: 'asc' } } },
    });
    return buybackQuoteSchema.parse({
      ...q,
      total: q.total.toFixed(2),
      quotedAt: q.quotedAt.toISOString(),
      decidedAt: q.decidedAt?.toISOString() ?? null,
      lines: q.lines.map((l) => ({
        itemId: l.itemId,
        appraisalId: l.appraisalId,
        appraisedBy: l.appraisedBy,
        measuredWeight: l.measuredWeight.toFixed(4),
        acceptedWeight: l.acceptedWeight.toFixed(4),
        metalId: l.metalId,
        metalKind: l.metalKind,
        purityPerMille: l.purityPerMille.toFixed(4),
        policyId: l.policyId,
        policyVersion: l.policyVersion,
        priceId: l.priceId,
        metalCode: l.metalCode,
        unit: l.unit,
        unitPrice: l.unitPrice.toFixed(2),
        effectiveFrom: l.effectiveFrom.toISOString(),
        capturedAt: l.capturedAt.toISOString(),
        deductionVndPerItem: l.deductionVndPerItem.toFixed(2),
        amount: l.amount.toFixed(2),
      })),
    });
  }
  async appraisals(user: AuthUser, branchId: string, id: string) {
    assertOrderBranch(user, branchId);
    return this.prisma.$transaction(
      async (tx) => {
        const h = await this.header(tx, branchId, id);
        return {
          intakeId: id,
          status: h.status,
          version: h.version,
          items: (await this.latest(tx, id)).map(appraisal),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async appraise(
    user: AuthUser,
    branchId: string,
    id: string,
    itemId: string,
    key: string,
    input: AppraisalInput,
  ) {
    const body = appraisalInputSchema.parse(input);
    return this.execute(
      user,
      branchId,
      id,
      key,
      { action: 'appraise', itemId, ...body },
      async (tx, h) => {
        this.check(h, body.version);
        const item = await tx.buybackIntakeItem.findFirst({ where: { id: itemId, intakeId: id } });
        if (!item) throw missing();
        if (item.assetKind !== 'JEWELRY' && item.assetKind !== body.metalKind)
          throw new BusinessError(
            'VALIDATION_FAILED',
            'Loại kim loại không khớp món tiếp nhận',
            400,
          );
        if (h.activeQuoteId)
          await tx.buybackQuote.updateMany({
            where: { id: h.activeQuoteId, intakeId: id, status: 'QUOTED' },
            data: { status: 'SUPERSEDED' },
          });
        const { version, ...values } = body;
        const row = await tx.buybackAppraisal.create({
          data: {
            ...values,
            intakeId: id,
            itemId,
            intakeVersion: version + 1,
            appraisedBy: user.id,
          },
        });
        const latest = await this.latest(tx, id);
        const count = await tx.buybackIntakeItem.count({ where: { intakeId: id } });
        await this.advance(
          tx,
          h,
          user,
          latest.length === count ? 'APPRAISED' : 'PENDING_APPRAISAL',
          'APPRAISED',
          null,
        );
        return appraisal(row);
      },
    );
  }
  async quotes(user: AuthUser, branchId: string, id: string) {
    assertOrderBranch(user, branchId);
    return this.prisma.$transaction(
      async (tx) => {
        const h = await this.header(tx, branchId, id);
        const rows = await tx.buybackQuote.findMany({
          where: { intakeId: id },
          orderBy: [{ quotedAt: 'desc' }, { id: 'desc' }],
          take: 50,
        });
        const quotes = [];
        for (const q of rows) quotes.push(await this.quoteView(tx, q.id));
        return {
          intakeId: id,
          status: h.status,
          version: h.version,
          activeQuoteId: h.activeQuoteId,
          quotes,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  private async quoteInputs(tx: Tx, h: BuybackIntake, body: BuybackQuoteInput) {
    this.check(h, body.version);
    if (h.status !== 'APPRAISED')
      throw new BusinessError('BUYBACK_APPRAISAL_INCOMPLETE', 'Chưa kiểm định đủ món', 409);
    const latest = await this.latest(tx, h.id);
    const count = await tx.buybackIntakeItem.count({ where: { intakeId: h.id } });
    if (latest.length !== count || body.items.length !== count)
      throw new BusinessError(
        'BUYBACK_APPRAISAL_INCOMPLETE',
        'Báo giá cần đủ mọi món đã kiểm định',
        409,
      );
    const result = [];
    // Stable lock order across policies; HTTP is never performed under these locks.
    const ids = [...new Set(body.items.map((i) => i.policyId))].sort();
    await tx.$queryRaw`SELECT id FROM "sales"."BuybackPricePolicy" WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
    for (const i of body.items) {
      const a = latest.find((a) => a.itemId === i.itemId);
      const p = await tx.buybackPricePolicy.findFirst({
        where: { id: i.policyId, branchId: h.branchId, isActive: true },
      });
      if (!a || !p)
        throw new BusinessError(
          'BUYBACK_POLICY_REQUIRED',
          'Cần policy có hiệu lực cho từng món kiểm định',
          409,
        );
      if (p.version !== i.policyVersion) throw conflict();
      if (
        p.metalId !== a.metalId ||
        p.metalKind !== a.metalKind ||
        !p.purityPerMille.equals(a.purityPerMille)
      )
        throw new BusinessError(
          'BUYBACK_POLICY_REQUIRED',
          'Policy không khớp kim loại/hàm lượng đã kiểm định',
          409,
        );
      result.push({ a, p });
    }
    return result;
  }
  async quote(user: AuthUser, branchId: string, id: string, key: string, input: BuybackQuoteInput) {
    assertOrderBranch(user, branchId);
    key = idempotencyKeySchema.parse(key);
    const body = buybackQuoteInputSchema.parse(input);
    // UUID input is case-insensitive; normalize before JS set matching and request hashing.
    body.items = body.items.map((item) => ({
      ...item,
      itemId: item.itemId.toLowerCase(),
      policyId: item.policyId.toLowerCase(),
    }));
    body.items.sort((a, b) => a.itemId.localeCompare(b.itemId));
    const command = { action: 'quote', ...body };
    const prepared = await this.write(async (tx) => {
      const h = await this.header(tx, branchId, id, true);
      const prior = await this.replay<BuybackQuote>(tx, id, user.id, key, hash(command));
      return prior
        ? { prior: prior.result, inputs: null }
        : { prior: null, inputs: await this.quoteInputs(tx, h, body) };
    });
    if (prepared.prior) return prepared.prior;
    const prices = new Map<string, InventoryBuybackPrice>();
    for (const { a } of prepared.inputs!)
      if (!prices.has(a.metalId)) prices.set(a.metalId, await this.prices.current(a.metalId));
    return this.execute(user, branchId, id, key, command, async (tx, h) => {
      const inputs = await this.quoteInputs(tx, h, body);
      const lines = inputs.map(({ a, p }) => {
        const price = prices.get(a.metalId);
        if (!price || price.metalKind !== a.metalKind)
          throw new BusinessError(
            'BUYBACK_PRICE_INVALID',
            'Nguồn giá không khớp kim loại kiểm định',
            409,
          );
        return {
          itemId: a.itemId,
          appraisalId: a.id,
          appraisedBy: a.appraisedBy,
          measuredWeight: a.measuredWeight,
          acceptedWeight: a.acceptedWeight,
          metalId: a.metalId,
          metalKind: a.metalKind,
          purityPerMille: a.purityPerMille,
          policyId: p.id,
          policyVersion: p.version,
          priceId: price.priceId,
          metalCode: price.metalCode,
          unit: price.unit,
          unitPrice: price.buyPricePerChi,
          effectiveFrom: new Date(price.effectiveFrom),
          capturedAt: new Date(price.capturedAt),
          deductionVndPerItem: p.deductionVndPerItem,
          amount: priceBuybackLine(
            a.acceptedWeight,
            new Prisma.Decimal(price.buyPricePerChi),
            p.deductionVndPerItem,
          ),
        };
      });
      const total = lines.reduce((sum, l) => sum.add(l.amount), new Prisma.Decimal(0));
      if (total.gte('1000000000000000000'))
        throw new BusinessError('BUYBACK_PRICE_INVALID', 'Tổng vượt giới hạn', 409);
      if (h.activeQuoteId)
        await tx.buybackQuote.updateMany({
          where: { id: h.activeQuoteId, intakeId: id, status: 'QUOTED' },
          data: { status: 'SUPERSEDED' },
        });
      const q = await tx.buybackQuote.create({
        data: {
          intakeId: id,
          sourceVersion: h.version,
          total,
          rounding: BUYBACK_ROUNDING,
          requireSeparateApprover: true,
          quotedBy: user.id,
          lines: { create: lines },
        },
      });
      await this.advance(tx, h, user, 'APPRAISED', 'QUOTED', q.id);
      return this.quoteView(tx, q.id);
    });
  }
  async decide(
    user: AuthUser,
    branchId: string,
    id: string,
    quoteId: string,
    key: string,
    input: { version: number; reason?: string },
    approve: boolean,
  ) {
    manager(user, branchId);
    quoteId = quoteId.toLowerCase();
    const body: { version: number; reason?: string } = approve
      ? buybackDecisionSchema.parse(input)
      : rejectBuybackQuoteSchema.parse(input);
    return this.execute(
      user,
      branchId,
      id,
      key,
      { action: approve ? 'approve' : 'reject', quoteId, ...body },
      async (tx, h) => {
        this.check(h, body.version);
        const q = await tx.buybackQuote.findFirst({
          where: { id: quoteId, intakeId: id },
          include: { lines: true },
        });
        if (h.status !== 'APPRAISED' || h.activeQuoteId !== quoteId || !q || q.status !== 'QUOTED')
          throw state();
        const latest = await this.latest(tx, id);
        if (
          latest.length !== q.lines.length ||
          q.lines.some((l) => !latest.some((a) => a.id === l.appraisalId))
        )
          throw conflict();
        if (
          approve &&
          (user.id === h.createdBy ||
            user.id === q.quotedBy ||
            q.lines.some((l) => l.appraisedBy === user.id))
        )
          throw new BusinessError(
            'BUYBACK_SEPARATE_APPROVER_REQUIRED',
            'Người duyệt phải khác người lập/kiểm định/báo giá',
            403,
          );
        const status = approve ? 'APPROVED' : 'REJECTED';
        await tx.buybackQuote.update({
          where: { id: quoteId },
          data: {
            status,
            decidedBy: user.id,
            decidedAt: new Date(),
            rejectionReason: body.reason ?? null,
          },
        });
        await this.advance(tx, h, user, status, status, quoteId);
        return this.quoteView(tx, quoteId);
      },
    );
  }
  async policies(user: AuthUser, branchId: string) {
    assertOrderBranch(user, branchId);
    return (
      await this.prisma.buybackPricePolicy.findMany({
        where: { branchId },
        orderBy: { id: 'asc' },
        take: 100,
      })
    ).map(policy);
  }
  async createPolicy(user: AuthUser, branchId: string, key: string, input: CreateBuybackPolicy) {
    admin(user, branchId);
    key = idempotencyKeySchema.parse(key);
    const body = createBuybackPolicySchema.parse(input);
    const requestHash = hash(body);
    const where = {
      branchId_createdBy_idempotencyKey: { branchId, createdBy: user.id, idempotencyKey: key },
    };
    const replay = (row: BuybackPricePolicy) => {
      if (row.requestHash !== requestHash)
        throw new BusinessError(
          'IDEMPOTENCY_KEY_REUSED',
          'Key policy đã dùng cho nội dung khác',
          422,
        );
      return policy(row);
    };
    const existing = await this.prisma.buybackPricePolicy.findUnique({ where });
    if (existing) return replay(existing);
    const rate = await this.prices.current(body.metalId);
    if (rate.metalKind !== body.metalKind)
      throw new BusinessError(
        'BUYBACK_POLICY_REQUIRED',
        'Ánh xạ policy sai loại kim loại Inventory',
        409,
      );
    try {
      return await this.write(async (tx) => {
        const { reason, ...values } = body;
        const row = await tx.buybackPricePolicy.create({
          data: {
            ...values,
            id: randomUUID(),
            branchId,
            createdBy: user.id,
            idempotencyKey: key,
            requestHash,
          },
        });
        const view = policy(row);
        await tx.buybackPolicyAudit.create({
          data: { policyId: row.id, version: 1, actorId: user.id, reason, snapshot: json(view) },
        });
        return view;
      });
    } catch (error) {
      if (violatedUniqueIndex(error) !== 'BuybackPricePolicy_branchId_createdBy_idempotencyKey_key')
        throw error;
      return replay(await this.prisma.buybackPricePolicy.findUniqueOrThrow({ where }));
    }
  }
  async updatePolicy(user: AuthUser, branchId: string, id: string, input: UpdateBuybackPolicy) {
    admin(user, branchId);
    const body = updateBuybackPolicySchema.parse(input);
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "sales"."BuybackPricePolicy" WHERE id=${id}::uuid AND "branchId"=${branchId}::uuid FOR UPDATE`;
      const p = await tx.buybackPricePolicy.findFirst({ where: { id, branchId } });
      if (!p) throw missing();
      if (p.version !== body.version) throw conflict();
      const { version, reason, ...values } = body;
      const row = await tx.buybackPricePolicy.update({
        where: { id },
        data: { ...values, version: version + 1 },
      });
      const view = policy(row);
      await tx.buybackPolicyAudit.create({
        data: {
          policyId: id,
          version: version + 1,
          actorId: user.id,
          reason,
          snapshot: json(view),
        },
      });
      return view;
    });
  }
}
