import { Alert, Button, Group, Loader, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import { describeError } from '../api/messages.ts';
import { PrinterIcon } from '../components/icons.tsx';
import { formatMoney, formatWeight } from '../inventory/format.ts';
import './label-print.css';

/**
 * Trang in tem riêng (không có khung menu), mở ở thẻ mới từ trang tồn kho. Dựng tem từ JSON của
 * `GET /jewelry-items/{tagCode}/label`, rồi dùng chức năng in của trình duyệt: CSS `@media print` ẩn nút điều
 * khiển và đặt khổ giấy 70 × 40 mm. Không tạo file PDF. "Giá tạm tính" nghĩa là theo giá kim loại tại lúc in.
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
      <Group className="no-print">
        <Button
          leftSection={<PrinterIcon size={16} />}
          disabled={label.data === undefined}
          onClick={() => window.print()}
        >
          In tem
        </Button>
        <Button variant="default" onClick={() => window.close()}>
          Đóng
        </Button>
      </Group>
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
      <Text className="no-print" size="xs" c="dimmed">
        Giá tạm tính theo giá kim loại hiện tại. Chọn khổ giấy 70 × 40 mm khi in.
      </Text>
    </div>
  );
}
