// Read every scheduled run of every canary back from the GitHub Actions API, match them to the
// ticks the crons asked for, and write the result under data/.
//
//   GITHUB_TOKEN=... node scripts/collect.mjs [--repo owner/name] [--now ISO]
//
// The token only needs to read Actions runs on this repository (the default GITHUB_TOKEN inside
// a workflow has that). Without a token the public API still answers, just with a low rate limit.
//
// Outputs (all deterministic, so a re-run without new runs produces no diff):
//   data/runs.json     every scheduled run seen, raw fields from the API
//   data/ticks.json    every tick with its state (ran / dropped / pending) and delay
//   data/summary.json  counts and delay percentiles per canary, per UTC hour, per weekday
import { readFileSync, writeFileSync } from 'node:fs';
import { ticksBetween, matchRuns, summarize } from '../src/ticks.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
const repo = flag('--repo', process.env.GITHUB_REPOSITORY);
if (!repo) { console.error('need --repo owner/name or GITHUB_REPOSITORY'); process.exit(2); }
const now = flag('--now', new Date().toISOString());
const token = process.env.GITHUB_TOKEN || '';

const config = JSON.parse(readFileSync('data/config.json', 'utf8'));
const settleMs = (config.settle_hours ?? 24) * 3_600_000;

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'will-github-run-my-cron collector',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// All scheduled runs of one workflow file since observe_from, newest page first, all pages.
async function scheduledRuns(file, sinceISO) {
  const since = sinceISO.slice(0, 10);
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const q = `event=schedule&per_page=100&page=${page}&created=%3E%3D${since}`;
    const d = await api(`/repos/${repo}/actions/workflows/${file}/runs?${q}`);
    const runs = d.workflow_runs ?? [];
    for (const r of runs) {
      if (r.created_at >= sinceISO) {
        out.push({
          id: r.id, created_at: r.created_at, run_started_at: r.run_started_at ?? null,
          updated_at: r.updated_at, status: r.status, conclusion: r.conclusion,
          html_url: r.html_url, head_branch: r.head_branch,
        });
      }
    }
    if (runs.length < 100) break;
  }
  return out;
}

const perCanary = [];
const rawRuns = [];
for (const c of config.canaries) {
  const runs = await scheduledRuns(c.file, config.observe_from);
  rawRuns.push(...runs.map((r) => ({ canary: c.label, file: c.file, ...r })));
  const ticks = ticksBetween(c.cron, config.observe_from, now);
  const { slots, unmatched } = matchRuns(ticks, runs, { now, settleMs });
  if (unmatched.length) console.error(`${c.label}: ${unmatched.length} run(s) before the first tick, ignored`);
  perCanary.push({ label: c.label, cron: c.cron, file: c.file, slots });
}

rawRuns.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.file.localeCompare(b.file));
const ticks = perCanary.flatMap((c) => c.slots.map((s) => ({ canary: c.label, ...s })))
  .sort((a, b) => a.tick.localeCompare(b.tick) || a.canary.localeCompare(b.canary));
const summary = summarize(perCanary);

const stamp = (obj) => JSON.stringify({ generated_at: now, repo, observe_from: config.observe_from,
  settle_hours: config.settle_hours ?? 24, ...obj }, null, 2) + '\n';
writeFileSync('data/runs.json', stamp({ runs: rawRuns }));
writeFileSync('data/ticks.json', stamp({ ticks }));
writeFileSync('data/summary.json', stamp(summary));

const o = summary.overall;
console.log(`${repo} since ${config.observe_from} as of ${now}`);
console.log(`ticks expected ${o.expected}: ran ${o.ran}, dropped ${o.dropped}, pending ${o.pending}`);
console.log(`delay p50 ${o.p50_delay_s ?? '-'}s  p95 ${o.p95_delay_s ?? '-'}s  max ${o.max_delay_s ?? '-'}s  (within 60s: ${o.on_time_within_60s}, within 5min: ${o.within_5min})`);
for (const c of summary.per_canary) {
  console.log(`  ${c.label}  expected ${c.expected}  ran ${c.ran}  dropped ${c.dropped}  pending ${c.pending}  p50 ${c.p50_delay_s ?? '-'}s  p95 ${c.p95_delay_s ?? '-'}s`);
}
