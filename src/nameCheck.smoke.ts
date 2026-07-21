import {
  buildStoryGroundingNotes,
  checkIssueNames,
  extractProperNames,
  nameAppearsInGrounding,
  scrubUngroundedNames,
} from "./nameCheck.js";
import type { Issue, Story } from "./types.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const names = extractProperNames(
  "Mayor Davey Davidson joined Councilmember Elena Ruiz at City Council."
);
assert(names.includes("Davey Davidson"), `expected Davey Davidson in ${names}`);
assert(names.includes("Elena Ruiz"), `expected Elena Ruiz in ${names}`);
assert(!names.some((n) => /city council/i.test(n)), "should ignore City Council");

const grounding = "TRANSCRIPT / SOURCE TEXT:\nMayor Davey Davidson spoke.";
assert(nameAppearsInGrounding("Davey Davidson", grounding), "name should match");
assert(!nameAppearsInGrounding("Elena Ruiz", grounding), "missing name should fail");

const issue = {
  subject: "Elena Ruiz leads vote",
  preheader: "",
  intro: "Neighbors heard from Elena Ruiz.",
  coming_up: [],
} as unknown as Issue;

const stories = [
  {
    position: 1,
    title: "Harbor plan",
    toc_title: "Harbor",
    eyebrow: "Local",
    summary: "Elena Ruiz backed the dock repair.",
    why_it_matters: "",
    quote: null,
    quote_attribution: null,
    source_notes: grounding,
  },
] as unknown as Story[];

const gate = checkIssueNames(issue, stories);
assert(!gate.ok, "gate should fail");
assert(
  gate.ungrounded.some((h) => h.name === "Elena Ruiz"),
  "Elena should be ungrounded"
);

const scrubbed = scrubUngroundedNames(
  {
    subject: issue.subject,
    preheader: "",
    intro: issue.intro,
    coming_up: [],
    stories: [
      {
        position: 1,
        toc_title: "Harbor",
        title: "Harbor plan",
        eyebrow: "Local",
        summary: "Elena Ruiz backed the dock repair.",
        why_it_matters: "",
        quote: null,
        quote_attribution: null,
      },
    ],
  },
  gate.ungrounded
);
assert(!/Elena Ruiz/i.test(scrubbed.stories[0].summary), "scrub should remove name");
assert(!/Elena Ruiz/i.test(scrubbed.subject), "scrub should remove from subject");

const built = buildStoryGroundingNotes("Dock vote 4-3", [
  {
    kind: "transcript",
    id: "1",
    sourceTable: "transcripts",
    title: "Council",
    content: "Mayor Davey Davidson said the docks need work.",
    meta: "",
    occurredAt: null,
    url: "",
    category: "Transcript",
  },
]);
assert(built.includes("TOPIC SUMMARY:"), "should include summary");
assert(built.includes("TRANSCRIPT / SOURCE TEXT:"), "should include raw");
assert(built.includes("Davey Davidson"), "should include raw name");

console.log("nameCheck.smoke ok");
