import { Logger } from '@nestjs/common';
import type { SystemTestPayload } from '@jewelry/contracts';

const logger = new Logger('SystemTestHandler');

/** `system.test` là sự kiện kỹ thuật để kiểm thử đường đi outbox → consumer: chỉ ghi log, không có nghiệp vụ. */
export async function handleSystemTest(payload: SystemTestPayload): Promise<void> {
  logger.log(`Nhận system.test: ${payload.message}`);
}
