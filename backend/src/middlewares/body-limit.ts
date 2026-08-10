import { bodyLimit } from "hono/body-limit";
import { isV2ApiRequest, problemResponse } from "../platform/http/problem";

export const MAX_API_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Bounds every API body before route-level JSON parsing. Agent v4 applies an
 * additional 1 MiB compressed / 2 MiB decompressed limit in its own adapter.
 */
export const apiBodyLimitMiddleware = bodyLimit({
  maxSize: MAX_API_REQUEST_BODY_BYTES,
  onError: (c) => {
    if (isV2ApiRequest(c)) {
      return problemResponse(c, {
        status: 413,
        code: "REQUEST_BODY_TOO_LARGE",
        title: "Request body too large",
      });
    }
    return c.json({ success: false, message: "请求体过大" }, 413);
  },
});
