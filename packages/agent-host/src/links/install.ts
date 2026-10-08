import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { verifiedPackage, type RegistryOptions } from './registry.js'
import { lastLine, remoteScript, type RemoteRun, type RemoteSpec } from './tunnel.js'

/**
 * The hub's installer for a linked machine (docs/plans/remote-hub.md §10.2, phase 3 step 3): over the
 * same ssh as the link, and with nothing on the remote but a shell, `tar` and a way to download.
 *
 *   0. preflight   a script per shell reports what the machine is (`preflightCommand`); the hub
 *                  decides here whether it can install there (`preflight`), in one sentence if not
 *   1. Node        a script per shell downloads the pinned Node for that platform from nodejs.org,
 *                  checks it against the SHA-256 this release pinned (`remote-runtime.json`), unpacks
 *                  it with the system's tar and prunes it to the binary and its licence
 *   2. Centralu    `remote-install.mjs`, sent from here and run on that Node: both npm tarballs,
 *                  each checked against the integrity the hub read from signed registry metadata
 *                  (registry.ts), unpacked beside what is there, the managed launcher written once,
 *                  `current` and `previous` switched by rename, older versions removed
 *
 * The remote never trusts a value that travelled with the file it checks (plan §10.3). Every script
 * and value crosses the shells as base64 or as plain words, as tunnel.ts sends commands.
 */

/** `packaging/remote-runtime.json`, which the release copies beside the host's `main.mjs` */
export type RemoteRuntime = { node: { version: string; archives: Record<string, { file: string; sha256: string }> } }

export type RemotePlatform = 'linux-x64' | 'linux-arm64' | 'win32-x64'

/** What the preflight script reports (`CENTRALU-PREFLIGHT key=value …`) */
export type PreflightFacts = {
  os: string
  arch: string
  /** `getconf GNU_LIBC_VERSION`'s number; null where there is no glibc */
  glibc: string | null
  musl: boolean
  /** Free space where `<data>` is or would be, in KiB; null when unknown */
  freeKb: number | null
  tar: boolean
  gzip: boolean
  /** `curl`, `wget`, `iwr` (PowerShell's own), or null */
  fetch: string | null
  /** A SHA-256 tool, or null */
  sha: string | null
}

const PREFLIGHT = 'CENTRALU-PREFLIGHT'
export const STEP = 'CENTRALU-INSTALL'
/** The oldest glibc the published native modules load on (they reference GLIBC_2.34 symbols; plan §10.2) */
export const MIN_GLIBC = [2, 34] as const
/** Space a first install needs at its peak: downloads and unpacked folders side by side (plan §10.7), with room */
export const NEED_MB: Record<'linux' | 'win32', number> = { linux: 600, win32: 300 }

/** The data folder on the remote, in each shell: `CC_DATA_DIR`, else `~/.centralu` (serve.mjs's rule) */
export const DATA_SH = 'd="${CC_DATA_DIR:-$HOME/.centralu}"; r="$d/remote"'
export const DATA_PS = "$d = if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:USERPROFILE '.centralu' }; $r = Join-Path $d 'remote'"

const PREFLIGHT_SH = `${DATA_SH}
p="$d"; while [ ! -d "$p" ]; do p=$(dirname "$p"); done
musl=0; if ldd --version 2>&1 | grep -qi musl; then musl=1; fi
for f in /lib/ld-musl-*; do [ -e "$f" ] && musl=1; done
has() { command -v "$1" >/dev/null 2>&1 && echo 1 || echo 0; }
fetch=; if command -v curl >/dev/null 2>&1; then fetch=curl; elif command -v wget >/dev/null 2>&1; then fetch=wget; fi
sha=; if command -v sha256sum >/dev/null 2>&1; then sha=sha256sum; elif command -v shasum >/dev/null 2>&1; then sha=shasum; fi
echo "${PREFLIGHT} os=$(uname -s) arch=$(uname -m) glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p') musl=$musl freeKb=$(df -Pk "$p" 2>/dev/null | awk 'NR==2 {print $4}') tar=$(has tar) gzip=$(has gzip) fetch=$fetch sha=$sha"
`

const PREFLIGHT_PS = `${DATA_PS}
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$p = $d; while (-not (Test-Path $p)) { $p = Split-Path $p }
$free = try { [math]::Floor((New-Object IO.DriveInfo ([IO.Path]::GetPathRoot((Resolve-Path $p).Path))).AvailableFreeSpace / 1024) } catch { '' }
$tar = [int](Test-Path (Join-Path $env:SystemRoot 'System32\\tar.exe'))
$fetch = if (Test-Path (Join-Path $env:SystemRoot 'System32\\curl.exe')) { 'curl' } else { 'iwr' }
"${PREFLIGHT} os=Windows arch=$arch glibc= musl=0 freeKb=$free tar=$tar gzip=1 fetch=$fetch sha=Get-FileHash"
`

/** Step 0 in the remote's shell */
export function preflightCommand(spec: RemoteSpec): string {
  return remoteScript(spec, { sh: PREFLIGHT_SH, ps: PREFLIGHT_PS })
}

/** Reads the preflight line; throws when there is none */
export function parsePreflight(stdout: string): PreflightFacts {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(`${PREFLIGHT} `))
  if (!line) throw new Error('The remote did not answer the install check')
  const kv = new Map(line.slice(PREFLIGHT.length + 1).trim().split(/\s+/).map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] as const))
  const word = (k: string) => kv.get(k) || null
  const free = Number(kv.get('freeKb'))
  return {
    os: word('os') ?? '',
    arch: word('arch') ?? '',
    glibc: word('glibc'),
    musl: kv.get('musl') === '1',
    freeKb: kv.get('freeKb') && Number.isFinite(free) ? free : null,
    tar: kv.get('tar') === '1',
    gzip: kv.get('gzip') === '1',
    fetch: word('fetch'),
    sha: word('sha'),
  }
}

/**
 * Whether the hub can install on a machine like this, and for which published platform; otherwise
 * one sentence that says why not (plan S7), before anything is downloaded.
 */
export function preflight(f: PreflightFacts, runtime: RemoteRuntime): { ok: true; platform: RemotePlatform } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason })
  let platform: RemotePlatform
  if (f.os === 'Linux') {
    if (f.musl) return no('This Linux uses musl (Alpine and the like); Centralu runs on glibc 2.34 or later only')
    const arch = f.arch === 'x86_64' || f.arch === 'amd64' ? 'x64' : f.arch === 'aarch64' || f.arch === 'arm64' ? 'arm64' : null
    if (!arch) return no(`Centralu has no build for Linux on ${f.arch || 'this processor'}`)
    const [maj = 0, min = 0] = (f.glibc ?? '').split('.').map(Number)
    if (!f.glibc || maj < MIN_GLIBC[0] || (maj === MIN_GLIBC[0] && min < MIN_GLIBC[1])) {
      return no(`Centralu needs glibc ${MIN_GLIBC.join('.')} or later (Ubuntu 22.04, Debian 12, RHEL 9); this machine has ${f.glibc ? `glibc ${f.glibc}` : 'none that it reports'}`)
    }
    platform = `linux-${arch}`
  } else if (f.os === 'Windows') {
    if (f.arch !== 'AMD64') return no(`Centralu has no build for Windows on ${f.arch || 'this processor'}`)
    platform = 'win32-x64'
  } else {
    return no(`Installing from here is for Linux and Windows; on ${f.os || 'this system'}, install Centralu there (npm i -g centralu)`)
  }
  if (!runtime.node.archives[platform]) return no(`This Centralu pins no Node for ${platform}`)
  if (!f.tar) return no(platform === 'win32-x64' ? 'tar.exe is missing (it comes with Windows 10 1803 and later)' : 'tar is missing there; install it and try again')
  if (!f.gzip) return no('gzip is missing there; install it and try again')
  if (!f.fetch) return no('Neither curl nor wget is installed there; install one and try again')
  if (!f.sha) return no('No SHA-256 tool (sha256sum) is installed there; install coreutils and try again')
  const need = NEED_MB[platform === 'win32-x64' ? 'win32' : 'linux']
  if (f.freeKb !== null && f.freeKb < need * 1024) return no(`Installing needs about ${need} MB free there; ${Math.floor(f.freeKb / 1024)} MB is`)
  return { ok: true, platform }
}

const PLAIN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const SAFE_URL = /^https?:\/\/[0-9A-Za-z.:-]+(\/[0-9A-Za-z._~%/-]*)?$/

/** Step 1 in the remote's shell: the pinned Node, checked against its SHA-256 and pruned */
export function nodeCommand(spec: RemoteSpec, n: { version: string; url: string; sha256: string }): string {
  if (!PLAIN.test(n.version) || !SAFE_URL.test(n.url) || !/^[0-9a-f]{64}$/.test(n.sha256)) throw new Error('Not a Node archive to install')
  const sh = `${DATA_SH}; V="${n.version}"; n="$r/node/v$V"
say() { echo "${STEP} $*"; }
if [ -x "$n/bin/node" ] && "$n/bin/node" --version >/dev/null 2>&1; then say node ok; exit 0; fi
t="$r/.partial-node-$$"; trap 'rm -rf "$t"' EXIT
mkdir -p "$t/x" || { say fail mkdir; exit 1; }
if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$t/a" "${n.url}" || { say fail download node; exit 1; }
else wget -q -O "$t/a" "${n.url}" || { say fail download node; exit 1; }; fi
if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum "$t/a" | cut -d" " -f1); else h=$(shasum -a 256 "$t/a" | cut -d" " -f1); fi
[ "$h" = "${n.sha256}" ] || { say fail node_hash "$h"; exit 1; }
tar -xzf "$t/a" -C "$t/x" --strip-components 1 || { say fail unpack node; exit 1; }
mkdir -p "$t/keep/bin" && mv "$t/x/bin/node" "$t/keep/bin/node" || { say fail unpack node; exit 1; }
[ ! -f "$t/x/LICENSE" ] || mv "$t/x/LICENSE" "$t/keep/LICENSE"
"$t/keep/bin/node" --version >/dev/null 2>&1 || { say fail node_runs; exit 1; }
mkdir -p "$r/node" && rm -rf "$n" && mv "$t/keep" "$n" || { say fail place node; exit 1; }
say node ok
`
  const ps = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
${DATA_PS}; $n = Join-Path $r 'node\\v${n.version}'
function Say($s) { "${STEP} $s" }
if ((Test-Path (Join-Path $n 'node.exe'))) { Say 'node ok'; return }
$t = Join-Path $r ".partial-node-$PID"
try {
  New-Item -ItemType Directory -Force (Join-Path $t 'x') | Out-Null
  $a = Join-Path $t 'a.zip'
  $curl = Join-Path $env:SystemRoot 'System32\\curl.exe'
  if (Test-Path $curl) { & $curl -fsSL --retry 2 -o $a '${n.url}'; if ($LASTEXITCODE -ne 0) { throw 'download node' } }
  else { try { Invoke-WebRequest -UseBasicParsing '${n.url}' -OutFile $a } catch { throw 'download node' } }
  $h = (Get-FileHash -Algorithm SHA256 $a).Hash.ToLower()
  if ($h -ne '${n.sha256}') { throw "node_hash $h" }
  & (Join-Path $env:SystemRoot 'System32\\tar.exe') -xf $a -C (Join-Path $t 'x') --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw 'unpack node' }
  $k = Join-Path $t 'keep'; New-Item -ItemType Directory -Force $k | Out-Null
  Move-Item (Join-Path $t 'x\\node.exe') $k
  if (Test-Path (Join-Path $t 'x\\LICENSE')) { Move-Item (Join-Path $t 'x\\LICENSE') $k }
  & (Join-Path $k 'node.exe') --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'node_runs' }
  New-Item -ItemType Directory -Force (Join-Path $r 'node') | Out-Null
  if (Test-Path $n) { Remove-Item -Recurse -Force $n }
  Move-Item $k $n
  Say 'node ok'
} catch {
  $m = if ($_.Exception.Message) { $_.Exception.Message } else { "$_" }
  Say "fail $($m -replace '\\s+', ' ')"
} finally {
  if (Test-Path $t) { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }
}
`
  return remoteScript(spec, { sh, ps })
}

export type InstallParams = {
  version: string
  node: string
  platform: RemotePlatform
  /** Who installed it, for `install.json` */
  hub: string
  packages: { name: string; tarball: string; integrity: string }[]
  /** False: install beside and point nothing at it yet (an update switches after stopping the host) */
  activate?: boolean
}

/**
 * The update's later steps, run by the same `.mjs` on the Node `node` names (plan §10.5): write both
 * pointers as given, or remove what neither names. `version` is only checked as a word
 */
export type PointerParams = { action: 'pointers'; version: string; node: string; current: InstalledVersion | null; previous: InstalledVersion | null }
export type PruneParams = { action: 'prune'; version: string; node: string }

export type InstalledVersion = { version: string; node: string }

/**
 * Step 2 in the remote's shell: writes `remote-install.mjs` (gzip, then base64, so it fits one
 * PowerShell command line) beside the install and runs it on the pinned Node with `params` as one
 * base64 word.
 */
export function installCommand(spec: RemoteSpec, script: string, params: InstallParams | PointerParams | PruneParams): string {
  if (!PLAIN.test(params.version) || !PLAIN.test(params.node)) throw new Error('Not a version to install')
  const gz = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64')
  const arg = Buffer.from(JSON.stringify(params), 'utf8').toString('base64')
  const sh = `${DATA_SH}; f="$r/.install-$$.mjs"
mkdir -p "$r" && printf %s "${gz}" | base64 -d | gzip -dc > "$f" || { echo "${STEP} fail script"; exit 1; }
"$r/node/v${params.node}/bin/node" "$f" "${arg}"; c=$?; rm -f "$f"; exit $c
`
  const ps = `${DATA_PS}; $f = Join-Path $r ".install-$PID.mjs"
try {
  New-Item -ItemType Directory -Force $r | Out-Null
  $z = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('${gz}'))), [IO.Compression.CompressionMode]::Decompress)
  $o = [IO.File]::Create($f); $z.CopyTo($o); $o.Close(); $z.Close()
} catch { "${STEP} fail script"; return }
& (Join-Path $r 'node\\v${params.node}\\node.exe') $f '${arg}'
Remove-Item -Force $f -ErrorAction SilentlyContinue
`
  return remoteScript(spec, { sh, ps })
}

/** What an install did: the version now `current`, the one kept as `previous`, and what was removed */
export type InstallResult = {
  current: { version: string; node: string }
  previous: { version: string; node: string } | null
  /** With `activate: false`: what was placed beside (`current` and `previous` are then unchanged, and may be null) */
  installed?: InstalledVersion
  removed: string[]
  /** Folders that could not be removed (a Windows program still running from them) */
  left: string[]
}

/** The sentence for a step's failure code, for the person */
function failure(target: string, code: string, detail: string): string {
  switch (code) {
    case 'node_hash':
      return `The Node downloaded on ${target} does not match the SHA-256 this Centralu release pinned; nothing was installed`
    case 'integrity':
      return `${detail || 'A package'} downloaded on ${target} does not match the integrity the npm registry signed; nothing was installed`
    case 'download':
      return `${target} could not download ${detail || 'what it needs'}; check that it can reach nodejs.org and registry.npmjs.org`
    case 'busy':
      return `Another install is running on ${target}`
    case 'no_host':
      return `The package for ${detail} carries no host; this version cannot be installed on ${target}`
    case 'no_launcher':
      return `Centralu ${detail} predates installs from the app; install a newer version`
    case 'node_runs':
      return `The Node downloaded on ${target} does not run there`
    case 'missing':
      return `Centralu ${detail} is no longer installed on ${target}`
    case 'remove':
      return `What this computer installed on ${target} could not be removed: ${detail || 'no reason given'}`
    default:
      return `Installing on ${target} failed (${[code, detail].filter(Boolean).join(': ')})`
  }
}

/** The step's `CENTRALU-INSTALL` line: `<ok word> [json]`, or throws the sentence for its failure */
export function readStep(run: RemoteRun, ok: string, target: string): string {
  const line = run.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(`${STEP} `))
  if (!line) {
    const why = lastLine(run.stderr)
    throw new Error(`Installing on ${target} stopped without saying why${why ? `: ${why}` : run.code ? ` (exit ${run.code})` : ''}`)
  }
  const rest = line.slice(STEP.length + 1).trim()
  if (rest.startsWith('fail')) {
    const [, code = 'error', ...detail] = rest.split(' ')
    throw new Error(failure(target, code, detail.join(' ')))
  }
  if (!rest.startsWith(ok)) throw new Error(`Installing on ${target} answered something unexpected: ${rest.slice(0, 120)}`)
  return rest.slice(ok.length).trim()
}

export type InstallOptions = {
  /** Runs one command on the remote (`Tunnel.exec`) */
  exec: (command: string) => Promise<RemoteRun>
  spec: RemoteSpec
  /** For the sentences: the ssh target */
  target: string
  /** The Centralu version to install: the hub's own (plan §4) */
  version: string
  runtime: RemoteRuntime
  /** `remote-install.mjs`'s text (`installScript()`) */
  script: string
  registry?: RegistryOptions
  /** Where Node archives are downloaded from; tests serve one on loopback */
  nodeDist?: string
  /** Each step as it starts, for progress */
  onStep?: (step: 'preflight' | 'registry' | 'node' | 'centralu') => void
  /** False: install beside without switching `current` or removing anything (`machines.update`) */
  activate?: boolean
}

/** Steps 0 to 2 against one machine. Rejects with one sentence for the person */
export async function installRemote(o: InstallOptions): Promise<InstallResult> {
  o.onStep?.('preflight')
  const pf = preflight(parsePreflight((await o.exec(preflightCommand(o.spec))).stdout), o.runtime)
  if (!pf.ok) throw new Error(`Cannot install on ${o.target}: ${pf.reason}`)
  o.onStep?.('registry')
  const packages = await Promise.all([verifiedPackage('centralu', o.version, o.registry), verifiedPackage(`@centralu/${pf.platform}`, o.version, o.registry)])
  const archive = o.runtime.node.archives[pf.platform]!
  const nodeVersion = o.runtime.node.version
  o.onStep?.('node')
  const url = `${(o.nodeDist ?? 'https://nodejs.org/dist').replace(/\/+$/, '')}/v${nodeVersion}/${archive.file}`
  readStep(await o.exec(nodeCommand(o.spec, { version: nodeVersion, url, sha256: archive.sha256 })), 'node ok', o.target)
  o.onStep?.('centralu')
  const params: InstallParams = { version: o.version, node: nodeVersion, platform: pf.platform, hub: `${hostname()} (Centralu ${o.version})`, packages: packages.map(({ name, tarball, integrity }) => ({ name, tarball, integrity })), ...(o.activate === false ? { activate: false } : {}) }
  const done = readStep(await o.exec(installCommand(o.spec, o.script, params)), 'done', o.target)
  const r = JSON.parse(done) as InstallResult
  return { current: r.current, previous: r.previous ?? null, removed: r.removed ?? [], left: r.left ?? [], ...(r.installed ? { installed: r.installed } : {}) }
}

/** A file the host bundle carries beside `main.mjs` (bundle.mjs), or the source tree's copy while developing */
function bundled(name: string, source: string): string {
  for (const url of [new URL(`./${name}`, import.meta.url), new URL(source, import.meta.url)]) {
    const file = fileURLToPath(url)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  throw new Error(`${name} is missing from this host`)
}

/** The installer's step 2, as the hub sends it */
export function installScript(): string {
  return bundled('remote-install.mjs', './remote-install.mjs')
}

/** The Node remotes run, pinned by the release (plan §10.3) */
export function remoteRuntime(): RemoteRuntime {
  return JSON.parse(bundled('remote-runtime.json', '../../../../packaging/remote-runtime.json')) as RemoteRuntime
}
