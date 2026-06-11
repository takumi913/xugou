/**
 * JWT工具类，提供JWT相关的通用功能
 */

import { JWT_CONFIG } from "../config";

/**
 * 获取JWT密钥
 * 优先从环境变量中获取JWT_SECRET，如果不存在则使用默认值
 *
 * @param c Cloudflare环境上下文
 * @returns JWT密钥
 */
export const getJwtSecret = (c: any): string => {
  // 检查是否直接包含 CF_VERSION_METADATA
  if (c.CF_VERSION_METADATA) {
    const { id: versionId } = c.CF_VERSION_METADATA;
    return versionId || JWT_CONFIG.DEFAULT_SECRET;
  }

  // 检查是否在 env 属性下包含 CF_VERSION_METADATA
  if (c.env && c.env.CF_VERSION_METADATA) {
    const { id: versionId } = c.env.CF_VERSION_METADATA;
    return versionId || JWT_CONFIG.DEFAULT_SECRET;
  }

  console.error("错误: 未找到 CF_VERSION_METADATA");
  return JWT_CONFIG.DEFAULT_SECRET;
};

/**
 * 生成随机令牌
 * 生成用于API密钥或认证令牌的随机字符串，包含时间戳、前缀和签名
 *
 * @param env 环境变量或上下文对象，用于获取密钥
 * @returns 生成的随机令牌
 */
export async function generateToken(env?: any): Promise<string> {
  // 生成随机部分
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const randomPart = Array.from(array, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  // 添加时间戳
  const timestamp = Date.now().toString(36);

  // 添加特定前缀，用于标识这是一个XUGOU系统的令牌
  const prefix = "xugou";

  // 创建基本令牌
  const baseToken = `${prefix}_${timestamp}_${randomPart}`;

  // 获取密钥
  if (!env || !env.CF_VERSION_METADATA) {
    console.error("错误: env.CF_VERSION_METADATA 不存在，无法生成签名");
    return baseToken;
  }

  const { id: versionId } = env.CF_VERSION_METADATA;

  try {
    // 创建签名
    const msgUint8 = new TextEncoder().encode(baseToken + versionId);

    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 16);

    // 返回带签名的令牌
    const fullToken = `${baseToken}.${signature}`;
    return fullToken;
  } catch (error) {
    console.error("生成令牌签名时出错:", error);
    return baseToken;
  }
}

/**
 * 验证令牌是否有效
 * 验证令牌的格式和签名是否正确
 *
 * @param token 需要验证的令牌
 * @param env 环境变量或上下文对象，用于获取密钥
 * @returns 验证结果对象，包含是否有效和相关信息
 */
export async function verifyToken(
  token: string,
  env: any
): Promise<{
  valid: boolean;
  message?: string;
  timestamp?: number;
  payload?: any;
}> {
  try {
    // 首先验证令牌格式
    const parts = token.split(".");

    // 如果令牌没有签名部分（即不包含.），或者格式不正确，则无效
    if (parts.length !== 2) {
      return { valid: false, message: "令牌格式无效" };
    }

    // 解析令牌各部分
    const [baseToken, signature] = parts;

    const baseTokenParts = baseToken.split("_");

    // 验证基本令牌格式
    if (baseTokenParts.length !== 3) {
      return { valid: false, message: "令牌格式无效" };
    }

    const [prefix, timestampStr, randomPart] = baseTokenParts;

    // 验证前缀
    if (prefix !== "xugou") {
      return { valid: false, message: "令牌前缀无效" };
    }

    // 解析时间戳
    const timestamp = parseInt(timestampStr, 36);

    // 验证时间戳是否为有效数字
    if (isNaN(timestamp)) {
      return { valid: false, message: "令牌时间戳无效" };
    }

    // 获取密钥
    if (!env || !env.CF_VERSION_METADATA) {
      console.error("错误: env.CF_VERSION_METADATA 不存在，无法验证签名");
      return { valid: false, message: "环境变量不完整，无法验证签名" };
    }

    const { id: versionId } = env.CF_VERSION_METADATA;

    // 重新计算签名并验证
    const msgUint8 = new TextEncoder().encode(baseToken + versionId);

    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const calculatedSignature = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 16);

    // 比较计算出的签名和令牌中的签名
    if (calculatedSignature !== signature) {
      return { valid: false, message: "令牌签名无效" };
    }

    // 如果所有验证都通过，令牌有效
    return {
      valid: true,
      timestamp,
      payload: {
        prefix,
        timestamp,
        randomPart,
      },
    };
  } catch (error) {
    console.error("令牌验证过程出错:", error);
    return { valid: false, message: "令牌验证过程出错" };
  }
}
