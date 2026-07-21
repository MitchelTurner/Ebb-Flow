export type SubscriberStatus = "active" | "unsubscribed" | "bounced";
export type IssueStatus = "draft" | "ready" | "sending" | "sent";
export type SendStatus = "queued" | "sent" | "failed" | "skipped";
export type TaskStatus = "todo" | "doing" | "done";

export interface Subscriber {
  id: string;
  email: string;
  first_name: string | null;
  status: SubscriberStatus;
  unsubscribe_token: string;
  created_at?: string;
  updated_at?: string;
}

export interface Issue {
  id: string;
  issue_date: string;
  volume_label: string;
  subject: string;
  preheader: string;
  intro: string;
  weather: string;
  high_tides: string;
  low_tides: string;
  high_tide_label: string;
  coming_up: string[];
  cta_url: string;
  cta_label: string;
  tip_headline: string;
  tip_body: string;
  postal_address: string;
  status: IssueStatus;
  scheduled_for: string | null;
  /** Set when AI fact-check against transcripts last passed/applied. */
  fact_reviewed_at: string | null;
  created_at?: string;
  updated_at?: string;
  sent_at?: string | null;
}

export type FactReviewFinding = {
  severity: "error" | "warning";
  field: string;
  story_position: number | null;
  issue: string;
  evidence: string;
  suggestion: string;
  /** Public web source URL when the finding came from internet verification. */
  source_url?: string | null;
};

export interface Story {
  id: string;
  issue_id: string;
  position: number;
  toc_title: string;
  title: string;
  eyebrow: string;
  summary: string;
  why_it_matters: string;
  url: string;
  image_url: string | null;
  quote: string | null;
  quote_attribution: string | null;
  /** Raw reporter/editor notes Claude uses to draft polished copy. */
  source_notes: string;
  finding_id: string | null;
}

export interface Finding {
  id: string;
  title: string;
  body: string;
  source_url: string;
  category: string;
  found_at: string;
  used_in_issue_id: string | null;
  created_at?: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  due_date: string | null;
  issue_id: string | null;
  created_at?: string;
  updated_at?: string;
}

export type TemplateData = Record<string, string>;

export interface DashboardStats {
  active_subscribers: number;
  total_subscribers: number;
  draft_issues: number;
  ready_issues: number;
  open_tasks: number;
  unused_findings: number;
  unused_transcripts: number;
  scheduled_issues: number;
}

export type ProposalTopic = {
  key: string;
  selected: boolean;
  toc_title: string;
  title: string;
  eyebrow: string;
  summary: string;
  why_it_matters: string;
  source_notes: string;
  quote: string | null;
  quote_attribution: string | null;
};

export type ProposalSourceRef = {
  id: string;
  sourceTable: string;
  kind: string;
  title: string;
};

export type TopicProposal = {
  id: string;
  status: "pending" | "accepted" | "discarded";
  sources: ProposalSourceRef[];
  topics: ProposalTopic[];
  marine: {
    weather: string;
    high_tides: string;
    low_tides: string;
    high_tide_label: string;
    as_of?: string;
  };
  issue_id: string | null;
  created_at: string;
  updated_at: string;
};
