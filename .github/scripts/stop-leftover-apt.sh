#!/usr/bin/env bash
# Stops what a `playwright install-deps` that hit its time limit left running (#1503, review of #1505).
#
# The runner kills the step's own process tree, but `playwright install-deps` starts the install as
# `sudo sh -c "apt-get update && apt-get install …"`, and the apt-get of that stays alive as root, holding
# dpkg's `lock-frontend` and `lock`, still unpacking. A second try started at once finds "dpkg frontend lock
# was locked by another process" and fails exactly when the mirror was slow. So before the second try: ask
# what is left to stop (SIGTERM), wait for it to go, force it (SIGKILL) if it does not, and leave the locks free.
#
# The names are what to stop (default apt-get, apt, dpkg); `SUDO` is how to signal a process of root's
# (default `sudo`, empty for a test that starts its own stand-ins); `WAIT` is how many seconds to wait for each signal.
set -u

names=("$@")
[ "${#names[@]}" -gt 0 ] || names=(apt-get apt dpkg)
sudo_cmd=${SUDO-sudo}
wait=${WAIT:-30}

running() {
  for name in "${names[@]}"; do
    pgrep -x "$name" >/dev/null 2>&1 && return 0
  done
  return 1
}

signal() {
  for name in "${names[@]}"; do
    # shellcheck disable=SC2086 # $sudo_cmd is empty or one word
    $sudo_cmd pkill "-$1" -x "$name" >/dev/null 2>&1 || true
  done
}

waited() {
  for _ in $(seq 1 "$wait"); do
    running || return 0
    sleep 1
  done
  ! running
}

if running; then
  echo "A try that hit its limit left ${names[*]} running: stopping it"
  signal TERM
  if ! waited; then
    echo "It did not stop in ${wait}s: killing it"
    signal KILL
    waited || { echo "::error::${names[*]} is still running"; exit 1; }
  fi
fi
echo "No apt-get or dpkg is running: the package locks are free"
