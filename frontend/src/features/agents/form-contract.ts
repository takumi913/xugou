import { z } from "zod";
import type { AgentUpdate } from "@/api/agents";

const optionalNumber = (input: {
  minimum: number;
  maximum: number;
  positive?: boolean;
}) =>
  z.string().refine((value) => {
    if (value.trim() === "") return true;
    const number = Number(value);
    return (
      Number.isFinite(number) &&
      number >= input.minimum &&
      number <= input.maximum &&
      (!input.positive || number > 0)
    );
  });

export const agentFormSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    collectIntervalSeconds: z.string().regex(/^\d+$/),
    reportIntervalSeconds: z.string().regex(/^\d+$/),
    autoUpdate: z.boolean(),
    groupName: z.string().max(64),
    tags: z.string().max(3299),
    price: optionalNumber({ minimum: 0, maximum: 1_000_000 }),
    currency: z.string().trim().max(16),
    billingCycle: z.enum(["none", "monthly", "quarterly", "yearly", "once"]),
    expireDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
    autoRenewal: z.boolean(),
    trafficLimitGb: optionalNumber({
      minimum: 0,
      maximum: 1_000_000_000,
      positive: true,
    }),
    trafficResetDay: z.string().regex(/^\d+$/),
    trafficCalcType: z.enum(["sum", "rx", "tx"]),
    isHidden: z.boolean(),
  })
  .superRefine((value, context) => {
    const collect = Number(value.collectIntervalSeconds);
    const report = Number(value.reportIntervalSeconds);
    if (!Number.isInteger(collect) || collect < 1 || collect > 86400) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collectIntervalSeconds"],
        message: "invalid_collect_interval",
      });
    }
    if (
      !Number.isInteger(report) ||
      report < 1 ||
      report > 86400 ||
      report < collect
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reportIntervalSeconds"],
        message: "invalid_report_interval",
      });
    }
    const resetDay = Number(value.trafficResetDay);
    if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trafficResetDay"],
        message: "invalid_reset_day",
      });
    }
    const tags = value.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 50 || tags.some((tag) => tag.length > 64)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tags"],
        message: "invalid_tags",
      });
    }
  });

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export function agentFormToUpdate(values: AgentFormValues): AgentUpdate {
  return {
    name: values.name.trim(),
    collect_interval_seconds: Number(values.collectIntervalSeconds),
    report_interval_seconds: Number(values.reportIntervalSeconds),
    auto_update: values.autoUpdate,
    group_name: values.groupName.trim() || null,
    tags: values.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    price: values.price.trim() === "" ? null : Number(values.price),
    currency: values.currency.trim() || null,
    billing_cycle:
      values.billingCycle === "none" ? null : values.billingCycle,
    expire_date: values.expireDate || null,
    auto_renewal: values.autoRenewal,
    traffic_limit_gb:
      values.trafficLimitGb.trim() === ""
        ? null
        : Number(values.trafficLimitGb),
    traffic_reset_day: Number(values.trafficResetDay),
    traffic_calc_type: values.trafficCalcType,
    is_hidden: values.isHidden,
  };
}
