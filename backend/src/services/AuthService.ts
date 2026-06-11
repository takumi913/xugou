/**
 * AuthService.ts
 * 认证服务，处理用户认证、注册和令牌管理相关的业务逻辑
 */

import * as bcrypt from "bcryptjs";
import * as jsonwebtoken from "jsonwebtoken";
import * as repositories from "../repositories";
import { getJwtSecret } from "../utils/jwt";
import { Bindings } from "../models/db";
import * as SettingsService from "./SettingsService";
import * as NotificationService from "./NotificationService";
import { JWT_CONFIG, AUTH_CONFIG } from "../config";

/**
 * 用户登录
 * @param env 环境变量，包含数据库连接
 * @param username 用户名
 * @param password 密码(明文)
 * @returns 登录结果，包含令牌和用户信息
 */
export async function loginUser(
  env: { DB: Bindings["DB"] } & any,
  username: string,
  password: string
): Promise<{ success: boolean; message: string; token?: string; user?: any }> {
  try {
    // 查找用户
    const user = await repositories.getUserByUsername(username);

    if (!user) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return { success: false, message: "用户名或密码错误" };
    }

    // 生成JWT令牌
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    try {
      const secret = getJwtSecret(env);

      // 使用配置的 token 有效期（30天）
      const token = jsonwebtoken.sign(payload, secret, {
        expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRES_IN,
      } as jsonwebtoken.SignOptions) as string;

      return {
        success: true,
        message: "登录成功",
        token,
        user: { id: user.id, username: user.username, role: user.role },
      };
    } catch (jwtError) {
      console.error("JWT 生成错误:", jwtError);
      console.error(
        "JWT 错误堆栈:",
        jwtError instanceof Error ? jwtError.stack : "未知错误"
      );
      return { success: false, message: "Token 生成失败" };
    }
  } catch (error) {
    console.error("登录错误:", error);
    console.error(
      "错误堆栈:",
      error instanceof Error ? error.stack : "未知错误"
    );
    return { success: false, message: "登录处理失败" };
  }
}

/**
 * 用户注册
 * @param env 环境变量，包含数据库连接
 * @param username 用户名
 * @param password 密码(明文)
 * @param email 电子邮箱
 * @returns 注册结果
 */
export async function registerUser(
  env: { DB: Bindings["DB"] } & any,
  username: string,
  password: string,
  email: string | null = null
): Promise<{ success: boolean; message: string; user?: any }> {
  try {
    // 新增：检查是否允许新用户注册
    const isRegistrationAllowed =
      await SettingsService.getAllowNewUserRegistration();
    if (!isRegistrationAllowed) {
      return { success: false, message: "新用户注册功能已关闭" };
    }

    // 检查用户名是否已存在
    const existingUser = await repositories.getUserByUsername(username);
    if (existingUser) {
      return { success: false, message: "用户名已存在" };
    }

    // 密码加密（使用配置的盐轮数）
    const salt = await bcrypt.genSalt(AUTH_CONFIG.BCRYPT_SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 创建用户, 默认角色为 'user'
    const newUser = await repositories.createUser(
      username,
      hashedPassword,
      email,
      "user"
    );

    // 为新用户创建默认的通知设置
    if (newUser && newUser.id) {
      await NotificationService.createDefaultNotificationSettingsForUser(
        newUser.id
      );
    }

    return {
      success: true,
      message: "注册成功",
      user: newUser,
    };
  } catch (error) {
    console.error("注册错误:", error);
    return { success: false, message: "注册处理失败" };
  }
}

/**
 * 获取当前用户信息
 * @param env 环境变量，包含数据库连接
 * @param userId 用户ID
 * @returns 用户信息
 */
export async function getCurrentUser(
  env: { DB: Bindings["DB"] } & any,
  userId: number
): Promise<{ success: boolean; message: string; user?: any }> {
  try {
    const user = await repositories.getUserById(userId);

    if (!user) {
      return { success: false, message: "用户不存在" };
    }

    return {
      success: true,
      message: "获取用户信息成功",
      user,
    };
  } catch (error) {
    console.error("获取用户信息错误:", error);
    return { success: false, message: "获取用户信息失败" };
  }
}
