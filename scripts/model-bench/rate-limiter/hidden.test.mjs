// Hidden acceptance tests for the model benchmark - never shown to the model.
import { RateLimiter } from "./src/limiter.mjs";
let clock = 0;
const mk = (o = {}) => new RateLimiter({ limit: 3, windowMs: 1000, now: () => clock, ...o });
const tests = {
	"allows up to limit": () => { clock = 0; const r = mk(); return [1, 2, 3].every(() => r.allow("a").allowed) && !r.allow("a").allowed; },
	"remaining counts down": () => { clock = 0; const r = mk(); return r.allow("a").remaining === 2 && r.allow("a").remaining === 1 && r.allow("a").remaining === 0; },
	"sliding not fixed window": () => { clock = 0; const r = mk(); r.allow("a"); clock = 600; r.allow("a"); r.allow("a"); clock = 1000; const x = r.allow("a"); clock = 1100; const y = r.allow("a"); return x.allowed && !y.allowed; },
	"exact window boundary frees the call": () => { clock = 0; const r = mk({ limit: 1 }); r.allow("a"); clock = 999; const a = r.allow("a"); clock = 1000; const b = r.allow("a"); return !a.allowed && b.allowed; },
	"denied calls are not counted": () => { clock = 0; const r = mk({ limit: 1 }); r.allow("a"); clock = 500; r.allow("a"); r.allow("a"); clock = 1000; return r.allow("a").allowed; },
	"retryAfter when denied": () => { clock = 0; const r = mk(); r.allow("a"); clock = 300; r.allow("a"); r.allow("a"); clock = 400; const d = r.allow("a"); return !d.allowed && d.retryAfterMs === 600 && r.allow("b").retryAfterMs === 0; },
	"keys independent and reset": () => { clock = 0; const r = mk({ limit: 1 }); r.allow("a"); r.allow("b"); r.reset("a"); return r.allow("a").allowed && !r.allow("b").allowed; },
	"clock going backwards": () => { clock = 5000; const r = mk({ limit: 1 }); r.allow("a"); clock = 4000; const x = r.allow("a"); clock = 5999; const y = r.allow("a"); clock = 6000; const z = r.allow("a"); return !x.allowed && !y.allowed && z.allowed; },
	"validates arguments": () => { const bad = [{ limit: 0 }, { limit: 1.5 }, { limit: -1 }, { windowMs: 0 }, { windowMs: -5 }, { windowMs: NaN }]; return bad.every((o) => { try { mk(o); return false; } catch (e) { return e instanceof RangeError; } }); },
	"defaults to Date.now": () => { const r = new RateLimiter({ limit: 1, windowMs: 60000 }); return r.allow("x").allowed && !r.allow("x").allowed && r.allow("x").retryAfterMs > 59000; },
	"bounded memory": () => { clock = 0; const r = mk({ limit: 2 }); for (let i = 0; i < 5000; i++) { clock = i; r.allow("a"); } const heap = JSON.stringify(r, (k, v) => (v instanceof Map ? [...v] : v)); return heap.length < 2000; },
};
let passed = 0;
const results = {};
for (const [name, fn] of Object.entries(tests)) { let ok = false; try { ok = fn() === true; } catch { ok = false; } results[name] = ok; if (ok) passed++; }
console.log(JSON.stringify({ passed, total: Object.keys(tests).length, results }));
