import { drizzle } from "drizzle-orm/d1";
import { Bindings } from "../models/db";
import * as schema from "../db/schema";

export function createDb(env: Pick<Bindings, "DB">) {
  return drizzle(env.DB, { schema });
}

export type AppDatabase = ReturnType<typeof createDb>;
