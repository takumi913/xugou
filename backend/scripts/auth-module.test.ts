import assert from "node:assert/strict";
import {
  AuthUseCases,
  type AuthRepositoryPort,
} from "../src/modules/auth/application/AuthUseCases";

const repository: AuthRepositoryPort = {
  async createPrimaryAdmin() {},
  async findCredentialByUsername(username) {
    return username === "admin"
      ? { id: 1, username: "admin", password: "fixture-hash" }
      : null;
  },
  async findPublicAdminById(userId) {
    return userId === 1
      ? {
          id: 1,
          username: "admin",
          email: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }
      : null;
  },
};

const useCases = new AuthUseCases(repository, {
  compare: async (plaintext, hash) =>
    plaintext === "fixture-password" && hash === "fixture-hash",
  hash: async () => "fixture-hash",
});

assert.equal((await useCases.login("admin", "fixture-password")).success, true);
assert.equal((await useCases.login("admin", "wrong")).success, false);
assert.equal((await useCases.login("missing", "fixture-password")).success, false);

const current = await useCases.getCurrentAdmin(1);
assert.equal(current.success, true);
if (current.success) {
  assert.equal(current.user.username, "admin");
  assert.equal("password" in current.user, false);
}
assert.equal((await useCases.getCurrentAdmin(2)).success, false);

let bootstrappedPasswordHash: string | null = null;
const bootstrapUseCases = new AuthUseCases(
  {
    async findCredentialByUsername() {
      return null;
    },
    async findPublicAdminById() {
      return bootstrappedPasswordHash
        ? {
            id: 1,
            username: "admin",
            email: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }
        : null;
    },
    async createPrimaryAdmin(input) {
      bootstrappedPasswordHash = input.passwordHash;
    },
  },
  {
    hash: async (plaintext) => `hash:${plaintext}`,
    compare: async (plaintext, hash) => hash === `hash:${plaintext}`,
  }
);
assert.equal(
  (await bootstrapUseCases.bootstrapPrimaryAdmin("admin", "wrong", "initial-password-123")).status,
  "denied"
);
assert.equal(
  (await bootstrapUseCases.bootstrapPrimaryAdmin("admin", "initial-password-123", undefined)).status,
  "configuration_error"
);
assert.equal(
  (await bootstrapUseCases.bootstrapPrimaryAdmin("admin", "initial-password-123", "initial-password-123")).status,
  "created"
);
assert.equal(bootstrappedPasswordHash, "hash:initial-password-123");
