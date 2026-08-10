import type { Bindings } from "../../../models/db";
import { sendNotificationByChannel } from "../providers/NotificationProviders";
import { D1NotificationChannelStore } from "./D1NotificationChannelStore";

export async function sendRenderedNotification(
  env: Bindings,
  channelId: number,
  subject: string,
  content: string
) {
  const channel = await new D1NotificationChannelStore(env).deliveryChannel(channelId);
  if (!channel || !channel.enabled) {
    return { success: false, error: "通知渠道不存在或已停用" };
  }
  return sendNotificationByChannel(channel, subject, content);
}
