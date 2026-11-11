#!/usr/bin/env bash
# Points apt at a package mirror outside Canonical, for the try that follows one that failed (#2198).
#
# Why: on 2026-11-11 from about 14:39 to 17:00 UTC `azure.archive.ubuntu.com`, `archive.ubuntu.com` and `ports.ubuntu.com` timed
# out, and the runners' own list of mirrors (`/etc/apt/apt-mirrors.txt`) falls back only to other Canonical hosts. Every job
# that installs apt packages failed both tries, for 2.5 hours, and a mirror of another organization answered in about a second.
#
#   apt-fallback-mirror.sh   write the sources and the apt setting that makes every later `apt-get` of this machine use them
#
# What it writes: one sources file with the four pockets of the machine's Ubuntu release (release, -updates, -backports,
# -security) on the mirror, and one apt.conf.d snippet that replaces the machine's sources with that file (an `apt-get` started
# by `playwright install-deps` reads the snippet too, which is why this is a setting of the machine and not an option of one
# call). It stays for the rest of the job: a mirror that failed once is not asked again. Writing it twice changes nothing.
#
# Why the mirror cannot change what is installed: the sources name Ubuntu's archive keyring (`signed-by`), the keys the stock sources
# trust too, and apt checks every `InRelease` against it, then every package list and every .deb against the sizes and hashes
# in that signed file. A mirror that serves anything else fails `apt-get update` (a list) or the download (a .deb); it can be slow
# or behind, never wrong.
#
# The mirror is mirrors.ocf.berkeley.edu (the Open Computing Facility of UC Berkeley, an official Ubuntu mirror): the one that
# answered during the outage, over HTTPS, and it carries both architectures (`ubuntu` for amd64, `ubuntu-ports` for arm64).
# Probed on 2026-11-11 (`/ubuntu` and `/ubuntu-ports` `dists/noble-updates/InRelease`, both over HTTPS, the same 126125 bytes as Canonical's): of
# 13 mirrors, only this one, MIT and Leaseweb answered for both (kernel.org redirects); the rest had no `ubuntu-ports` or did
# not answer. They differ in speed, not in what they carry; this is the one with evidence from the outage. MIRROR names another.
#
# A machine it cannot name a mirror for is left as it is, with a warning: it never fails the step it runs in.
#
# `SUDO` is how to write as root (default `sudo`, empty for a test), `APT_ETC` where apt's setting lives (default /etc/apt),
# `MIRROR` the mirror's base URL (the folder holding `ubuntu` and `ubuntu-ports`), `ARCH` and `CODENAME` what the machine is (default: dpkg's
# and /etc/os-release's answers), `KEYRING` the archive's keys.
set -eu

sudo_cmd=${SUDO-sudo}
etc=${APT_ETC:-/etc/apt}
mirror=${MIRROR:-https://mirrors.ocf.berkeley.edu}
arch=${ARCH:-$(dpkg --print-architecture)}
codename=${CODENAME:-$(. /etc/os-release && echo "${VERSION_CODENAME:-}")}
keyring=${KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}

case "$arch" in
  amd64) archive=ubuntu ;;
  arm64) archive=ubuntu-ports ;;
  *) echo "::warning::no fallback mirror for the architecture $arch: the next try asks the same mirrors again"; exit 0 ;;
esac
[ -n "$codename" ] || { echo "::warning::the Ubuntu release is not known: the next try asks the same mirrors again"; exit 0; }

sources="$etc/fallback-mirror.list"
# shellcheck disable=SC2086 # $sudo_cmd is empty or one word
{
  $sudo_cmd mkdir -p "$etc/apt.conf.d"
  for pocket in "$codename" "$codename-updates" "$codename-backports" "$codename-security"; do
    echo "deb [signed-by=$keyring] $mirror/$archive $pocket main restricted universe multiverse"
  done | $sudo_cmd tee "$sources" >/dev/null
  printf 'Dir::Etc::sourcelist "%s";\nDir::Etc::sourceparts "-";\n' "$sources" | $sudo_cmd tee "$etc/apt.conf.d/99fallback-mirror" >/dev/null
}
echo "apt now uses $mirror/$archive ($codename), not Canonical's mirrors"
