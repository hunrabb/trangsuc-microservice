import { PermanentError } from '@jewelry/common';
import { posOrderEventPayloadSchema, ROUTING_KEYS } from '@jewelry/contracts';

/** POS đã deduct/release qua HTTP; ack sự kiện theo binding có sẵn, không làm thay đổi kho lần thứ hai. */
async function acknowledgePosOrder(payload: unknown): Promise<void> {
  if (!posOrderEventPayloadSchema.safeParse(payload).success) {
    throw new PermanentError('Sự kiện này chưa hỗ trợ luồng đơn ngoài POS');
  }
}

export const POS_ORDER_HANDLERS = {
  [ROUTING_KEYS.ORDER_CREATED]: acknowledgePosOrder,
  [ROUTING_KEYS.ORDER_PAID]: acknowledgePosOrder,
  [ROUTING_KEYS.ORDER_CANCELLED]: acknowledgePosOrder,
};
