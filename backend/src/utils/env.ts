export function getEnvNumber(
  env: object | undefined,
  key: string,
  fallback: number,
  options: { min?: number; max?: number } = {}
) {
  const rawValue = env
    ? (env as Record<string, unknown>)[key]
    : undefined;
  if (
    rawValue === undefined ||
    rawValue === null ||
    (typeof rawValue === "string" && rawValue.trim() === "")
  ) {
    return fallback;
  }
  const value =
    typeof rawValue === "number" ? rawValue : Number(String(rawValue));

  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;

  return Math.min(Math.max(rounded, min), max);
}

export function getEnvBoolean(
  env: object | undefined,
  key: string,
  fallback: boolean
): boolean {
  const rawValue = env
    ? (env as Record<string, unknown>)[key]
    : undefined;
  if (
    rawValue === undefined ||
    rawValue === null ||
    (typeof rawValue === "string" && rawValue.trim() === "")
  ) {
    return fallback;
  }
  if (typeof rawValue === "boolean") return rawValue;
  if (typeof rawValue === "number") return rawValue !== 0;
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
