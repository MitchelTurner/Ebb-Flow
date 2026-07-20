import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "ebb_admin";

function signToken(secret: string): string {
  return createHmac("sha256", secret).update("ebb-flow-admin-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function isAdminAuthenticated(req: Request, adminPassword: string): boolean {
  if (!adminPassword) return false;
  const cookies = parseCookies(req.get("cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  return safeEqual(token, signToken(adminPassword));
}

export function setAdminCookie(res: Response, adminPassword: string): void {
  const token = signToken(adminPassword);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`
  );
}

export function clearAdminCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

export function requireAdmin(adminPassword: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminPassword) {
      res.status(503).json({
        error: "Admin is not configured. Set ADMIN_PASSWORD in the environment.",
      });
      return;
    }
    if (!isAdminAuthenticated(req, adminPassword)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function verifyAdminPassword(
  provided: string,
  adminPassword: string
): boolean {
  return safeEqual(provided, adminPassword);
}
