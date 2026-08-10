import { z } from "zod";
import type { MonitorMutation } from "@/api/monitors";

const headerSchema = z.object({
  key: z.string().max(128),
  value: z.string().max(8192),
});

export const monitorFormSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    intervalMinutes: z.number().int().min(1).max(1440),
    timeoutSeconds: z.number().min(0.1).max(300),
    expectedStatus: z.number().int().min(100).max(599),
    headers: z.array(headerSchema).min(1).max(50),
    body: z.string().max(1024 * 1024),
  })
  .superRefine((value, context) => {
    const names = new Set<string>();
    value.headers.forEach((header, index) => {
      const key = header.key.trim().toLowerCase();
      if (!key) return;
      if (key.includes("\\")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", index, "key"],
          message: "invalid_header",
        });
      } else if (names.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", index, "key"],
          message: "duplicate_header",
        });
      }
      names.add(key);
    });
  });

export type MonitorFormValues = z.infer<typeof monitorFormSchema>;

export const emptyMonitorFormValues: MonitorFormValues = {
  name: "",
  url: "",
  method: "GET",
  intervalMinutes: 5,
  timeoutSeconds: 30,
  expectedStatus: 200,
  headers: [{ key: "", value: "" }],
  body: "",
};

export function monitorFormToMutation(
  values: MonitorFormValues
): MonitorMutation {
  const headers: Record<string, string> = {};
  for (const header of values.headers) {
    const key = header.key.trim();
    if (key) headers[key] = header.value;
  }
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    method: values.method,
    interval_seconds: values.intervalMinutes * 60,
    timeout_ms: Math.round(values.timeoutSeconds * 1000),
    expected_status: values.expectedStatus,
    headers,
    body: values.body || null,
  };
}
