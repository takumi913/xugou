import type { components } from "../api/generated/v2-schema";

type ContractChannel = components["schemas"]["NotificationChannel"];
type ContractTemplate = components["schemas"]["NotificationTemplate"];
type ContractConfig = components["schemas"]["NotificationConfig"];

/** UI view: parsed channel config plus camel-case display timestamps. */
export type NotificationChannel = Omit<
  ContractChannel,
  "config" | "created_at" | "updated_at"
> & {
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

/** UI view: immutable template content with camel-case display metadata. */
export type NotificationTemplate = Omit<
  ContractTemplate,
  "is_default" | "created_at" | "updated_at"
> & {
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export interface NotificationConfig {
  channels: NotificationChannel[];
  templates: NotificationTemplate[];
  channelsHasMore: boolean;
  templatesHasMore: boolean;
  settings: ContractConfig["settings"];
}
