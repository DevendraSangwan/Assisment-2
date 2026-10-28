export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface Sender {
  id: string;
  email: string;
  name: string;
  hourlyLimit: number;
}

export interface ScheduledEmail {
  id: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: "scheduled" | "sending" | "sent" | "failed";
  attempts?: number;
  lastError?: string | null;
  senderEmail: string;
}

export interface EmailListResponse {
  emails: ScheduledEmail[];
  page: number;
  limit: number;
  total: number;
}

export interface AppConfig {
  maxEmailsPerHourPerSender: number;
  minSendIntervalMs: number;
}
