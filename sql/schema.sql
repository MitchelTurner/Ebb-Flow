-- The Ebb & Flow newsletter schema (Railway Postgres)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'unsubscribed', 'bounced')),
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_date DATE NOT NULL,
  volume_label TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  weather TEXT NOT NULL DEFAULT '',
  high_tides TEXT NOT NULL DEFAULT '',
  low_tides TEXT NOT NULL DEFAULT '',
  high_tide_label TEXT NOT NULL DEFAULT '',
  coming_up TEXT[] NOT NULL DEFAULT '{}',
  cta_url TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT 'Read the full stories →',
  tip_headline TEXT NOT NULL DEFAULT 'Got a tip or a story we missed?',
  tip_body TEXT NOT NULL DEFAULT 'Just hit reply — every message reaches the newsroom directly.',
  postal_address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'sending', 'sent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position BETWEEN 1 AND 6),
  toc_title TEXT NOT NULL,
  title TEXT NOT NULL,
  eyebrow TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  why_it_matters TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  quote TEXT,
  quote_attribution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, position)
);

CREATE TABLE IF NOT EXISTS sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_issues_status_date ON issues (status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_stories_issue_position ON stories (issue_id, position);
CREATE INDEX IF NOT EXISTS idx_sends_issue ON sends (issue_id);
