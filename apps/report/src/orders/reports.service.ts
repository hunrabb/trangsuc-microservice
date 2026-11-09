import { BusinessError, type AuthUser } from '@jewelry/common';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

interface Filter {
  from: string;
  to: string;
  branchId?: string;
}

/** Kiểm tra khoảng ngày và quyền trước mọi truy vấn để MANAGER chỉ xem chi nhánh được gán. */
export function reportFilter(user: AuthUser, from: string, to: string, branchId?: string): Filter {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const first = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  if (
    !datePattern.test(from) ||
    !datePattern.test(to) ||
    !Number.isFinite(first.getTime()) ||
    !Number.isFinite(last.getTime()) ||
    first.toISOString().slice(0, 10) !== from ||
    last.toISOString().slice(0, 10) !== to ||
    first > last ||
    last.getTime() - first.getTime() > 366 * 24 * 60 * 60 * 1000
  ) {
    throw new BusinessError('VALIDATION_FAILED', 'Khoảng ngày không hợp lệ hoặc quá 366 ngày', 400);
  }
  if (branchId !== undefined && !z.uuid().safeParse(branchId).success) {
    throw new BusinessError('VALIDATION_FAILED', 'Mã chi nhánh không hợp lệ', 400);
  }
  const admin = user.branches.some((entry) => entry.role === 'ADMIN' && entry.branchId === null);
  if (
    !admin &&
    (branchId === undefined ||
      !user.branches.some((entry) => entry.role === 'MANAGER' && entry.branchId === branchId))
  ) {
    throw new BusinessError('FORBIDDEN', 'Không có quyền xem báo cáo chi nhánh này', 403);
  }
  return { from, to, branchId };
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Nhóm doanh thu từ từng đơn duy nhất; không có bộ đếm tích luỹ dễ cộng trùng. */
  async daily(filter: Filter, maxRows?: number) {
    const rows = await this.prisma.orderRevenue.groupBy({
      by: ['localDate', 'branchId', 'channel'],
      where: {
        status: 'PAID',
        localDate: { gte: filter.from, lte: filter.to },
        ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
      },
      _count: { _all: true, cogs: true },
      _sum: { revenue: true, cogs: true },
      orderBy: [{ localDate: 'asc' }, { branchId: 'asc' }],
      take: maxRows === undefined ? undefined : maxRows + 1,
    });
    if (maxRows !== undefined && rows.length > maxRows) {
      throw new BusinessError('PAYLOAD_TOO_LARGE', 'Báo cáo quá lớn, hãy thu hẹp bộ lọc', 413);
    }
    return {
      timezone: 'Asia/Ho_Chi_Minh',
      rows: rows.map((row) => ({
        date: row.localDate,
        branchId: row.branchId,
        channel: row.channel,
        orderCount: row._count._all,
        revenue: row._sum.revenue?.toFixed(2) ?? '0.00',
        // Một đơn cũ thiếu giá vốn thì cả nhóm không được hiện lợi nhuận giả.
        cogs: row._count.cogs === row._count._all ? (row._sum.cogs?.toFixed(2) ?? null) : null,
        grossProfit:
          row._count.cogs === row._count._all && row._sum.revenue !== null && row._sum.cogs !== null
            ? row._sum.revenue.minus(row._sum.cogs).toFixed(2)
            : null,
      })),
    };
  }

  /** Xếp mẫu theo số chiếc đã thu tiền trong khoảng ngày; huỷ không góp dòng bán. */
  async topProducts(filter: Filter) {
    const rows = await this.prisma.orderLineSales.groupBy({
      by: ['variantId', 'productName'],
      where: {
        order: {
          status: 'PAID',
          localDate: { gte: filter.from, lte: filter.to },
          ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
        },
      },
      _count: { _all: true },
      _sum: { revenue: true },
      orderBy: { _count: { tagCode: 'desc' } },
      take: 20,
    });
    return rows.map((row) => ({
      variantId: row.variantId,
      productName: row.productName,
      quantity: row._count._all,
      revenue: row._sum.revenue?.toFixed(2) ?? '0.00',
    }));
  }
}
