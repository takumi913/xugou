import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { createDb } from "../../config/db";
import { domainOutbox } from "../../db/schema";
import type { Bindings } from "../../models/db";
import { QueueJobPublisher } from "./QueuePublisher";

const MAX_QUEUE_BATCH_SIZE = 100;

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function relayPendingQueueWork(env: Bindings, limit = 1_000) {
  const db = createDb(env);
  const publisher = new QueueJobPublisher(env.XUGOU_JOBS);
  const now = new Date().toISOString();
  const boundedLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));

  const events = await db
    .select({ event_id: domainOutbox.event_id })
    .from(domainOutbox)
    .where(
      and(eq(domainOutbox.status, "pending"), lte(domainOutbox.available_at, now))
    )
    .orderBy(asc(domainOutbox.available_at), asc(domainOutbox.event_id))
    .limit(boundedLimit);

  let publishedJobs = 0;
  let publishedEvents = 0;

  for (const batch of chunks(events, MAX_QUEUE_BATCH_SIZE)) {
    const eventIds = batch.map((event) => event.event_id);
    await publisher.publishOutboxEvents(eventIds);
    await env.DB.prepare(
      `UPDATE domain_outbox
       SET status = 'published', attempts = attempts + 1, published_at = ?,
           last_error = NULL, updated_at = ?
       WHERE status = 'pending'
         AND event_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    )
      .bind(now, now, JSON.stringify(eventIds))
      .run();
    publishedEvents += batch.length;
  }
  return { publishedJobs, publishedEvents };
}
