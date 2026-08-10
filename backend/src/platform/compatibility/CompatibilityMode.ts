import type { Bindings } from "../../models/db";

export type DataCompatibilityMode = "expand" | "contract";

const LEGACY_API_ROOTS = [
  "/api/auth",
  "/api/profile",
  "/api/monitors",
  "/api/agents",
  "/api/status",
  "/api/notifications",
  "/api/dashboard",
] as const;

export function dataCompatibilityMode(
  env: Pick<Bindings, "DATA_COMPATIBILITY_MODE">
): DataCompatibilityMode {
  return env.DATA_COMPATIBILITY_MODE?.trim().toLowerCase() === "contract"
    ? "contract"
    : "expand";
}

export function isContractMode(
  env: Pick<Bindings, "DATA_COMPATIBILITY_MODE">
): boolean {
  return dataCompatibilityMode(env) === "contract";
}

export function isLegacyApiPath(path: string): boolean {
  return LEGACY_API_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

export async function hasTableColumn(
  env: Pick<Bindings, "DB">,
  table: string,
  column: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM pragma_table_info(?) WHERE name = ?`
  )
    .bind(table, column)
    .first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}
