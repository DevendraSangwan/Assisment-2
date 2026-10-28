import "dotenv/config";

function stringValue(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function integerValue(name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function urlValue(name: string, fallback: string): string {
  const value = stringValue(name, fallback);
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

const jwtSecret = stringValue("JWT_SECRET", "");
if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters");

const encryptionKey = stringValue("ENCRYPTION_KEY", "");
if (Buffer.byteLength(encryptionKey, "utf8") !== 32) {
  throw new Error("ENCRYPTION_KEY must be set to exactly 32 UTF-8 bytes");
}

const nodeEnv = stringValue("NODE_ENV", "development");
if (!["development", "test", "production"].includes(nodeEnv)) {
  throw new Error("NODE_ENV must be development, test, or production");
}

const smtpSecure = stringValue("SMTP_SECURE", "false").toLowerCase();
if (!["true", "false"].includes(smtpSecure)) {
  throw new Error("SMTP_SECURE must be true or false");
}

export const config = {
  NODE_ENV: nodeEnv as "development" | "test" | "production",
  PORT: integerValue("PORT", 4000, 1, 65535),
  FRONTEND_URL: urlValue("FRONTEND_URL", "http://localhost:5173"),
  API_URL: urlValue("API_URL", "http://localhost:4000"),
  DATABASE_URL: stringValue("DATABASE_URL", "postgres://scheduler:scheduler@localhost:5432/reachinbox"),
  REDIS_URL: urlValue("REDIS_URL", "redis://localhost:6379"),
  ELASTICSEARCH_URL: urlValue("ELASTICSEARCH_URL", "http://localhost:9200"),
  ELASTICSEARCH_INDEX: stringValue("ELASTICSEARCH_INDEX", "emails"),
  JWT_SECRET: jwtSecret,
  ENCRYPTION_KEY: encryptionKey,
  GOOGLE_CLIENT_ID: stringValue("GOOGLE_CLIENT_ID", ""),
  GOOGLE_CLIENT_SECRET: stringValue("GOOGLE_CLIENT_SECRET", ""),
  GOOGLE_CALLBACK_URL: urlValue("GOOGLE_CALLBACK_URL", "http://localhost:4000/auth/google/callback"),
  SMTP_HOST: stringValue("SMTP_HOST", "smtp.ethereal.email"),
  SMTP_PORT: integerValue("SMTP_PORT", 587, 1, 65535),
  SMTP_SECURE: smtpSecure === "true",
  SMTP_USER: stringValue("SMTP_USER", ""),
  SMTP_PASS: stringValue("SMTP_PASS", ""),
  WORKER_CONCURRENCY: integerValue("WORKER_CONCURRENCY", 10, 1, 100),
  MIN_SEND_INTERVAL_MS: integerValue("MIN_SEND_INTERVAL_MS", 2000, 0),
  MAX_EMAILS_PER_HOUR_PER_SENDER: integerValue("MAX_EMAILS_PER_HOUR_PER_SENDER", 200, 1),
  EMAIL_MAX_ATTEMPTS: integerValue("EMAIL_MAX_ATTEMPTS", 5, 1, 20),
  SLACK_CLIENT_ID: stringValue("SLACK_CLIENT_ID", ""),
  SLACK_CLIENT_SECRET: stringValue("SLACK_CLIENT_SECRET", ""),
  SLACK_CALLBACK_URL: urlValue("SLACK_CALLBACK_URL", "http://localhost:4000/auth/slack/callback"),
};
