import {
  appraisalInputSchema,
  buybackQuoteInputSchema,
  createBuybackSchema,
  type AppraisalInput,
  type BuybackDetail,
  type BuybackQuote,
  type CreateBuyback,
} from '@jewelry/contracts';
import type { BuybackPolicy } from './api.ts';
import { hasRoleAtBranch } from '../auth/permissions.ts';
import type { CurrentUser } from '@jewelry/contracts';

export const STATUS = {
  DRAFT: { label: 'Nháp', color: 'gray' },
  PENDING_APPRAISAL: { label: 'Chờ kiểm định', color: 'yellow' },
  APPRAISED: { label: 'Đã kiểm định', color: 'blue' },
  APPROVED: { label: 'Đã duyệt giá', color: 'green' },
  REJECTED: { label: 'Từ chối', color: 'red' },
  CANCELLED: { label: 'Đã huỷ', color: 'gray' },
} as const;

export const AUDIT_ACTION = {
  CREATED: 'Tạo phiếu',
  UPDATED: 'Sửa phiếu',
  SUBMITTED: 'Gửi kiểm định',
  CANCELLED: 'Hủy phiếu',
  APPRAISED: 'Kiểm định',
  QUOTED: 'Lập báo giá',
  APPROVED: 'Duyệt báo giá',
  REJECTED: 'Từ chối báo giá',
} as const;

export const QUOTE_STATUS = {
  QUOTED: 'Chờ duyệt',
  SUPERSEDED: 'Đã thay thế',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Đã từ chối',
} as const;

export type IntakeItemFields = {
  source: 'STORE_TAG' | 'EXTERNAL';
  referenceTagCode: string;
  assetKind: 'GOLD' | 'SILVER' | 'JEWELRY';
  description: string;
  condition: string;
  declaredWeight: string;
  initialMeasuredWeight: string;
  declaredPurity: string;
  notes: string;
};
export type IntakeFields = {
  customerMode: 'new' | 'existing';
  customerId: string;
  customerName: string;
  customerPhone: string;
  notes: string;
  items: IntakeItemFields[];
};
export const emptyItem = (): IntakeItemFields => ({
  source: 'EXTERNAL',
  referenceTagCode: '',
  assetKind: 'JEWELRY',
  description: '',
  condition: '',
  declaredWeight: '',
  initialMeasuredWeight: '',
  declaredPurity: '',
  notes: '',
});
export const emptyIntake = (): IntakeFields => ({
  customerMode: 'new',
  customerId: '',
  customerName: '',
  customerPhone: '',
  notes: '',
  items: [emptyItem()],
});
const optional = (value: string) => value.trim() || null;
export function intakeBody(fields: IntakeFields): CreateBuyback {
  return {
    customer:
      fields.customerMode === 'existing'
        ? { customerId: fields.customerId.trim() }
        : { name: fields.customerName.trim(), phone: fields.customerPhone.trim() },
    notes: optional(fields.notes),
    items: fields.items.map((item) => ({
      source: item.source,
      referenceTagCode: item.source === 'STORE_TAG' ? optional(item.referenceTagCode) : null,
      assetKind: item.assetKind,
      description: item.description.trim(),
      condition: item.condition.trim(),
      declaredWeight: optional(item.declaredWeight),
      initialMeasuredWeight: optional(item.initialMeasuredWeight),
      declaredPurity: optional(item.declaredPurity),
      notes: optional(item.notes),
    })),
  };
}
export function intakeErrors(fields: IntakeFields): Record<string, string> {
  const parsed = createBuybackSchema.safeParse(intakeBody(fields));
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || 'form';
      errors[path] ??= issue.message;
    }
  }
  // Sales còn chuẩn hoá +84/84 và kiểm tra số nội địa khi ghi khách mới.
  if (fields.customerMode === 'new') {
    const compact = fields.customerPhone.trim().replace(/[\s.()-]/g, '');
    const local = compact.startsWith('+84')
      ? `0${compact.slice(3)}`
      : compact.startsWith('84')
        ? `0${compact.slice(2)}`
        : compact;
    if (!/^0\d{9,10}$/.test(local)) errors['customer.phone'] = 'Số điện thoại không hợp lệ';
  }
  return errors;
}
export function fieldsFromDetail(detail: BuybackDetail): IntakeFields {
  return {
    customerMode: detail.customerId ? 'existing' : 'new',
    customerId: detail.customerId ?? '',
    customerName: detail.customerName,
    customerPhone: detail.customerPhone,
    notes: detail.notes ?? '',
    items: detail.items.map((item) => ({
      source: item.source,
      referenceTagCode: item.referenceTagCode ?? '',
      assetKind: item.assetKind,
      description: item.description,
      condition: item.condition,
      declaredWeight: item.declaredWeight ?? '',
      initialMeasuredWeight: item.initialMeasuredWeight ?? '',
      declaredPurity: item.declaredPurity ?? '',
      notes: item.notes ?? '',
    })),
  };
}
export function intakeActions(me: CurrentUser | undefined, detail: BuybackDetail) {
  const member = me && hasRoleAtBranch(me.branches, detail.branchId, ['STAFF', 'MANAGER']);
  const manager = me && hasRoleAtBranch(me.branches, detail.branchId, ['MANAGER']);
  const own = me?.id === detail.createdBy;
  return {
    edit: Boolean(detail.status === 'DRAFT' && member && (manager || own)),
    submit: Boolean(detail.status === 'DRAFT' && member && (manager || own)),
    cancel: Boolean(
      member &&
      (manager || own) &&
      (detail.status === 'DRAFT' || (manager && detail.status === 'PENDING_APPRAISAL')),
    ),
    appraise: Boolean(member && ['PENDING_APPRAISAL', 'APPRAISED'].includes(detail.status)),
    quote: Boolean(member && detail.status === 'APPRAISED'),
    decide: Boolean(manager && detail.status === 'APPRAISED'),
  };
}
export function canApprove(
  me: CurrentUser | undefined,
  detail: BuybackDetail,
  quote: BuybackQuote,
): string | null {
  if (!intakeActions(me, detail).decide) return 'Cần quyền quản lý và phiếu đã kiểm định.';
  if (
    me?.id === detail.createdBy ||
    me?.id === quote.quotedBy ||
    quote.lines.some((line) => line.appraisedBy === me?.id)
  )
    return 'Người duyệt phải khác người tiếp nhận, kiểm định và lập báo giá.';
  return null;
}
export function validAppraisal(body: AppraisalInput): Record<string, string> {
  const result = appraisalInputSchema.safeParse(body);
  return result.success
    ? {}
    : Object.fromEntries(
        result.error.issues.map((issue) => [issue.path.join('.') || 'form', issue.message]),
      );
}
export const samePurity = (left: string, right: string): boolean => {
  const normalized = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return `${BigInt(whole ?? '0')}.${fraction.padEnd(4, '0')}`;
  };
  return normalized(left) === normalized(right);
};
export function quoteBody(
  version: number,
  itemIds: string[],
  policies: Record<string, string>,
  allPolicies: BuybackPolicy[],
) {
  const body = {
    version,
    items: itemIds.map((itemId) => {
      const policy = allPolicies.find((entry) => entry.id === policies[itemId]);
      return { itemId, policyId: policy?.id ?? '', policyVersion: policy?.version ?? 0 };
    }),
  };
  return buybackQuoteInputSchema.parse(body);
}
