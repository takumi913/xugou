export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = 100_000;
export const MAX_PAGE_OFFSET = (MAX_PAGE_NUMBER - 1) * MAX_PAGE_SIZE;

export function normalizePageSize(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(
    Math.max(Math.trunc(value as number), 1),
    MAX_PAGE_SIZE
  );
}

export function normalizePageOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(
    Math.max(Math.trunc(value as number), 0),
    MAX_PAGE_OFFSET
  );
}
