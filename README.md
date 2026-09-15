<h1 align="center">Will GitHub run my cron?</h1>

<p align="center"><b>Scheduled GitHub Actions workflows, measured every hour: how late they run, and how often they do not run at all.</b></p>

Eight workflows in this repository ask GitHub to run them once an hour, each at a different minute, and do nothing else. A collector reads back from the Actions API when GitHub actually created each run and compares it with the minute that was asked for. The result is a public, continuously updated record of what a `schedule:` trigger really does.

## Why

GitHub's own documentation says this about the `schedule` event, and nothing more precise:

> The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs.
> High load times include the start of every hour.
> If the load is sufficiently high enough, some queued jobs may be dropped.
>
> — [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

"Can be delayed" and "may be dropped" are not numbers. People find the numbers out the hard way, one repository at a time, and then ask: [Github Actions doesnot run scheduled workflows](https://github.com/orgs/community/discussions/199267), [Unexpected delay in scheduled GitHub Actions workflows using cron](https://github.com/orgs/community/discussions/156282), [Cron Job doesn't run at 00:00](https://github.com/orgs/community/discussions/52477), [consistently delayed 8-14 hours, one day dropped entirely](https://github.com/orgs/community/discussions/201738). A dropped run leaves no trace: no run, no error, no notification. You only find out by looking.

This repository looks, every hour, and publishes what it sees.

It started as our own problem. Four sister projects ([AgentMatrix](https://github.com/barbarkaragul-oss/agentmatrix), [PrivacyMatrix](https://github.com/barbarkaragul-oss/privacymatrix), [Why didn't my job run?](https://github.com/barbarkaragul-oss/why-didnt-my-job-run), [Will it run on a Mac?](https://github.com/barbarkaragul-oss/will-it-run-on-a-mac)) each depend on a weekly schedule to keep their published data honest. On 2026-09-14 all four missed their first Monday slot: not late, absent. The Actions API reported zero scheduled runs, ever. We moved the minutes off the top of the hour on the strength of the sentence quoted above, then realised we were guessing. This is the measurement we wished existed.

## How it works

**The canaries.** `.github/workflows/canary-MM.yml`, one per minute: `:00`, `:05`, `:15`, `:17`, `:30`, `:37`, `:45`, `:53`. That mix covers the top of the hour the documentation warns about, the round minutes people actually type, and odd minutes nobody types. Each job runs for a few seconds and prints the time. The job's output is not the measurement.

**The measurement** is the run's `created_at` as recorded by GitHub, read back by [`scripts/collect.mjs`](scripts/collect.mjs) through the Actions API. For each canary the collector computes every *tick* the cron asked for since `observe_from` in [`data/config.json`](data/config.json), then matches each scheduled run to the most recent tick at or before its `created_at`:

| State | Meaning |
|---|---|
| `ran` | a run exists for this tick; `delay_s` is `created_at` minus the tick |
| `dropped` | no run, and the tick is older than the settle window (24 h) |
| `pending` | no run yet, but a late one could still arrive |

Delay is measured to the moment GitHub *created* the run, not to when a runner picked it up, because the question is whether GitHub honoured the schedule, not how busy the runner pool was. `run_started_at` is kept alongside for anyone who wants the other number.

**The outputs**, committed by [`collect.yml`](.github/workflows/collect.yml) four times a day:

- [`data/runs.json`](data/runs.json): every scheduled run seen, raw
- [`data/ticks.json`](data/ticks.json): every tick with its state and delay
- [`data/summary.json`](data/summary.json): counts and delay percentiles per canary, per UTC hour, per weekday

The collector itself is a scheduled workflow, so it is exposed to the very thing it measures. That cannot corrupt the data, because ticks are computed from the cron expressions rather than from when the collector ran; it can only make the update late. A cron on a server we control dispatches it if it has not run in two days.

Every decision the collector makes is a pure function in [`src/ticks.mjs`](src/ticks.mjs) with tests in [`tests/`](tests/): tick generation across hours and midnight, matching, the settle window, duplicate runs, percentiles.

## Limits

- **One account.** Everything here describes what GitHub did for this one personal account on the free plan, created in November 2025 (about ten months before the canaries started), with a dozen public repositories and no organisation. A discussion linked above wonders whether account age matters; one account cannot answer that. See below for how you can.
- **Hourly only, for now.** Daily crons at popular times (`0 0 * * *`, `0 6 * * *`) are the next canaries to add once the hourly picture is clear.
- **A very late run is scored against a later tick.** If GitHub creates the `09:00` run at `14:03`, the collector cannot tell that from a `14:00` run that was three minutes late, so it records a drop at `09:00` and a 180-second delay at `14:00`. This under-reports extreme delays and over-reports drops by the same amount. The raw runs are in `data/runs.json` if you want to score it differently.
- **The canaries can be disabled by GitHub.** In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days. The collector's commits are activity, so this should not happen; if it does, it will show up as every canary dropping at once, and the collector's own run history will say why.
- **Nothing here says why.** Whether delays come from load, from account tier, from anything else, is not something the outside can observe. This repository reports what happened, not the reason.

## Run your own canaries

The interesting comparisons need more than one account. Fork this repository, enable Actions on the fork, and let it run for a week; the collector will commit your `data/summary.json`. Open an issue here with a link to it and a line about the account (age, plan, organisation or personal), and it goes into a table that no single account can produce.

## Wrong?

If a tick is scored in a way you can show is wrong from the API's own data, open an issue with the run URL. The raw run wins, and the case becomes a test.

MIT.
