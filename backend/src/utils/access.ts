export type OwnedResource = {
  created_by: number;
};

export function canAccessOwnedResource<T extends OwnedResource>(
  resource: T | null | undefined,
  userId: number,
  role?: string
): resource is T {
  if (!resource) {
    return false;
  }
  return role === "admin" || resource.created_by === userId;
}

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
