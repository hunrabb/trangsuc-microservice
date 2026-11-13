import {
  Alert,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import type { CreateBuyback } from '@jewelry/contracts';
import { ErrorAlert } from '../components/error-alert.tsx';
import {
  emptyIntake,
  emptyItem,
  intakeBody,
  intakeErrors,
  type IntakeFields,
  type IntakeItemFields,
} from './model.ts';

export function IntakeForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onReload,
}: {
  initial?: IntakeFields;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  onSubmit(body: CreateBuyback): Promise<void>;
  onReload?: () => void;
}) {
  const [fields, setFields] = useState<IntakeFields>(() => initial ?? emptyIntake());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (patch: Partial<IntakeFields>) => {
    setFields((current) => ({ ...current, ...patch }));
    setErrors({});
  };
  const updateItem = (index: number, patch: Partial<IntakeItemFields>) => {
    setFields((current) => ({
      ...current,
      items: current.items.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    }));
    setErrors({});
  };
  const submit = async () => {
    const next = intakeErrors(fields);
    setErrors(next);
    if (Object.keys(next).length === 0) {
      try {
        await onSubmit(intakeBody(fields));
      } catch {
        /* mutation hiện lỗi qua prop error và notification của màn hình */
      }
    }
  };
  return (
    <Stack>
      <ErrorAlert error={error} onReload={onReload} />
      {Object.keys(errors).length > 0 && <Alert color="red">{Object.values(errors)[0]}</Alert>}
      <Paper withBorder p="md" radius="md">
        <Stack>
          <Title order={4}>Khách hàng</Title>
          <Select
            label="Thông tin khách"
            value={fields.customerMode}
            allowDeselect={false}
            data={[
              { value: 'new', label: 'Nhập tên và số điện thoại' },
              { value: 'existing', label: 'Khách đã có ID' },
            ]}
            onChange={(value) =>
              value && update({ customerMode: value as IntakeFields['customerMode'] })
            }
          />
          {fields.customerMode === 'existing' ? (
            <TextInput
              label="ID khách hàng"
              value={fields.customerId}
              error={errors['customer.customerId']}
              onChange={(event) => update({ customerId: event.currentTarget.value })}
            />
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Tên khách hàng"
                value={fields.customerName}
                error={errors['customer.name']}
                onChange={(event) => update({ customerName: event.currentTarget.value })}
              />
              <TextInput
                label="Số điện thoại"
                value={fields.customerPhone}
                error={errors['customer.phone']}
                onChange={(event) => update({ customerPhone: event.currentTarget.value })}
              />
            </SimpleGrid>
          )}
          <Textarea
            label="Ghi chú phiếu"
            maxLength={2000}
            value={fields.notes}
            error={errors.notes}
            onChange={(event) => update({ notes: event.currentTarget.value })}
          />
        </Stack>
      </Paper>
      {fields.items.map((item, index) => {
        const e = (name: keyof IntakeItemFields) => errors[`items.${index}.${name}`];
        return (
          <Paper withBorder p="md" radius="md" key={index}>
            <Stack>
              <Group justify="space-between">
                <Title order={4}>Món {index + 1}</Title>
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  disabled={fields.items.length === 1 || busy}
                  onClick={() =>
                    update({ items: fields.items.filter((_, position) => position !== index) })
                  }
                >
                  Xóa món
                </Button>
              </Group>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label="Nguồn"
                  value={item.source}
                  allowDeselect={false}
                  data={[
                    { value: 'EXTERNAL', label: 'Hàng bên ngoài' },
                    { value: 'STORE_TAG', label: 'Có tem cửa hàng' },
                  ]}
                  onChange={(value) =>
                    value &&
                    updateItem(index, {
                      source: value as IntakeItemFields['source'],
                      referenceTagCode: '',
                    })
                  }
                />
                <Select
                  label="Loại khai báo"
                  value={item.assetKind}
                  allowDeselect={false}
                  data={[
                    { value: 'GOLD', label: 'Vàng' },
                    { value: 'SILVER', label: 'Bạc' },
                    { value: 'JEWELRY', label: 'Trang sức' },
                  ]}
                  onChange={(value) =>
                    value &&
                    updateItem(index, { assetKind: value as IntakeItemFields['assetKind'] })
                  }
                />
                {item.source === 'STORE_TAG' && (
                  <TextInput
                    label="Mã tem tham chiếu"
                    value={item.referenceTagCode}
                    error={e('referenceTagCode')}
                    maxLength={100}
                    onChange={(event) =>
                      updateItem(index, { referenceTagCode: event.currentTarget.value })
                    }
                  />
                )}
                <TextInput
                  label="Tình trạng"
                  value={item.condition}
                  maxLength={1000}
                  error={e('condition')}
                  onChange={(event) => updateItem(index, { condition: event.currentTarget.value })}
                />
                <TextInput
                  label="Trọng lượng khách khai (chỉ)"
                  value={item.declaredWeight}
                  error={e('declaredWeight')}
                  onChange={(event) =>
                    updateItem(index, { declaredWeight: event.currentTarget.value })
                  }
                />
                <TextInput
                  label="Số đo ban đầu (chỉ)"
                  value={item.initialMeasuredWeight}
                  error={e('initialMeasuredWeight')}
                  onChange={(event) =>
                    updateItem(index, { initialMeasuredWeight: event.currentTarget.value })
                  }
                />
                <TextInput
                  label="Hàm lượng khách khai"
                  value={item.declaredPurity}
                  maxLength={100}
                  error={e('declaredPurity')}
                  onChange={(event) =>
                    updateItem(index, { declaredPurity: event.currentTarget.value })
                  }
                />
              </SimpleGrid>
              <Textarea
                label="Mô tả trang sức"
                value={item.description}
                maxLength={1000}
                error={e('description')}
                onChange={(event) => updateItem(index, { description: event.currentTarget.value })}
              />
              <Textarea
                label="Ghi chú món"
                value={item.notes}
                maxLength={1000}
                error={e('notes')}
                onChange={(event) => updateItem(index, { notes: event.currentTarget.value })}
              />
            </Stack>
          </Paper>
        );
      })}
      {errors.items && (
        <Text c="red" size="sm">
          {errors.items}
        </Text>
      )}
      <Group>
        <Button
          variant="light"
          disabled={fields.items.length >= 20 || busy}
          onClick={() => update({ items: [...fields.items, emptyItem()] })}
        >
          Thêm món
        </Button>
        <Button loading={busy} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}
