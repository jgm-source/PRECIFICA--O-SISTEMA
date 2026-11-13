const buckets = new Map();

export function clearRateLimits() {
  buckets.clear();
}

function recentHits(key, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter(time => now - time < windowMs);
  buckets.set(key, recent);
  if (buckets.size > 5000) {
    for (const [bucketKey, times] of buckets) {
      if (!times.length) buckets.delete(bucketKey);
    }
  }
  return recent;
}

export function isLimited(key, limit, windowMs) {
  return recentHits(key, windowMs).length >= limit;
}

export function recordFailure(key, windowMs) {
  recentHits(key, windowMs).push(Date.now());
}
