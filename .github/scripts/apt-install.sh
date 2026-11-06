#!/usr/bin/env bash
# Installs apt packages so that a slow or stuck mirror costs a retry, not the job (2026-11-05: `keeper e2e (linux)` sat
# in `sudo apt-get update && apt-get install …` until its 20-minute limit, on main and in a merge batch, and the queue
# read a cancelled job as "no failed job"; #1503, #1592, #1597, #1603 were the same mirror).
#
#   apt-install.sh PACKAGE...
#
# Each try is `apt-get update && apt-get install -y PACKAGE...` under a time limit (TRY_SECONDS, 180), and apt itself gives up
# on a connection that says nothing for 30 s (Acquire::*::Timeout) and retries a download twice. A try that fails or hits the
# limit is followed by one more (TRIES, 2): first what the timed-out one left running is stopped, since `timeout` ends `sudo`
# and the root `apt-get` under it can go on holding dpkg's locks (stop-leftover-apt.sh, #1503), then dpkg is put right.
# The .deb files an earlier try downloaded stay in apt's archive folder, so the second try fetches only what is left. Both
# tries failing exits 1, in a step the caller limits again (`timeout-minutes`): the step's name is what the merge queue reads
# (an install step that fails or times out is the runner's or the mirror's, not the commit's: run-failure.mjs `isSetupStep`).
#
# `SUDO` is how to run as root (default `sudo`, empty for a test with stand-ins), `TRIES` and `TRY_SECONDS` as above, `RECOVER`
# the command that puts the machine right between two tries (default: stop-leftover-apt.sh, then `dpkg --configure -a`; a test
# gives its own, since the default stops every apt-get and dpkg of the machine by name).
set -u

[ "$#" -gt 0 ] || { echo "usage: $0 PACKAGE..." >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sudo_cmd=${SUDO-sudo}
tries=${TRIES:-2}
limit=${TRY_SECONDS:-180}

try() {
  # shellcheck disable=SC2086 # $sudo_cmd is empty or one word
  timeout --kill-after=15 "$limit" $sudo_cmd env DEBIAN_FRONTEND=noninteractive sh -c '
    set -e
    net="-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2"
    apt-get $net update
    apt-get $net install -y "$@"
  ' apt-install "$@"
}

for n in $(seq 1 "$tries"); do
  if [ "$n" -gt 1 ]; then
    if [ -n "${RECOVER:-}" ]; then
      sh -c "$RECOVER" || true
    else
      bash "$here/stop-leftover-apt.sh" || true
      # shellcheck disable=SC2086
      $sudo_cmd dpkg --configure -a || true
    fi
  fi
  echo "apt try $n of $tries (limit ${limit}s): $*"
  start=$SECONDS
  if try "$@"; then
    echo "Installed in $((SECONDS - start)) s (try $n)"
    exit 0
  fi
  echo "::warning::apt try $n of $tries failed or hit its ${limit}s limit after $((SECONDS - start)) s"
done
echo "::error::the packages could not be installed in $tries tries of ${limit}s: the package mirror is slow or down"
exit 1
