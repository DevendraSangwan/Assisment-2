import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./security.js";
import { redis } from "./redis.js";

export async function createSlackAuthorization(userId: string): Promise<string> {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    throw new Error("Slack OAuth is not configured");
  }
  const state = randomBytes(32).toString("base64url");
  await redis.set(`oauth:slack:${state}`, userId, "EX", 600, "NX");
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

export async function completeSlackAuthorization(code: string, state: string): Promise<void> {
  const userId = await redis.getdel(`oauth:slack:${state}`);
  if (!userId) throw new Error("Slack OAuth state expired or was already used");
  const body = new URLSearchParams({
    code,
    client_id: config.SLACK_CLIENT_ID,
    client_secret: config.SLACK_CLIENT_SECRET,
    redirect_uri: config.SLACK_CALLBACK_URL,
  });
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Slack token exchange failed (${response.status})`);
  const result = await response.json() as {
    ok: boolean;
    error?: string;
    incoming_webhook?: { url?: string; channel?: string };
    team?: { name?: string };
  };
  if (!result.ok || !result.incoming_webhook?.url) {
    throw new Error(`Slack did not return an incoming webhook${result.error ? `: ${result.error}` : ""}`);
  }
  await db.query(
    `INSERT INTO slack_connections (user_id, encrypted_webhook, team_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_webhook = EXCLUDED.encrypted_webhook,
       team_name = EXCLUDED.team_name,
       connected_at = NOW()`,
    [userId, encryptSecret(result.incoming_webhook.url), result.team?.name ?? null],
  );
}

export async function sendRateLimitNotification(
  userId: string,
  senderId: string,
  senderEmail: string,
  hourKey: string,
): Promise<void> {
  const result = await db.query<{ encrypted_webhook: string }>(
    "SELECT encrypted_webhook FROM slack_connections WHERE user_id = $1",
    [userId],
  );
  const encryptedWebhook = result.rows[0]?.encrypted_webhook;
  if (!encryptedWebhook) return;
  const key = `slack-notified:${userId}:${senderId}:${hourKey}`;
  const claimed = await redis.set(key, "1", "EX", 7200, "NX");
  if (!claimed) return;
  try {
    const response = await fetch(decryptSecret(encryptedWebhook), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `Hourly email limit reached for ${senderEmail} (${hourKey} UTC). Queued emails will continue in the next available hour window.`,
      }),
    });
    if (!response.ok) throw new Error(`Slack notification failed (${response.status})`);
  } catch (error) {
    await redis.del(key);
    throw error;
  }
}
