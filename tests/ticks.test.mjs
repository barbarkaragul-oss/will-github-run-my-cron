import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, ticksBetween, matchRuns, percentile, summarize } from '../src/ticks.mjs';

test('parseCron accepts hourly and daily, rejects the rest', () => {
  assert.deepEqual(parseCron('37 * * * *'), { kind: 'hourly', minute: 37 });
  assert.deepEqual(parseCron('0 6 * * *'), { kind: 'daily', minute: 0, hour: 6 });
  assert.throws(() => parseCron('0 6 * * 1'), /only hourly and daily/);
  assert.throws(() => parseCron('*/5 * * * *'), /bad minute/);
  assert.throws(() => parseCron('60 * * * *'), /bad minute/);
});

test('hourly ticks start at the first tick at or after from, end at or before to', () => {
  const t = ticksBetween('37 * * * *', '2026-09-15T09:00:00Z', '2026-09-15T12:00:00Z');
  assert.deepEqual(t, ['2026-09-15T09:37:00.000Z', '2026-09-15T10:37:00.000Z', '2026-09-15T11:37:00.000Z']);
  // from exactly on a tick includes it
  assert.equal(ticksBetween('0 * * * *', '2026-09-15T09:00:00Z', '2026-09-15T09:00:00Z').length, 1);
  // from just after the tick skips to the next hour
  assert.equal(ticksBetween('0 * * * *', '2026-09-15T09:00:01Z', '2026-09-15T09:59:59Z').length, 0);
});

test('daily ticks cross midnight correctly', () => {
  const t = ticksBetween('30 6 * * *', '2026-09-15T07:00:00Z', '2026-09-17T07:00:00Z');
  assert.deepEqual(t, ['2026-09-16T06:30:00.000Z', '2026-09-17T06:30:00.000Z']);
});

const ticks = ticksBetween('0 * * * *', '2026-09-15T09:00:00Z', '2026-09-15T13:00:00Z'); // 09,10,11,12,13
const now = '2026-09-16T12:30:00Z';
const settleMs = 24 * 3_600_000;

test('a run is matched to the most recent tick at or before its created_at, delay in seconds', () => {
  const runs = [
    { id: 1, created_at: '2026-09-15T09:00:12Z' },   // 12 s late
    { id: 2, created_at: '2026-09-15T10:47:00Z' },   // 47 min late
    { id: 3, created_at: '2026-09-15T12:00:00Z' },   // exactly on time
  ];
  const { slots, unmatched } = matchRuns(ticks, runs, { now, settleMs });
  assert.equal(unmatched.length, 0);
  assert.equal(slots[0].state, 'ran'); assert.equal(slots[0].delay_s, 12);
  assert.equal(slots[1].state, 'ran'); assert.equal(slots[1].delay_s, 47 * 60);
  assert.equal(slots[3].state, 'ran'); assert.equal(slots[3].delay_s, 0);
});

test('a tick with no run is dropped after the settle window and pending before it', () => {
  const { slots } = matchRuns(ticks, [], { now, settleMs });
  // 09:00, 10:00, 11:00, 12:00 on the 15th are > 24 h before now (16th 12:30); 13:00 is not
  assert.deepEqual(slots.map((s) => s.state), ['dropped', 'dropped', 'dropped', 'dropped', 'pending']);
});

test('two runs on the same tick keep the first and record the extra; a run before any tick is unmatched', () => {
  const runs = [
    { id: 5, created_at: '2026-09-15T11:05:00Z' },
    { id: 4, created_at: '2026-09-15T11:01:00Z' },
    { id: 9, created_at: '2026-09-15T08:59:00Z' },
  ];
  const { slots, unmatched } = matchRuns(ticks, runs, { now, settleMs });
  assert.equal(slots[2].run.id, 4);
  assert.equal(slots[2].delay_s, 60);
  assert.deepEqual(slots[2].extra_runs.map((r) => r.id), [5]);
  assert.deepEqual(unmatched.map((r) => r.id), [9]);
});

test('a run that arrives hours late lands on a later tick; the earlier tick counts as dropped', () => {
  // GitHub catching up at 14:03 for a 09:00 schedule is indistinguishable from a 3-minute-late 14:00
  // run, so it is scored as the latter and the README says so.
  const t = ticksBetween('0 * * * *', '2026-09-15T09:00:00Z', '2026-09-15T14:00:00Z');
  const { slots } = matchRuns(t, [{ id: 1, created_at: '2026-09-15T14:03:00Z' }], { now, settleMs });
  assert.equal(slots[0].state, 'dropped');
  assert.equal(slots[5].state, 'ran');
  assert.equal(slots[5].delay_s, 180);
});

test('percentile is nearest-rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([30, 10, 20], 50), 20);
});

test('summarize counts per canary, per UTC hour and overall', () => {
  const a = matchRuns(ticks, [
    { id: 1, created_at: '2026-09-15T09:00:30Z' },
    { id: 2, created_at: '2026-09-15T10:10:00Z' },
  ], { now, settleMs }).slots;
  const s = summarize([{ label: ':00', cron: '0 * * * *', file: 'canary-00.yml', slots: a }]);
  assert.equal(s.overall.expected, 5);
  assert.equal(s.overall.ran, 2);
  assert.equal(s.overall.dropped, 2);
  assert.equal(s.overall.pending, 1);
  assert.equal(s.overall.on_time_within_60s, 1);
  assert.equal(s.overall.within_5min, 1);
  assert.equal(s.overall.p50_delay_s, 30);
  assert.equal(s.overall.max_delay_s, 600);
  assert.equal(s.per_canary[0].label, ':00');
  const h10 = s.per_hour_utc.find((h) => h.hour === 10);
  assert.equal(h10.ran, 1); assert.equal(h10.p50_delay_s, 600);
});
