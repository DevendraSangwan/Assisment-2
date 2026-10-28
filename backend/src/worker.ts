import "dotenv/config";
import nodemailer from "nodemailer";
import { DelayedError, Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { db, initializeDatabase } from "./db.js";
import { EMAIL_QUEUE_NAME, SEND_EMAIL_JOB_NAME, type SendEmailJob } from "./queue.js";
import { createRedisConnection, redis } from "./redis.js";
import { indexEmail } from "./search.js";
import { sendRateLimitNotification } from "./slack.js";

interface RateLimitResult {
  allowed: boolean;
  used: number;
  hourKey: string;
}

const consumeSenderHour = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  local limit = tonumber(ARGV[1])
  if current >= limit then
    return {0, current}
  end
  current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], 7200)
  end
  return {1, current}
`;

async function takeHourlySlot(senderId: string, limit: number): Promise<RateLimitResult> {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13);
  const key = `sender-hour:${senderId}:${hourKey}`;
  const [allowed, used] = await redis.eval(consumeSenderHour, 1, key, limit) as [number, number];
  return { allowed: allowed === 1, used, hourKey };
}

function millisecondsUntilNextUtcHour(now = new Date()): number {
  const nextHour = new Date(now);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
  return Math.max(1000, nextHour.getTime() - now.getTime());
}

async function processEmail(job: Job<SendEmailJob, void, typeof SEND_EMAIL_JOB_NAME>): Promise<void> {
  const candidate = await db.query<{
    id: string;
    user_id: string;
    sender_id: string;
    recipient: string;
    subject: string;
    body: string;
    sender_email: string;
    sender_name: string;
    hourly_limit: number;
    status: string;
  }>(
    `SELECT e.id, e.user_id, e.sender_id, e.recipient, e.subject, e.body,
            s.email AS sender_email, s.name AS sender_name,
            s.hourly_limit, e.status
     FROM email_jobs e
     JOIN senders s ON s.id = e.sender_id
     WHERE e.id = $1`,
    [job.data.emailId],
  );
  const email = candidate.rows[0];
  if (!email || email.status === "sent" || email.status === "sending") return;
  if (email.status !== "scheduled" && email.status !== "failed") return;

  const rate = await takeHourlySlot(email.sender_id, email.hourly_limit);
  if (!rate.allowed) {
    try {
      await sendRateLimitNotification(email.user_id, email.sender_id, email.sender_email, rate.hourKey);
    } catch (error) {
      console.error("Slack rate-limit notification failed:", error);
    }
    await job.moveToDelayed(Date.now() + millisecondsUntilNextUtcHour(), job.token!);
    throw new DelayedError();
  }

  const claim = await db.query(
    `UPDATE email_jobs SET status = 'sending', attempts = attempts + 1, last_error = NULL
     WHERE id = $1 AND status IN ('scheduled', 'failed')
     RETURNING id`,
    [email.id],
  );
  if (!claim.rows[0]) return;

  if (!config.SMTP_USER || !config.SMTP_PASS) {
    const message = "SMTP_USER and SMTP_PASS must be configured before email delivery";
    await db.query(
      "UPDATE email_jobs SET status = 'failed', last_error = $2 WHERE id = $1",
      [email.id, message],
    );
    throw new Error(message);
  }

  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  try {
    await transport.sendMail({
      from: { name: email.sender_name, address: email.sender_email },
      to: email.recipient,
      subject: email.subject,
      text: email.body,
    });
    const sent = await db.query(
      `UPDATE email_jobs SET status = 'sent', sent_at = NOW(), last_error = NULL
       WHERE id = $1 RETURNING id, user_id, recipient, subject, status, scheduled_at, sent_at`,
      [email.id],
    );
    const sentEmail = sent.rows[0];
    if (sentEmail) {
      await indexEmail(sentEmail).catch((error: unknown) => {
        console.error(`Search index update failed for email ${email.id}:`, error);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : "SMTP delivery failed";
    await db.query(
      "UPDATE email_jobs SET status = 'failed', last_error = $2 WHERE id = $1",
      [email.id, message],
    );
    throw error;
  } finally {
    transport.close();
  }
}

async function main(): Promise<void> {
  await initializeDatabase();
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    console.warn("SMTP is not configured; scheduled jobs will remain retryable and cannot be delivered.");
  }
  const worker = new Worker<SendEmailJob, void, typeof SEND_EMAIL_JOB_NAME>(
    EMAIL_QUEUE_NAME,
    processEmail,
    {
      connection: createRedisConnection(),
      concurrency: config.WORKER_CONCURRENCY,
      limiter: {
        max: 1,
        duration: Math.max(1, config.MIN_SEND_INTERVAL_MS),
      },
    },
  );
  worker.on("failed", (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void db.query(
        "UPDATE email_jobs SET status = 'failed', last_error = $2 WHERE id = $1 AND status <> 'sent'",
        [job.data.emailId, error.message.slice(0, 2000)],
      ).catch((dbError: unknown) => console.error("Could not save final job failure:", dbError));
    }
    console.error(`Email job ${job?.id ?? "unknown"} failed:`, error.message);
  });
  worker.on("error", (error) => console.error("BullMQ worker error:", error));

  const shutdown = async (): Promise<void> => {
    await worker.close();
    await redis.quit();
    await db.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(`Email worker ready (concurrency ${config.WORKER_CONCURRENCY})`);
}

main().catch((error: unknown) => {
  console.error("Email worker startup failed:", error);
  process.exitCode = 1;
});
