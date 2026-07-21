import assert from "node:assert/strict";
import { msUntilNextWeeklyUtc, WEEKLY_CRON_DAY_UTC } from "./weeklyCron.js";

// From Monday 14:00 UTC → same Monday 15:00
const before = new Date(Date.UTC(2026, 6, 20, 14, 0, 0)); // Mon Jul 20 2026
assert.equal(before.getUTCDay(), WEEKLY_CRON_DAY_UTC);
const delayBefore = msUntilNextWeeklyUtc(before);
assert.equal(delayBefore, 60 * 60 * 1000);

// From Monday 16:00 UTC → next Monday
const after = new Date(Date.UTC(2026, 6, 20, 16, 0, 0));
const delayAfter = msUntilNextWeeklyUtc(after);
assert.equal(delayAfter, 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000);

console.log("weeklyCron.smoke ok");
