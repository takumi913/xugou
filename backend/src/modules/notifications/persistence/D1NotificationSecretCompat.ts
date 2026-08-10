import type { NotificationChannel } from "../../../models/notification";
import type { Bindings } from "../../../models/db";
import { D1NotificationChannelStore } from "./D1NotificationChannelStore";

export function persistNotificationSecureConfig(
  env: Bindings,
  channelId: number,
  type: string,
  config: unknown
) {
  return new D1NotificationChannelStore(env).persistSecureConfig(
    channelId,
    type,
    config
  );
}

export async function loadFullNotificationConfig(
  env: Bindings,
  channel: NotificationChannel
) {
  const full = await new D1NotificationChannelStore(env).deliveryChannel(channel.id);
  if (!full) return {};
  try {
    return JSON.parse(full.config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function maskNotificationChannel(
  env: Bindings,
  channel: NotificationChannel
) {
  const row = await new D1NotificationChannelStore(env).findRow(channel.id);
  return row
    ? new D1NotificationChannelStore(env).maskedChannel(row)
    : channel;
}

export async function mergeNotificationConfigUpdate(
  env: Bindings,
  existing: NotificationChannel,
  nextType: string,
  nextConfig: unknown
) {
  const store = new D1NotificationChannelStore(env);
  const row = await store.findRow(existing.id);
  return row ? store.mergeConfigUpdate(row, nextType, nextConfig) : {};
}
