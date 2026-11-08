import { Alert, Loader } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { describeError } from '../api/messages.ts';
import { formatMoney, formatWeight } from '../inventory/format.ts';
import './label-print.css';

/**
 * Trang in tem riêng (không có khung menu), mở ở thẻ mới từ trang tồn kho. Dựng tem từ JSON của
 * `GET /jewelry-items/{tagCode}/label`. Trang chỉ hiện nội dung tem để khi mở ở thẻ mới không lẫn nút điều khiển;
 * CSS `@media print` đặt khổ giấy 70 × 40 mm. Không tạo file PDF. "Giá tạm tính" là theo giá lúc mở trang.
 */
export function ItemLabelPage() {
  const { tagCode = '' } = useParams();
  const label = useQuery({
    queryKey: ['inventory', 'label', tagCode],
    queryFn: () => inventoryApi.getItemLabel(tagCode),
    retry: false,
  });

  return (
    <div className="label-page">
      {label.isPending && <Loader className="no-print" />}
      {label.isError && (
        <Alert color="red" className="no-print">
          {describeError(label.error)}
        </Alert>
      )}
      {label.data !== undefined && (
        <div className="label-sheet">
          <p className="label-name">{label.data.productName}</p>
          <p className="label-detail">
            {label.data.variantName} · {label.data.metalName}
          </p>
          <p className="label-detail">Trọng lượng: {formatWeight(label.data.weight)}</p>
          <p className="label-price">{formatMoney(label.data.estimatedPrice)}</p>
          <p className="label-tag">{label.data.tagCode}</p>
        </div>
      )}
    </div>
  );
}
