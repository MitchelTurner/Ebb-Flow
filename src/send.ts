import { Resend } from "resend";
import type { AppConfig } from "./config.js";
import { brandLogoResendAttachment } from "./brandAssets.js";
import {
  getActiveSubscribers,
  getIssueForSend,
  getStories,
  listDueIssues,
  listSentSubscriberIds,
  markIssueReadyForRetry,
  markIssueSending,
  markIssueSent,
  recordSend,
} from "./db.js";
import { loadTemplate, renderIssueEmail } from "./render.js";
import { randomUUID } from "node:crypto";

export interface SendResult {
  issueId: string;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
}

/** Send all due scheduled/ready issues (used by cron). */
export async function sendDueNewsletters(
  config: AppConfig
): Promise<SendResult[]> {
  if (config.issueId) {
    return [await sendNewsletter(config)];
  }

  const due = await listDueIssues(config.databaseUrl);
  if (due.length === 0) {
    // Cron should exit cleanly on quiet weeks.
    return [];
  }

  const results: SendResult[] = [];
  for (const issue of due) {
    results.push(await sendNewsletter({ ...config, issueId: issue.id }));
  }
  return results;
}

export async function sendNewsletter(config: AppConfig): Promise<SendResult> {
  const issue = await getIssueForSend(config.databaseUrl, config.issueId);
  if (!issue) {
    throw new Error(
      config.issueId
        ? `Issue not found: ${config.issueId}`
        : "No due ready issue found (check scheduled_for)"
    );
  }

  if (!["ready", "sending"].includes(issue.status) && !config.dryRun) {
    throw new Error(
      `Issue ${issue.id} has status '${issue.status}' (expected ready)`
    );
  }

  if (
    issue.scheduled_for &&
    new Date(issue.scheduled_for).getTime() > Date.now() &&
    !config.dryRun
  ) {
    throw new Error(
      `Issue ${issue.id} is scheduled for ${issue.scheduled_for} and is not due yet`
    );
  }

  const stories = await getStories(config.databaseUrl, issue.id);
  if (stories.length === 0) {
    throw new Error(`Issue ${issue.id} has no stories`);
  }

  const subscribers = await getActiveSubscribers(
    config.databaseUrl,
    config.maxRecipients
  );
  if (subscribers.length === 0) {
    throw new Error("No active subscribers to send to");
  }

  const alreadySent = await listSentSubscriberIds(
    config.databaseUrl,
    issue.id
  );

  const template = loadTemplate();
  const result: SendResult = {
    issueId: issue.id,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    dryRun: config.dryRun,
  };

  if (!config.dryRun) {
    if (!config.resendApiKey) {
      throw new Error("RESEND_API_KEY is required unless DRY_RUN=true");
    }
    await markIssueSending(config.databaseUrl, issue.id);
  }

  const resend = config.dryRun ? null : new Resend(config.resendApiKey);
  const logoAttachment = brandLogoResendAttachment();
  if (!logoAttachment) {
    console.warn(
      "Brand logo PNG missing — emails will fall back to hosted APP_URL logo"
    );
  }

  for (const subscriber of subscribers) {
    if (alreadySent.has(subscriber.id)) {
      result.skipped += 1;
      continue;
    }

    result.attempted += 1;
    const html = renderIssueEmail({
      issue,
      stories,
      subscriber,
      appUrl: config.appUrl,
      template,
      logoDelivery: logoAttachment ? "cid" : "hosted",
    });

    if (config.dryRun) {
      console.log(
        `[dry-run] Would send to ${subscriber.email} (${html.length} bytes) subject="${issue.subject}"`
      );
      await recordSend({
        databaseUrl: config.databaseUrl,
        issueId: issue.id,
        subscriberId: subscriber.id,
        providerId: null,
        status: "skipped",
        error: "dry_run",
      });
      result.skipped += 1;
      continue;
    }

    try {
      const { data, error } = await resend!.emails.send({
        from: config.fromEmail,
        to: subscriber.email,
        subject: issue.subject,
        html,
        ...(logoAttachment ? { attachments: [logoAttachment] } : {}),
        headers: {
          "List-Unsubscribe": `<${config.appUrl}/unsubscribe/${subscriber.unsubscribe_token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      await recordSend({
        databaseUrl: config.databaseUrl,
        issueId: issue.id,
        subscriberId: subscriber.id,
        providerId: data?.id ?? null,
        status: "sent",
      });
      result.sent += 1;
      console.log(`Sent to ${subscriber.email} (${data?.id ?? "no-id"})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordSend({
        databaseUrl: config.databaseUrl,
        issueId: issue.id,
        subscriberId: subscriber.id,
        providerId: null,
        status: "failed",
        error: message,
      });
      result.failed += 1;
      console.error(`Failed for ${subscriber.email}: ${message}`);
    }
  }

  if (!config.dryRun) {
    if (result.failed === 0) {
      await markIssueSent(config.databaseUrl, issue.id);
    } else {
      // Leave retriable: already-sent recipients are skipped next run.
      await markIssueReadyForRetry(config.databaseUrl, issue.id);
      console.warn(
        `Issue ${issue.id} had ${result.failed} failure(s); re-queued as ready for retry`
      );
    }
  }

  return result;
}

/** Email a rendered preview to one address without changing issue status. */
export async function sendPreviewEmail(
  config: AppConfig,
  issueId: string,
  toEmail: string
): Promise<{ ok: true; providerId: string | null; to: string }> {
  const email = toEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid preview email address.");
  }

  const issue = await getIssueForSend(config.databaseUrl, issueId);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  const stories = await getStories(config.databaseUrl, issueId);
  if (!stories.length) {
    throw new Error("Add stories before sending a preview.");
  }

  const logoAttachment = brandLogoResendAttachment();
  const html = renderIssueEmail({
    issue,
    stories,
    subscriber: {
      first_name: "editor",
      unsubscribe_token: "preview",
    },
    appUrl: config.appUrl,
    logoDelivery: logoAttachment ? "cid" : "hosted",
  });

  if (config.dryRun) {
    console.log(
      `[dry-run] Would preview-send to ${email} (${html.length} bytes) subject="${issue.subject}"`
    );
    return { ok: true, providerId: null, to: email };
  }

  if (!config.resendApiKey) {
    throw new Error("RESEND_API_KEY is required to email a preview.");
  }

  const resend = new Resend(config.resendApiKey);
  const { data, error } = await resend.emails.send({
    from: config.fromEmail,
    to: email,
    subject: `[Preview] ${issue.subject}`,
    html,
    ...(logoAttachment ? { attachments: [logoAttachment] } : {}),
    headers: {
      "X-Ebb-Flow-Preview": randomUUID(),
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true, providerId: data?.id ?? null, to: email };
}
