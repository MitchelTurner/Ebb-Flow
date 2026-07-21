import assert from "node:assert/strict";
import { bounceEmailsFromEvent } from "./webhooks.js";

assert.deepEqual(
  bounceEmailsFromEvent({
    type: "email.bounced",
    data: {
      to: ["bad@example.com"],
      bounce: { type: "Permanent" },
    },
  }),
  ["bad@example.com"]
);

assert.deepEqual(
  bounceEmailsFromEvent({
    type: "email.bounced",
    data: {
      to: ["soft@example.com"],
      bounce: { type: "Temporary" },
    },
  }),
  []
);

assert.deepEqual(
  bounceEmailsFromEvent({
    type: "email.complained",
    data: { to: ["spam@example.com"] },
  }),
  ["spam@example.com"]
);

console.log("webhooks.smoke ok");
