const encoder = new TextEncoder();

export interface CursorPage<T, Cursor extends string | number> {
  data: T[];
  next_cursor: Cursor | null;
}

interface StreamJsonArrayOptions<
  T,
  Cursor extends string | number,
  Output,
> {
  filename: string;
  loadPage: (cursor?: Cursor) => Promise<CursorPage<T, Cursor>>;
  map?: (item: T) => Output;
}

/**
 * 按 Cursor Page 输出 `{ "data": [...] }`，每次最多在内存中保留一页。
 * ReadableStream.pull 由消费端背压驱动，避免导出大量配置时先构建整个数组。
 */
export function streamJsonDataArrayResponse<
  T,
  Cursor extends string | number,
  Output = T,
>(options: StreamJsonArrayOptions<T, Cursor, Output>): Response {
  return streamJsonArray(options, true);
}

/** 兼容旧导入器的根 JSON 数组，同时保持逐页背压输出。 */
export function streamJsonArrayResponse<
  T,
  Cursor extends string | number,
  Output = T,
>(options: StreamJsonArrayOptions<T, Cursor, Output>): Response {
  return streamJsonArray(options, false);
}

function streamJsonArray<
  T,
  Cursor extends string | number,
  Output,
>(
  options: StreamJsonArrayOptions<T, Cursor, Output>,
  dataEnvelope: boolean
): Response {
  let cursor: Cursor | undefined;
  let previousCursor: Cursor | undefined;
  let opened = false;
  let firstItem = true;
  let finished = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!opened) {
          controller.enqueue(encoder.encode(dataEnvelope ? '{"data":[' : "["));
          opened = true;
        }
        if (finished) return;

        for (;;) {
          const page = await options.loadPage(cursor);
          const serialized = page.data.map((item) => {
            const json = JSON.stringify(options.map ? options.map(item) : item);
            if (json === undefined) {
              throw new TypeError("JSON export item is not serializable");
            }
            return json;
          });

          if (serialized.length > 0) {
            controller.enqueue(
              encoder.encode(`${firstItem ? "" : ","}${serialized.join(",")}`)
            );
            firstItem = false;
          }

          if (page.next_cursor === null) {
            controller.enqueue(encoder.encode(dataEnvelope ? "]}" : "]"));
            controller.close();
            finished = true;
            return;
          }
          previousCursor = cursor;
          cursor = page.next_cursor;
          if (cursor === previousCursor) {
            throw new Error("JSON export cursor did not advance");
          }
          // 空页不产生空 Chunk，继续前进到下一个 Cursor。
          if (serialized.length > 0) return;
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
  });

  const filename = options.filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
