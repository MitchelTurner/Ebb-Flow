import type { AppConfig } from "./config.js";
import { sendDueNewsletters, type SendResult } from "./send.js";

/** Monday in JS Date#getUTCDay() */
export const WEEKLY_CRON_DAY_UTC = 1;
/** 15:00 UTC ≈ 7am AKST / 8am AKDT */
export const WEEKLY_CRON_HOUR_UTC = 15;
export const WEEKLY_CRON_MINUTE_UTC = 0;

export function msUntilNextWeeklyUtc(
  now = new Date(),
  dayOfWeek = WEEKLY_CRON_DAY_UTC,
  hourUtc = WEEKLY_CRON_HOUR_UTC,
  minuteUtc = WEEKLY_CRON_MINUTE_UTC
): number {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      minuteUtc,
      0,
      0
    )
  );
  const currentDow = next.getUTCDay();
  let daysAhead = (dayOfWeek - currentDow + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= now.getTime()) {
    daysAhead = 7;
  }
  next.setUTCDate(next.getUTCDate() + daysAhead);
  return Math.max(0, next.getTime() - now.getTime());
}

export type WeeklyCronResult = {
  ok: true;
  ranAt: string;
  results: SendResult[];
  message: string;
};

/**
 * Send any due scheduled/ready issues. Empty inbox is success for cron.
 */
export async function runWeeklySendCron(
  config: AppConfig
): Promise<WeeklyCronResult> {
  const ranAt = new Date().toISOString();
  try {
    const results = await sendDueNewsletters(config);
    return {
      ok: true,
      ranAt,
      results,
      message: `Sent ${results.length} due issue(s).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no due ready issues/i.test(message)) {
      return {
        ok: true,
        ranAt,
        results: [],
        message: "No due ready issues to send.",
      };
    }
    throw err;
  }
}

/** Schedule weekly send inside the long-running web process. */
export function startWeeklyCronScheduler(config: AppConfig): void {
  if (!config.weeklyCronEnabled) {
    console.log("Weekly cron scheduler disabled (WEEKLY_CRON_ENABLED=false).");
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextWeeklyUtc();
    const nextAt = new Date(Date.now() + delay).toISOString();
    console.log(
      `Weekly send cron armed for ${nextAt} (Mondays ${String(WEEKLY_CRON_HOUR_UTC).padStart(2, "0")}:${String(WEEKLY_CRON_MINUTE_UTC).padStart(2, "0")} UTC).`
    );
    setTimeout(async () => {
      try {
        const result = await runWeeklySendCron(config);
        console.log(`Weekly cron: ${result.message}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Weekly cron failed: ${message}`);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}
