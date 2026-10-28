import type {
  AppConfig,
  EmailListResponse,
  ScheduledEmail,
  Sender,
  User,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  config: () => request<AppConfig>("/api/config"),
  senders: () => request<{ senders: Sender[] }>("/api/senders"),
  saveSender: (sender: Pick<Sender, "email" | "name" | "hourlyLimit">) =>
    request<{ sender: Sender }>("/api/senders", {
      method: "POST",
      body: JSON.stringify(sender),
    }),
  emails: (status: "scheduled" | "sent", query = "") =>
    request<EmailListResponse>(
      `/api/emails?status=${status}&limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`,
    ),
  schedule: (data: {
    senderId: string;
    recipients: string[];
    subject: string;
    body: string;
    scheduledAt: string;
    delayMs: number;
  }, idempotencyKey: string) => request<{
    batchId: string;
    count: number;
    warning?: string;
    emails: Array<Pick<ScheduledEmail, "id" | "recipient" | "subject" | "status" | "scheduledAt">>;
  }>("/api/emails/schedule", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(data),
  }),
  slackStatus: () => request<{
    connected: boolean;
    teamName: string | null;
    configured: boolean;
  }>("/auth/slack/status"),
  disconnectSlack: () => request<void>("/auth/slack", { method: "DELETE" }),
};
