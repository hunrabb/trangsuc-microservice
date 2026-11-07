import {
  type BranchCreatedPayload,
  branchCreatedPayloadSchema,
  type BranchUpdatedPayload,
  branchUpdatedPayloadSchema,
  ROUTING_KEYS,
} from '@jewelry/contracts';
import { PermanentError } from '@jewelry/common';
import type { Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Tạo hoặc cập nhật kho của chi nhánh bằng MỘT câu `INSERT ... ON CONFLICT`, nên đúng dù thư đến trùng, đến lệch
 * thứ tự (`branch.updated` tới trước `branch.created`), hay hai instance xử lý song song: unique `branchId`
 * là trọng tài, không bao giờ có hai kho cho một chi nhánh.
 */
async function upsertWarehouse(
  tx: Tx,
  branchId: string,
  name: string,
  isActive: boolean,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "inventory"."Warehouse" ("id", "branchId", "name", "isActive", "updatedAt")
    VALUES (gen_random_uuid(), ${branchId}::uuid, ${name}, ${isActive}, now())
    ON CONFLICT ("branchId") DO UPDATE
      SET "name" = EXCLUDED."name", "isActive" = EXCLUDED."isActive", "updatedAt" = now()`;
}

/** Payload sai dạng là lỗi vĩnh viễn: thử lại vô ích, thư vào DLQ ngay. */
const parse = <T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  payload: unknown,
): T => {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw new PermanentError('Payload sự kiện chi nhánh sai định dạng');
  }
  return result.data;
};

/**
 * `branch.created`: tạo kho (đang hoạt động). Nếu kho đã có (thư trùng, hoặc `branch.updated` tới trước) thì
 * không đụng vào trạng thái đang có: chỉ tạo khi chưa có.
 */
export async function onBranchCreated(payload: unknown, { tx }: { tx: Tx }): Promise<void> {
  const { branchId, name } = parse<BranchCreatedPayload>(branchCreatedPayloadSchema, payload);
  await tx.$executeRaw`
    INSERT INTO "inventory"."Warehouse" ("id", "branchId", "name", "isActive", "updatedAt")
    VALUES (gen_random_uuid(), ${branchId}::uuid, ${name}, true, now())
    ON CONFLICT ("branchId") DO NOTHING`;
}

/** `branch.updated`: cập nhật tên và trạng thái của kho; chưa có kho thì tạo luôn (thư đến lệch thứ tự). */
export async function onBranchUpdated(payload: unknown, { tx }: { tx: Tx }): Promise<void> {
  const { branchId, name, isActive } = parse<BranchUpdatedPayload>(
    branchUpdatedPayloadSchema,
    payload,
  );
  await upsertWarehouse(tx, branchId, name, isActive);
}

/** Bảng sự kiện → hàm xử lý, đăng ký cho consumer cơ sở của `libs/common`. */
export const BRANCH_HANDLERS = {
  [ROUTING_KEYS.BRANCH_CREATED]: onBranchCreated,
  [ROUTING_KEYS.BRANCH_UPDATED]: onBranchUpdated,
};
