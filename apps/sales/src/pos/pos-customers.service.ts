import { randomUUID } from 'node:crypto';
import { type AuthUser, BusinessError, violatedUniqueIndex } from '@jewelry/common';
import {
  type CreatePosCustomerRequest,
  type PosCustomer,
  type PosCustomerOrders,
} from '@jewelry/contracts';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertOrderBranch, presentOrder } from '../core/order-record';

/** Chuẩn hoá cùng một số điện thoại trước unique, kể cả khi hai quầy gửi song song. */
export function normalizeCustomerPhone(input: string): string {
  const compact = input.trim().replace(/[\s.()-]/g, '');
  const local = compact.startsWith('+84')
    ? `0${compact.slice(3)}`
    : compact.startsWith('84')
      ? `0${compact.slice(2)}`
      : compact;
  if (!/^0\d{9,10}$/.test(local)) {
    throw new BusinessError('VALIDATION_FAILED', 'Số điện thoại không hợp lệ', 400);
  }
  return local;
}

/** Khách thuộc Sales; unique phone quyết định khi nhiều quầy tạo cùng lúc. */
@Injectable()
export class PosCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Gắn với chi nhánh có quyền; số trùng trả khách cũ và không ghi đè tên từ quầy khác. */
  async createOrFind(user: AuthUser, request: CreatePosCustomerRequest): Promise<PosCustomer> {
    assertOrderBranch(user, request.branchId);
    const phone = normalizeCustomerPhone(request.phone);
    try {
      return await this.prisma.customer.create({
        data: { id: randomUUID(), phone, name: request.name },
        select: { id: true, phone: true, name: true },
      });
    } catch (error) {
      if (violatedUniqueIndex(error) !== 'Customer_phone_key') throw error;
      return this.prisma.customer.findUniqueOrThrow({
        where: { phone },
        select: { id: true, phone: true, name: true },
      });
    }
  }

  /** Tra khách theo số đã chuẩn hoá; quyền chi nhánh do server kiểm, không tin UI. */
  async findByPhone(user: AuthUser, branchId: string, input: string): Promise<PosCustomer> {
    assertOrderBranch(user, branchId);
    const customer = await this.prisma.customer.findUnique({
      where: { phone: normalizeCustomerPhone(input) },
      select: { id: true, phone: true, name: true },
    });
    if (customer === null) throw new BusinessError('NOT_FOUND', 'Không tìm thấy khách hàng', 404);
    return customer;
  }

  /** Chỉ trả đơn đã thanh toán ở chi nhánh được phép; không lộ lịch sử chi nhánh khác. */
  async purchaseHistory(
    user: AuthUser,
    customerId: string,
    branchId: string,
  ): Promise<PosCustomerOrders> {
    assertOrderBranch(user, branchId);
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (customer === null) throw new BusinessError('NOT_FOUND', 'Không tìm thấy khách hàng', 404);
    const orders = await this.prisma.order.findMany({
      where: { customerId, branchId, status: 'COMPLETED' },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: orders.map(presentOrder) };
  }
}
