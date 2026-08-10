import { z } from "zod";

export const statusConfigV2Schema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500),
    logoUrl: z.string().trim().max(2048).default(""),
    customCss: z.string().max(20_000).default(""),
    theme: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).default("mono"),
    monitors: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(100)
      .default([]),
    agents: z
      .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.monitors).size !== value.monitors.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["monitors"],
        message: "Monitor IDs must be unique",
      });
    }
    if (new Set(value.agents).size !== value.agents.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents"],
        message: "Agent IDs must be unique",
      });
    }
  });

export const publicAgentIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
