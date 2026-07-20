import express from "express";
import type { AppConfig } from "./config.js";
import {
  getIssueForSend,
  getStories,
  getSubscriberByToken,
  unsubscribeByToken,
} from "./db.js";
import { renderIssueEmail } from "./render.js";
import { sendNewsletter } from "./send.js";

export function createServer(config: AppConfig) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ebb-flow-newsletter" });
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

  // Manual / cron trigger. Protect with CRON_SECRET when set.
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
      const result = await sendNewsletter(config);
      res.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return app;
}

export async function startServer(config: AppConfig): Promise<void> {
  const app = createServer(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`Listening on :${config.port}`);
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
