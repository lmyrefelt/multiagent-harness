export class RateLimiter {
	constructor({ limit, windowMs, now = Date.now } = {}) {
		if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("limit");
		if (!(typeof windowMs === "number" && windowMs > 0)) throw new RangeError("windowMs");
		this.limit = limit; this.windowMs = windowMs; this.now = now; this.log = new Map(); this.last = -Infinity;
	}
	t() { const n = this.now(); if (n > this.last) this.last = n; return this.last; }
	allow(key) {
		const t = this.t();
		const q = (this.log.get(key) ?? []).filter((x) => t - x < this.windowMs);
		if (q.length >= this.limit) { this.log.set(key, q); return { allowed: false, remaining: 0, retryAfterMs: q[0] + this.windowMs - t }; }
		q.push(t); this.log.set(key, q);
		return { allowed: true, remaining: this.limit - q.length, retryAfterMs: 0 };
	}
	reset(key) { this.log.delete(key); }
}
