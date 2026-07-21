/** Tiny in-memory sliding window rate limiter (per-process). */

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export function rateLimit(params: {
  key: string;
  limit: number;
  windowMs: number;
}): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(params.key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter(
    (ts) => now - ts < params.windowMs
  );
  if (bucket.timestamps.length >= params.limit) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((params.windowMs - (now - oldest)) / 1000)
    );
    buckets.set(params.key, bucket);
    return { ok: false, retryAfterSec };
  }
  bucket.timestamps.push(now);
  buckets.set(params.key, bucket);
  return { ok: true };
}
