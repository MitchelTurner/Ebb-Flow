import assert from "node:assert/strict";
import {
  formatNeighborProof,
  isAllowedAnalyticsEvent,
} from "./analytics.js";

assert.equal(isAllowedAnalyticsEvent("page_view"), true);
assert.equal(isAllowedAnalyticsEvent("hack"), false);

const early = formatNeighborProof(4);
assert.match(early.proof_label, /early readers/i);

const crowd = formatNeighborProof(127);
assert.match(crowd.proof_label, /120\+/);

console.log("analytics.smoke ok");
