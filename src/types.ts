export type SubscriberStatus = "active" | "unsubscribed" | "bounced";
export type IssueStatus = "draft" | "ready" | "sending" | "sent";
export type SendStatus = "queued" | "sent" | "failed" | "skipped";

export interface Subscriber {
  id: string;
  email: string;
  first_name: string | null;
  status: SubscriberStatus;
  unsubscribe_token: string;
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
}

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
}

export type TemplateData = Record<string, string>;
