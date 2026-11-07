import { BusinessError, outbox, violatedUniqueIndex } from '@jewelry/common';
import {
  type CreateMetalPriceRequest,
  type CreateMetalRequest,
  type Metal,
  type MetalPrice,
  type MetalPricePage,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from '../common/audit';
import { fieldError, notFound, pageArgs } from '../common/errors';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface CurrentPrice {
  id: string;
  metalId: string;
  buyPrice: Prisma.Decimal;
  sellPrice: Prisma.Decimal;
  effectiveFrom: Date;
  createdBy: string;
}

/**
 * Giá hiện tại của một kim loại = dòng có `effectiveFrom` mới nhất mà `<= now()`. So thời gian bằng `now()` của
 * Postgres, không bằng đồng hồ của service. Hai dòng cùng `effectiveFrom` thì dòng ghi sau thắng.
 * Chưa có dòng nào có hiệu lực → `undefined`. Chỉ đọc, không có tình huống đồng thời.
 */
export async function findCurrentPrice(db: Db, metalId: string): Promise<CurrentPrice | undefined> {
  const [row] = await db.$queryRaw<CurrentPrice[]>`
    SELECT "id", "metalId", "buyPrice", "sellPrice", "effectiveFrom", "createdBy"
    FROM "inventory"."MetalPrice"
    WHERE "metalId" = ${metalId}::uuid AND "effectiveFrom" <= now()
    ORDER BY "effectiveFrom" DESC, "createdAt" DESC
    LIMIT 1`;
  return row;
}

export const priceNotSet = () =>
  new BusinessError('METAL_PRICE_NOT_SET', 'Kim loại này chưa có giá có hiệu lực', 409);

export const toMetalPrice = (
  row: CurrentPrice | Prisma.MetalPriceGetPayload<object>,
): MetalPrice => ({
  id: row.id,
  metalId: row.metalId,
  buyPrice: row.buyPrice.toFixed(2),
  sellPrice: row.sellPrice.toFixed(2),
  effectiveFrom: row.effectiveFrom.toISOString(),
  createdBy: row.createdBy,
});

const toMetal = ({
  id,
  code,
  name,
  kind,
  isActive,
  version,
}: Prisma.MetalGetPayload<object>): Metal => ({
  id,
  code,
  name,
  kind,
  isActive,
  version,
});

@Injectable()
export class MetalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<Metal[]> {
    return (await this.prisma.metal.findMany({ orderBy: { code: 'asc' } })).map(toMetal);
  }

  /** Tạo kim loại. Đồng thời: hai request cùng `code` thì unique chặn một bên (`P2002` đúng index `Metal_code_key`). */
  async create(actorId: string, body: CreateMetalRequest): Promise<Metal> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.metal.create({ data: body });
        await writeAudit(tx, {
          actorId,
          action: 'metal.created',
          entityType: 'Metal',
          entityId: created.id,
          data: { code: created.code, name: created.name, kind: created.kind },
        });
        return toMetal(created);
      });
    } catch (error) {
      if (violatedUniqueIndex(error) === 'Metal_code_key') {
        throw fieldError({ field: 'code', message: 'Mã kim loại đã tồn tại' });
      }
      throw error;
    }
  }

  async currentPrice(metalId: string): Promise<MetalPrice> {
    await this.requireMetal(this.prisma, metalId);
    const price = await findCurrentPrice(this.prisma, metalId);
    if (price === undefined) {
      throw priceNotSet();
    }
    return toMetalPrice(price);
  }

  async history(
    metalId: string,
    paging: { page: number; pageSize: number },
  ): Promise<MetalPricePage> {
    await this.requireMetal(this.prisma, metalId);
    const where = { metalId };
    const [rows, total] = await Promise.all([
      this.prisma.metalPrice.findMany({
        where,
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(paging),
      }),
      this.prisma.metalPrice.count({ where }),
    ]);
    return { items: rows.map(toMetalPrice), total, ...paging };
  }

  /**
   * Nhập giá mới (chỉ ADMIN). Chỉ ghi thêm, không sửa giá cũ. Dòng giá, `AuditLog` và sự kiện
   * `metal_price.changed` (outbox) ghi trong MỘT transaction: rollback thì không có thư nào được gửi.
   * Đồng thời: hai ADMIN nhập cùng lúc thì cả hai dòng đều được ghi; "mới nhất" do `effectiveFrom` quyết định.
   */
  async createPrice(
    actorId: string,
    metalId: string,
    body: CreateMetalPriceRequest,
  ): Promise<MetalPrice> {
    return this.prisma.$transaction(async (tx) => {
      const metal = await this.requireMetal(tx, metalId);
      if (!metal.isActive) {
        throw fieldError({ field: 'metalId', message: 'Kim loại đã ngừng sử dụng' });
      }
      const price = await tx.metalPrice.create({
        data: {
          metalId,
          buyPrice: body.buyPrice,
          sellPrice: body.sellPrice,
          effectiveFrom:
            body.effectiveFrom === undefined ? new Date() : new Date(body.effectiveFrom),
          createdBy: actorId,
        },
      });
      const dto = toMetalPrice(price);
      await writeAudit(tx, {
        actorId,
        action: 'metal_price.changed',
        entityType: 'Metal',
        entityId: metalId,
        data: {
          buyPrice: dto.buyPrice,
          sellPrice: dto.sellPrice,
          effectiveFrom: dto.effectiveFrom,
        },
      });
      await outbox.add(tx, {
        eventType: ROUTING_KEYS.METAL_PRICE_CHANGED,
        aggregateType: 'Metal',
        aggregateId: metalId,
        payload: {
          metalId,
          metalCode: metal.code,
          buyPrice: dto.buyPrice,
          sellPrice: dto.sellPrice,
          effectiveFrom: dto.effectiveFrom,
        },
      });
      return dto;
    });
  }

  private async requireMetal(db: Pick<Prisma.TransactionClient, 'metal'>, metalId: string) {
    const metal = await db.metal.findUnique({ where: { id: metalId } });
    if (metal === null) {
      throw notFound('kim loại');
    }
    return metal;
  }
}
