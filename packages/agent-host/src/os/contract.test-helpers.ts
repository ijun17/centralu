import type { Os, OsChild, OsError } from './port.js'
import type { MemoryOs } from './memory.js'
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
  /**
   * macOS's answer where it is not Linux's (`want.posix`), as measured on a Mac or as Darwin documents it:
   * `real.test.ts` holds a Mac's real OS to it, and the in-memory OS (which models Linux) to `want.posix`
   */
  darwin?: unknown
  /** Needs the right to make a symlink, which a Windows account without Developer Mode lacks */
  symlinks?: boolean
  /**
   * The POSIX answer is Linux's, and macOS answers otherwise: its volume ignores case, and `unlink` of a folder is
   * `EPERM` there. `real.test.ts` does not hold macOS to it; the in-memory OS follows Linux
   */
  linux?: boolean
  run(os: Os, root: string, ctx: ContractContext): unknown
}

export type ContractContext = {
  /**
   * Starts a program that runs until it is stopped, in `cwd`, and answers it once it runs: it writes `ready` to its
   * stdout. Windows starts holding a process's working folder only once the process itself has set it up, a moment
   * after its start is reported (`'spawn'`).
   */
  waiter(cwd: string): Promise<OsChild>
  /** Puts at `path` a program that exits 0 when started with no arguments (on the real OS, a copy of Node) */
  program(path: string): void
  /** A program that writes its stdin to its stdout, as a command and its arguments */
  readonly cat: { command: string; args: string[] }
}

/** The contract's context on an in-memory OS: its waiter, a program that exits 0, and `cat` */
export function memoryContext(os: MemoryOs): ContractContext {
  const cat = os.paths.path.join(os.paths.path.dirname(os.env.execPath), os.family === 'windows' ? 'cat.exe' : 'cat')
  os.programs.add(cat, async (ctx) => {
    for await (const chunk of ctx.stdin) ctx.stdout.write(chunk)
  })
  return {
    waiter: (cwd) => ready(os.processes.start(os.env.execPath, ['wait'], { cwd })),
    program: (path) => os.programs.add(path, () => 0),
    cat: { command: cat, args: [] },
  }
}

/** Everything `stream` gives until it ends, as text */
function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    if (!stream) return resolve(text)
    stream.on('data', (d: Buffer) => (text += String(d)))
    stream.on('end', () => resolve(text))
  })
}

/** How a child ended, once it has */
const exitOf = async (child: OsChild) => {
  const e = await child.exited
  return { code: e.code, signal: e.signal }
}

/** A value, or the error's code; a `Promise` is awaited */
export async function outcome(fn: () => unknown): Promise<unknown> {
  try {
    return await fn()
  } catch (e) {
    return { error: (e as OsError).code ?? String(e) }
  }
}

/** A signal name no OS has */
const NO_SUCH_SIGNAL = 'SIGNOPE' as NodeJS.Signals

const both = (v: unknown) => ({ windows: v, posix: v })
const err = (code: string) => ({ error: code })
/**
 * The rest of the copy options case: a target through a file is the same refusal from both copies (Windows says no
 * entry there, so the copy fails making the parent; POSIX says ENOTDIR at once)
 */
const OPTION_TAIL = { notRecursive: err('ERR_FS_EISDIR'), readOnlyFolder: 'k', throughFile: err('EEXIST'), throughFilePromised: err('EEXIST') }
const OPTION_TAIL_POSIX = { ...OPTION_TAIL, throughFile: err('ENOTDIR'), throughFilePromised: err('ENOTDIR') }

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
    linux: true,
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
    linux: true,
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
    want: { windows: { file: 'k', link: 't\\in', whole: true }, posix: { file: 'k', link: 't/in', whole: true } },
    run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.mkdirSync(join(root, 'src', 't'), { recursive: true })
      f.writeFileSync(join(root, 'src', 't', 'in'), 'k')
      f.symlinkSync(join('t', 'in'), join(root, 'src', 's'), 'file')
      f.cpSync(join(root, 'src'), join(root, 'dst'), { recursive: true, verbatimSymlinks: true })
      // Without verbatimSymlinks, Node's rule: made whole from the source link's folder
      f.cpSync(join(root, 'src'), join(root, 'whole'), { recursive: true })
      return {
        file: f.readFileSync(join(root, 'dst', 't', 'in'), 'utf8'),
        link: f.readlinkSync(join(root, 'dst', 's')),
        whole: os.paths.same(f.readlinkSync(join(root, 'whole', 's')), join(root, 'src', 't', 'in')),
      }
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
    name: 'a rename to the same name in another case: the name is stored as written',
    want: both({ list: ['name.txt'], native: 'name.txt' }),
    run(os, root) {
      const { join, basename } = os.paths.path
      os.files.writeFileSync(join(root, 'Name.TXT'), 'x')
      os.files.renameSync(join(root, 'Name.TXT'), join(root, 'name.txt'))
      return { list: os.files.readdirSync(root), native: basename(os.files.realpathNativeSync(join(root, 'name.txt'))) }
    },
  },
  {
    name: 'mkdir over a link: taken; with -p, followed to a folder, or nowhere',
    want: both({ dangling: err('EEXIST'), danglingP: err('ENOENT'), toDir: err('EEXIST'), toDirP: 'ok' }),
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.symlinkSync(join(root, 'gone'), join(root, 'l'), 'junction')
      f.mkdirSync(join(root, 't'))
      f.symlinkSync(join(root, 't'), join(root, 'lt'), 'junction')
      const ok = (fn: () => unknown) => outcome(() => (fn(), 'ok'))
      return {
        dangling: await ok(() => f.mkdirSync(join(root, 'l'))),
        danglingP: await ok(() => f.mkdirSync(join(root, 'l'), { recursive: true })),
        toDir: await ok(() => f.mkdirSync(join(root, 'lt'))),
        toDirP: await ok(() => f.mkdirSync(join(root, 'lt'), { recursive: true })),
      }
    },
  },
  {
    name: 'a folder opened: for reading on both, for writing on Windows only; it reads as EISDIR',
    want: {
      windows: { read: err('EISDIR'), isDir: true, forWrite: 'ok', renamedOpen: 'ok' },
      posix: { read: err('EISDIR'), isDir: true, forWrite: err('EISDIR'), renamedOpen: 'ok' },
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.mkdirSync(join(root, 'd'))
      const fd = f.openSync(join(root, 'd'), 'r')
      const result = {
        read: await outcome(() => f.readSync(fd, Buffer.alloc(4), 0, 4, null)),
        isDir: f.fstatSync(fd).isDirectory(),
        forWrite: await outcome(() => (f.closeSync(f.openSync(join(root, 'd'), 'r+')), 'ok')),
        renamedOpen: await outcome(() => (f.renameSync(join(root, 'd'), join(root, 'e')), 'ok')),
      }
      f.closeSync(fd)
      return result
    },
  },
  {
    name: 'a tree copied into itself is refused',
    want: both({ copy: err('ERR_FS_CP_EINVAL'), viaLink: err('ERR_FS_CP_EINVAL') }),
    async run(os, root) {
      const { join } = os.paths.path
      os.files.mkdirSync(join(root, 's'))
      os.files.writeFileSync(join(root, 's', 'f'), '')
      // `l` leads to `s`: `l/in` is inside it too
      os.files.symlinkSync(join(root, 's'), join(root, 'l'), 'junction')
      return {
        copy: await outcome(() => os.files.cpSync(join(root, 's'), join(root, 's', 'in'), { recursive: true })),
        viaLink: await outcome(() => os.files.cpSync(join(root, 's'), join(root, 'l', 'in'), { recursive: true })),
      }
    },
  },
  {
    name: "relative paths are read from the Os's own working folder",
    want: both({ resolve: true, key: true, same: true, inside: true, relative: 'rel' }),
    run(os) {
      const cwd = os.env.cwd()
      const { join, resolve, relative } = os.paths.path
      return {
        resolve: resolve('rel') === join(cwd, 'rel'),
        key: os.paths.key('rel') === os.paths.key(join(cwd, 'rel')),
        same: os.paths.same('rel', join(cwd, 'rel')),
        inside: os.paths.inside(cwd, 'rel'),
        relative: relative(cwd, 'rel'),
      }
    },
  },
  {
    name: 'signals: on Windows TERM, KILL, INT and QUIT end a process and any other is refused; on POSIX each is sent',
    want: {
      windows: {
        hup: err('ENOSYS'),
        hupAlive: true,
        hupByPid: err('ENOSYS'),
        unknown: err('ERR_UNKNOWN_SIGNAL'),
        unknownByPid: err('ERR_UNKNOWN_SIGNAL'),
        quit: { code: null, signal: 'SIGQUIT' },
        termByPid: { code: 1, signal: null },
        gone: false,
      },
      posix: {
        hup: { code: null, signal: 'SIGHUP' },
        hupAlive: false,
        hupByPid: { code: null, signal: 'SIGHUP' },
        unknown: err('ERR_UNKNOWN_SIGNAL'),
        unknownByPid: err('ERR_UNKNOWN_SIGNAL'),
        quit: { code: null, signal: 'SIGQUIT' },
        termByPid: { code: null, signal: 'SIGTERM' },
        gone: false,
      },
    },
    async run(os, root, ctx) {
      const children = await Promise.all([1, 2, 3, 4].map(() => ctx.waiter(root)))
      const [a, b, c, d] = children as [OsChild, OsChild, OsChild, OsChild]
      try {
        const sent = (fn: () => boolean, child: OsChild) => outcome(() => (fn(), exitOf(child)))
        const hup = await sent(() => a.kill('SIGHUP'), a)
        const hupAlive = os.processes.alive(a.pid ?? 0)
        const hupByPid = await sent(() => os.processes.signal(b.pid ?? 0, 'SIGHUP'), b)
        const unknown = await outcome(() => c.kill(NO_SUCH_SIGNAL))
        const unknownByPid = await outcome(() => os.processes.signal(c.pid ?? 0, NO_SUCH_SIGNAL))
        const quit = await sent(() => c.kill('SIGQUIT'), c)
        const termByPid = await sent(() => os.processes.signal(d.pid ?? 0, 'SIGTERM'), d)
        return { hup, hupAlive, hupByPid, unknown, unknownByPid, quit, termByPid, gone: os.processes.signal(d.pid ?? 0, 'SIGTERM') }
      } finally {
        await Promise.all(children.map((child) => os.processes.stop(child, 1000)))
      }
    },
  },
  {
    name: 'a read-only file: not written, opened to write, or copied onto; Windows refuses a rename onto it too',
    want: {
      windows: { write: err('EPERM'), append: err('EPERM'), openToWrite: err('EPERM'), read: 'r', renameOnto: err('EPERM'), copyOnto: err('EPERM'), cpOnto: 'new', renameAway: 'ok', unlink: 'ok', madeReadOnly: err('EPERM') },
      posix: { write: err('EACCES'), append: err('EACCES'), openToWrite: err('EACCES'), read: 'r', renameOnto: 'ok', copyOnto: err('EACCES'), cpOnto: 'new', renameAway: 'ok', unlink: 'ok', madeReadOnly: err('EACCES') },
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      const ok = (fn: () => unknown) => outcome(() => (fn(), 'ok'))
      const readOnly = (name: string) => {
        f.writeFileSync(join(root, name), 'r')
        f.chmodSync(join(root, name), 0o444)
        return join(root, name)
      }
      f.writeFileSync(join(root, 'src'), 'new')
      const a = readOnly('a')
      const result = {
        write: await ok(() => f.writeFileSync(a, 'x')),
        append: await ok(() => f.appendFileSync(a, 'x')),
        openToWrite: await ok(() => f.closeSync(f.openSync(a, 'r+'))),
        read: f.readFileSync(a, 'utf8'),
        renameOnto: await ok(() => f.renameSync(join(root, 'src'), readOnly('b'))),
        copyOnto: await ok(() => f.copyFileSync(join(root, 'a'), readOnly('c'))),
        cpOnto: await outcome(() => (f.cpSync(join(root, f.existsSync(join(root, 'src')) ? 'src' : 'b'), readOnly('d')), f.readFileSync(join(root, 'd'), 'utf8'))),
        renameAway: await ok(() => f.renameSync(a, join(root, 'a2'))),
        unlink: await ok(() => f.unlinkSync(join(root, 'a2'))),
        madeReadOnly: await ok(() => (f.writeFileSync(join(root, 'm'), '1', { mode: 0o400 }), f.writeFileSync(join(root, 'm'), '2'))),
      }
      // The temporary folder is removed after: nothing read-only is left in it
      for (const name of f.readdirSync(root)) f.chmodSync(join(root, name), 0o644)
      return result
    },
  },
  {
    name: 'a read at or past the end of a file answers 0 bytes',
    want: both({ atEnd: 0, past: 0 }),
    run(os, root) {
      const p = os.paths.path.join(root, 'f')
      os.files.writeFileSync(p, 'abc')
      const fd = os.files.openSync(p, 'r')
      try {
        return { atEnd: os.files.readSync(fd, Buffer.alloc(4), 0, 4, 3), past: os.files.readSync(fd, Buffer.alloc(4), 0, 4, 100) }
      } finally {
        os.files.closeSync(fd)
      }
    },
  },
  {
    name: 'refusals of a folder made through a file, a folder moved into itself, and copies onto the other kind or itself',
    want: {
      windows: { mkdirThrough: err('ENOTDIR'), mkdirOnto: err('EEXIST'), renameInto: err('EPERM'), dirOntoFile: err('ERR_FS_CP_DIR_TO_NON_DIR'), fileOntoDir: err('ERR_FS_CP_NON_DIR_TO_DIR'), fileOntoItself: err('ERR_FS_CP_EINVAL') },
      posix: { mkdirThrough: err('ENOTDIR'), mkdirOnto: err('EEXIST'), renameInto: err('EINVAL'), dirOntoFile: err('ERR_FS_CP_DIR_TO_NON_DIR'), fileOntoDir: err('ERR_FS_CP_NON_DIR_TO_DIR'), fileOntoItself: err('ERR_FS_CP_EINVAL') },
    },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      f.writeFileSync(join(root, 'f'), 'x')
      f.mkdirSync(join(root, 'd', 'sub'), { recursive: true })
      f.mkdirSync(join(root, 's'))
      f.writeFileSync(join(root, 's', 'in'), '')
      return {
        mkdirThrough: await outcome(() => f.mkdirSync(join(root, 'f', 'x', 'y'), { recursive: true })),
        mkdirOnto: await outcome(() => f.mkdirSync(join(root, 'f'), { recursive: true })),
        renameInto: await outcome(() => f.renameSync(join(root, 'd'), join(root, 'd', 'sub', 'in'))),
        dirOntoFile: await outcome(() => f.cpSync(join(root, 's'), join(root, 'f'), { recursive: true })),
        fileOntoDir: await outcome(() => f.cpSync(join(root, 'f'), join(root, 'd'), { recursive: true })),
        fileOntoItself: await outcome(() => f.cpSync(join(root, 'f'), join(root, 'f'))),
      }
    },
  },
  {
    name: "a child's stdin can be a file the host opened",
    want: both({ out: 'from-file' }),
    async run(os, root, ctx) {
      const p = os.paths.path.join(root, 'in')
      os.files.writeFileSync(p, 'from-file')
      const fd = os.files.openSync(p, 'r')
      let child: OsChild
      try {
        child = os.processes.start(ctx.cat.command, ctx.cat.args, { stdio: [fd, 'pipe', 'ignore'] })
      } finally {
        os.files.closeSync(fd)
      }
      const out = await readAll(child.stdout)
      await child.exited
      return { out }
    },
  },
  {
    name: 'file times keep whole microseconds, cut as each OS cuts them',
    want: {
      windows: { seconds: '1700000000123456000', date: '1700000000123000000' },
      posix: { seconds: '1700000000123456000', date: '1700000000122999000' },
    },
    // libuv cuts a time to whole microseconds on Linux only; on macOS APFS keeps the nanoseconds of the double it is
    // given (measured on macOS 27, Node 26)
    darwin: { seconds: '1700000000123456716', date: '1700000000122999906' },
    run(os, root) {
      const { join } = os.paths.path
      os.files.writeFileSync(join(root, 'a'), '')
      os.files.writeFileSync(join(root, 'b'), '')
      os.files.utimesSync(join(root, 'a'), 1_700_000_000 + 0.123456789, 1_700_000_000 + 0.123456789)
      os.files.utimesSync(join(root, 'b'), new Date(1700000000123), new Date(1700000000123))
      return { seconds: String(os.files.statSync(join(root, 'a')).mtimeNs), date: String(os.files.statSync(join(root, 'b')).mtimeNs) }
    },
  },
  {
    name: 'a hard link renamed onto another link of the same file: Windows takes the name away, POSIX does nothing',
    want: { windows: { first: false, nlink: 1 }, posix: { first: true, nlink: 2 } },
    run(os, root) {
      const { join } = os.paths.path
      os.files.writeFileSync(join(root, 'h1'), 'h')
      os.files.linkSync(join(root, 'h1'), join(root, 'h2'))
      os.files.renameSync(join(root, 'h1'), join(root, 'h2'))
      return { first: os.files.existsSync(join(root, 'h1')), nlink: os.files.statSync(join(root, 'h2')).nlink }
    },
  },
  {
    name: 'a name Windows refuses (a*b) is not there to write, nor a folder to make',
    want: { windows: { write: err('ENOENT'), mkdir: err('EINVAL') }, posix: { write: 'ok', mkdir: 'ok' } },
    async run(os, root) {
      const { join } = os.paths.path
      return {
        write: await outcome(() => (os.files.writeFileSync(join(root, 'a*b'), ''), 'ok')),
        mkdir: await outcome(() => (os.files.mkdirSync(join(root, 'x*y')), 'ok')),
      }
    },
  },
  {
    name: 'a file named with a trailing separator: the file on Windows, ENOTDIR on POSIX',
    want: {
      windows: { stat: true, lstat: true, exists: true, read: 'x', write: 'ok' },
      posix: { stat: err('ENOTDIR'), lstat: err('ENOTDIR'), exists: false, read: err('ENOTDIR'), write: err('EISDIR') },
    },
    // Darwin's open(2) with O_CREAT of `name/` that is not there answers ENOENT, Linux's EISDIR (measured on macOS 27)
    darwin: { stat: err('ENOTDIR'), lstat: err('ENOTDIR'), exists: false, read: err('ENOTDIR'), write: err('ENOENT') },
    async run(os, root) {
      const { join } = os.paths.path
      const f = `${join(root, 'f')}/`
      os.files.writeFileSync(join(root, 'f'), 'x')
      return {
        stat: await outcome(() => os.files.statSync(f).isFile()),
        lstat: await outcome(() => os.files.lstatSync(f).isFile()),
        exists: os.files.existsSync(f),
        read: await outcome(() => os.files.readFileSync(f, 'utf8')),
        write: await outcome(() => (os.files.writeFileSync(`${join(root, 'w')}/`, ''), 'ok')),
      }
    },
  },
  {
    name: 'a recursive listing is breadth first and never enters a link, even one back to its own folder',
    want: {
      windows: {
        names: ['a', 'b', 'c', 'j', 'a\\x', 'a\\y', 'b\\z', 'a\\x\\f'],
        parents: ['', '', '', '', 'a', 'a', 'b', 'a\\x'],
        promised: ['a', 'b', 'c', 'j', 'a\\x', 'a\\y', 'b\\z', 'a\\x\\f'],
      },
      posix: {
        names: ['a', 'b', 'c', 'j', 'a/x', 'a/y', 'b/z', 'a/x/f'],
        parents: ['', '', '', '', 'a', 'a', 'b', 'a/x'],
        promised: ['a', 'b', 'c', 'j', 'a/x', 'a/y', 'b/z', 'a/x/f'],
      },
    },
    async run(os, root) {
      const { join, relative } = os.paths.path
      const f = os.files
      const t = join(root, 't')
      f.mkdirSync(join(t, 'a', 'x'), { recursive: true })
      f.writeFileSync(join(t, 'a', 'x', 'f'), '')
      f.writeFileSync(join(t, 'a', 'y'), '')
      f.mkdirSync(join(t, 'b'))
      f.writeFileSync(join(t, 'b', 'z'), '')
      f.writeFileSync(join(t, 'c'), '')
      // A junction to the folder it is in
      f.symlinkSync(t, join(t, 'j'), 'junction')
      // Linux lists a folder in no order: each depth is sorted there; NTFS lists by name, as the want says
      const depth = (n: string) => n.split(/[\\/]/).length
      const ordered = (names: string[]) => (os.traits.foldsPathCase ? names : [...names].sort((x, y) => depth(x) - depth(y) || (x < y ? -1 : x > y ? 1 : 0)))
      const ents = f.readdirSync(t, { withFileTypes: true, recursive: true }).map((e) => ({ rel: join(relative(t, e.parentPath), e.name), parent: relative(t, e.parentPath) }))
      const sortedEnts = os.traits.foldsPathCase ? ents : [...ents].sort((x, y) => depth(x.rel) - depth(y.rel) || (x.rel < y.rel ? -1 : 1))
      return {
        names: ordered(f.readdirSync(t, { recursive: true })),
        parents: sortedEnts.map((e) => e.parent),
        promised: ordered(await f.promises.readdir(t, { recursive: true })),
      }
    },
  },
  {
    name: 'a tree with a junction back to its own folder is copied with the junction as a link, by both copies',
    // Node's own cpSync copied it as the folder it leads to on Windows, for ever, and ended the process (0xC0000409)
    want: both({ copy: 'ok', kept: true, same: true, promised: 'ok', promisedKept: true }),
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      const t = join(root, 't')
      f.mkdirSync(join(t, 'd'), { recursive: true })
      f.writeFileSync(join(t, 'd', 'f'), '')
      f.symlinkSync(t, join(t, 'd', 'up'), 'junction')
      const up = (out: string) => f.lstatSync(join(root, out, 'd', 'up')).isSymbolicLink()
      return {
        copy: await outcome(() => (f.cpSync(t, join(root, 'copy'), { recursive: true }), 'ok')),
        kept: up('copy'),
        same: os.paths.same(f.readlinkSync(join(root, 'copy', 'd', 'up')), t),
        promised: await outcome(async () => (await f.promises.cp(t, join(root, 'copy2'), { recursive: true }), 'ok')),
        promisedKept: up('copy2'),
      }
    },
  },
  {
    name: 'a tree with a link in a circle (a -> b -> a, x -> x) is copied with each link as a link, a file link as much as a folder link, the root too',
    // Node's own cpSync of one ended the process: 0xC0000409 on Windows, an uncaught C++ error (abort) on Linux
    symlinks: true,
    want: both({
      mutual: { copy: 'ok', links: ['loopB', 'loopA'], promised: 'ok' },
      self: { copy: 'ok', links: ['x'], promised: 'ok' },
      folders: { copy: 'ok', links: [true, true], promised: 'ok' },
      root: { copy: 'ok', links: ['r'], promised: 'ok' },
      rootNotRecursive: { copy: 'ok', links: ['r'] },
    }),
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      let n = 0
      const tree = (build: (t: string) => void) => {
        const t = join(root, `t${n++}`)
        f.mkdirSync(join(t, 'd'), { recursive: true })
        f.writeFileSync(join(t, 'f'), 'k')
        build(t)
        return t
      }
      // What each named link in the copy is (`''`: the copy itself), by `read`
      const copyOf = async (t: string, names: string[], read: (link: string) => unknown, recursive = true) => {
        const out = join(root, `out${n++}`)
        const copy = await outcome(() => (f.cpSync(t, out, { recursive }), 'ok'))
        const result: Record<string, unknown> = { copy, links: names.map((name) => read(name === '' ? out : join(out, name))) }
        if (recursive) result['promised'] = await outcome(async () => (await f.promises.cp(t, join(root, `out${n++}`), { recursive }), 'ok'))
        return result
      }
      // Made whole from the source's folder (no verbatimSymlinks): the name it leads to
      const text = (link: string) => os.paths.path.basename(f.readlinkSync(link))
      return {
        mutual: await copyOf(
          tree((t) => {
            f.symlinkSync('loopB', join(t, 'loopA'), 'file')
            f.symlinkSync('loopA', join(t, 'loopB'), 'file')
          }),
          ['loopA', 'loopB'],
          text,
        ),
        self: await copyOf(
          tree((t) => f.symlinkSync('x', join(t, 'd', 'x'), 'file')),
          [join('d', 'x')],
          text,
        ),
        folders: await copyOf(
          tree((t) => {
            f.symlinkSync(join(t, 'b'), join(t, 'a'), 'dir')
            f.symlinkSync(join(t, 'a'), join(t, 'b'), 'dir')
          }),
          ['a', 'b'],
          (link) => f.lstatSync(link).isSymbolicLink(),
        ),
        root: await copyOf((f.symlinkSync('r', join(root, 'r'), 'file'), join(root, 'r')), [''], text),
        rootNotRecursive: await copyOf(join(root, 'r'), [''], text, false),
      }
    },
  },
  {
    name: 'a link that leads somewhere is copied as a link: a symlink back to its own folder, a junction, one to a file and one to nothing',
    symlinks: true,
    want: both({ copy: 'ok', kept: { up: true, junction: true, file: true, dangling: true }, through: 'k', folderFiles: ['f'] }),
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      const t = join(root, 't')
      f.mkdirSync(join(t, 'd'), { recursive: true })
      f.writeFileSync(join(t, 'd', 'f'), 'k')
      f.writeFileSync(join(t, 'g'), 'k')
      f.symlinkSync(t, join(t, 'd', 'up'), 'dir')
      f.symlinkSync(join(t, 'd'), join(t, 'junction'), 'junction')
      f.symlinkSync(join(t, 'g'), join(t, 'd', 'file'), 'file')
      f.symlinkSync(join(t, 'gone'), join(t, 'd', 'dangling'), 'file')
      const copy = await outcome(() => (f.cpSync(t, join(root, 'out'), { recursive: true }), 'ok'))
      const kept = (...name: string[]) => f.lstatSync(join(root, 'out', ...name)).isSymbolicLink()
      return {
        copy,
        kept: { up: kept('d', 'up'), junction: kept('junction'), file: kept('d', 'file'), dangling: kept('d', 'dangling') },
        through: f.readFileSync(join(root, 'out', 'junction', 'f'), 'utf8'),
        folderFiles: f.readdirSync(join(root, 'out', 'd')).filter((n) => n === 'f'),
      }
    },
  },
  {
    name: "a copy takes Node's options: force, errorOnExist, preserveTimestamps; a link onto a file is EEXIST, onto a link replaces it",
    // `timesLost`: a plain copy keeps the change time where copying a file does (Windows' CopyFile, macOS's copyfile)
    want: {
      windows: { replaced: 'new', kept: 'old', refused: err('ERR_FS_CP_EEXIST'), times: true, timesLost: true, readOnlyTimes: true, linkOntoFile: err('EEXIST'), linkOntoLink: true, ...OPTION_TAIL },
      posix: { replaced: 'new', kept: 'old', refused: err('ERR_FS_CP_EEXIST'), times: true, timesLost: false, readOnlyTimes: true, linkOntoFile: err('EEXIST'), linkOntoLink: true, ...OPTION_TAIL_POSIX },
    },
    darwin: { replaced: 'new', kept: 'old', refused: err('ERR_FS_CP_EEXIST'), times: true, timesLost: true, readOnlyTimes: true, linkOntoFile: err('EEXIST'), linkOntoLink: true, ...OPTION_TAIL_POSIX },
    async run(os, root) {
      const { join } = os.paths.path
      const f = os.files
      const tree = (name: string, text: string) => {
        f.mkdirSync(join(root, name))
        f.writeFileSync(join(root, name, 'a'), text)
        return join(root, name)
      }
      const s = tree('s', 'new')
      const read = (d: string) => f.readFileSync(join(d, 'a'), 'utf8')
      const replace = tree('d1', 'old')
      f.cpSync(s, replace, { recursive: true })
      const keep = tree('d2', 'old')
      f.cpSync(s, keep, { recursive: true, force: false })
      const refuse = tree('d3', 'old')
      f.utimesSync(join(s, 'a'), 1_600_000_000, 1_600_000_000)
      f.writeFileSync(join(s, 'ro'), 'r')
      f.utimesSync(join(s, 'ro'), 1_600_000_000, 1_600_000_000)
      f.chmodSync(join(s, 'ro'), 0o444)
      f.cpSync(s, join(root, 't1'), { recursive: true, preserveTimestamps: true })
      f.cpSync(s, join(root, 't2'), { recursive: true })
      const mtime = (...p: string[]) => f.statSync(join(root, ...p)).mtimeMs
      // A link copied onto a file, and onto a link: the junction `j` in `l`, over `j` a file in `lf` and a link in `ll`
      const ro = join(root, 'ro')
      f.mkdirSync(ro)
      f.writeFileSync(join(ro, 'in'), 'k')
      const l = join(root, 'l')
      f.mkdirSync(l)
      f.symlinkSync(s, join(l, 'j'), 'junction')
      f.mkdirSync(join(root, 'lf'))
      f.writeFileSync(join(root, 'lf', 'j'), 'file')
      f.mkdirSync(join(root, 'll'))
      f.symlinkSync(join(root, 'gone'), join(root, 'll', 'j'), 'junction')
      const result = {
        replaced: read(replace),
        kept: read(keep),
        refused: await outcome(() => f.cpSync(s, refuse, { recursive: true, force: false, errorOnExist: true })),
        times: mtime('t1', 'a') === 1_600_000_000_000,
        timesLost: mtime('t2', 'a') === 1_600_000_000_000,
        readOnlyTimes: mtime('t1', 'ro') === 1_600_000_000_000,
        linkOntoFile: await outcome(() => f.cpSync(l, join(root, 'lf'), { recursive: true })),
        linkOntoLink: (f.cpSync(l, join(root, 'll'), { recursive: true }), os.paths.same(f.readlinkSync(join(root, 'll', 'j')), s)),
        notRecursive: await outcome(() => f.cpSync(s, join(root, 'nr'))),
        // A folder's mode is set once its entries are in: a read-only one is copied whole
        readOnlyFolder: (f.chmodSync(ro, 0o555), f.cpSync(ro, join(root, 'rocopy'), { recursive: true }), f.readFileSync(join(root, 'rocopy', 'in'), 'utf8')),
        throughFile: await outcome(() => f.cpSync(s, join(root, 'd1', 'a', 'x'), { recursive: true })),
        throughFilePromised: await outcome(() => f.promises.cp(s, join(root, 'd1', 'a', 'x'), { recursive: true })),
      }
      for (const p of [ro, join(root, 'rocopy')]) f.chmodSync(p, 0o755)
      // The temporary folder is removed after: nothing read-only is left in it
      for (const p of [join(s, 'ro'), join(root, 't1', 'ro'), join(root, 't2', 'ro')]) f.chmodSync(p, 0o644)
      return result
    },
  },
  {
    name: 'names NTFS folds and those it does not: é and É are one, the Kelvin sign and k, or ı and I, are two',
    linux: true,
    want: {
      windows: { list: ['I', 'k', '_', 'é', 'ı', 'K'], eAcute: 'é' },
      posix: { list: ['I', '_', 'k', 'É', 'é', 'ı', 'K'], eAcute: 'É' },
    },
    run(os, root) {
      const { join } = os.paths.path
      for (const n of ['k', 'K', 'I', 'ı', 'é', '_']) os.files.writeFileSync(join(root, n), n)
      // On Windows this is the file é; on POSIX a new one
      if (!os.files.existsSync(join(root, 'É'))) os.files.writeFileSync(join(root, 'É'), 'É')
      const list = os.files.readdirSync(root)
      return { list: os.traits.foldsPathCase ? list : list.sort(), eAcute: os.files.readFileSync(join(root, 'É'), 'utf8') }
    },
  },
  {
    name: 'a path without an extension starts on Windows only as a .com or .exe; elsewhere only as written',
    // Whether it starts, not how it ends: a copy of Node made in a test ended by a signal on macOS 27 (code null)
    want: { windows: { noExtension: err('ENOENT'), found: 'started' }, posix: { noExtension: 'started', found: err('ENOENT') } },
    async run(os, root, ctx) {
      const { join } = os.paths.path
      ctx.program(join(root, 'noext'))
      ctx.program(join(root, 'withext.exe'))
      const code = (path: string) => outcome(async () => (await os.processes.run(path, []), 'started'))
      return { noExtension: await code(join(root, 'noext')), found: await code(join(root, 'withext')) }
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
