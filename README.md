# The Ebb & Flow — automated newsletter

Pulls issue + subscriber data from **Railway Postgres**, fills `templates/ebb-and-flow.html`, and sends via **Resend**. Includes a public subscribe page and password-protected admin for subscribers, transcripts, and email issues.

## What you get

- Parameterized HTML email template
- Postgres schema: `subscribers`, `issues`, `stories`, `sends`, `transcripts`
- Public subscribe page (`/`)
- Admin UI (`/admin`) — manage subscribers, transcripts, draft/send emails
- CLI: migrate / seed / preview / send
- Railway-ready `railway.toml` + Dockerfile

## Setup

1. Create a Railway Postgres database and copy `DATABASE_URL`.
2. Create a [Resend](https://resend.com) API key and verify your sending domain.
3. Copy env vars:

```bash
cp .env.example .env
# fill DATABASE_URL, RESEND_API_KEY, FROM_EMAIL, APP_URL, ADMIN_PASSWORD
```

4. Install:

```bash
npm install
```

The web server applies `sql/schema.sql` automatically on startup. Optional seed data:

```bash
npm run db:seed
```

5. Run the web app:

```bash
npm run serve
# open http://localhost:3000        → subscribe
# open http://localhost:3000/admin  → manage (unlisted)
```

6. Dry-run / real send:

```bash
DRY_RUN=true npm run send
npm run send
```

Or send from **Admin → Emails → Send now**.

## Frontend

| URL | Purpose |
|-----|---------|
| `/` | Public subscribe form (no admin link) |
| `/admin` | Unlisted newsroom dashboard (bookmark this; requires `ADMIN_PASSWORD`) |

Admin tabs:

- **Overview** — subscriber / transcript / draft counts
- **Review** — topic proposals, checklist, schedule
- **Transcripts** — paste meeting notes for Claude to draft from
- **Subscribers** — add, reactivate, unsubscribe, delete
- **Emails** — create/edit issues + stories, preview, dry-run/live send

## API (selected)

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/subscribe` | public |
| `POST` | `/api/admin/login` | password |
| `GET` | `/api/admin/subscribers` | admin cookie |
| `GET/POST/PATCH` | `/api/admin/issues` | admin cookie |
| `POST` | `/api/admin/issues/:id/send` | admin cookie |
| `GET/POST` | `/api/admin/transcripts` | admin cookie |

Also:

| Route | Purpose |
|--------|---------|
| `GET /health` | Health check |
| `GET /preview/:issueId` | Render issue in browser |
| `GET/POST /unsubscribe/:token` | One-click unsubscribe |
| `POST /cron/send` | Cron trigger (`CRON_SECRET` optional) |

## Railway deploy

1. Deploy this repo; attach Postgres.
2. Set env vars from `.env.example` (**include `ADMIN_PASSWORD`**).
3. Schema is applied automatically when the web service starts. Optional sample data:

```bash
npm run db:seed
```

4. Open your public URL to subscribe. Admin is unlisted at `/admin` (not linked from the site).
5. Optional cron service: `npm run start:send` on `0 15 * * 1`.

If you ever see `relation "subscribers" does not exist`, redeploy the web service (or run `npm run db:migrate` in Railway shell).

## Editorial workflow

1. Add **Transcripts** in Admin → Transcripts (or insert into `transcripts`).
2. Click **Propose topics** — Claude suggests digestible topics (deduped vs recent issues) with source grounding; weather/tides are autofilled for review.
3. Select topics → **Write selected topics** to create the draft issue. Or use **Quick draft** to skip the review step.
4. Run **AI fact-check** on the draft (verifies names/details against transcript notes **and the public web** via Claude web search; can auto-correct).
5. Check the **editorial checklist**, use **Email me a preview**, then **Approve & schedule**.
6. Cron `POST /cron/send` delivers due `ready` issues.

Draft source priority: `transcripts` → discovered `%transcript%` / `%recording%` tables.

Weather: Open-Meteo (includes “as of” time). Tides: NOAA `9450460` (Ketchikan). Override with `MARINE_*` / `TIDE_STATION_ID`.

### Claude auto-write

Set on Railway:

```bash
AI_KEY=sk-ant-...          # preferred (underscore). AI-KEY also accepted.
AUTO_DRAFT_FROM_FINDINGS=true
# FINDINGS_BATCH_SIZE=6
```

Check `/health` → `aiKeyConfigured: true` after redeploy. If false, the key isn’t on the **web** service (or the name doesn’t match).

Drafting always uses **Claude Fable 5** (`claude-fable-5`) — the model is not configurable.

CLI:

```bash
npm run auto-draft
npm run generate -- --issue=<issue-uuid>
npm run send   # sends all due scheduled/ready issues
```

## Template tags

Merge tags use `{{key}}` or `{{key|fallback}}` (used for `{{first_name|neighbor}}`).

See `templates/ebb-and-flow.html`. The original bundler file `The Ebb and Flow.html` remains for design reference.
