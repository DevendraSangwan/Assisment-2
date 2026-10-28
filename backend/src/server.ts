import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config.js";
import authRouter from "./auth.js";
import emailRouter from "./email-routes.js";
import { db, initializeDatabase } from "./db.js";
import { startOutboxPublisher } from "./outbox.js";
import { emailQueue } from "./queue.js";
import { redis } from "./redis.js";
import { initializeSearch, searchClient } from "./search.js";
import { requireAuth } from "./security.js";

async function main(): Promise<void> {
  await initializeDatabase();
  await redis.ping();
  await initializeSearch();

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({
    origin: config.FRONTEND_URL,
    credentials: true,
  }));
  app.use(express.json({ limit: "4mb" }));
  app.use("/auth", authRouter);
  app.use("/api", emailRouter);

  const bullBoard = new ExpressAdapter();
  bullBoard.setBasePath("/admin/queues");
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter: bullBoard,
  });
  app.use("/admin/queues", requireAuth, bullBoard.getRouter());

  app.get("/health", async (_request, response, next) => {
    try {
      const dbHealth = await db.query("SELECT 1");
      const [redisHealth, searchHealth] = await Promise.all([
        redis.ping(),
        searchClient.cluster.health(),
      ]);
      response.json({
        status: "ok",
        postgres: dbHealth.rowCount === 1,
        redis: redisHealth === "PONG",
        elasticsearch: searchHealth.status,
      });
    } catch (error) {
      next(error);
    }
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error("Request failed:", error);
    if (response.headersSent) return;
    response.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  const server = app.listen(config.PORT, () => {
    console.log(`API listening at ${config.API_URL}`);
    console.log(`BullMQ dashboard at ${config.API_URL}/admin/queues`);
  });
  const outboxTimer = startOutboxPublisher();

  const shutdown = async (): Promise<void> => {
    clearInterval(outboxTimer);
    server.close();
    await emailQueue.close();
    await redis.quit();
    await searchClient.close();
    await db.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error("API startup failed:", error);
  process.exitCode = 1;
});
