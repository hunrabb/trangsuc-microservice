import { type ApiError, isApiError } from './api-error.ts';

/** Thông báo tiếng Việt theo mã lỗi của server. Một chỗ duy nhất để mọi màn hình nói cùng một câu. */
const MESSAGES: Partial<Record<string, string>> = {
  INVALID_CREDENTIALS: 'Sai email hoặc mật khẩu.',
  ACCOUNT_NOT_PROVISIONED:
    'Tài khoản này chưa được cấp quyền, đã bị khoá hoặc chưa có vai trò. Vui lòng liên hệ quản trị viên.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.',
  INVALID_TOKEN: 'Phiên đăng nhập không hợp lệ, vui lòng đăng nhập lại.',
  PASSWORD_TOO_WEAK: 'Mật khẩu phải có ít nhất 12 ký tự (tối đa 72 byte).',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  NOT_FOUND: 'Không tìm thấy dữ liệu. Có thể nó đã bị xoá hoặc đổi.',
  VERSION_CONFLICT: 'Dữ liệu đã bị người khác sửa, tải lại?',
  BUYBACK_POLICY_REQUIRED: 'Chưa có chính sách thu mua phù hợp cho món kiểm định.',
  BUYBACK_APPRAISAL_INCOMPLETE: 'Cần kiểm định đủ tất cả món trước khi báo giá.',
  BUYBACK_PRICE_INVALID: 'Giá mua vào không hợp lệ hoặc chưa có. Hãy kiểm tra giá Inventory.',
  BUYBACK_SEPARATE_APPROVER_REQUIRED:
    'Người duyệt phải khác người tiếp nhận, kiểm định và lập báo giá.',
  IDEMPOTENCY_KEY_REUSED: 'Yêu cầu đã dùng khóa này với nội dung khác; tải lại trước khi thử.',
  PAYMENT_REFERENCE_CONFLICT:
    'Mã chứng từ đã được dùng cho giao dịch khác. Hãy đối chiếu trước khi tiếp tục.',
  LAST_ADMIN: 'Không thể: hệ thống phải còn ít nhất một quản trị viên.',
  METAL_PRICE_NOT_SET:
    'Kim loại này chưa có giá. Hãy nhập giá kim loại ở trang "Giá kim loại" trước.',
  ITEM_NOT_AVAILABLE: 'Có món hàng không còn bán được.',
  INVALID_STATE: 'Thao tác không còn phù hợp với trạng thái hiện tại. Hãy tải lại danh sách.',
  VALIDATION_FAILED: 'Dữ liệu chưa hợp lệ, vui lòng kiểm tra lại.',
  SERVICE_UNAVAILABLE: 'Hệ thống đang bận, vui lòng thử lại sau ít giây.',
  NETWORK_ERROR: 'Không kết nối được tới máy chủ. Hãy kiểm tra mạng rồi thử lại.',
  INVALID_DOWNLOAD: 'Máy chủ không trả về file Excel hợp lệ. Vui lòng thử lại.',
  PAYLOAD_TOO_LARGE: 'Báo cáo quá lớn. Hãy chọn ít ngày hơn hoặc lọc một chi nhánh.',
  INTERNAL_ERROR: 'Hệ thống gặp lỗi, vui lòng thử lại sau.',
};

const rateLimited = (error: ApiError): string =>
  error.retryAfterSeconds === undefined
    ? 'Bạn thử quá nhiều lần. Vui lòng chờ một lát rồi thử lại.'
    : `Bạn thử quá nhiều lần. Vui lòng chờ ${error.retryAfterSeconds} giây rồi thử lại.`;

/** Câu thông báo cho người dùng; lỗi lạ thì nói chung chung, không lộ chi tiết kỹ thuật. */
export function describeError(error: unknown): string {
  if (!isApiError(error)) {
    return MESSAGES.INTERNAL_ERROR ?? 'Hệ thống gặp lỗi.';
  }
  if (error.code === 'RATE_LIMITED') {
    return rateLimited(error);
  }
  return MESSAGES[error.code] ?? MESSAGES.INTERNAL_ERROR ?? 'Hệ thống gặp lỗi.';
}
