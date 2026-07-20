import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./api.js";
import type { AppConfig } from "./config.js";
import {
  getIssueForSend,
  getStories,
  getSubscriberByToken,
  runSqlFile,
  unsubscribeByToken,
} from "./db.js";
import { autoDraftFromNewestFindings } from "./autoDraft.js";
import { renderIssueEmail } from "./render.js";
import { sendDueNewsletters } from "./send.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const indexHtml = join(publicDir, "index.html");
const adminHtml = join(publicDir, "admin", "index.html");

export function createServer(config: AppConfig) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.use("/api", createApiRouter(config));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ebb-flow-newsletter",
      publicDirExists: existsSync(publicDir),
    });
  });

  app.get("/preview/:issueId", async (req, res) => {
    try {
      const issue = await getIssueForSend(config.databaseUrl, req.params.issueId);
      if (!issue) {
        res.status(404).send("Issue not found");
        return;
      }
      const stories = await getStories(config.databaseUrl, issue.id);
      const html = renderIssueEmail({
        issue,
        stories,
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

  app.get("/unsubscribe/:token", async (req, res) => {
    try {
      const subscriber = await getSubscriberByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res.status(404).type("html").send(page("Unsubscribe", "Link not found."));
        return;
      }

      if (subscriber.status === "unsubscribed") {
        res
          .type("html")
          .send(page("Unsubscribed", "You are already unsubscribed."));
        return;
      }

      res.type("html").send(page(
        "Confirm unsubscribe",
        `<p>Unsubscribe <strong>${escape(subscriber.email)}</strong> from The Ebb &amp; Flow?</p>
         <form method="POST" action="/unsubscribe/${subscriber.unsubscribe_token}">
           <button type="submit" style="margin-top:16px;padding:10px 18px;background:#16293a;color:#fff;border:0;cursor:pointer;">
             Unsubscribe
           </button>
         </form>`
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).type("html").send(page("Error", escape(message)));
    }
  });

  app.post("/unsubscribe/:token", async (req, res) => {
    try {
      const subscriber = await unsubscribeByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res.status(404).type("html").send(page("Unsubscribe", "Link not found."));
        return;
      }
      res
        .type("html")
        .send(
          page(
            "Unsubscribed",
            `You have been unsubscribed (<strong>${escape(subscriber.email)}</strong>).`
          )
        );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).type("html").send(page("Error", escape(message)));
    }
  });

  app.get("/preferences/:token", async (req, res) => {
    try {
      const subscriber = await getSubscriberByToken(
        config.databaseUrl,
        req.params.token
      );
      if (!subscriber) {
        res.status(404).type("html").send(page("Preferences", "Link not found."));
        return;
      }
      res.type("html").send(
        page(
          "Preferences",
          `<p>Status for <strong>${escape(subscriber.email)}</strong>: <em>${escape(subscriber.status)}</em></p>
           <p>To leave the list, <a href="/unsubscribe/${subscriber.unsubscribe_token}">unsubscribe here</a>.</p>`
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).type("html").send(page("Error", escape(message)));
    }
  });

  app.post("/cron/send", async (req, res) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
      const header = req.get("authorization") ?? "";
      if (header !== `Bearer ${secret}`) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    try {
      const results = await sendDueNewsletters(config);
      res.json({ ok: true, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/cron/auto-draft", async (req, res) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
      const header = req.get("authorization") ?? "";
      if (header !== `Bearer ${secret}`) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    try {
      const draft = await autoDraftFromNewestFindings(config);
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

  // Schema uses IF NOT EXISTS, so this is safe on every boot.
  await ensureSchema(config.databaseUrl);

  if (config.autoDraftFromFindings) {
    try {
      const draft = await autoDraftFromNewestFindings(config);
      if (draft.drafted) {
        console.log(
          `Auto-drafted issue ${draft.result?.issue.id} from ${draft.findingCount} findings`
        );
      } else {
        console.log(`Auto-draft skipped: ${draft.reason}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Auto-draft failed: ${message}`);
    }
  }

  const app = createServer(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`Listening on :${config.port}`);
      console.log(`Serving frontend from ${publicDir}`);
      resolve();
    });
  });
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · The Ebb &amp; Flow</title>
  <style>
    body { margin:0; font-family: Georgia, 'Times New Roman', serif; background:#f0ede8; color:#3a352e; }
    main { max-width:520px; margin:64px auto; padding:0 24px; }
    h1 { font-size:28px; color:#16293a; }
    a { color:#16293a; }
  </style>
</head>
<body>
  <main>
    <h1>${escape(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}
