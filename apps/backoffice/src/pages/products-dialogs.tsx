import type { Category, Product, Variant } from '@jewelry/contracts';
import { Button, Group, Modal, Select, Stack, Switch, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inventoryApi } from '../api/inventory-endpoints.ts';
import {
  inventoryKeys,
  useAllProducts,
  useCategories,
  useMetals,
} from '../api/inventory-queries.ts';
import { boundFieldErrors, ErrorAlert } from '../components/error-alert.tsx';
import { isDecimalText } from '../inventory/format.ts';

/**
 * Ba biểu mẫu tạo và sửa: danh mục, mẫu, biến thể. Sửa gửi kèm `version`: người khác vừa sửa thì server trả
 * `VERSION_CONFLICT` và biểu mẫu hiện "Dữ liệu đã bị người khác sửa, tải lại?" kèm nút tải lại (đóng biểu mẫu và
 * tải lại danh sách).
 */

/** Sau khi lưu hoặc tải lại: làm mới cả ba danh sách, vì mẫu và biến thể tham chiếu lẫn nhau. */
function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: inventoryKeys.categories }),
      queryClient.invalidateQueries({ queryKey: inventoryKeys.products }),
      queryClient.invalidateQueries({ queryKey: inventoryKeys.variants }),
    ]);
}

// ---------------------------------------------------------------- Danh mục
const CATEGORY_FIELDS = ['name', 'isActive'];

export function CategoryModal({
  category,
  onClose,
}: {
  category: Category | null;
  onClose(): void;
}) {
  const refresh = useRefreshCatalog();
  const form = useForm({
    initialValues: { name: category?.name ?? '', isActive: category?.isActive ?? true },
    validate: { name: (value) => (value.trim() === '' ? 'Nhập tên danh mục' : null) },
  });
  const save = useMutation({
    mutationFn: (values: { name: string; isActive: boolean }) =>
      category === null
        ? inventoryApi.createCategory({ name: values.name.trim() })
        : inventoryApi.updateCategory(category.id, {
            version: category.version,
            name: values.name.trim(),
            isActive: values.isActive,
          }),
    onSuccess: async () => {
      await refresh();
      notifications.show({ color: 'green', message: 'Đã lưu danh mục.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, CATEGORY_FIELDS)),
  });
  const reload = () => {
    void refresh();
    onClose();
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={category === null ? 'Thêm danh mục' : 'Sửa danh mục'}
      centered
    >
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert error={save.error} onReload={reload} boundFields={CATEGORY_FIELDS} />
        <Stack>
          <TextInput label="Tên danh mục" withAsterisk {...form.getInputProps('name')} />
          {category !== null && (
            <Switch
              label="Đang sử dụng"
              {...form.getInputProps('isActive', { type: 'checkbox' })}
            />
          )}
          <FormButtons onClose={onClose} saving={save.isPending} />
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Mẫu
const PRODUCT_FIELDS = ['categoryId', 'name', 'description', 'isActive'];

export function ProductModal({ product, onClose }: { product: Product | null; onClose(): void }) {
  const refresh = useRefreshCatalog();
  const categories = useCategories();
  const form = useForm({
    initialValues: {
      categoryId: product?.categoryId ?? '',
      name: product?.name ?? '',
      description: product?.description ?? '',
      isActive: product?.isActive ?? true,
    },
    validate: {
      categoryId: (value) => (value === '' ? 'Chọn danh mục' : null),
      name: (value) => (value.trim() === '' ? 'Nhập tên mẫu' : null),
    },
  });
  const save = useMutation({
    mutationFn: (values: typeof form.values) => {
      const description = values.description.trim();
      return product === null
        ? inventoryApi.createProduct({
            categoryId: values.categoryId,
            name: values.name.trim(),
            ...(description === '' ? {} : { description }),
          })
        : inventoryApi.updateProduct(product.id, {
            version: product.version,
            categoryId: values.categoryId,
            name: values.name.trim(),
            description: description === '' ? null : description,
            isActive: values.isActive,
          });
    },
    onSuccess: async () => {
      await refresh();
      notifications.show({ color: 'green', message: 'Đã lưu mẫu sản phẩm.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, PRODUCT_FIELDS)),
  });
  const reload = () => {
    void refresh();
    onClose();
  };

  return (
    <Modal opened onClose={onClose} title={product === null ? 'Thêm mẫu' : 'Sửa mẫu'} centered>
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert error={save.error} onReload={reload} boundFields={PRODUCT_FIELDS} />
        <Stack>
          <Select
            label="Danh mục"
            withAsterisk
            searchable
            allowDeselect={false}
            data={(categories.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
            {...form.getInputProps('categoryId')}
          />
          <TextInput label="Tên mẫu" withAsterisk {...form.getInputProps('name')} />
          <TextInput label="Mô tả" {...form.getInputProps('description')} />
          {product !== null && (
            <Switch
              label="Đang sử dụng"
              {...form.getInputProps('isActive', { type: 'checkbox' })}
            />
          )}
          <FormButtons onClose={onClose} saving={save.isPending} />
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Biến thể
const VARIANT_FIELDS = ['productId', 'metalId', 'sku', 'name', 'defaultLaborFee', 'isActive'];

/** Biến thể = mẫu + loại kim loại. Khi sửa chỉ đổi được tên, tiền công mặc định và trạng thái. */
export function VariantModal({ variant, onClose }: { variant: Variant | null; onClose(): void }) {
  const refresh = useRefreshCatalog();
  const products = useAllProducts();
  const metals = useMetals();
  const form = useForm({
    initialValues: {
      productId: variant?.productId ?? '',
      metalId: variant?.metalId ?? '',
      sku: variant?.sku ?? '',
      name: variant?.name ?? '',
      defaultLaborFee: variant?.defaultLaborFee ?? '0',
      isActive: variant?.isActive ?? true,
    },
    validate: {
      productId: (value) => (value === '' ? 'Chọn mẫu' : null),
      metalId: (value) => (value === '' ? 'Chọn kim loại' : null),
      sku: (value) => (value.trim() === '' ? 'Nhập mã SKU' : null),
      name: (value) => (value.trim() === '' ? 'Nhập tên biến thể' : null),
      defaultLaborFee: (value) =>
        isDecimalText(value, 2) ? null : 'Nhập số tiền hợp lệ (tối đa 2 chữ số thập phân)',
    },
  });
  const save = useMutation({
    mutationFn: (values: typeof form.values) =>
      variant === null
        ? inventoryApi.createVariant({
            productId: values.productId,
            metalId: values.metalId,
            sku: values.sku.trim(),
            name: values.name.trim(),
            defaultLaborFee: values.defaultLaborFee.trim(),
          })
        : inventoryApi.updateVariant(variant.id, {
            version: variant.version,
            name: values.name.trim(),
            defaultLaborFee: values.defaultLaborFee.trim(),
            isActive: values.isActive,
          }),
    onSuccess: async () => {
      await refresh();
      notifications.show({ color: 'green', message: 'Đã lưu biến thể.' });
      onClose();
    },
    onError: (error) => form.setErrors(boundFieldErrors(error, VARIANT_FIELDS)),
  });
  const reload = () => {
    void refresh();
    onClose();
  };
  const isCreating = variant === null;

  return (
    <Modal opened onClose={onClose} title={isCreating ? 'Thêm biến thể' : 'Sửa biến thể'} centered>
      <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
        <ErrorAlert error={save.error} onReload={reload} boundFields={VARIANT_FIELDS} />
        <Stack>
          <Select
            label="Mẫu"
            withAsterisk
            searchable
            disabled={!isCreating}
            allowDeselect={false}
            data={(products.data?.items ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            {...form.getInputProps('productId')}
          />
          <Select
            label="Kim loại"
            withAsterisk
            disabled={!isCreating}
            allowDeselect={false}
            data={(metals.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
            {...form.getInputProps('metalId')}
          />
          <TextInput
            label="Mã SKU"
            withAsterisk
            disabled={!isCreating}
            {...form.getInputProps('sku')}
          />
          <TextInput label="Tên biến thể" withAsterisk {...form.getInputProps('name')} />
          <TextInput
            label="Tiền công mặc định (đồng)"
            description="Điền sẵn khi nhập hàng; mỗi chiếc có thể có tiền công riêng."
            inputMode="decimal"
            {...form.getInputProps('defaultLaborFee')}
          />
          {!isCreating && (
            <Switch
              label="Đang sử dụng"
              {...form.getInputProps('isActive', { type: 'checkbox' })}
            />
          )}
          <FormButtons onClose={onClose} saving={save.isPending} />
        </Stack>
      </form>
    </Modal>
  );
}

function FormButtons({ onClose, saving }: { onClose(): void; saving: boolean }) {
  return (
    <Group justify="flex-end">
      <Button variant="default" onClick={onClose}>
        Huỷ
      </Button>
      <Button type="submit" loading={saving}>
        Lưu
      </Button>
    </Group>
  );
}
