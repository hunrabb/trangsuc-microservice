import { onlineOrderPaidSchema } from '@jewelry/contracts';
import { confirmPaidReservation } from './payment-events';
import {
  onlineOrderCreatedSchema,
  onlineOrderCancelledSchema,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';
import { POS_ORDER_HANDLERS } from '../stock/pos-order-events';
import { reserveOnlineOrder, releaseOnlineOrder } from './reservations';

type Context = { tx: Prisma.TransactionClient };
export const ONLINE_INVENTORY_HANDLERS = {
  [ROUTING_KEYS.ORDER_PAID]: async (payload: unknown, context: Context) => {
    if (onlineOrderPaidSchema.safeParse(payload).success)
      return confirmPaidReservation(payload, context);
    return POS_ORDER_HANDLERS[ROUTING_KEYS.ORDER_PAID](payload);
  },
  [ROUTING_KEYS.ORDER_CREATED]: async (payload: unknown, context: Context) => {
    const online = onlineOrderCreatedSchema.safeParse(payload);
    if (online.success) return reserveOnlineOrder(context.tx, online.data);
    return POS_ORDER_HANDLERS[ROUTING_KEYS.ORDER_CREATED](payload);
  },
  [ROUTING_KEYS.ORDER_CANCELLED]: async (payload: unknown, context: Context) => {
    const online = onlineOrderCancelledSchema.safeParse(payload);
    if (online.success) return releaseOnlineOrder(context.tx, online.data.orderId, 'RELEASED');
    return POS_ORDER_HANDLERS[ROUTING_KEYS.ORDER_CANCELLED](payload);
  },
};
