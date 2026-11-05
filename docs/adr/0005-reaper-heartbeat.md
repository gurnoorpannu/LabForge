# ADR-0005: Reaper liveness via a Postgres heartbeat, not a Pushgateway

**Status:** accepted

## Context
The reaper is a CronJob: each run lives for about a second, so Prometheus can't scrape
it. `ReaperStale` needs "when did the reaper last succeed?".

## Decision
The reaper upserts a row in `heartbeats` (`last_success`, cumulative `total` reaped) after a
fully successful run. The API reads it at scrape time and exports
`labforge_reaper_last_success_timestamp_seconds` and `labforge_labs_reaped_total`.

## Alternatives
- **Pushgateway:** one more stateful component to run, secure and monitor, and stale pushes
  linger after the job is gone, which is the opposite of what a staleness alert needs.
- **kube-state-metrics `kube_cronjob_status_last_successful_time`:** counts the Job's exit
  code only; our heartbeat is written only when every deletion *and* the DB bookkeeping
  succeeded, which is the success that matters.

## Consequences
No new component; the signal lives with the data. If Postgres is down the heartbeat stops
and `ReaperStale` fires, which is correct: bookkeeping is broken (deletions still happen).
