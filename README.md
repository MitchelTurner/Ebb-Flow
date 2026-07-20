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

4. Install and migrate:

```bash
npm install
npm run db:migrate
npm run db:seed
```

5. Run the web app:

```bash
npm run serve
# open http://localhost:3000        → subscribe
# open http://localhost:3000/admin  → manage
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
3. Run once in Railway shell:

```bash
npm run db:migrate
npm run db:seed
```

4. Open your public URL to subscribe. Admin is unlisted at `/admin` (not linked from the site).
5. Optional cron service: `npm run start:send` on `0 15 * * 1`.

## Editorial workflow

1. In Admin → **Emails**, create a draft issue and add up to 6 stories.
2. Track prep work in **Tasks**.
3. Preview the issue, set status to **ready**, then **Send now** (or wait for cron).
4. After send, status becomes `sent`.

## Template tags

Merge tags use `{{key}}` or `{{key|fallback}}` (used for `{{first_name|neighbor}}`).

See `templates/ebb-and-flow.html`. The original bundler file `The Ebb and Flow.html` remains for design reference.
