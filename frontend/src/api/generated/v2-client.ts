import createClient from "openapi-fetch";
import { ENV_API_BASE_URL } from "../../config";
import type { paths } from "./v2-schema";

function getCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

export class OpenApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: unknown
  ) {
    super(
      problem && typeof problem === "object" && "title" in problem
        ? String(problem.title)
        : `HTTP ${status}`
    );
    this.name = "OpenApiRequestError";
  }
}

export const v2Client = createClient<paths>({
  baseUrl: ENV_API_BASE_URL || "",
  credentials: "include",
});

v2Client.use({
  onRequest({ request }) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      const csrfToken = getCookie("xugou_csrf");
      if (csrfToken) request.headers.set("X-CSRF-Token", csrfToken);
    }
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      if (window.location.pathname !== "/login") window.location.href = "/login";
    }
    return response;
  },
});

export function unwrapOpenApi<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (!result.response.ok || result.error !== undefined) {
    throw new OpenApiRequestError(result.response.status, result.error);
  }
  return result.data as T;
}
