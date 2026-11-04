import type { DedupInput } from './dedup.js';

/** Giữ khớp với maxItems của excludeIds trong dedup-input.schema.json. */
const MAX_EXCLUDE_IDS = 100;

/**
 * Validate thủ công input theo đúng dedup-input.schema.json tại boundary
 * của route, trước khi đưa vào domain logic. Giữ đồng bộ tay với
 * src/schemas/dedup-input.schema.json — xem ghi chú ở validate-output.ts.
 */
export function parseDedupInput(input: unknown): DedupInput {
  const errors = collectInputErrors(input);
  if (errors.length > 0) {
    throw new Error(`Input không hợp lệ theo dedup-input.schema.json: ${errors.join('; ')}`);
  }

  const record = input as Record<string, unknown>;
  return {
    type: record.type as DedupInput['type'],
    title: record.title as string,
    content: record.content as string,
    excludeIds: Array.isArray(record.excludeIds) ? (record.excludeIds as string[]) : undefined,
    parentSolutionId: typeof record.parentSolutionId === 'string' ? record.parentSolutionId : undefined,
  };
}

function collectInputErrors(input: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return ['input phải là object'];
  }

  const allowedKeys = ['type', 'title', 'content', 'excludeIds', 'parentSolutionId'];
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    errors.push(`additionalProperties không hợp lệ: ${unknownKeys.join(', ')}`);
  }

  if (input.type !== 'solution') {
    errors.push('type phải là "solution"');
  }

  if (!isBoundedString(input.title, 1, 300)) {
    errors.push('title phải là string độ dài 1..300');
  }

  if (!isBoundedString(input.content, 1, 20000)) {
    errors.push('content phải là string độ dài 1..20000');
  }

  if (input.excludeIds !== undefined) {
    if (!Array.isArray(input.excludeIds) || input.excludeIds.length > MAX_EXCLUDE_IDS) {
      errors.push(`excludeIds phải là array tối đa ${MAX_EXCLUDE_IDS} phần tử khi có mặt`);
    } else if (!input.excludeIds.every((id) => isBoundedString(id, 1, 200))) {
      errors.push('mỗi phần tử của excludeIds phải là string độ dài 1..200');
    }
  }

  if (input.parentSolutionId !== undefined && !isBoundedString(input.parentSolutionId, 1, 200)) {
    errors.push('parentSolutionId phải là string độ dài 1..200 khi có mặt');
  }

  return errors;
}

function isBoundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
