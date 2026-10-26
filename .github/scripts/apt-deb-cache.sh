#!/usr/bin/env bash
# Moves the .deb files `playwright install-deps` downloads between apt's archive folder and a folder the
# workflow caches (#1592, #1597, on top of #1503).
#
# Why: `playwright install-deps` runs `apt-get update && apt-get install -y …`, about 140 packages (117 MB) from a
# mirror that took 244 to 893 s on bad days and timed out both tries of the install. With the .deb files of an earlier
# run in /var/cache/apt/archives, apt-get still reads the package lists from the network (small) but finds each
# package file locally, so the mirror's speed no longer decides the step. A package whose version moved since the
# cache was saved is downloaded alone: a stale or partial cache costs a few downloads, never a wrong install, because
# apt checks every file's size and hash against the lists.
#
#   apt-deb-cache.sh restore DIR   copy DIR/*.deb into /var/cache/apt/archives (a cache miss leaves DIR empty or absent)
#   apt-deb-cache.sh save DIR      copy /var/cache/apt/archives/*.deb into DIR, for the cache action to save, and
#                                  write count=<how many> to $GITHUB_OUTPUT
#
# Neither fails the job: a cache that cannot be filled or used leaves the install as slow as it was.
set -u

archives=${APT_ARCHIVES:-/var/cache/apt/archives}
sudo_cmd=${SUDO-sudo}
mode=${1:-}
dir=${2:-}
[ -n "$dir" ] && { [ "$mode" = restore ] || [ "$mode" = save ]; } || { echo "usage: $0 restore|save DIR" >&2; exit 2; }

count() { find "$1" -maxdepth 1 -name '*.deb' 2>/dev/null | wc -l | tr -d ' '; }

case "$mode" in
  restore)
    # A Docker-style image deletes each package after installing it; the runner images do not. Make sure of it.
    if [ -e /etc/apt/apt.conf.d/docker-clean ]; then
      echo "Removing /etc/apt/apt.conf.d/docker-clean, which would delete the packages after the install"
      $sudo_cmd rm -f /etc/apt/apt.conf.d/docker-clean || true
    fi
    echo "apt keeps downloaded packages: $(apt-config dump 2>/dev/null | grep -i 'Keep-Downloaded-Packages' || echo 'default (yes)')"
    if [ "$(count "$dir")" -gt 0 ]; then
      # shellcheck disable=SC2086 # $sudo_cmd is empty or one word
      $sudo_cmd cp -f "$dir"/*.deb "$archives"/ || echo "::warning::Could not copy the cached packages into $archives"
    fi
    echo "Cached packages: $(count "$dir"); $archives now holds $(count "$archives")"
    ;;
  save)
    mkdir -p "$dir"
    # The files are root's but world-readable; the copy is the runner user's, so the cache action can read it
    cp -f "$archives"/*.deb "$dir"/ 2>/dev/null || echo "::warning::No packages in $archives to cache"
    echo "Saved $(count "$dir") packages ($(du -sh "$dir" 2>/dev/null | cut -f1))"
    # The workflow saves the cache only when there is something in it: an empty entry under the key would be a hit
    # that restores nothing, for every later run of the same image
    [ -z "${GITHUB_OUTPUT:-}" ] || echo "count=$(count "$dir")" >> "$GITHUB_OUTPUT"
    ;;
esac
exit 0
