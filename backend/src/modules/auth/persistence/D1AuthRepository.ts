import type { Bindings } from "../../../models/db";
import type { AuthRepositoryPort } from "../application/AuthUseCases";
import type {
  AdminCredentialRecord,
  PublicAdminProfile,
} from "../domain/models";

const PRIMARY_ADMIN_ID = 1;

export class D1AuthRepository implements AuthRepositoryPort {
  constructor(private readonly env: Pick<Bindings, "DB">) {}

  async findCredentialByUsername(username: string) {
    return this.env.DB.prepare(
      `SELECT id, username, password, email, created_at, updated_at
       FROM users WHERE id = ? AND username = ? LIMIT 1`
    )
      .bind(PRIMARY_ADMIN_ID, username)
      .first<AdminCredentialRecord>();
  }

  async findPublicAdminById(userId: number) {
    return this.env.DB.prepare(
      `SELECT id, username, email, created_at, updated_at
       FROM users WHERE id = ? AND id = ? LIMIT 1`
    )
      .bind(PRIMARY_ADMIN_ID, userId)
      .first<PublicAdminProfile>();
  }

  async createPrimaryAdmin(input: {
    username: string;
    passwordHash: string;
    now: string;
  }) {
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, username, password, email, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
      .bind(
        PRIMARY_ADMIN_ID,
        input.username,
        input.passwordHash,
        input.now,
        input.now
      )
      .run();
  }
}
