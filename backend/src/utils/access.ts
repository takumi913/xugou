export function dedupeResourceIds(ids: number[]) {
  return Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
}

export function getMissingResourceIds(
  requestedIds: number[],
  accessibleIds: number[]
) {
  const accessibleIdSet = new Set(accessibleIds);
  return requestedIds.filter((id) => !accessibleIdSet.has(id));
}
