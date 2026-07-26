/**
 * 字节数组转小写十六进制字符串（md5/sha256/随机令牌共用）
 */
export function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
