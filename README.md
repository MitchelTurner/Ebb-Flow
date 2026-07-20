# The Ebb & Flow — automated newsletter

Pulls issue + subscriber data from **Railway Postgres**, fills `templates/ebb-and-flow.html`, and sends via **Resend**. Includes a public subscribe page and password-protected admin for subscribers, email issues, and tasks.

## What you get

- Parameterized HTML email template
- Postgres schema: `subscribers`, `issues`, `stories`, `sends`, `tasks`
- Public subscribe page (`/`)
- Admin UI (`/admin`) — manage subscribers, draft/send emails, track tasks
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

- **Overview** — subscriber/issue/task counts
- **Subscribers** — add, reactivate, unsubscribe, delete
- **Emails** — create/edit issues + 6 stories, preview, dry-run/live send
- **Tasks** — todo / doing / done board for editorial work

## API (selected)

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/subscribe` | public |
| `POST` | `/api/admin/login` | password |
| `GET` | `/api/admin/subscribers` | admin cookie |
| `GET/POST/PATCH` | `/api/admin/issues` | admin cookie |
| `POST` | `/api/admin/issues/:id/send` | admin cookie |
| `GET/POST/PATCH` | `/api/admin/tasks` | admin cookie |

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

1. Add **Transcripts** (meeting / interview text) in Admin → Transcripts, or insert into the `transcripts` table. Short tip-style **Findings** are a fallback when no unused transcripts exist.
2. Claude Fable 5 **analyzes** the newest unused transcripts and auto-drafts a review issue that fills the email template (on boot, `/cron/auto-draft`, or Admin → Draft from newest transcripts).
3. In **Review & schedule**, preview the draft, edit if needed, then **Approve & schedule** a delivery time.
4. Cron `POST /cron/send` (or `npm run start:send`) delivers due `ready` issues when `scheduled_for` has passed.
5. After send, status becomes `sent`.

Draft source priority: `transcripts` table → other public tables named like `%transcript%` / `%recording%` → `findings`.

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
