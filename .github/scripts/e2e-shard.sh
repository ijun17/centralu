#!/usr/bin/env bash
# One shard of the e2e suite, as the `e2e (webkit i/n)` and `e2e (chromium i/n)` jobs run it: the replay project's share
# of the tests, then every other project's, each cut by Playwright's `--shard` into n equal runs (E2E_REPLAY, e2e/engine.ts).
# One cut over all the projects put the replay's 60 tests, one worker deep, in a single shard (8 minutes of them on a slow
# runner), so that shard timed out while the others had room.
#
#   e2e-shard.sh <shard> <shards>
#
# Both runs happen even when the first fails, and the script fails when either did. Each keeps a blob report of its own
# name, in a folder of its own (a run empties the blob folder it starts in, so the second would delete the first's),
# which `e2e report` merges with the other shards'. The engine is E2E_BROWSER, set by the job.
set -u
shard="${1:?usage: e2e-shard.sh <shard> <shards>}"
shards="${2:?usage: e2e-shard.sh <shard> <shards>}"

status=0
for part in skip only; do
  name="report-$shard.zip"
  [ "$part" = only ] && name="report-$shard-replay.zip"
  E2E_REPLAY="$part" PLAYWRIGHT_BLOB_OUTPUT_DIR="blob-report/$part" PLAYWRIGHT_BLOB_OUTPUT_NAME="$name" \
    pnpm e2e --shard="$shard/$shards" --reporter=list,blob,./e2e/flaky-report.ts --trace=retain-on-failure || status=$?
done
exit "$status"
