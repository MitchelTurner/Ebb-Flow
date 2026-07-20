#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config.js";
import {
  closePool,
  getIssueForSend,
  getStories,
  runSqlFile,
} from "./db.js";
import { renderIssueEmail } from "./render.js";
import { sendNewsletter } from "./send.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case "migrate": {
        const config = getConfig();
        await runSqlFile(config.databaseUrl, "sql/schema.sql");
        console.log("Schema applied.");
        break;
      }
      case "seed": {
        const config = getConfig();
        await runSqlFile(config.databaseUrl, "sql/seed.sql");
        console.log("Seed data applied.");
        break;
      }
      case "send": {
        const config = getConfig();
        const issueArg = args.find((a) => a.startsWith("--issue="));
        if (issueArg) {
          process.env.ISSUE_ID = issueArg.slice("--issue=".length);
        }
        if (args.includes("--dry-run")) {
          process.env.DRY_RUN = "true";
        }
        const result = await sendNewsletter(getConfig());
        console.log(JSON.stringify(result, null, 2));
        if (result.failed > 0) process.exitCode = 1;
        break;
      }
      case "preview": {
        const config = getConfig();
        const issueId =
          args.find((a) => a.startsWith("--issue="))?.slice("--issue=".length) ??
          config.issueId;
        const issue = await getIssueForSend(config.databaseUrl, issueId);
        if (!issue) {
          throw new Error("No issue found to preview");
        }
        const stories = await getStories(config.databaseUrl, issue.id);
        const html = renderIssueEmail({
          issue,
          stories,
          subscriber: {
            first_name: args.includes("--anonymous") ? "" : "Alex",
            unsubscribe_token: "preview-token",
          },
          appUrl: config.appUrl,
        });
        mkdirSync(".preview", { recursive: true });
        const out = join(".preview", `${issue.id}.html`);
        writeFileSync(out, html, "utf8");
        console.log(`Wrote ${out} (${html.length} bytes)`);
        break;
      }
      case "serve": {
        const config = getConfig();
        await startServer(config);
        // keep process alive
        await new Promise(() => {});
        break;
      }
      case "help":
      default:
        printHelp();
        if (command !== "help") {
          process.exitCode = 1;
        }
        break;
    }
  } finally {
    await closePool();
  }
}

function printHelp(): void {
  console.log(`The Ebb & Flow newsletter CLI

Commands:
  migrate              Apply sql/schema.sql
  seed                 Apply sql/seed.sql
  preview [--issue=ID] Render latest/ready issue HTML to .preview/
  send [--issue=ID] [--dry-run]
                       Auto-fill template from Postgres and send via Resend
  serve                HTTP server (preview, unsubscribe, /cron/send)

Environment: see .env.example
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
