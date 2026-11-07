import type { Category, Product, Variant } from '@jewelry/contracts';
import {
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import {
  useAllProducts,
  useCategories,
  useMetals,
  useProductPage,
  useVariantPage,
} from '../api/inventory-queries.ts';
import { ErrorAlert } from '../components/error-alert.tsx';
import { PlusIcon } from '../components/icons.tsx';
import { formatMoney } from '../inventory/format.ts';
import { CategoryModal, ProductModal, VariantModal } from './products-dialogs.tsx';

const PAGE_SIZE = 20;

type Dialog =
  | { kind: 'category'; category: Category | null }
  | { kind: 'product'; product: Product | null }
  | { kind: 'variant'; variant: Variant | null };

const ActiveBadge = ({ isActive }: { isActive: boolean }) => (
  <Badge color={isActive ? 'green' : 'gray'}>{isActive ? 'Đang dùng' : 'Ngừng dùng'}</Badge>
);

/** Sản phẩm (chỉ ADMIN): ba thẻ danh mục, mẫu, biến thể; mỗi thẻ có bảng, thêm và sửa. */
export function ProductsPage() {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const closeDialog = () => setDialog(null);

  return (
    <Stack>
      <Title order={2}>Sản phẩm</Title>
      <Tabs defaultValue="categories" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="categories">Danh mục</Tabs.Tab>
          <Tabs.Tab value="products">Mẫu</Tabs.Tab>
          <Tabs.Tab value="variants">Biến thể</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="categories" pt="md">
          <CategoriesTab onEdit={(category) => setDialog({ kind: 'category', category })} />
        </Tabs.Panel>
        <Tabs.Panel value="products" pt="md">
          <ProductsTab onEdit={(product) => setDialog({ kind: 'product', product })} />
        </Tabs.Panel>
        <Tabs.Panel value="variants" pt="md">
          <VariantsTab onEdit={(variant) => setDialog({ kind: 'variant', variant })} />
        </Tabs.Panel>
      </Tabs>
      {dialog?.kind === 'category' && (
        <CategoryModal category={dialog.category} onClose={closeDialog} />
      )}
      {dialog?.kind === 'product' && (
        <ProductModal product={dialog.product} onClose={closeDialog} />
      )}
      {dialog?.kind === 'variant' && (
        <VariantModal variant={dialog.variant} onClose={closeDialog} />
      )}
    </Stack>
  );
}

function AddButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Group justify="flex-end" mb="sm">
      <Button leftSection={<PlusIcon size={16} />} onClick={onClick}>
        {label}
      </Button>
    </Group>
  );
}

function CategoriesTab({ onEdit }: { onEdit(category: Category | null): void }) {
  const categories = useCategories();
  return (
    <>
      <AddButton label="Thêm danh mục" onClick={() => onEdit(null)} />
      {categories.isError && (
        <ErrorAlert error={categories.error} onReload={() => void categories.refetch()} />
      )}
      <Paper withBorder radius="md" bg="white">
        <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Tên danh mục</Table.Th>
              <Table.Th>Trạng thái</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {categories.data?.map((category) => (
              <Table.Tr key={category.id}>
                <Table.Td>{category.name}</Table.Td>
                <Table.Td>
                  <ActiveBadge isActive={category.isActive} />
                </Table.Td>
                <Table.Td>
                  <Group justify="flex-end">
                    <Button size="compact-sm" variant="default" onClick={() => onEdit(category)}>
                      Sửa
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
      {categories.data?.length === 0 && <Text c="dimmed">Chưa có danh mục nào.</Text>}
    </>
  );
}

function ProductsTab({ onEdit }: { onEdit(product: Product | null): void }) {
  const [page, setPage] = useState(1);
  const products = useProductPage(page, PAGE_SIZE);
  const categories = useCategories();
  const categoryName = (categoryId: string) =>
    categories.data?.find((category) => category.id === categoryId)?.name ?? '…';
  const totalPages = Math.max(1, Math.ceil((products.data?.total ?? 0) / PAGE_SIZE));

  return (
    <>
      <AddButton label="Thêm mẫu" onClick={() => onEdit(null)} />
      {products.isError && (
        <ErrorAlert error={products.error} onReload={() => void products.refetch()} />
      )}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={560}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tên mẫu</Table.Th>
                <Table.Th>Danh mục</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {products.data?.items.map((product) => (
                <Table.Tr key={product.id}>
                  <Table.Td>
                    <Text fw={500}>{product.name}</Text>
                    {product.description !== null && (
                      <Text size="xs" c="dimmed">
                        {product.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{categoryName(product.categoryId)}</Table.Td>
                  <Table.Td>
                    <ActiveBadge isActive={product.isActive} />
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end">
                      <Button size="compact-sm" variant="default" onClick={() => onEdit(product)}>
                        Sửa
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {products.data?.items.length === 0 && <Text c="dimmed">Chưa có mẫu nào.</Text>}
      {totalPages > 1 && <Pagination mt="md" total={totalPages} value={page} onChange={setPage} />}
    </>
  );
}

function VariantsTab({ onEdit }: { onEdit(variant: Variant | null): void }) {
  const [page, setPage] = useState(1);
  const variants = useVariantPage(page, PAGE_SIZE);
  const products = useAllProducts();
  const metals = useMetals();
  const productName = (productId: string) =>
    products.data?.items.find((product) => product.id === productId)?.name ?? '…';
  const metalName = (metalId: string) =>
    metals.data?.find((metal) => metal.id === metalId)?.name ?? '…';
  const totalPages = Math.max(1, Math.ceil((variants.data?.total ?? 0) / PAGE_SIZE));

  return (
    <>
      <AddButton label="Thêm biến thể" onClick={() => onEdit(null)} />
      {variants.isError && (
        <ErrorAlert error={variants.error} onReload={() => void variants.refetch()} />
      )}
      <Paper withBorder radius="md" bg="white">
        <Table.ScrollContainer minWidth={720}>
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Biến thể</Table.Th>
                <Table.Th>Mẫu</Table.Th>
                <Table.Th>Kim loại</Table.Th>
                <Table.Th>Tiền công mặc định</Table.Th>
                <Table.Th>Trạng thái</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {variants.data?.items.map((variant) => (
                <Table.Tr key={variant.id}>
                  <Table.Td>{variant.sku}</Table.Td>
                  <Table.Td>{variant.name}</Table.Td>
                  <Table.Td>{productName(variant.productId)}</Table.Td>
                  <Table.Td>{metalName(variant.metalId)}</Table.Td>
                  <Table.Td>{formatMoney(variant.defaultLaborFee)}</Table.Td>
                  <Table.Td>
                    <ActiveBadge isActive={variant.isActive} />
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end">
                      <Button size="compact-sm" variant="default" onClick={() => onEdit(variant)}>
                        Sửa
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>
      {variants.data?.items.length === 0 && <Text c="dimmed">Chưa có biến thể nào.</Text>}
      {totalPages > 1 && <Pagination mt="md" total={totalPages} value={page} onChange={setPage} />}
    </>
  );
}
