import type { AppConfig } from "./config.js";

/** Resend fields shared by newsletter / welcome / preview sends. */
export function resendReplyFields(
  config: AppConfig
): { replyTo: string } | Record<string, never> {
  const replyTo = config.replyToEmail?.trim();
  if (!replyTo) return {};
  return { replyTo };
}
