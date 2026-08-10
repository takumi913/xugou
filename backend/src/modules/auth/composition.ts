import * as bcrypt from "bcryptjs";
import type { Bindings } from "../../models/db";
import { AuthUseCases } from "./application/AuthUseCases";
import { D1AuthRepository } from "./persistence/D1AuthRepository";

export function createAuthUseCases(env: Pick<Bindings, "DB">) {
  return new AuthUseCases(new D1AuthRepository(env), {
    compare: (plaintext, passwordHash) => bcrypt.compare(plaintext, passwordHash),
    hash: (plaintext) => bcrypt.hash(plaintext, 12),
  });
}
