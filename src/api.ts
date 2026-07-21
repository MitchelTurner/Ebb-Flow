import { Router, type Request } from "express";
import multer from "multer";
import type { AppConfig } from "./config.js";
import {
  clearAdminCookie,
  isAdminAuthenticated,
  requireAdmin,
  setAdminCookie,
  verifyAdminPassword,
} from "./auth.js";
import {
  getAnalyticsFunnel,
  getPublicLandingStats,
  isAllowedAnalyticsEvent,
  recordAnalyticsEvent,
} from "./analytics.js";
import { autoDraftFromNewestSources } from "./autoDraft.js";
import {
  createContextFile,
  deleteContextFile,
  listContextFiles,
  loadStoriesWithContext,
  matchStoryPositionForUpload,
} from "./contextFiles.js";
import {
  createIssue,
  deleteIssue,
  deleteStory,
  deleteSubscriber,
  getDashboardStats,
  getIssueForSend,
  getSendOpsSnapshot,
  getStories,
  listIssues,
  listReviewIssues,
  listSubscribers,
  scheduleIssue,
  subscribe,
  updateIssue,
  updateSubscriberStatus,
  updateSubscriberStatusByEmail,
  upsertStory,
} from "./db.js";
import {
  ExtractTextError,
  SUPPORTED_UPLOAD_FORMATS,
  extractTextFromUpload,
} from "./extractText.js";
import { rateLimit } from "./rateLimit.js";
import { bounceEmailsFromEvent, verifyResendWebhook } from "./webhooks.js";
import { sendSubscribeThankYou } from "./welcome.js";
import {
  createTranscript,
  deleteTranscript,
  listTranscripts,
} from "./sources.js";
import { buildEditorialChecklist } from "./checklist.js";
import {
  applyMarineAutofill,
  confirmFactReview,
  factReviewAndMaybeApply,
  generateAndSaveIssue,
} from "./generate.js";
import { checkIssueNames } from "./nameCheck.js";
import {
  acceptTopicProposal,
  discardProposal,
  getProposal,
  listPendingProposals,
  proposeTopicsFromNewestSources,
  saveProposalTopics,
} from "./proposals.js";
import { sendNewsletter, sendPreviewEmail } from "./send.js";
import type {
  IssueStatus,
  ProposalTopic,
  SubscriberStatus,
} from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(res: import("express").Response, message: string): void {
  res.status(400).json({ error: message });
}

export function createApiRouter(config: AppConfig): Router {
  const router = Router();
  const adminPassword = config.adminPassword;
  const guard = requireAdmin(adminPassword);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fileSize: Math.max(1_048_576, config.contextUploadMaxBytes || 25 * 1024 * 1024),
    },
  });

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ebb-flow-newsletter",
      aiKeyConfigured: Boolean(config.anthropicApiKey),
    });
  });

  /** Public landing bootstrap: social proof + analytics config (no secrets). */
  router.get("/public/landing", async (_req, res) => {
    try {
      const stats = await getPublicLandingStats(config.databaseUrl);
      res.json({
        proof_label: stats.proof_label,
        sent_issues: stats.sent_issues,
        analytics_enabled: config.analyticsEnabled,
        plausible_domain: config.plausibleDomain ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** First-party funnel events from the landing page. */
  router.post("/events", async (req, res) => {
    try {
      if (!config.analyticsEnabled) {
        res.status(204).end();
        return;
      }
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ||
        req.ip ||
        "unknown";
      const limited = rateLimit({
        key: `events:${ip}`,
        limit: 120,
        windowMs: 60 * 60 * 1000,
      });
      if (!limited.ok) {
        res.status(429).json({ error: "Too many events." });
        return;
      }

      const name = String(req.body?.name ?? "").trim();
      if (!isAllowedAnalyticsEvent(name)) {
        badRequest(res, "Unknown event.");
        return;
      }

      const meta =
        req.body?.meta && typeof req.body.meta === "object"
          ? (req.body.meta as Record<string, unknown>)
          : {};

      await recordAnalyticsEvent(config.databaseUrl, {
        name,
        path: String(req.body?.path ?? "/"),
        referrer: String(req.body?.referrer ?? ""),
        utm_source: String(req.body?.utm_source ?? ""),
        utm_medium: String(req.body?.utm_medium ?? ""),
        utm_campaign: String(req.body?.utm_campaign ?? ""),
        meta,
      });
      res.status(204).end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/subscribe", async (req, res) => {
    try {
      // Honeypot — bots fill hidden fields; humans leave blank.
      const honeypot = String(req.body?.company_website ?? "").trim();
      if (honeypot) {
        res.status(201).json({ ok: true, subscriber: { email: "", status: "active" } });
        return;
      }

      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ||
        req.ip ||
        "unknown";
      const limited = rateLimit({
        key: `subscribe:${ip}`,
        limit: 8,
        windowMs: 60 * 60 * 1000,
      });
      if (!limited.ok) {
        res.setHeader("Retry-After", String(limited.retryAfterSec));
        res.status(429).json({
          error: "Too many subscribe attempts. Try again later.",
        });
        return;
      }

      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const firstName = String(req.body?.first_name ?? "").trim() || null;
      if (!EMAIL_RE.test(email)) {
        badRequest(res, "Enter a valid email address.");
        return;
      }
      const subscriber = await subscribe(config.databaseUrl, email, firstName);
      const welcome = await sendSubscribeThankYou(config, subscriber);

      if (config.analyticsEnabled) {
        try {
          await recordAnalyticsEvent(config.databaseUrl, {
            name: "subscribe_success",
            path: "/",
            referrer: String(req.body?.referrer ?? ""),
            utm_source: String(req.body?.utm_source ?? ""),
            utm_medium: String(req.body?.utm_medium ?? ""),
            utm_campaign: String(req.body?.utm_campaign ?? ""),
            meta: {
              has_name: Boolean(firstName),
              welcome_sent: Boolean(
                welcome && "sent" in welcome && welcome.sent
              ),
            },
          });
        } catch {
          /* never fail subscribe on analytics */
        }
      }

      res.status(201).json({
        ok: true,
        subscriber: {
          email: subscriber.email,
          first_name: subscriber.first_name,
          status: subscriber.status,
        },
        welcome_email: welcome,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = /relation .* does not exist/i.test(message)
        ? " Database tables are missing — redeploy or run npm run db:migrate."
        : "";
      res.status(500).json({ error: `${message}${hint}` });
    }
  });

  router.post("/webhooks/resend", async (req, res) => {
    try {
      const rawBody =
        (req as Request & { rawBody?: string }).rawBody ??
        JSON.stringify(req.body ?? {});
      const verified = verifyResendWebhook({
        secret: config.resendWebhookSecret,
        req,
        rawBody,
      });
      if (!verified.ok) {
        res.status(401).json({ error: verified.error });
        return;
      }

      const emails = bounceEmailsFromEvent(req.body);
      const updated: string[] = [];
      for (const email of emails) {
        const status =
          (req.body as { type?: string })?.type === "email.complained"
            ? ("unsubscribed" as const)
            : ("bounced" as const);
        const row = await updateSubscriberStatusByEmail(
          config.databaseUrl,
          email,
          status
        );
        if (row) updated.push(email);
      }

      res.json({ ok: true, updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/session", (req, res) => {
    if (!adminPassword) {
      res.json({ authenticated: false, configured: false });
      return;
    }
    res.json({
      authenticated: isAdminAuthenticated(req, adminPassword),
      configured: true,
    });
  });

  router.post("/admin/login", (req, res) => {
    if (!adminPassword) {
      res.status(503).json({
        error: "Admin is not configured. Set ADMIN_PASSWORD in the environment.",
      });
      return;
    }
    const password = String(req.body?.password ?? "");
    if (!verifyAdminPassword(password, adminPassword)) {
      res.status(401).json({ error: "Incorrect password." });
      return;
    }
    setAdminCookie(res, adminPassword);
    res.json({ ok: true });
  });

  router.post("/admin/logout", (_req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
  });

  router.get("/admin/stats", guard, async (_req, res) => {
    try {
      const stats = await getDashboardStats(config.databaseUrl);
      res.json({ stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/ops", guard, async (_req, res) => {
    try {
      const ops = await getSendOpsSnapshot(config.databaseUrl);
      const funnel = config.analyticsEnabled
        ? await getAnalyticsFunnel(config.databaseUrl, 7)
        : null;
      res.json({
        ops,
        funnel,
        health: {
          reply_to_configured: Boolean(config.replyToEmail),
          resend_configured: Boolean(config.resendApiKey),
          webhook_configured: Boolean(config.resendWebhookSecret),
          weekly_cron_in_process: config.weeklyCronEnabled,
          cron_secret_configured: Boolean(config.cronSecret),
          dry_run: config.dryRun,
          analytics_enabled: config.analyticsEnabled,
          plausible_domain: config.plausibleDomain ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/subscribers", guard, async (_req, res) => {
    try {
      const subscribers = await listSubscribers(config.databaseUrl);
      res.json({ subscribers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/subscribers", guard, async (req, res) => {
    try {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const firstName = String(req.body?.first_name ?? "").trim() || null;
      if (!EMAIL_RE.test(email)) {
        badRequest(res, "Enter a valid email address.");
        return;
      }
      const subscriber = await subscribe(config.databaseUrl, email, firstName);
      res.status(201).json({ subscriber });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.patch("/admin/subscribers/:id", guard, async (req, res) => {
    try {
      const status = String(req.body?.status ?? "") as SubscriberStatus;
      if (!["active", "unsubscribed", "bounced"].includes(status)) {
        badRequest(res, "Invalid status.");
        return;
      }
      const subscriber = await updateSubscriberStatus(
        config.databaseUrl,
        req.params.id,
        status
      );
      if (!subscriber) {
        res.status(404).json({ error: "Subscriber not found" });
        return;
      }
      res.json({ subscriber });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/admin/subscribers/:id", guard, async (req, res) => {
    try {
      const ok = await deleteSubscriber(config.databaseUrl, req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Subscriber not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/issues", guard, async (_req, res) => {
    try {
      const issues = await listIssues(config.databaseUrl);
      res.json({ issues });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/issues", guard, async (req, res) => {
    try {
      const issue_date = String(req.body?.issue_date ?? "").trim();
      const subject = String(req.body?.subject ?? "").trim();
      if (!issue_date || !subject) {
        badRequest(res, "issue_date and subject are required.");
        return;
      }
      const coming_up = normalizeComingUp(req.body?.coming_up);
      const issue = await createIssue(config.databaseUrl, {
        ...req.body,
        issue_date,
        subject,
        coming_up,
      });
      res.status(201).json({ issue });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.patch("/admin/issues/:id", guard, async (req, res) => {
    try {
      if (req.body?.status) {
        const status = String(req.body.status) as IssueStatus;
        if (!["draft", "ready", "sending", "sent"].includes(status)) {
          badRequest(res, "Invalid issue status.");
          return;
        }
      }
      const current = await getIssueForSend(config.databaseUrl, req.params.id);
      if (!current) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const payload = { ...req.body };
      if (payload.coming_up !== undefined) {
        payload.coming_up = normalizeComingUp(payload.coming_up);
      }
      // Only clear the fact-check stamp when copy actually changed.
      const copyKeys = [
        "subject",
        "preheader",
        "intro",
        "coming_up",
        "volume_label",
        "tip_headline",
        "tip_body",
      ] as const;
      if (payload.fact_reviewed_at === undefined) {
        const copyChanged = copyKeys.some((key) => {
          if (!Object.prototype.hasOwnProperty.call(payload, key)) return false;
          const nextVal = payload[key];
          const prevVal = current[key];
          if (key === "coming_up") {
            return (
              JSON.stringify(nextVal ?? []) !== JSON.stringify(prevVal ?? [])
            );
          }
          return String(nextVal ?? "") !== String(prevVal ?? "");
        });
        if (copyChanged) {
          payload.fact_reviewed_at = null;
        }
      }
      const issue = await updateIssue(config.databaseUrl, req.params.id, payload);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      res.json({ issue });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/admin/issues/:id", guard, async (req, res) => {
    try {
      const ok = await deleteIssue(config.databaseUrl, req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/issues/:id/stories", guard, async (req, res) => {
    try {
      const stories = await getStories(config.databaseUrl, req.params.id);
      res.json({ stories });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.put("/admin/issues/:id/stories", guard, async (req, res) => {
    try {
      const body = req.body ?? {};
      const position = Number(body.position);
      if (!Number.isInteger(position) || position < 1 || position > 6) {
        badRequest(res, "position must be 1–6.");
        return;
      }
      const sourceNotes = String(body.source_notes ?? "");
      const title = String(body.title ?? "").trim() || `Story ${position} draft`;
      const tocTitle =
        String(body.toc_title ?? "").trim() || title.slice(0, 48) || `Story ${position}`;
      const story = await upsertStory(config.databaseUrl, req.params.id, {
        id: body.id,
        position,
        toc_title: tocTitle,
        title,
        eyebrow: String(body.eyebrow ?? ""),
        summary: String(body.summary ?? ""),
        why_it_matters: String(body.why_it_matters ?? ""),
        url: String(body.url ?? ""),
        image_url: body.image_url ? String(body.image_url) : null,
        quote: body.quote ? String(body.quote) : null,
        quote_attribution: body.quote_attribution
          ? String(body.quote_attribution)
          : null,
        source_notes: sourceNotes,
        finding_id: body.finding_id ? String(body.finding_id) : null,
      });

      // Story edits can change names/quotes — require a fresh fact-check.
      await updateIssue(config.databaseUrl, req.params.id, {
        fact_reviewed_at: null,
      });

      let generated = null;
      if (config.anthropicAutoWrite && sourceNotes.trim() && config.anthropicApiKey) {
        generated = await generateAndSaveIssue(config, req.params.id);
      }

      res.json({ story, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/issues/:id/generate", guard, async (req, res) => {
    try {
      const result = await generateAndSaveIssue(config, req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post("/admin/issues/:id/fact-review", guard, async (req, res) => {
    try {
      const apply =
        req.body?.apply === undefined ? undefined : Boolean(req.body.apply);
      const result = await factReviewAndMaybeApply(config, req.params.id, {
        apply,
      });
      res.json({
        success: true,
        review_ok: result.ok,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: message });
    }
  });

  router.post("/admin/issues/:id/confirm-fact-review", guard, async (req, res) => {
    try {
      const result = await confirmFactReview(config, req.params.id);
      const checklist = buildEditorialChecklist(
        result.issue,
        await loadStoriesWithContext(
          config.databaseUrl,
          result.issue.id,
          result.stories
        )
      );
      res.json({ ...result, checklist });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: message });
    }
  });

  router.post("/admin/issues/:id/marine", guard, async (req, res) => {
    try {
      const force = req.body?.force !== false;
      const issue = await applyMarineAutofill(config, req.params.id, { force });
      res.json({ ok: true, issue });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.delete("/admin/issues/:issueId/stories/:storyId", guard, async (req, res) => {
    try {
      const ok = await deleteStory(
        config.databaseUrl,
        req.params.issueId,
        req.params.storyId
      );
      if (!ok) {
        res.status(404).json({ error: "Story not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/issues/:id/send", guard, async (req, res) => {
    try {
      const dryRun = Boolean(req.body?.dry_run);
      // Live Send must not be silently swallowed by server DRY_RUN.
      if (!dryRun && config.dryRun) {
        res.status(400).json({
          ok: false,
          error:
            "Server DRY_RUN=true — emails will not be delivered or archived. Turn off DRY_RUN on Railway, or use Dry-run for a test render.",
        });
        return;
      }
      if (!dryRun && !config.resendApiKey) {
        res.status(400).json({
          ok: false,
          error:
            "RESEND_API_KEY is not set — cannot send. Add it on the Railway web service and redeploy.",
        });
        return;
      }

      let current = await getIssueForSend(config.databaseUrl, req.params.id);
      if (!current) {
        res.status(404).json({ ok: false, error: "Issue not found" });
        return;
      }
      let stories = await loadStoriesWithContext(
        config.databaseUrl,
        current.id,
        await getStories(config.databaseUrl, current.id)
      );

      // Clicking Send is editor confirmation when the name gate already passes.
      if (!dryRun && !current.fact_reviewed_at) {
        const names = checkIssueNames(current, stories);
        if (names.ok) {
          const stamped = await updateIssue(config.databaseUrl, current.id, {
            fact_reviewed_at: new Date().toISOString(),
          });
          if (stamped) current = stamped;
        }
      }

      const checklist = buildEditorialChecklist(current, stories);
      if (!dryRun && !checklist.ok && !req.body?.force) {
        res.status(400).json({
          ok: false,
          error:
            "Not ready to send. Fix the checklist items below, then try again.",
          checklist,
        });
        return;
      }
      // Immediate send: clear future schedule so due-check passes.
      if (!dryRun) {
        await updateIssue(config.databaseUrl, req.params.id, {
          status: "ready",
          scheduled_for: new Date().toISOString(),
        });
      }
      const result = await sendNewsletter({
        ...config,
        issueId: req.params.id,
        dryRun,
      });

      const issued = await getIssueForSend(config.databaseUrl, req.params.id);
      const archived = issued?.status === "sent";
      const archiveUrl = archived
        ? `${config.appUrl}/archive/${req.params.id}`
        : `${config.appUrl}/archive`;

      if (!dryRun && result.sent === 0) {
        res.status(502).json({
          ok: false,
          error:
            result.failed > 0
              ? `Send failed for all recipients (${result.failed}). Nothing was archived.`
              : "No emails were sent (no active subscribers, or all already received this issue).",
          result,
          checklist,
          issue: issued,
          archived: false,
          archive_url: archiveUrl,
        });
        return;
      }

      res.json({
        ok: true,
        result,
        checklist,
        issue: issued,
        archived,
        archive_url: archiveUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post("/admin/issues/:id/preview-email", guard, async (req, res) => {
    try {
      const to = String(req.body?.to ?? "").trim();
      if (!to) {
        badRequest(res, "to email is required.");
        return;
      }
      const result = await sendPreviewEmail(config, req.params.id, to);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get("/admin/issues/:id/checklist", guard, async (req, res) => {
    try {
      const issue = await getIssueForSend(config.databaseUrl, req.params.id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const stories = await loadStoriesWithContext(
        config.databaseUrl,
        issue.id,
        await getStories(config.databaseUrl, issue.id)
      );
      res.json({ checklist: buildEditorialChecklist(issue, stories) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/issues/:id/context-files", guard, async (req, res) => {
    try {
      const files = await listContextFiles(config.databaseUrl, req.params.id);
      res.json({
        files: files.map((file) => ({
          id: file.id,
          issue_id: file.issue_id,
          story_position: file.story_position,
          filename: file.filename,
          mime_type: file.mime_type,
          byte_size: file.byte_size,
          char_count: file.content_text.length,
          created_at: file.created_at,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post(
    "/admin/issues/:id/context-files",
    guard,
    upload.single("file"),
    async (req, res) => {
      try {
        const issue = await getIssueForSend(config.databaseUrl, req.params.id);
        if (!issue) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        const file = req.file;
        if (!file) {
          badRequest(res, "Choose a file to upload.");
          return;
        }

        const rawPosition = String(req.body?.story_position ?? "").trim();
        let storyPosition: number | null = null;
        let autoMatched = false;
        if (
          rawPosition &&
          rawPosition !== "all" &&
          rawPosition !== "issue" &&
          rawPosition !== "auto"
        ) {
          const n = Number(rawPosition);
          if (!Number.isInteger(n) || n < 1 || n > 6) {
            badRequest(
              res,
              "story_position must be 1–6, auto, or empty for issue-wide."
            );
            return;
          }
          storyPosition = n;
        }

        const contentText = await extractTextFromUpload({
          filename: file.originalname,
          mimeType: file.mimetype,
          buffer: file.buffer,
          maxChars: config.contextUploadMaxChars,
        });

        if (rawPosition === "auto") {
          const stories = await getStories(config.databaseUrl, req.params.id);
          const matched = matchStoryPositionForUpload(
            stories,
            file.originalname || "upload.txt",
            contentText
          );
          if (matched != null) {
            storyPosition = matched;
            autoMatched = true;
          }
        }

        const saved = await createContextFile(config.databaseUrl, {
          issueId: req.params.id,
          storyPosition,
          filename: file.originalname || "upload.txt",
          mimeType: file.mimetype || "application/octet-stream",
          byteSize: file.size,
          contentText,
        });

        await updateIssue(config.databaseUrl, req.params.id, {
          fact_reviewed_at: null,
        });

        res.status(201).json({
          file: {
            id: saved.id,
            issue_id: saved.issue_id,
            story_position: saved.story_position,
            filename: saved.filename,
            mime_type: saved.mime_type,
            byte_size: saved.byte_size,
            char_count: saved.content_text.length,
            created_at: saved.created_at,
            auto_matched: autoMatched,
          },
          supported_formats: SUPPORTED_UPLOAD_FORMATS,
        });
      } catch (err) {
        if (err instanceof ExtractTextError) {
          badRequest(res, err.message);
          return;
        }
        if (
          err instanceof multer.MulterError &&
          err.code === "LIMIT_FILE_SIZE"
        ) {
          badRequest(
            res,
            `File is too large (max ${Math.round(config.contextUploadMaxBytes / (1024 * 1024))} MB).`
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    }
  );

  router.delete(
    "/admin/issues/:id/context-files/:fileId",
    guard,
    async (req, res) => {
      try {
        const ok = await deleteContextFile(
          config.databaseUrl,
          req.params.id,
          req.params.fileId
        );
        if (!ok) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        await updateIssue(config.databaseUrl, req.params.id, {
          fact_reviewed_at: null,
        });
        res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    }
  );

  router.post("/admin/issues/:id/schedule", guard, async (req, res) => {
    try {
      const scheduledFor = String(req.body?.scheduled_for ?? "").trim();
      if (!scheduledFor || Number.isNaN(Date.parse(scheduledFor))) {
        badRequest(res, "scheduled_for must be a valid datetime.");
        return;
      }

      const current = await getIssueForSend(config.databaseUrl, req.params.id);
      if (!current) {
        res.status(404).json({ error: "Issue not found or not schedulable" });
        return;
      }
      const stories = await loadStoriesWithContext(
        config.databaseUrl,
        current.id,
        await getStories(config.databaseUrl, current.id)
      );
      const checklist = buildEditorialChecklist(current, stories);
      if (!checklist.ok && !req.body?.force) {
        res.status(400).json({
          error: "Editorial checklist incomplete. Fix items or pass force=true.",
          checklist,
        });
        return;
      }

      const issue = await scheduleIssue(
        config.databaseUrl,
        req.params.id,
        scheduledFor
      );
      if (!issue) {
        res.status(404).json({ error: "Issue not found or not schedulable" });
        return;
      }
      res.json({ issue, checklist });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/review", guard, async (_req, res) => {
    try {
      const issues = await listReviewIssues(config.databaseUrl);
      res.json({ issues });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/admin/transcripts", guard, async (req, res) => {
    try {
      const unusedOnly = String(req.query.unused ?? "") === "1";
      const transcripts = await listTranscripts(config.databaseUrl, { unusedOnly });
      res.json({ transcripts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/transcripts", guard, async (req, res) => {
    try {
      const content = String(req.body?.content ?? "").trim();
      if (!content) {
        badRequest(res, "content is required.");
        return;
      }
      const transcript = await createTranscript(config.databaseUrl, {
        title: String(req.body?.title ?? ""),
        content,
        source: String(req.body?.source ?? ""),
        speaker: String(req.body?.speaker ?? ""),
        recorded_at: req.body?.recorded_at || undefined,
      });
      res.status(201).json({ transcript });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/admin/transcripts/:id", guard, async (req, res) => {
    try {
      const ok = await deleteTranscript(config.databaseUrl, req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Transcript not found or already used" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/auto-draft", guard, async (_req, res) => {
    try {
      const draft = await autoDraftFromNewestSources(config);
      res.json({ ok: true, draft });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get("/admin/proposals", guard, async (_req, res) => {
    try {
      const proposals = await listPendingProposals(config.databaseUrl);
      res.json({ proposals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/proposals", guard, async (_req, res) => {
    try {
      const result = await proposeTopicsFromNewestSources(config);
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get("/admin/proposals/:id", guard, async (req, res) => {
    try {
      const proposal = await getProposal(config.databaseUrl, req.params.id);
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      res.json({ proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.patch("/admin/proposals/:id", guard, async (req, res) => {
    try {
      const topics = req.body?.topics as ProposalTopic[] | undefined;
      if (!Array.isArray(topics)) {
        badRequest(res, "topics array is required.");
        return;
      }
      const proposal = await saveProposalTopics(
        config.databaseUrl,
        req.params.id,
        topics
      );
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found or not pending" });
        return;
      }
      res.json({ proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/admin/proposals/:id/accept", guard, async (req, res) => {
    try {
      const topicKeys = Array.isArray(req.body?.topic_keys)
        ? req.body.topic_keys.map(String)
        : undefined;
      const result = await acceptTopicProposal(config, req.params.id, topicKeys);
      if (!result.accepted) {
        res.status(400).json({ ok: false, error: result.reason });
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post("/admin/proposals/:id/discard", guard, async (req, res) => {
    try {
      const ok = await discardProposal(config.databaseUrl, req.params.id);
      if (!ok) {
        res.status(404).json({ error: "Proposal not found or not pending" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}

function normalizeComingUp(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.replace(/^[•\-\*]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}
