import { Queue } from "bullmq";
import { config } from "./config.js";
import { createRedisConnection } from "./redis.js";

export interface SendEmailJob {
  emailId: string;
}

export const EMAIL_QUEUE_NAME = "scheduled-emails" as const;
export const SEND_EMAIL_JOB_NAME = "send-email" as const;

export const emailQueue = new Queue<SendEmailJob, void, typeof SEND_EMAIL_JOB_NAME>(EMAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: config.EMAIL_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
  },
});
