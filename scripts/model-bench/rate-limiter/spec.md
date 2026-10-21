# Task: sliding-window rate limiter

Implement `src/limiter.mjs` (plain Node.js ES module, no dependencies) exporting a class
`RateLimiter`.

```js
const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: () => clock });
rl.allow(key)       // -> { allowed: boolean, remaining: number, retryAfterMs: number }
rl.reset(key)       // forget one key
```

Rules:
1. A key may make at most `limit` allowed calls in any rolling window of `windowMs`
   milliseconds (sliding log, not fixed buckets).
2. A call exactly `windowMs` after an earlier allowed call no longer counts that earlier call.
3. Denied calls are not counted.
4. `remaining` is how many more calls would be allowed right now AFTER this call.
5. `retryAfterMs` is 0 when allowed; when denied, the milliseconds until the oldest counted
   call leaves the window.
6. Keys are independent. `reset(key)` only affects that key.
7. `now` is optional and defaults to `Date.now`; time read from it must never go backwards in
   your bookkeeping (if the clock moves backwards, treat it as the last time seen).
8. The constructor throws a `RangeError` when `limit` is not a positive integer or `windowMs`
   is not a positive number.
9. Memory per key stays bounded by `limit` entries.

Write only `src/limiter.mjs`. Do not add test files or dependencies. When done, stop.
