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
import { autoDraftFromNewestFindings } from "./autoDraft.js";
import { generateAndSaveIssue } from "./generate.js";
import { renderIssueEmail } from "./render.js";
import { sendDueNewsletters, sendNewsletter } from "./send.js";
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
        const fresh = getConfig();
        if (fresh.issueId) {
          const result = await sendNewsletter(fresh);
          console.log(JSON.stringify(result, null, 2));
          if (result.failed > 0) process.exitCode = 1;
        } else {
          const results = await sendDueNewsletters(fresh);
          console.log(JSON.stringify(results, null, 2));
          if (results.some((r) => r.failed > 0)) process.exitCode = 1;
        }
        break;
      }
      case "auto-draft": {
        const result = await autoDraftFromNewestFindings(getConfig());
        console.log(JSON.stringify(result, null, 2));
        if (!result.drafted) process.exitCode = 1;
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
      case "generate": {
        const config = getConfig();
        const issueId =
          args.find((a) => a.startsWith("--issue="))?.slice("--issue=".length) ??
          config.issueId;
        if (!issueId) {
          throw new Error("Pass --issue=<uuid> or set ISSUE_ID");
        }
        const result = await generateAndSaveIssue(config, issueId);
        console.log(
          JSON.stringify(
            {
              model: result.model,
              subject: result.issue.subject,
              stories: result.stories.map((s) => ({
                position: s.position,
                title: s.title,
              })),
            },
            null,
            2
          )
        );
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
  generate --issue=ID  Use Claude to rewrite issue + stories from source notes
  auto-draft           Draft a review issue from newest unused transcripts
  send [--issue=ID] [--dry-run]
                       Send due scheduled/ready issues via Resend
  serve                HTTP server (preview, unsubscribe, cron routes)

Environment: see .env.example
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
