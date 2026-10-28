import Redis from "ioredis";
import { config } from "./config.js";

export function createRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export const redis = createRedisConnection();
