import { checkIssueNames } from "./nameCheck.js";
import type { Issue, Story } from "./types.js";

export type ChecklistItem = {
  id: string;
  label: string;
  pass: boolean;
  required: boolean;
};

export type EditorialChecklist = {
  ok: boolean;
  items: ChecklistItem[];
};

/** Gate schedule/send until the issue is editorially ready. */
export function buildEditorialChecklist(
  issue: Issue,
  stories: Story[]
): EditorialChecklist {
  const nameGate = checkIssueNames(issue, stories);

  const items: ChecklistItem[] = [
    {
      id: "subject",
      label: "Subject line set",
      pass: Boolean(issue.subject?.trim()) && !/— draft /i.test(issue.subject),
      required: true,
    },
    {
      id: "intro",
      label: "Intro written",
      pass: Boolean(issue.intro?.trim()),
      required: true,
    },
    {
      id: "stories",
      label: "At least 3 stories",
      pass: stories.length >= 3,
      required: true,
    },
    {
      id: "story_copy",
      label: "Stories have summaries",
      pass:
        stories.length > 0 &&
        stories.every((s) => Boolean(s.summary?.trim()) && Boolean(s.title?.trim())),
      required: true,
    },
    {
      id: "grounding",
      label: "Every story has transcript / uploaded context grounding",
      pass:
        stories.length > 0 && stories.every((s) => Boolean(s.source_notes?.trim())),
      required: true,
    },
    {
      id: "names",
      label: nameGate.ok
        ? "Person names match grounding (notes + uploads)"
        : `Person names match grounding (${nameGate.ungrounded.length} unsupported)`,
      pass: stories.length > 0 && nameGate.ok,
      required: true,
    },
    {
      id: "weather",
      label: "Weather filled",
      pass: Boolean(issue.weather?.trim()),
      required: true,
    },
    {
      id: "tides",
      label: "High & low tides filled",
      pass: Boolean(issue.high_tides?.trim()) && Boolean(issue.low_tides?.trim()),
      required: true,
    },
    {
      id: "high_tide_label",
      label: "High tide label filled",
      pass: Boolean(issue.high_tide_label?.trim()),
      required: true,
    },
    {
      id: "fact_review",
      label: "Editor confirmed fact-check (after AI scrub)",
      pass: Boolean(issue.fact_reviewed_at) && nameGate.ok,
      required: true,
    },
  ];

  return {
    ok: items.filter((i) => i.required).every((i) => i.pass),
    items,
  };
}
