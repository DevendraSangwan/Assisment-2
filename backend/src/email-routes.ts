import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { indexEmails, searchEmails } from "./search.js";
import { requireAuth } from "./security.js";

const router = Router();
const senderSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  hourlyLimit: z.number().int().min(1).max(config.MAX_EMAILS_PER_HOUR_PER_SENDER).optional(),
});
const scheduleSchema = z.object({
  senderId: z.string().uuid(),
  recipients: z.array(z.string().email().max(254)).min(1).max(5000),
  subject: z.string().trim().min(1).max(998),
  body: z.string().min(1).max(100_000),
  scheduledAt: z.string().datetime({ offset: true }),
  delayMs: z.number().int().min(0).max(3_600_000),
});

router.use(requireAuth);

router.get("/config", (_request, response) => {
  response.json({
    maxEmailsPerHourPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    minSendIntervalMs: config.MIN_SEND_INTERVAL_MS,
  });
});

router.get("/senders", async (request, response, next) => {
  try {
    const result = await db.query(
      `SELECT id, email, name, hourly_limit AS "hourlyLimit"
       FROM senders WHERE user_id = $1 ORDER BY created_at`,
      [request.user!.id],
    );
    response.json({ senders: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/senders", async (request, response, next) => {
  try {
    const parsed = senderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid sender" });
      return;
    }
    const sender = parsed.data;
    const result = await db.query(
      `INSERT INTO senders (id, user_id, email, name, hourly_limit)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, email) DO UPDATE SET
         name = EXCLUDED.name,
         hourly_limit = EXCLUDED.hourly_limit
       RETURNING id, email, name, hourly_limit AS "hourlyLimit"`,
      [
        randomUUID(),
        request.user!.id,
        sender.email.toLowerCase(),
        sender.name,
        sender.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      ],
    );
    response.status(201).json({ sender: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/emails", async (request, response, next) => {
  try {
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const status = request.query.status === "sent" ? "sent" : "scheduled";
    const queryText = typeof request.query.q === "string" ? request.query.q.trim() : "";
    let searchOrder: string[] | null = null;
    if (queryText) {
      searchOrder = await searchEmails(request.user!.id, queryText);
      if (searchOrder.length === 0) {
        response.json({ emails: [], page, limit, total: 0 });
        return;
      }
    }

    const statuses = status === "sent"
      ? ["sent", "failed"]
      : ["scheduled", "sending"];
    const result = await db.query(
      `SELECT e.id, e.recipient, e.subject, e.scheduled_at AS "scheduledAt",
              e.sent_at AS "sentAt", e.status, e.attempts,
              e.last_error AS "lastError", s.email AS "senderEmail"
       FROM email_jobs e
       JOIN senders s ON s.id = e.sender_id
       WHERE e.user_id = $1 AND e.status = ANY($2::text[])
         AND ($3::uuid[] IS NULL OR e.id = ANY($3::uuid[]))
       ORDER BY
         CASE WHEN $4::uuid[] IS NOT NULL THEN array_position($4::uuid[], e.id) END,
         CASE WHEN $5 = 'scheduled' THEN e.scheduled_at END ASC,
         CASE WHEN $5 = 'sent' THEN e.sent_at END DESC,
         e.created_at DESC
       LIMIT $6 OFFSET $7`,
      [request.user!.id, statuses, searchOrder, searchOrder, status, limit, (page - 1) * limit],
    );
    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM email_jobs
       WHERE user_id = $1 AND status = ANY($2::text[])
         AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [request.user!.id, statuses, searchOrder],
    );
    response.json({
      emails: result.rows,
      page,
      limit,
      total: Number(countResult.rows[0]?.count ?? 0),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/emails/schedule", async (request, response, next) => {
  const parsed = scheduleSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid schedule request" });
    return;
  }
  const input = parsed.data;
  const recipients = [...new Set(input.recipients.map((email) => email.trim().toLowerCase()))];
  if (recipients.length > 5000) {
    response.status(400).json({ error: "A schedule can contain at most 5,000 unique email addresses" });
    return;
  }
  const scheduledAt = new Date(input.scheduledAt);
  if (scheduledAt.getTime() < Date.now() - 60_000) {
    response.status(400).json({ error: "Start time must be in the future" });
    return;
  }
  const idempotencyKeyHeader = request.header("Idempotency-Key");
  if (idempotencyKeyHeader && (idempotencyKeyHeader.length < 1 || idempotencyKeyHeader.length > 128)) {
    response.status(400).json({ error: "Idempotency-Key must be between 1 and 128 characters" });
    return;
  }
  const idempotencyKey = idempotencyKeyHeader ?? randomUUID();
  const payloadHash = createHash("sha256").update(JSON.stringify({
    senderId: input.senderId,
    recipients,
    subject: input.subject,
    body: input.body,
    scheduledAt: scheduledAt.toISOString(),
    delayMs: input.delayMs,
  })).digest("hex");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sender = await client.query(
      "SELECT id FROM senders WHERE id = $1 AND user_id = $2",
      [input.senderId, request.user!.id],
    );
    if (!sender.rows[0]) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Sender not found" });
      return;
    }

    const batchId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO idempotency_requests (user_id, idempotency_key, payload_hash, batch_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING batch_id`,
      [request.user!.id, idempotencyKey, payloadHash, batchId],
    );
    if (!inserted.rows[0]) {
      const previous = await client.query<{ payload_hash: string; batch_id: string }>(
        `SELECT payload_hash, batch_id FROM idempotency_requests
         WHERE user_id = $1 AND idempotency_key = $2`,
        [request.user!.id, idempotencyKey],
      );
      if (previous.rows[0]?.payload_hash !== payloadHash) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "This idempotency key was already used for a different request" });
        return;
      }
      const existing = await client.query(
        `SELECT id, recipient, subject, scheduled_at AS "scheduledAt", status
         FROM email_jobs WHERE batch_id = $1 ORDER BY scheduled_at`,
        [previous.rows[0]!.batch_id],
      );
      await client.query("COMMIT");
      response.status(200).json({ batchId: previous.rows[0]!.batch_id, count: existing.rowCount, emails: existing.rows, replayed: true });
      return;
    }

    const values: unknown[] = [];
    const tuples = recipients.map((recipient, index) => {
      const id = randomUUID();
      const sendTime = new Date(scheduledAt.getTime() + index * input.delayMs);
      values.push(
        id,
        request.user!.id,
        input.senderId,
        recipient,
        input.subject,
        input.body,
        sendTime,
        batchId,
        idempotencyKey,
      );
      const offset = index * 9;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
               $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
    });
    const created = await client.query<{
      id: string;
      user_id: string;
      recipient: string;
      subject: string;
      status: string;
      scheduled_at: Date;
      sent_at: Date | null;
    }>(
      `INSERT INTO email_jobs
         (id, user_id, sender_id, recipient, subject, body, scheduled_at, batch_id, idempotency_key)
       VALUES ${tuples.join(",")}
       RETURNING id, user_id, recipient, subject, status, scheduled_at, sent_at`,
      values,
    );
    const emailIds = created.rows.map((row) => row.id);
    await client.query(
      "INSERT INTO email_outbox (email_id) SELECT UNNEST($1::uuid[])",
      [emailIds],
    );
    await client.query("COMMIT");

    let indexingWarning: string | undefined;
    await indexEmails(created.rows).catch((error: unknown) => {
      console.error("Email search indexing failed; Elasticsearch refresh can be retried after scheduling:", error);
      indexingWarning = "Emails were scheduled, but search indexing is temporarily unavailable.";
    });
    response.status(202).json({
      batchId,
      count: created.rowCount,
      ...(indexingWarning ? { warning: indexingWarning } : {}),
      emails: created.rows.map((row) => ({
        id: row.id,
        recipient: row.recipient,
        subject: row.subject,
        status: row.status,
        scheduledAt: row.scheduled_at,
      })),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      console.error("Email schedule rollback failed:", rollbackError);
    });
    next(error);
  } finally {
    client.release();
  }
});

export default router;
