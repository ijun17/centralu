/**
 * The oldest macOS each Mach-O file in a folder runs on, checked against the one the app supports.
 *
 *   node scripts/macos-minos.mjs <folder> [--max 11.0]
 *
 * Why: the deployment target is stated for the builds this repository runs (`MACOSX_DEPLOYMENT_TARGET`, Tauri's
 * `minimumSystemVersion`), but nothing states it for what it only copies: node-pty and better-sqlite3 arrive as
 * upstream prebuilds, and a newer SDK or a C dependency can raise a compiled file's target without any error. The
 * app would then fail to open on the older Macs. Every Mach-O file under the folder is read (`otool -l`, `minos` of
 * LC_BUILD_VERSION, `version` of LC_VERSION_MIN_MACOSX), the app and keeper, the `.node` add-ons, `spawn-helper`, the
 * keeper copy in the content folder and the shell included; a file that asks for more than `--max` is a problem.
 *
 * `build.yml` runs it on the bundle, `release-npm.mts` on the staged package. Dependency-free JavaScript.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isMain } from './is-main.mjs'

/** What the app is built for, and the most any file in it may ask for */
export const SUPPORTED_MACOS = '11.0'

/** Mach-O magic numbers, thin (either byte order, 32 or 64 bit) and fat */
const MAGIC = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'])

/** Whether the file starts with a Mach-O or fat header; a fat header's `cafebabe` is also a Java class, but there is none here */
export function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && MAGIC.has(head.toString('hex'))
  } finally {
    closeSync(fd)
  }
}

/** Every regular file under `dir` (links are not followed: a link into the bundle is the file it names), sorted */
export function filesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) found.push(...filesUnder(path))
    else if (stat.isFile()) found.push(path)
  }
  return found.sort()
}

/** The macOS versions `otool -l` output asks for, one per architecture of the file; empty when it names none */
export function minosOf(otool) {
  const versions = []
  let cmd = ''
  for (const line of otool.split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (key === 'cmd') cmd = value ?? ''
    else if (key === 'minos' && cmd === 'LC_BUILD_VERSION') versions.push(value)
    else if (key === 'version' && cmd === 'LC_VERSION_MIN_MACOSX') versions.push(value)
  }
  return versions
}

/** `a` before (negative), equal to (0) or after (positive) `b`, as dotted numbers: 11.0 equals 11.0.0 */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * What is wrong with the Mach-O files under `dir`: one line each for a file that asks for more than `max`, or that
 * names no minimum. `report` is called with every file read and its versions, for the log.
 */
export function minosProblems(dir, { max = SUPPORTED_MACOS, otool = (path) => execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }), report = () => {} } = {}) {
  const problems = []
  let seen = 0
  for (const path of filesUnder(dir)) {
    if (!isMachO(path)) continue
    seen++
    const name = relative(dir, path).split('\\').join('/')
    const versions = minosOf(otool(path))
    report(name, versions)
    if (!versions.length) problems.push(`${name} names no minimum macOS`)
    else if (versions.some((v) => compareVersions(v, max) > 0)) problems.push(`${name} needs macOS ${versions.join(', ')}, the app supports ${max}`)
  }
  if (!seen) problems.push(`no Mach-O file under ${dir}`)
  return problems
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--max')
  const max = at >= 0 ? args.splice(at, 2)[1] : SUPPORTED_MACOS
  const [dir] = args
  if (!dir || !max) {
    console.error('usage: node scripts/macos-minos.mjs <folder> [--max 11.0]')
    process.exit(2)
  }
  const problems = minosProblems(dir, { max, report: (name, versions) => console.log(`minos ${versions.join(', ') || 'none'}  ${name}`) })
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(problems.length ? 1 : 0)
}
