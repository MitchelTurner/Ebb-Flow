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
  scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- Existing DBs may predate scheduled_for.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

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
  source_notes TEXT NOT NULL DEFAULT '',
  finding_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, position)
);

ALTER TABLE stories ADD COLUMN IF NOT EXISTS source_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE stories ADD COLUMN IF NOT EXISTS finding_id UUID;

-- Raw newer database findings / tips that Claude turns into drafts.
CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_in_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transcripts Claude analyzes into newsletter story drafts.
-- If a transcripts table already exists (different schema), CREATE is skipped
-- and the ALTERs below add any missing app columns without wiping data.
CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_in_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing transcripts/findings tables may predate app columns.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker TEXT NOT NULL DEFAULT '';
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS used_in_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE findings ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
ALTER TABLE findings ADD COLUMN IF NOT EXISTS found_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE findings ADD COLUMN IF NOT EXISTS used_in_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Tracks which external/source rows have already been drafted into an issue
-- (used for discovered transcript tables that lack used_in_issue_id).
CREATE TABLE IF NOT EXISTS source_usage (
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
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

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'doing', 'done')),
  due_date DATE,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pending topic proposals (review before Claude writes full copy).
CREATE TABLE IF NOT EXISTS topic_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'discarded')),
  sources JSONB NOT NULL DEFAULT '[]',
  topics JSONB NOT NULL DEFAULT '[]',
  marine JSONB NOT NULL DEFAULT '{}',
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_issues_status_date ON issues (status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_issues_scheduled
  ON issues (scheduled_for)
  WHERE status = 'ready' AND scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_issue_position ON stories (issue_id, position);
CREATE INDEX IF NOT EXISTS idx_findings_unused ON findings (found_at DESC) WHERE used_in_issue_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_transcripts_unused ON transcripts (recorded_at DESC) WHERE used_in_issue_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_usage_issue ON source_usage (issue_id);
CREATE INDEX IF NOT EXISTS idx_sends_issue ON sends (issue_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, due_date NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_topic_proposals_pending
  ON topic_proposals (created_at DESC)
  WHERE status = 'pending';
