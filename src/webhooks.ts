import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Verify a Resend (Svix) webhook signature when RESEND_WEBHOOK_SECRET is set.
 * Secret format: whsec_...
 */
export function verifyResendWebhook(params: {
  secret: string | undefined;
  req: Request;
  rawBody: string;
}): { ok: true } | { ok: false; error: string } {
  const secret = params.secret?.trim();
  if (!secret) {
    return { ok: false, error: "RESEND_WEBHOOK_SECRET is not configured" };
  }

  const svixId = params.req.get("svix-id");
  const svixTimestamp = params.req.get("svix-timestamp");
  const svixSignature = params.req.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, error: "Missing Svix signature headers" };
  }

  const ts = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "Invalid Svix timestamp" };
  }
  // Reject stamps older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) {
    return { ok: false, error: "Svix timestamp outside tolerance" };
  }

  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");
  const signed = `${svixId}.${svixTimestamp}.${params.rawBody}`;
  const digest = createHmac("sha256", key).update(signed).digest("base64");

  const candidates = svixSignature.split(" ").map((part) => {
    const [, value] = part.split(",");
    return value || part;
  });

  const expected = Buffer.from(digest);
  for (const candidate of candidates) {
    const got = Buffer.from(candidate);
    if (
      got.length === expected.length &&
      timingSafeEqual(got, expected)
    ) {
      return { ok: true };
    }
  }
  return { ok: false, error: "Invalid Svix signature" };
}

export function bounceEmailsFromEvent(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const event = body as {
    type?: string;
    data?: { to?: unknown; bounce?: { type?: string } };
  };
  if (event.type !== "email.bounced" && event.type !== "email.complained") {
    return [];
  }
  // Permanent bounces + spam complaints only.
  if (
    event.type === "email.bounced" &&
    event.data?.bounce?.type &&
    event.data.bounce.type !== "Permanent"
  ) {
    return [];
  }
  const to = event.data?.to;
  if (!Array.isArray(to)) return [];
  return to
    .map((value) => String(value).trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}
