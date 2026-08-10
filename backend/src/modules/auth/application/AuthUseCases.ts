import type {
  AdminCredentialRecord,
  PublicAdminProfile,
} from "../domain/models";

export interface AuthRepositoryPort {
  findCredentialByUsername(
    username: string
  ): Promise<AdminCredentialRecord | null>;
  findPublicAdminById(userId: number): Promise<PublicAdminProfile | null>;
  createPrimaryAdmin(input: {
    username: string;
    passwordHash: string;
    now: string;
  }): Promise<void>;
}

export interface PasswordVerifierPort {
  compare(plaintext: string, passwordHash: string): Promise<boolean>;
  hash(plaintext: string): Promise<string>;
}

export class AuthUseCases {
  constructor(
    private readonly repository: AuthRepositoryPort,
    private readonly passwordVerifier: PasswordVerifierPort
  ) {}

  async bootstrapPrimaryAdmin(
    username: string,
    password: string,
    initialPassword: string | undefined
  ) {
    if (await this.repository.findPublicAdminById(1)) {
      return { status: "existing" as const };
    }
    if (username !== "admin") {
      return { status: "denied" as const };
    }
    const normalizedInitialPassword = initialPassword?.trim();
    if (!normalizedInitialPassword || normalizedInitialPassword.length < 12) {
      return { status: "configuration_error" as const };
    }

    // bcrypt compare 避免直接比较 Worker Secret；同一哈希随后可直接作为初始密码保存。
    const passwordHash = await this.passwordVerifier.hash(
      normalizedInitialPassword
    );
    if (!(await this.passwordVerifier.compare(password, passwordHash))) {
      return { status: "denied" as const };
    }
    await this.repository.createPrimaryAdmin({
      username: "admin",
      passwordHash,
      now: new Date().toISOString(),
    });
    return { status: "created" as const };
  }

  async login(username: string, password: string) {
    const user = await this.repository.findCredentialByUsername(username);
    if (!user || !(await this.passwordVerifier.compare(password, user.password))) {
      return { success: false as const, message: "用户名或密码错误" };
    }
    return {
      success: true as const,
      message: "登录成功",
      user: { id: user.id, username: user.username },
    };
  }

  async getCurrentAdmin(userId: number) {
    const user = await this.repository.findPublicAdminById(userId);
    if (!user) {
      return { success: false as const, message: "用户不存在" };
    }
    return {
      success: true as const,
      message: "获取用户信息成功",
      user,
    };
  }
}
