import type { Os, OsChild, OsError } from './port.js'
import type { OsFamily } from './rules.js'

/**
 * What the in-memory OS must answer as the real one does (#1599, docs/plans/os-layer.md §7.1): each case runs on an
 * `Os` in a folder of its own and answers a value, or the code of what it threw. `want` is each family's answer, as
 * measured (Windows 11 with Node 22; Linux). `memory.test.ts` holds the in-memory OS to both families' answers on any
 * OS; `real.test.ts` holds the real OS, and the in-memory one as that OS's family, to the answer of the OS it runs on.
 */
/** `child` once it has written `ready` */
export function ready(child: OsChild): Promise<OsChild> {
  return new Promise((resolve, reject) => {
    let seen = ''
    child.stdout?.on('data', (d: Buffer) => {
      seen += String(d)
      if (seen.includes('ready')) resolve(child)
    })
    child.once('error', reject)
  })
}

export type Contract = {
  name: string
  want: Record<OsFamily, unknown>
  /** Needs the right to make a symlink, which a Windows account without Developer Mode lacks */
  symlinks?: boolean
  run(os: Os, root: string, ctx: ContractContext): unknown
}

export type ContractContext = {
  /**
   * Starts a program that runs until it is stopped, in `cwd`, and answers it once it runs: it writes `ready` to its
   * stdout. Windows starts holding a process's working folder only once the process itself has set it up, a moment
   * after its start is reported (`'spawn'`).
   */
  waiter(cwd: string): Promise<OsChild>
}

/** A value, or the error's code; a `Promise` is awaited */
export async function outcome(fn: () => unknown): Promise<unknown> {
  try {
    return await fn()
  } catch (e) {
    return { error: (e as OsError).code ?? String(e) }
  }
}

const both = (v: unknown) => ({ windows: v, posix: v })
const err = (code: string) => ({ error: code })

export const CONTRACT: Contract[] = [
  {
    name: 'a file written is read back, its size stated, and listed',
    want: both({ text: 'hé\n', size: 4, isFile: true, list: ['a.txt'] }),
    run(os, root) {
      const p = os.paths.path.join(root, 'a.txt')
      os.files.writeFileSync(p, 'hé\n')
      const st = os.files.statSync(p)
      return { text: os.files.readFileSync(p, 'utf8'), size: st.size, isFile: st.isFile(), list: os.files.readdirSync(root) }
    },
  },
  {
    name: 'refusals on missing paths, folders and files',
    want: {
      windows: [err('ENOENT'), err('EISDIR'), err('ENOTDIR'), err('ENOENT'), err('ENOENT'), err('EEXIST'), err('ENOENT')],
      posix: [err('ENOENT'), err('EISDIR'), err('ENOTDIR'), err('ENOTDIR'), err('ENOENT'), err('EEXIST'), err('ENOENT')],
    },
    async run(os, root) {
      const { join } = os.paths.path
      os.files.mkdirSync(join(root, 'd'))
      os.files.writeFileSync(join(root, 'f'), 'x')
      return [
        await outcome(() => os.files.readFileSync(join(root, 'missing'))),
        await outcome(() => os.files.readFileSync(join(root, 'd'))),
        await outcome(() => os.files.readdirSync(join(root, 'f'))),
        // A path through a file
        await outcome(() => os.files.statSync(join(root, 'f', 'x'))),
        await outcome(() => os.files.writeFileSync(join(root, 'nope', 'x'), '')),
        await outcome(() => os.files.mkdirSync(join(root, 'd'))),
        await outcome(() => os.files.mkdirSync(join(root, 'nope', 'deeper'))),
      ]
    },
  },
  {
    name: 'removing: each call on the wrong kind',
    want: {
      windows: [err('EPERM'), err('ENOENT'), err('ENOTEMPTY'), err('ERR_FS_EISDIR'), err('ENOENT'), 'ok', 'ok'],
      posix: [err('EISDIR'), err('ENOTDIR'), err('ENOTEMPTY'), err('ERR_FS_EISDIR'), err('ENOENT'), 'ok', 'ok'],
    },
    async run(os, root) {
      const { join } = os.paths.path
      os.files.mkdirSync(join(root, 'd'))
      os.files.writeFileSync(join(root, 'd', 'in'), '')
      os.files.writeFileSync(join(root, 'f'), '')
      const ok = (fn: () => void) => outcome(() => (fn(), 'ok'))
      return [
        await ok(() => os.files.unlinkSync(join(root, 'd'))),
        await ok(() => os.files.rmdirSync(join(root, 'f'))),
        await ok(() => os.files.rmdirSync(join(root, 'd'))),
        await ok(() => os.files.rmSync(join(root, 'd'))),
        await ok(() => os.files.rmSync(join(root, 'missing'))),
        await ok(() => os.files.rmSync(join(root, 'missing'), { force: true })),
        await ok(() => os.files.rmSync(join(root, 'd'), { recursive: true })),
      ]
    },
  },
  {
    name: 'renaming onto what is there',
    want: {
      windows: { fileOntoFile: 'ok', text: 'a', fileOntoDir: err('EPERM'), dirOntoEmptyDir: err('EPERM'), dirOntoFullDir: err('EPERM'), missing: err('ENOENT'), intoMissing: err('ENOENT') },
      posix: { fileOntoFile: 'ok', text: 'a', fileOntoDir: err('EISDIR'), dirOntoEmptyDir: 'ok', dirOntoFullDir: err('ENOTEMPTY'), missing: err('ENOENT'), intoMissing: err('ENOENT') },
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.writeFileSync(join(root, 'a'), 'a')
      f.writeFileSync(join(root, 'b'), 'b')
      f.mkdirSync(join(root, 'e1'))
      f.mkdirSync(join(root, 'e2'))
      f.mkdirSync(join(root, 'full'))
      f.writeFileSync(join(root, 'full', 'x'), '')
      f.mkdirSync(join(root, 'g'))
      const ok = (fn: () => void) => outcome(() => (fn(), 'ok'))
      return {
        fileOntoFile: await ok(() => f.renameSync(join(root, 'a'), join(root, 'b'))),
        text: f.readFileSync(join(root, 'b'), 'utf8'),
        fileOntoDir: await ok(() => f.renameSync(join(root, 'b'), join(root, 'e1'))),
        dirOntoEmptyDir: await ok(() => f.renameSync(join(root, 'e2'), join(root, 'e1'))),
        dirOntoFullDir: await ok(() => f.renameSync(join(root, 'g'), join(root, 'full'))),
        missing: await ok(() => f.renameSync(join(root, 'nope'), join(root, 'nope2'))),
        intoMissing: await ok(() => f.renameSync(join(root, 'b'), join(root, 'nope', 'b'))),
      }
    },
  },
  {
    name: 'claiming a name that is taken: exclusive write, hard link, exclusive copy',
    want: {
      windows: [err('EEXIST'), err('EEXIST'), err('EEXIST'), err('EPERM')],
      posix: [err('EEXIST'), err('EEXIST'), err('EEXIST'), err('EISDIR')],
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.writeFileSync(join(root, 'a'), 'a')
      f.writeFileSync(join(root, 'b'), 'b')
      f.mkdirSync(join(root, 'd'))
      return [
        await outcome(() => f.writeFileSync(join(root, 'a'), 'x', { flag: 'wx' })),
        await outcome(() => f.linkSync(join(root, 'a'), join(root, 'b'))),
        await outcome(() => f.copyFileSync(join(root, 'a'), join(root, 'b'), f.constants.COPYFILE_EXCL)),
        await outcome(() => f.copyFileSync(join(root, 'a'), join(root, 'd'))),
      ]
    },
  },
  {
    name: 'names in another case: one file on Windows, none on Linux; each realpath spells it its way',
    want: {
      windows: { read: 'x', native: 'Name.TXT', given: 'name.txt', list: ['Name.TXT'] },
      posix: { read: err('ENOENT'), native: err('ENOENT'), given: err('ENOENT'), list: ['Name.TXT'] },
    },
    async run(os, root) {
      const { join, basename } = os.paths.path
      os.files.writeFileSync(join(root, 'Name.TXT'), 'x')
      const other = join(root, 'name.txt')
      return {
        read: await outcome(() => os.files.readFileSync(other, 'utf8')),
        native: await outcome(() => basename(os.files.realpathNativeSync(other))),
        given: await outcome(() => basename(os.files.realpathSync(other))),
        list: os.files.readdirSync(root),
      }
    },
  },
  {
    name: 'a link to a folder: a link to lstat and to the listing, the folder through it, removed alone',
    want: both({ lstat: true, statDir: true, listed: { link: true, dir: false }, through: 'k', readlinkEnds: true, removed: 'ok', targetKept: true }),
    run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.mkdirSync(join(root, 't'))
      f.writeFileSync(join(root, 't', 'in'), 'k')
      f.symlinkSync(join(root, 't'), join(root, 'l'), 'junction')
      const entry = f.readdirSync(root, { withFileTypes: true }).find((e) => e.name === 'l')!
      const result = {
        lstat: f.lstatSync(join(root, 'l')).isSymbolicLink(),
        statDir: f.statSync(join(root, 'l')).isDirectory(),
        listed: { link: entry.isSymbolicLink(), dir: entry.isDirectory() },
        through: f.readFileSync(join(root, 'l', 'in'), 'utf8'),
        readlinkEnds: f.readlinkSync(join(root, 'l')).replace(/[\\/]+$/, '').endsWith('t'),
        removed: '',
        targetKept: false,
      }
      f.rmSync(join(root, 'l'), { recursive: true })
      result.removed = 'ok'
      result.targetKept = f.existsSync(join(root, 't', 'in'))
      return result
    },
  },
  {
    name: 'a dangling link: there to lstat, not there to existsSync',
    want: both({ lstat: true, exists: false, stat: err('ENOENT') }),
    async run(os, root) {
      const { join } = os.paths.path
      os.files.symlinkSync(join(root, 'gone'), join(root, 'l'), 'junction')
      return { lstat: os.files.lstatSync(join(root, 'l')).isSymbolicLink(), exists: os.files.existsSync(join(root, 'l')), stat: await outcome(() => os.files.statSync(join(root, 'l'))) }
    },
  },
  {
    name: 'a relative symlink to a file is read from its folder',
    symlinks: true,
    want: { windows: { read: 'k', target: 't\\in' }, posix: { read: 'k', target: 't/in' } },
    run(os, root) {
      const { join } = os.paths.path
      os.files.mkdirSync(join(root, 't'))
      os.files.writeFileSync(join(root, 't', 'in'), 'k')
      os.files.symlinkSync(os.paths.path.join('t', 'in'), join(root, 's'), 'file')
      return { read: os.files.readFileSync(join(root, 's'), 'utf8'), target: os.files.readlinkSync(join(root, 's')) }
    },
  },
  {
    name: 'a file open in this process: renamed and deleted, but not replaced, nor its folder moved',
    want: {
      windows: { renameOpen: 'ok', replaceOpen: err('EPERM'), moveFolder: err('EPERM'), unlinkOpen: 'ok', gone: false },
      posix: { renameOpen: 'ok', replaceOpen: 'ok', moveFolder: 'ok', unlinkOpen: 'ok', gone: false },
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      const ok = (fn: () => void) => outcome(() => (fn(), 'ok'))
      f.mkdirSync(join(root, 'a'))
      f.writeFileSync(join(root, 'a', 'f'), 'x')
      f.writeFileSync(join(root, 'a', 'g'), 'y')
      let fd = f.openSync(join(root, 'a', 'f'), 'r')
      const renameOpen = await ok(() => f.renameSync(join(root, 'a', 'f'), join(root, 'a', 'f2')))
      f.closeSync(fd)
      fd = f.openSync(join(root, 'a', 'f2'), 'r')
      const replaceOpen = await ok(() => f.renameSync(join(root, 'a', 'g'), join(root, 'a', 'f2')))
      const moveFolder = await ok(() => f.renameSync(join(root, 'a'), join(root, 'b')))
      const dir = f.existsSync(join(root, 'a')) ? 'a' : 'b'
      const unlinkOpen = await ok(() => f.unlinkSync(join(root, dir, 'f2')))
      const gone = f.existsSync(join(root, dir, 'f2'))
      f.closeSync(fd)
      return { renameOpen, replaceOpen, moveFolder, unlinkOpen, gone }
    },
  },
  {
    name: "a running process's working folder: not renamed or removed on Windows, nor its parent renamed",
    want: {
      windows: { rename: err('EBUSY'), remove: err('EBUSY'), renameParent: err('EPERM'), writeInside: 'ok' },
      posix: { rename: 'ok', remove: 'ok', renameParent: 'ok', writeInside: 'ok' },
    },
    async run(os, root, ctx) {
      const { join } = os.paths.path
      const f = os.files
      const ok = (fn: () => void) => outcome(() => (fn(), 'ok'))
      f.mkdirSync(join(root, 'p', 'w'), { recursive: true })
      f.mkdirSync(join(root, 'q', 'w'), { recursive: true })
      f.mkdirSync(join(root, 'r', 'w'), { recursive: true })
      const children = await Promise.all([ctx.waiter(join(root, 'p', 'w')), ctx.waiter(join(root, 'q', 'w')), ctx.waiter(join(root, 'r', 'w'))])
      try {
        const rename = await ok(() => f.renameSync(join(root, 'p', 'w'), join(root, 'p', 'w2')))
        const remove = await ok(() => f.rmSync(join(root, 'q', 'w'), { recursive: true }))
        const renameParent = await ok(() => f.renameSync(join(root, 'r'), join(root, 'r2')))
        const working = f.existsSync(join(root, 'p', 'w')) ? join(root, 'p', 'w') : join(root, 'p', 'w2')
        return { rename, remove, renameParent, writeInside: await ok(() => f.writeFileSync(join(working, 'x'), '')) }
      } finally {
        await Promise.all(children.map((c) => os.processes.stop(c, 1000)))
      }
    },
  },
  {
    name: 'descriptors: written, read at a position, stated, appended',
    want: both({ read: 'llo', size: 5, appended: 'hello!' }),
    run(os, root) {
      const p = os.paths.path.join(root, 'f')
      const f = os.files
      let fd = f.openSync(p, 'w', 0o600)
      f.writeSync(fd, 'hello')
      f.closeSync(fd)
      fd = f.openSync(p, 'r')
      const buf = Buffer.alloc(3)
      const n = f.readSync(fd, buf, 0, 3, 2)
      const size = f.fstatSync(fd).size
      f.closeSync(fd)
      fd = f.openSync(p, 'a')
      f.writeSync(fd, '!')
      f.closeSync(fd)
      return { read: buf.subarray(0, n).toString(), size, appended: f.readFileSync(p, 'utf8') }
    },
  },
  {
    name: 'a temporary folder is the prefix and six characters, made empty',
    want: both({ suffix: 6, empty: [], dir: true }),
    run(os, root) {
      const prefix = os.paths.path.join(root, 'x-')
      const made = os.files.mkdtempSync(prefix)
      return { suffix: made.length - prefix.length, empty: os.files.readdirSync(made), dir: os.files.statSync(made).isDirectory() }
    },
  },
  {
    name: 'a copy of a tree keeps a relative link as written',
    symlinks: true,
    want: { windows: { file: 'k', link: 't\\in' }, posix: { file: 'k', link: 't/in' } },
    run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.mkdirSync(join(root, 'src', 't'), { recursive: true })
      f.writeFileSync(join(root, 'src', 't', 'in'), 'k')
      f.symlinkSync(join('t', 'in'), join(root, 'src', 's'), 'file')
      f.cpSync(join(root, 'src'), join(root, 'dst'), { recursive: true, verbatimSymlinks: true })
      return { file: f.readFileSync(join(root, 'dst', 't', 'in'), 'utf8'), link: f.readlinkSync(join(root, 'dst', 's')) }
    },
  },
  {
    name: 'the same operations through promises',
    want: { windows: { text: 'a', list: ['f'], missing: err('ENOENT') }, posix: { text: 'a', list: ['f'], missing: err('ENOENT') } },
    async run(os, root) {
      const { join } = os.paths.path
      const p = os.files.promises
      await p.mkdir(join(root, 'd'))
      await p.writeFile(join(root, 'd', 'f'), 'a')
      return { text: await p.readFile(join(root, 'd', 'f'), 'utf8'), list: await p.readdir(join(root, 'd')), missing: await outcome(() => p.stat(join(root, 'nope'))) }
    },
  },
  {
    name: 'a program that is not there, or not a program, does not start',
    // POSIX: a file that is there but not executable
    want: { windows: { missing: 'ENOENT', batch: 'EINVAL' }, posix: { missing: 'ENOENT', batch: 'EACCES' } },
    async run(os, root) {
      const { join } = os.paths.path
      os.files.writeFileSync(join(root, 'x.cmd'), '@echo off\r\n')
      const code = async (child: OsChild) => {
        const exit = await child.exited
        return exit.error?.code ?? null
      }
      return {
        missing: await code(os.processes.start(join(root, 'missing-program'), [])),
        batch: await code(os.processes.start(join(root, 'x.cmd'), [])),
      }
    },
  },
]
