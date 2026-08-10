export interface OrderedCursor {
  sortOrder: number;
  id: number;
}

const CURSOR_PATTERN = /^(-?\d+):(\d+)$/;

export function encodeOrderedCursor(cursor: OrderedCursor): string {
  return `${cursor.sortOrder}:${cursor.id}`;
}

export function decodeOrderedCursor(value: string): OrderedCursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const sortOrder = Number(match[1]);
  const id = Number(match[2]);
  if (
    !Number.isSafeInteger(sortOrder) ||
    !Number.isSafeInteger(id) ||
    id <= 0
  ) {
    return null;
  }
  return { sortOrder, id };
}
