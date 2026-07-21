import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBrandFile, resolvePublicDir } from "./assetPaths.js";
import { BRAND_LOGO_FILE } from "./brandAssets.js";
import { createApiRouter } from "./api.js";
import { isAdminAuthenticated } from "./auth.js";
import type { AppConfig } from "./config.js";
import { authorizeCron } from "./cronAuth.js";
import {
  getIssueForSend,
  getStories,
  getSubscriberByToken,
  listSentIssues,
  runSqlFile,
  unsubscribeByToken,
  updateSubscriberPreferences,
} from "./db.js";
import { autoDraftFromNewestSources } from "./autoDraft.js";
import { brandPage, escapeHtml } from "./publicPages.js";
import { renderIssueEmail } from "./render.js";
import { sendDueNewsletters } from "./send.js";
import { startWeeklyCronScheduler } from "./weeklyCron.js";

const publicDir = resolvePublicDir();
const indexHtml = join(publicDir, "index.html");
const adminHtml = join(publicDir, "admin", "index.html");

export function createServer(config: AppConfig) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Keep raw body for Resend webhook signature verification.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody =
          buf.toString("utf8");
      },
    })
  );

  app.use("/api", createApiRouter(config));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ebb-flow-newsletter",
      publicDir,
      publicDirExists: existsSync(publicDir),
      brandLogo: Boolean(resolveBrandFile(BRAND_LOGO_FILE)),
      aiKeyConfigured: Boolean(config.anthropicApiKey),
      weeklyCronEnabled: config.weeklyCronEnabled,
      autoDraftOnBoot: config.autoDraftOnBoot,
    });
  });

  app.get("/preview/:issueId", async (req, res) => {
    try {
      const issue = await getIssueForSend(
        config.databaseUrl,
        req.params.issueId
      );
      if (!issue) {
        res.status(404).send("Issue not found");
        return;
      }

      const isAdmin = Boolean(
        config.adminPassword &&
          isAdminAuthenticated(req, config.adminPassword)
      );
      // Public inbox "view in browser" only for sent issues; drafts need admin.
      if (issue.status !== "sent" && !isAdmin) {
        res.status(404).send("Issue not found");
        return;
      }

      const stories = await getStories(config.databaseUrl, issue.id);
      const html = renderIssueEmail({
        issue,
        stories,
        logoDelivery: "relative",
        subscriber: {
          first_name: "neighbor",
          unsubscribe_token: "preview",
        },
        appUrl: config.appUrl,
      });
      res.type("html").send(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).send(message);
    }
  });

  app.get("/archive", async (_req, res) => {
    try {
      const issues = await listSentIssues(config.databaseUrl);
      const items = issues.length
        ? `<ul class="archive-list">${issues
            .map(
              (issue) => `<li>
              <a href="/archive/${issue.id}">${escapeHtml(issue.subject)}</a>
              <div class="muted">${escapeHtml(issue.issue_date)}${
                issue.volume_label
                  ? ` · ${escapeHtml(issue.volume_label)}`
                  : ""
              }</div>
            </li>`
            )
            .join("")}</ul>`
        : `<p class="muted">No published issues yet — check back after the first send.</p>`;

      res.type("html").send(
        brandPage({
          title: "Archive",
          eyebrow: "Past issues · Tongass Narrows",
          body: `<p class="muted">Read previous weeks of The Ebb &amp; Flow.</p>
                 <div class="card">${items}</div>
                 <p class="muted" style="margin-top:1.5rem;"><a href="/">Subscribe</a></p>`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.get("/archive/:issueId", async (req, res) => {
    try {
      const issue = await getIssueForSend(
        config.databaseUrl,
        req.params.issueId
      );
      if (!issue || issue.status !== "sent") {
        res
          .status(404)
          .type("html")
          .send(
            brandPage({
              title: "Not found",
              body: `<p>That issue isn’t in the public archive.</p><p><a href="/archive">Back to archive</a></p>`,
            })
          );
        return;
      }
      const stories = await getStories(config.databaseUrl, issue.id);
      const html = renderIssueEmail({
        issue,
        stories,
        logoDelivery: "relative",
        subscriber: {
          first_name: "neighbor",
          unsubscribe_token: "preview",
        },
        appUrl: config.appUrl,
      });
      res.type("html").send(html);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.get("/unsubscribe/:token", async (req, res) => {
    try {
      const subscriber = await getSubscriberByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res
          .status(404)
          .type("html")
          .send(
            brandPage({ title: "Unsubscribe", body: "<p>Link not found.</p>" })
          );
        return;
      }

      if (subscriber.status === "unsubscribed") {
        res.type("html").send(
          brandPage({
            title: "Already unsubscribed",
            body: `<p>You’re already off the list.</p><p class="muted"><a href="/">Back to The Ebb &amp; Flow</a></p>`,
          })
        );
        return;
      }

      res.type("html").send(
        brandPage({
          title: "Confirm unsubscribe",
          body: `<div class="card">
            <p>Leave the list for <strong>${escapeHtml(subscriber.email)}</strong>?</p>
            <form method="POST" action="/unsubscribe/${subscriber.unsubscribe_token}">
              <button type="submit">Unsubscribe</button>
              <a class="btn secondary" href="/preferences/${subscriber.unsubscribe_token}">Manage preferences</a>
            </form>
          </div>`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.post("/unsubscribe/:token", async (req, res) => {
    try {
      const subscriber = await unsubscribeByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res
          .status(404)
          .type("html")
          .send(
            brandPage({ title: "Unsubscribe", body: "<p>Link not found.</p>" })
          );
        return;
      }
      res.type("html").send(
        brandPage({
          title: "Unsubscribed",
          body: `<p>You’re off the list (<strong>${escapeHtml(subscriber.email)}</strong>).</p>
                 <p class="muted">Changed your mind? <a href="/preferences/${subscriber.unsubscribe_token}">Reactivate here</a>.</p>`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.get("/preferences/:token", async (req, res) => {
    try {
      const subscriber = await getSubscriberByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res
          .status(404)
          .type("html")
          .send(
            brandPage({ title: "Preferences", body: "<p>Link not found.</p>" })
          );
        return;
      }

      const statusNote =
        subscriber.status === "active"
          ? "You’re subscribed and receiving the weekly roundup."
          : subscriber.status === "bounced"
            ? "Delivery is paused because mail to this address bounced. Update nothing here — reply to the newsroom if this is wrong."
            : "You’re currently unsubscribed.";

      res.type("html").send(
        brandPage({
          title: "Preferences",
          body: `<p class="muted">${escapeHtml(statusNote)}</p>
          <div class="card">
            <form method="POST" action="/preferences/${subscriber.unsubscribe_token}">
              <label>Email
                <input type="email" value="${escapeHtml(subscriber.email)}" disabled>
              </label>
              <label>First name
                <input type="text" name="first_name" value="${escapeHtml(subscriber.first_name ?? "")}" autocomplete="given-name" placeholder="Neighbor">
              </label>
              ${
                subscriber.status === "unsubscribed"
                  ? `<button type="submit" name="action" value="reactivate">Resubscribe</button>`
                  : `<button type="submit" name="action" value="save">Save name</button>
                     <button type="submit" name="action" value="unsubscribe" class="secondary">Unsubscribe</button>`
              }
            </form>
          </div>
          <p class="muted" style="margin-top:1.25rem;"><a href="/archive">Browse the archive</a> · <a href="/">Home</a></p>`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.post("/preferences/:token", async (req, res) => {
    try {
      const action = String(req.body?.action ?? "save");
      const firstName = String(req.body?.first_name ?? "").trim() || null;
      let status: "active" | "unsubscribed" | undefined;
      if (action === "unsubscribe") status = "unsubscribed";
      if (action === "reactivate") status = "active";

      const subscriber = await updateSubscriberPreferences(
        config.databaseUrl,
        req.params.token,
        {
          first_name: firstName,
          status,
        }
      );
      if (!subscriber) {
        res
          .status(404)
          .type("html")
          .send(
            brandPage({ title: "Preferences", body: "<p>Link not found.</p>" })
          );
        return;
      }

      const message =
        action === "unsubscribe"
          ? "You’re unsubscribed."
          : action === "reactivate"
            ? "Welcome back — you’re subscribed again."
            : "Preferences saved.";

      res.type("html").send(
        brandPage({
          title: "Preferences",
          body: `<p>${escapeHtml(message)}</p>
                 <p class="muted"><a href="/preferences/${subscriber.unsubscribe_token}">Back to preferences</a></p>`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(brandPage({ title: "Error", body: `<p>${escapeHtml(message)}</p>` }));
    }
  });

  app.post("/cron/send", async (req, res) => {
    if (!authorizeCron(config, req, res)) return;
    try {
      const results = await sendDueNewsletters(config);
      res.json({ ok: true, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/cron/auto-draft", async (req, res) => {
    if (!authorizeCron(config, req, res)) return;
    try {
      const draft = await autoDraftFromNewestSources(config);
      res.json({ ok: true, draft });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  // Keep /admin unlisted: noindex + not linked from the public site.
  app.use(["/admin", "/api/admin"], (_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.use(express.static(publicDir, { index: "index.html" }));

  app.get("/", (_req, res) => {
    if (!existsSync(indexHtml)) {
      res
        .status(500)
        .type("text")
        .send(`Frontend missing. Expected ${indexHtml}`);
      return;
    }
    res.sendFile(indexHtml);
  });

  app.get(["/admin", "/admin/"], (_req, res) => {
    if (!existsSync(adminHtml)) {
      res
        .status(500)
        .type("text")
        .send(`Admin UI missing. Expected ${adminHtml}`);
      return;
    }
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(adminHtml);
  });

  return app;
}

export async function ensureSchema(databaseUrl: string): Promise<void> {
  console.log("Applying database schema...");
  await runSqlFile(databaseUrl, "sql/schema.sql");
  console.log("Database schema ready.");
}

export async function startServer(config: AppConfig): Promise<void> {
  if (!existsSync(publicDir)) {
    console.warn(`Warning: public directory not found at ${publicDir}`);
  }

  const app = createServer(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`Listening on :${config.port}`);
      console.log(`Serving frontend from ${publicDir}`);
      resolve();
    });
  });

  void runBootJobs(config);
}

async function runBootJobs(config: AppConfig): Promise<void> {
  try {
    await ensureSchema(config.databaseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Schema migrate failed (server still up): ${message}`);
  }

  startWeeklyCronScheduler(config);

  if (!config.autoDraftFromFindings || !config.autoDraftOnBoot) {
    if (!config.autoDraftOnBoot) {
      console.log(
        "Boot auto-draft off (AUTO_DRAFT_ON_BOOT=false). Use admin or POST /cron/auto-draft."
      );
    }
    return;
  }

  try {
    const draft = await autoDraftFromNewestSources(config);
    if (draft.drafted) {
      console.log(
        `Auto-drafted issue ${draft.result?.issue.id} from ${draft.sourceCount} ${draft.sourceKind || "source"}(s) in ${draft.sourceTable || "database"}`
      );
    } else {
      console.log(`Auto-draft skipped: ${draft.reason}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Auto-draft failed: ${message}`);
  }
}
