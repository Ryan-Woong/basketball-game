/* Small abuse-protection helpers (pure, injectable clock for tests). */

/** Token bucket: `capacity` burst, refilled at `refillPerSec`. take() -> true if allowed. */
function createRateLimiter({ capacity = 30, refillPerSec = 10, now = Date.now } = {}) {
    let tokens = capacity, last = now();
    return {
        take(cost = 1) {
            const t = now();
            tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
            last = t;
            if (tokens >= cost) { tokens -= cost; return true; }
            return false;
        },
    };
}

/** Counts events inside a sliding window. blocked() once `max` events happened within `windowMs`. */
function createWindowCounter(max, windowMs, now = Date.now) {
    let stamps = [];
    const prune = () => { const t = now(); stamps = stamps.filter(s => t - s < windowMs); };
    return {
        record() { prune(); stamps.push(now()); },
        blocked() { prune(); return stamps.length >= max; },
    };
}

module.exports = { createRateLimiter, createWindowCounter };
