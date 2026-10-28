import { db } from "./db.js";
import { emailQueue, SEND_EMAIL_JOB_NAME } from "./queue.js";

export async function publishPendingEmails(): Promise<void> {
  const pending = await db.query<{ email_id: string; scheduled_at: Date }>(
    `SELECT o.email_id, e.scheduled_at
     FROM email_outbox o
     JOIN email_jobs e ON e.id = o.email_id
     WHERE o.published_at IS NULL
     ORDER BY o.created_at
     LIMIT 250`,
  );

  for (const row of pending.rows) {
    await emailQueue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: row.email_id },
      {
        jobId: row.email_id,
        delay: Math.max(0, new Date(row.scheduled_at).getTime() - Date.now()),
      },
    );
    await db.query(
      "UPDATE email_outbox SET published_at = COALESCE(published_at, NOW()) WHERE email_id = $1",
      [row.email_id],
    );
  }
}

export function startOutboxPublisher(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void publishPendingEmails().catch((error: unknown) => {
      console.error("Email outbox publish failed:", error);
    });
  }, 2000);
  timer.unref();
  void publishPendingEmails().catch((error: unknown) => {
    console.error("Initial email outbox publish failed:", error);
  });
  return timer;
}
