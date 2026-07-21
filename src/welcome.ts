import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resend } from "resend";
import type { AppConfig } from "./config.js";
import { renderTemplate } from "./render.js";
import type { Subscriber } from "./types.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "subscribe-thank-you.html"
);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadThankYouTemplate(): string {
  return readFileSync(templatePath, "utf8");
}

export function renderSubscribeThankYouEmail(params: {
  subscriber: Pick<Subscriber, "email" | "first_name" | "unsubscribe_token">;
  appUrl: string;
}): { subject: string; html: string } {
  const name = params.subscriber.first_name?.trim();
  const siteLabel = params.appUrl.replace(/^https?:\/\//, "");
  const html = renderTemplate(loadThankYouTemplate(), {
    greeting_name: name ? `, ${escapeHtml(name)}` : "",
    subscriber_email: escapeHtml(params.subscriber.email),
    unsubscribe_url: `${params.appUrl}/unsubscribe/${params.subscriber.unsubscribe_token}`,
    site_url: params.appUrl,
    site_url_label: escapeHtml(siteLabel),
  });

  return {
    subject: "You're subscribed to The Ebb & Flow",
    html,
  };
}

export type WelcomeEmailResult =
  | { sent: true; providerId: string | null }
  | { sent: false; skipped: true; reason: string }
  | { sent: false; skipped: false; error: string };

/**
 * Send the post-subscribe confirmation email.
 * Never throws for provider failures — callers should not fail the subscribe.
 */
export async function sendSubscribeThankYou(
  config: AppConfig,
  subscriber: Pick<Subscriber, "email" | "first_name" | "unsubscribe_token">
): Promise<WelcomeEmailResult> {
  const { subject, html } = renderSubscribeThankYouEmail({
    subscriber,
    appUrl: config.appUrl,
  });

  if (config.dryRun) {
    console.log(
      `[dry-run] Would send subscribe thank-you to ${subscriber.email} (${html.length} bytes)`
    );
    return { sent: false, skipped: true, reason: "dry_run" };
  }

  if (!config.resendApiKey) {
    console.warn(
      "Subscribe thank-you skipped: RESEND_API_KEY is not set."
    );
    return { sent: false, skipped: true, reason: "missing_resend_api_key" };
  }

  try {
    const resend = new Resend(config.resendApiKey);
    const { data, error } = await resend.emails.send({
      from: config.fromEmail,
      to: subscriber.email,
      subject,
      html,
      headers: {
        "List-Unsubscribe": `<${config.appUrl}/unsubscribe/${subscriber.unsubscribe_token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (error) {
      console.error(
        `Subscribe thank-you failed for ${subscriber.email}: ${error.message}`
      );
      return { sent: false, skipped: false, error: error.message };
    }

    console.log(
      `Subscribe thank-you sent to ${subscriber.email} (${data?.id ?? "no-id"})`
    );
    return { sent: true, providerId: data?.id ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Subscribe thank-you failed for ${subscriber.email}: ${message}`);
    return { sent: false, skipped: false, error: message };
  }
}
