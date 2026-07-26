/**
 * 通用格式化工具
 */

// 字节数 -> 可读文本（1024 进制，单位钳制到 PB；0/undefined 等 falsy 输入返回 "0 B"）
export function formatBytes(
  bytes: number | null | undefined,
  decimals = 1
): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k))
  );
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

// 速率（bytes/s）-> 可读文本（1024 进制自适应 B/s ~ TB/s）；
// null/undefined/非有限数/负值返回 "-"（表示无速率数据）
export function formatSpeed(
  bytesPerSec: number | null | undefined,
  decimals = 1
): string {
  if (
    bytesPerSec === null ||
    bytesPerSec === undefined ||
    !Number.isFinite(bytesPerSec) ||
    bytesPerSec < 0
  ) {
    return "-";
  }
  if (bytesPerSec < 1) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  const i = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytesPerSec) / Math.log(k))
  );
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(decimals))} ${
    sizes[i]
  }`;
}
