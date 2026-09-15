// Pure functions: which runs a schedule should have produced, which it did, and how late.
//
// A "tick" is one moment a cron expression asked for. GitHub does not record ticks anywhere; it
// only records the runs it actually created. So the ticks are computed here from the cron
// expression and a window, and each run is matched to the most recent tick at or before the
// run's own created_at. The difference is the delay. A tick with no run is dropped once enough
// time has passed for a late run to have shown up (settle window), and pending before that.
//
// Only the two shapes the canaries use are supported: hourly ("M * * * *") and daily
// ("M H * * *"), both in UTC, which is what GitHub uses for schedules.

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`unsupported cron (need 5 fields): ${expr}`);
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') {
    throw new Error(`only hourly and daily crons are supported: ${expr}`);
  }
  const minute = Number(min);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`bad minute in cron: ${expr}`);
  if (hour === '*') return { kind: 'hourly', minute };
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`bad hour in cron: ${expr}`);
  return { kind: 'daily', minute, hour: h };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Every tick t of `expr` with from <= t <= to, as ISO strings, ascending.
export function ticksBetween(expr, fromISO, toISO) {
  const c = parseCron(expr);
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('ticksBetween: bad date');
  const out = [];
  if (to < from) return out;
  const d = new Date(from);
  let t;
  if (c.kind === 'hourly') {
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), c.minute);
    if (t < from) t += HOUR;
    for (; t <= to; t += HOUR) out.push(new Date(t).toISOString());
  } else {
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), c.hour, c.minute);
    if (t < from) t += DAY;
    for (; t <= to; t += DAY) out.push(new Date(t).toISOString());
  }
  return out;
}

// runs: [{ id, created_at, ... }] for ONE canary, any order.
// Returns one record per tick, in tick order, plus runs that matched no tick.
export function matchRuns(ticks, runs, { now, settleMs }) {
  const nowMs = Date.parse(now);
  const tickMs = ticks.map((t) => Date.parse(t));
  const slots = ticks.map((tick) => ({ tick, state: 'pending', delay_s: null, run: null, extra_runs: [] }));
  const unmatched = [];

  const sorted = [...runs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const run of sorted) {
    const created = Date.parse(run.created_at);
    // latest tick <= created (binary search)
    let lo = 0, hi = tickMs.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tickMs[mid] <= created) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx === -1) { unmatched.push(run); continue; }
    const slot = slots[idx];
    const rec = { id: run.id, created_at: run.created_at, run_started_at: run.run_started_at ?? null,
                  conclusion: run.conclusion ?? null, html_url: run.html_url ?? null };
    if (slot.run === null) {
      slot.run = rec;
      slot.state = 'ran';
      slot.delay_s = Math.round((created - tickMs[idx]) / 1000);
    } else {
      slot.extra_runs.push(rec);
    }
  }

  for (const [i, slot] of slots.entries()) {
    if (slot.run !== null) continue;
    slot.state = nowMs - tickMs[i] >= settleMs ? 'dropped' : 'pending';
  }
  return { slots, unmatched };
}

// Nearest-rank percentile on an unsorted array of numbers. null when empty.
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

function stats(slots) {
  const ran = slots.filter((s) => s.state === 'ran');
  const delays = ran.map((s) => s.delay_s);
  return {
    expected: slots.length,
    ran: ran.length,
    dropped: slots.filter((s) => s.state === 'dropped').length,
    pending: slots.filter((s) => s.state === 'pending').length,
    on_time_within_60s: delays.filter((d) => d <= 60).length,
    within_5min: delays.filter((d) => d <= 300).length,
    p50_delay_s: percentile(delays, 50),
    p95_delay_s: percentile(delays, 95),
    max_delay_s: delays.length ? Math.max(...delays) : null,
  };
}

// perCanary: [{ label, cron, file, slots }]
export function summarize(perCanary) {
  const per_canary = perCanary.map((c) => ({ label: c.label, cron: c.cron, file: c.file, ...stats(c.slots) }));
  const all = perCanary.flatMap((c) => c.slots);
  const per_hour_utc = [];
  for (let h = 0; h < 24; h++) {
    const hourSlots = all.filter((s) => new Date(s.tick).getUTCHours() === h);
    if (hourSlots.length) per_hour_utc.push({ hour: h, ...stats(hourSlots) });
  }
  const per_weekday_utc = [];
  for (let w = 0; w < 7; w++) {
    const daySlots = all.filter((s) => new Date(s.tick).getUTCDay() === w);
    if (daySlots.length) per_weekday_utc.push({ weekday: w, ...stats(daySlots) });
  }
  return { overall: stats(all), per_canary, per_hour_utc, per_weekday_utc };
}
