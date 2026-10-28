import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const SESSION_COOKIE = "reachinbox_session";

export function setSessionCookie(response: Response, user: SessionUser): void {
  const token = jwt.sign(
    { sub: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
    config.JWT_SECRET,
    { expiresIn: "7d", issuer: "reachinbox-scheduler" },
  );
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (!cookie) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(cookie, config.JWT_SECRET, {
      issuer: "reachinbox-scheduler",
    }) as jwt.JwtPayload & { email: string; name: string; avatarUrl: string | null };
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      throw new Error("Invalid session claims");
    }
    request.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      avatarUrl: payload.avatarUrl ?? null,
    };
    next();
  } catch {
    response.status(401).json({ error: "Session expired; sign in again" });
  }
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.ENCRYPTION_KEY), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
