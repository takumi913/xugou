/**
 * 列表页导入/导出的小工具：JSON 文件下载与文件解析
 */

// 将数据序列化为 JSON 并触发浏览器下载
export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// 读取用户选择的文件并解析为 JSON 数组；格式不符返回 null
export async function readJsonArrayFile(file: File): Promise<unknown[] | null> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
