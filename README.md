# The Ebb & Flow — automated newsletter

Pulls issue + subscriber data from **Railway Postgres**, fills `templates/ebb-and-flow.html`, and sends via **Resend**.

## What you get

- Parameterized HTML email template (from the original design mock)
- Postgres schema: `subscribers`, `issues`, `stories`, `sends`
- CLI: migrate / seed / preview / send
- HTTP service: health, browser preview, unsubscribe, cron trigger
- Railway-ready `railway.toml` + Dockerfile

## Setup

1. Create a Railway Postgres database and copy `DATABASE_URL`.
2. Create a [Resend](https://resend.com) API key and verify your sending domain.
3. Copy env vars:

```bash
cp .env.example .env
# fill DATABASE_URL, RESEND_API_KEY, FROM_EMAIL, APP_URL
```

4. Install and migrate:

```bash
npm install
npm run db:migrate
npm run db:seed
```

5. Preview locally (no send):

```bash
npm run preview
# open .preview/<issue-id>.html
```

6. Dry-run send (writes `sends` rows as `skipped`):

```bash
DRY_RUN=true npm run send
```

7. Real send:

```bash
npm run send
# or a specific issue:
npm run send -- --issue=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
```

## HTTP service

```bash
npm run serve
```

| Route | Purpose |
|--------|---------|
| `GET /health` | Health check |
| `GET /preview/:issueId` | Render issue in browser |
| `GET/POST /unsubscribe/:token` | One-click unsubscribe |
| `GET /preferences/:token` | Simple prefs page |
| `POST /cron/send` | Trigger send (optional `Authorization: Bearer $CRON_SECRET`) |

## Railway deploy

1. Create a Railway project and attach Postgres.
2. Deploy this repo as a service; set env vars from `.env.example`.
3. Run once (Railway shell or one-off):

```bash
npm run db:migrate
npm run db:seed
```

4. Add a **Cron** service (or GitHub Action) that runs:

```bash
npm run start:send
```

Suggested schedule: `0 15 * * 1` (Mondays 15:00 UTC).

Alternatively hit `POST /cron/send` with `CRON_SECRET` from an external scheduler.

## Editorial workflow

1. Insert/update a row in `issues` with `status = 'draft'`.
2. Insert up to 6 rows in `stories` (`position` 1–6; position 1 is the lead/hero).
3. When ready to mail, set `issues.status = 'ready'`.
4. Cron/`npm run send` sends to all `subscribers` with `status = 'active'`, then marks the issue `sent`.

## Template tags

Merge tags use `{{key}}` or `{{key|fallback}}` (used for `{{first_name|neighbor}}`).

Dynamic fields include issue metadata, weather/tides, intro, six stories, CTA, coming-up list, tip box, and per-subscriber unsubscribe/prefs URLs. See `templates/ebb-and-flow.html`.

The original bundler preview file `The Ebb and Flow.html` is kept for design reference; production rendering uses `templates/ebb-and-flow.html`.
