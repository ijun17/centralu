import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A repository that came from somewhere (#407): a folder copied the way a zip extract lands, with
 * every program a git read could be talked into running planted in its own `.git`. Each program
 * leaves a marker file named after itself, so a test reads which ones ran.
 *
 * Planted: the `post-index-change`, `post-checkout` and `reference-transaction` hooks; a filter
 * driver with clean and smudge commands; a diff driver with textconv and an external command;
 * `core.fsmonitor`; and `gpg.program` with `log.showSignature`, against a commit that carries a
 * signature header. With `processFilter`, also a long-running filter process on `b.dat`: it does
 * not speak git's protocol, which makes the trusted read that reaches it fail, so it is opt-in.
 * The copy has a tracked file changed since the commit, tracked files whose stat data no longer
 * matches the index (so status has to hash them), an untracked file and an ignored one.
 *
 * The scripts are `sh`, which Git for Windows runs too, and every path in them is written with
 * forward slashes so its shell reads it as a path rather than as escapes.
 */
export type PlantedRepo = {
  /** The copied repository, the folder a person would add as a project */
  dir: string
  /** Everything this made, to remove afterwards */
  root: string
  /** The commit with the signature header, which changes a.txt */
  signed: string
  /** Names of the planted programs that ran, sorted */
  ran: () => string[]
}

const HOOKS = ['post-index-change', 'post-checkout', 'reference-transaction'] as const

export function plantedRepo(opts: { processFilter?: boolean } = {}): PlantedRepo {
  const root = mkdtempSync(join(tmpdir(), 'cc-planted-'))
  const src = join(root, 'src')
  const dir = join(root, 'copy')
  const markers = join(root, 'markers')
  const tools = join(root, 'tools')
  mkdirSync(src)
  mkdirSync(markers)
  mkdirSync(tools)
  const posix = (p: string) => p.replaceAll('\\', '/')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })

  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(src, 'a.txt'), 'hello\n')
  writeFileSync(join(src, 'c.txt'), 'unchanged\n')
  writeFileSync(join(src, '.gitattributes'), '*.txt filter=planted diff=planted\n')
  writeFileSync(join(src, '.gitignore'), 'ignored.log\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  // A commit with a signature header: `log.showSignature` hands it to `gpg.program` to verify
  writeFileSync(join(src, 'a.txt'), 'hello\nsigned\n')
  git('add', 'a.txt')
  const tree = git('write-tree').trim()
  const parent = git('rev-parse', 'HEAD').trim()
  const commit = [
    `tree ${tree}`,
    `parent ${parent}`,
    'author t <t@t> 1700000000 +0000',
    'committer t <t@t> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEzBAABCAAdFiEE',
    ' -----END PGP SIGNATURE-----',
    '',
    'signed',
    '',
  ].join('\n')
  const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: src, input: commit, encoding: 'utf8' }).trim()
  git('update-ref', 'refs/heads/main', signed)
  git('reset', '-q', '--hard')

  /*
   * A long-running filter process is the one driver kind status prefers over clean and smudge, so
   * it lives on a second driver that only `b.dat` uses — on the same driver it would hide whether
   * clean and smudge are turned off.
   */
  writeFileSync(join(src, '.gitattributes'), '*.txt filter=planted diff=planted\n*.dat filter=batch\n')
  writeFileSync(join(src, 'b.dat'), 'data\n')
  git('add', '.gitattributes', 'b.dat')
  git('commit', '-qm', 'batch')

  // Planted only now, so nothing above ran them
  const script = (name: string, body: string) => {
    const path = join(tools, `${name}.sh`)
    writeFileSync(path, `#!/bin/sh\nprintf ran > "${posix(join(markers, name))}"\n${body}\n`)
    chmodSync(path, 0o755)
    return posix(path)
  }
  git('config', 'filter.planted.clean', script('clean', 'cat'))
  git('config', 'filter.planted.smudge', script('smudge', 'cat'))
  git('config', 'diff.planted.textconv', script('textconv', 'cat "$1"'))
  git('config', 'diff.planted.command', script('extdiff', 'exit 0'))
  git('config', 'core.fsmonitor', script('fsmonitor', 'exit 1'))
  git('config', 'log.showSignature', 'true')
  git('config', 'gpg.program', script('gpg', 'exit 1'))
  for (const hook of HOOKS) {
    const path = join(src, '.git', 'hooks', hook)
    writeFileSync(path, `#!/bin/sh\nprintf ran > "${posix(join(markers, `hook-${hook}`))}"\n`)
    chmodSync(path, 0o755)
  }
  if (opts.processFilter) git('config', 'filter.batch.process', script('process', 'exit 1'))

  /*
   * The copy: new inodes and times, as a zip extract leaves them. `c.txt` and `b.dat` keep their
   * content and size, so status cannot tell from the size alone and hashes them, through their
   * filters. Then work on top.
   */
  cpSync(src, dir, { recursive: true })
  const later = new Date(Date.now() + 60_000)
  for (const name of ['c.txt', 'b.dat']) utimesSync(join(dir, name), later, later)
  writeFileSync(join(dir, 'a.txt'), 'hello\nsigned\nchanged in the copy\n')
  writeFileSync(join(dir, 'new.txt'), 'untracked\n')
  writeFileSync(join(dir, 'ignored.log'), 'ignored\n')
  if (readdirSync(markers).length > 0) throw new Error(`the fixture ran its own programs: ${readdirSync(markers).join(', ')}`)

  return { dir, root, signed, ran: () => readdirSync(markers).sort() }
}
