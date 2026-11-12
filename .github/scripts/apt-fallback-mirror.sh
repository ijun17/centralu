#!/usr/bin/env bash
# Points apt at package mirrors outside Canonical, for the try that follows one that failed (#2198).
#
# Why: on 2026-11-11 from about 14:39 to 17:00 UTC `azure.archive.ubuntu.com`, `archive.ubuntu.com` and `ports.ubuntu.com` timed
# out, and the runners' own list of mirrors (`/etc/apt/apt-mirrors.txt`) falls back only to other Canonical hosts. Every job
# that installs apt packages failed both tries, for 2.5 hours, and a mirror of another organization answered in about a second.
#
#   apt-fallback-mirror.sh   write the sources and the apt setting that makes every later `apt-get` of this machine use them
#
# What it writes: a list of mirrors (`fallback-mirrors.txt`, read by apt's `mirror+file:` method, which goes on to the next when one
# does not answer, as the runners' own list does, in the order given: OCF first), one sources file with the four pockets of the machine's Ubuntu release (release,
# -updates, -backports, -security) on that list, and one apt.conf.d snippet that replaces the machine's sources with that file (an
# `apt-get` started by `playwright install-deps` reads the snippet too, which is why this is a setting of the machine and not an option of
# one call). It stays for the rest of the job: a mirror that failed once is not asked again. Writing it twice changes nothing.
#
# The machine's other sources (`sources.list.d`) are switched off with it: Ubuntu's own are the ones that failed, and nothing that
# is installed on this path comes from another one. The packages of the three `apt-packages` lists (build.yml, release.yml) are all
# Ubuntu's (main or universe), and `playwright install-deps` installs Ubuntu's libraries and fonts. A package from another source would
# need that source listed here.
#
# Why a mirror cannot change what is installed: the sources name Ubuntu's archive keyring (`signed-by`), the keys the stock sources
# trust too, and apt checks every `InRelease` against it, then every package list and every .deb against the sizes and hashes
# in that signed file. A mirror that serves anything else fails `apt-get update` (a list) or the download (a .deb); it can be slow
# or behind, never wrong.
#
# The list only gets past a mirror that fails fast (refuses, or answers with an error): one that times out costs its full timeout for every file
# apt asks of it, so a later mirror helps with a dead host, not with a slow one.
#
# The mirrors are mirrors.ocf.berkeley.edu (the Open Computing Facility of UC Berkeley, the one that answered during the outage),
# mirrors.mit.edu and mirror.leaseweb.com: official Ubuntu mirrors that answer over HTTPS for both `ubuntu` (amd64) and `ubuntu-ports`
# (arm64). Probed on 2026-11-11 (`dists/noble-updates/InRelease` of each, the same 126125 bytes as Canonical's): of 13 mirrors, only these
# three answered for both (kernel.org redirects); the rest had no `ubuntu-ports` or did not answer. They differ in speed, not in what they carry.
#
# A machine it cannot name mirrors for, or write the setting on, is left as it is, with a warning: it never fails the step it runs in
# (build.yml runs it under `bash -e`, before the install that is the step's work).
#
# `SUDO` is how to write as root (default `sudo`, empty for a test), `APT_ETC` where apt's setting lives (default /etc/apt),
# `MIRRORS` the mirrors' base URLs, separated by white space (each the folder holding `ubuntu` and `ubuntu-ports`), `ARCH` and `CODENAME`
# what the machine is (default: dpkg's and /etc/os-release's answers), `KEYRING` the archive's keys.
set -eu

sudo_cmd=${SUDO-sudo}
etc=${APT_ETC:-/etc/apt}
mirrors=${MIRRORS:-https://mirrors.ocf.berkeley.edu https://mirrors.mit.edu https://mirror.leaseweb.com}
arch=${ARCH:-$(dpkg --print-architecture)}
codename=${CODENAME:-$(. /etc/os-release && echo "${VERSION_CODENAME:-}")}
keyring=${KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}
retry="the next try asks the same mirrors again"

case "$arch" in
  amd64) archive=ubuntu ;;
  arm64) archive=ubuntu-ports ;;
  *) echo "::warning::no fallback mirror for the architecture $arch: $retry"; exit 0 ;;
esac
[ -n "$codename" ] || { echo "::warning::the Ubuntu release is not known: $retry"; exit 0; }

list="$etc/fallback-mirrors.txt"
sources="$etc/fallback-mirror.list"
# The setting goes last: a write that fails before it leaves apt as it was. Each step is checked on its own, as `set -e` is off in a function called in `||`
# shellcheck disable=SC2086 # $sudo_cmd is empty or one word, $mirrors a list of words
write() {
  $sudo_cmd mkdir -p "$etc/apt.conf.d" || return 1
  # A priority on each: without one apt asks the mirrors in random order (apt-transport-mirror(1)), so the first named would not be the first asked
  n=0
  for base in $mirrors; do n=$((n + 1)); printf '%s/%s/\tpriority:%s\n' "$base" "$archive" "$n"; done | $sudo_cmd tee "$list" >/dev/null || return 1
  for pocket in "$codename" "$codename-updates" "$codename-backports" "$codename-security"; do
    echo "deb [signed-by=$keyring] mirror+file:$list $pocket main restricted universe multiverse"
  done | $sudo_cmd tee "$sources" >/dev/null || return 1
  printf 'Dir::Etc::sourcelist "%s";\nDir::Etc::sourceparts "-";\n' "$sources" | $sudo_cmd tee "$etc/apt.conf.d/99fallback-mirror" >/dev/null
}
write || { echo "::warning::the mirror setting could not be written to $etc: $retry"; exit 0; }
echo "apt now uses $(echo "$mirrors" | wc -w | tr -d ' ') mirror(s) for $archive ($codename), not Canonical's mirrors"
