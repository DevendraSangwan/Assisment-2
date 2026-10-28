import { randomBytes } from "node:crypto";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { db } from "./db.js";
import { redis } from "./redis.js";
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  type SessionUser,
} from "./security.js";
import {
  completeSlackAuthorization,
  createSlackAuthorization,
} from "./slack.js";

const router = Router();
const googleOAuth = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_CALLBACK_URL,
);

router.get("/google", async (_request, response, next) => {
  try {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      response.status(503).json({ error: "Google OAuth is not configured" });
      return;
    }
    const state = randomBytes(32).toString("base64url");
    await redis.set(`oauth:google:${state}`, "1", "EX", 600, "NX");
    response.redirect(googleOAuth.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      prompt: "select_account",
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/google/callback", async (request, response, next) => {
  try {
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const validState = state ? await redis.getdel(`oauth:google:${state}`) : null;
    if (!validState || !code) {
      response.redirect(`${config.FRONTEND_URL}/?login_error=oauth_state`);
      return;
    }

    const { tokens } = await googleOAuth.getToken(code);
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await googleOAuth.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      throw new Error("Google account is missing a verified email");
    }

    const user = await db.query<{
      id: string;
      email: string;
      name: string;
      avatar_url: string | null;
    }>(
      `INSERT INTO users (id, email, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url
       RETURNING id, email, name, avatar_url`,
      [profile.sub, profile.email, profile.name ?? profile.email, profile.picture ?? null],
    );
    const row = user.rows[0];
    if (!row) throw new Error("Unable to create the account");
    const sessionUser: SessionUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
    };
    setSessionCookie(response, sessionUser);
    response.redirect(config.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (_request, response) => {
  clearSessionCookie(response);
  response.status(204).end();
});

router.get("/me", requireAuth, (request, response) => {
  response.json({ user: request.user });
});

router.get("/slack/connect", requireAuth, async (request, response, next) => {
  try {
    response.redirect(await createSlackAuthorization(request.user!.id));
  } catch (error) {
    next(error);
  }
});

router.get("/slack/callback", async (request, response, next) => {
  try {
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const state = typeof request.query.state === "string" ? request.query.state : "";
    if (!code || !state) throw new Error("Slack authorization response is missing code or state");
    await completeSlackAuthorization(code, state);
    response.redirect(`${config.FRONTEND_URL}/?slack=connected`);
  } catch (error) {
    next(error);
  }
});

router.get("/slack/status", requireAuth, async (request, response, next) => {
  try {
    const result = await db.query<{ team_name: string | null; connected_at: Date }>(
      "SELECT team_name, connected_at FROM slack_connections WHERE user_id = $1",
      [request.user!.id],
    );
    response.json({
      connected: Boolean(result.rows[0]),
      teamName: result.rows[0]?.team_name ?? null,
      connectedAt: result.rows[0]?.connected_at ?? null,
      configured: Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET),
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/slack", requireAuth, async (request, response, next) => {
  try {
    await db.query("DELETE FROM slack_connections WHERE user_id = $1", [request.user!.id]);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
