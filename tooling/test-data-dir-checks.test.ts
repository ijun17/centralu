/** `test-env/data-dir` keeps a test file from writing CC_DATA_DIR by hand (#845, #1602). */
import { describe, expect, it } from 'vitest'
import { guardLinter } from './eslint-virtual.test-helpers.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EXCEPTIONS } from './eslint-test-data-dir.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = guardLinter()

/** The lines the rule reports in `code`, linted as the file at `filePath` */
async function reported(filePath: string, code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
  return (result?.messages ?? []).filter((message) => message.ruleId === 'test-env/data-dir').map((message) => message.line)
}
const inTest = (code: string) => reported('packages/agent-host/src/x.test.ts', code)

describe('a data folder written by hand in a test file', () => {
  // The eight forms the unit test that read every test file caught (#845)
  it.each([
    ['dot assignment', "process.env.CC_DATA_DIR = '/x'"],
    ['bracket assignment', "process.env['CC_DATA_DIR'] = '/x'"],
    ['an assignment operator that is not =', 'process.env["CC_DATA_DIR"] ??= dir'],
    ['delete by dot', 'delete process.env.CC_DATA_DIR'],
    ['delete by bracket', "delete process.env['CC_DATA_DIR']"],
    ['Object.assign naming it', "Object.assign(process.env, { CC_DATA_DIR: '/x' })"],
    ['Object.assign copying in a saved environment', 'Object.assign(process.env, saved)'],
    ['replacing process.env', 'process.env = { ...saved }'],
  ])('is reported: %s', async (_form, code) => {
    expect(await inTest(code)).toEqual([1])
  })

  it('is reported on the line it is written, among lines that are fine', async () => {
    const code = ['const a = 1', "vi.stubEnv('CC_DATA_DIR', '/x')", "process.env.CC_DATA_DIR = '/x'", 'const b = 2', 'delete process.env.CC_DATA_DIR'].join('\n')
    expect(await inTest(code)).toEqual([3, 5])
  })

  it.each([
    ['+= on it', "process.env.CC_DATA_DIR += '/x'"],
    ['||= on it', "process.env.CC_DATA_DIR ||= '/x'"],
    ['a quoted key in Object.assign', "Object.assign(process.env, { 'CC_DATA_DIR': '/x' })"],
    ['a computed key in Object.assign', "Object.assign(process.env, { ['CC_DATA_DIR']: '/x' })"],
    ['a key held in a variable in Object.assign', 'Object.assign(process.env, { [name]: "/x" })'],
    ['a spread in an object given to Object.assign', "Object.assign(process.env, { OTHER: '1', ...saved })"],
    ['a later source of Object.assign', "Object.assign(process.env, { OTHER: '1' }, saved)"],
    ['a spread argument of Object.assign', 'Object.assign(process.env, ...sources)'],
    ['process.env behind a type assertion', "(process.env as Record<string, string>).CC_DATA_DIR = '/x'"],
    ['process.env behind a non-null assertion', "process.env!.CC_DATA_DIR = '/x'"],
    ['process.env behind parentheses', "(process.env).CC_DATA_DIR = '/x'"],
    ['process.env read by bracket', "process['env'].CC_DATA_DIR = '/x'"],
    ['process.env replaced by an assertion', 'process.env = saved as NodeJS.ProcessEnv'],
    ['process.env replaced with ||=', 'process.env ||= saved'],
    ['a template-literal key', "process.env[`CC_DATA_DIR`] = '/x'"],
    ['delete by a template-literal key', 'delete process.env[`CC_DATA_DIR`]'],
    ['a const holding the key', "const KEY = 'CC_DATA_DIR'\nprocess.env[KEY] = '/x'"],
    ['a const key built from parts', "const KEY = 'CC_' + 'DATA_DIR'\ndelete process.env[KEY]"],
    ['a const holding the key through another const', "const A = 'CC_DATA_DIR'\nconst B = A\nprocess.env[B] ??= '/x'"],
    ['an alias of process.env', "const env = process.env\nenv.CC_DATA_DIR = '/x'"],
    ['an alias of an alias', "const a = process.env\nconst b = a\ndelete b['CC_DATA_DIR']"],
    ['process.env taken out of process', "const { env } = process\nenv.CC_DATA_DIR = '/x'"],
    ['an alias of process', "const p = process\np.env.CC_DATA_DIR = '/x'"],
    ['globalThis.process.env', "globalThis.process.env.CC_DATA_DIR = '/x'"],
    ['global.process.env', "delete global.process.env.CC_DATA_DIR"],
    ['Reflect.set', "Reflect.set(process.env, 'CC_DATA_DIR', '/x')"],
    ['Reflect.deleteProperty', "Reflect.deleteProperty(process.env, 'CC_DATA_DIR')"],
    ['Reflect.set with a key that cannot be seen', 'Reflect.set(process.env, key, value)'],
    ['Object.defineProperty', "Object.defineProperty(process.env, 'CC_DATA_DIR', { value: '/x' })"],
    ['Object.defineProperties', "Object.defineProperties(process.env, { CC_DATA_DIR: { value: '/x' } })"],
    ['Object.defineProperty replacing env', "Object.defineProperty(process, 'env', { value: {} })"],
    ['Reflect.set replacing env', "Reflect.set(process, 'env', {})"],
    ['Object.assign into an alias', "const env = process.env\nObject.assign(env, saved)"],
    ['an increment', 'process.env.CC_DATA_DIR++'],
    ['a template key with a substitution', "const N = 'CC_DATA_DIR'\nprocess.env[`${N}`] = '/x'"],
    ['a template key built from parts', "const P = 'CC_'\ndelete process.env[`${P}DATA_DIR`]"],
    ['env imported by name', "import { env } from 'node:process'\nenv.CC_DATA_DIR = '/x'"],
    ['env imported by name from process', "import { env } from 'process'\ndelete env.CC_DATA_DIR"],
    ['a quoted method name', "Object['assign'](process.env, saved)"],
    ['delete through an optional chain', 'delete process?.env.CC_DATA_DIR'],
    ['delete behind an assertion', 'delete (process.env as Env).CC_DATA_DIR'],
  ])('is reported, in a spelling the old check did not name: %s', async (_form, code) => {
    // On the line of the write, the last of the case
    expect(await inTest(code)).toEqual([code.split('\n').length])
  })

  it.each([
    ['vi.stubEnv', "vi.stubEnv('CC_DATA_DIR', '/x')"],
    ['reading it', 'const d = process.env.CC_DATA_DIR'],
    ['comparing it', 'if (process.env.CC_DATA_DIR === d) {}'],
    ['Object.assign of other variables', "Object.assign(process.env, { OTHER: '1' })"],
    ['Object.assign of another target', 'Object.assign(target, saved)'],
    ['another variable by hand', "process.env.OTHER = '1'"],
    ['deleting another variable', 'delete process.env.OTHER'],
    ['a variable of another object', "other.env.CC_DATA_DIR = '/x'"],
    ['a copy of the environment', "const copy = { ...process.env, CC_DATA_DIR: '/x' }"],
    ['an alias of another variable', "const env = process.env\nenv.OTHER = '1'"],
    ['a const key that is another name', "const KEY = 'OTHER'\nprocess.env[KEY] = '1'"],
    ['a local named env that is not process.env', "const env = {}\nenv.CC_DATA_DIR = '/x'"],
    ['a parameter named process', "function f(process) { process.env.CC_DATA_DIR = '/x' }"],
    ['Reflect.set of another variable', "Reflect.set(process.env, 'OTHER', '1')"],
    ['Reflect.set on another object', "Reflect.set(other, 'CC_DATA_DIR', '1')"],
    ['Object.defineProperty of another variable', "Object.defineProperty(process.env, 'OTHER', { value: '1' })"],
    ['env imported by name from another module', "import { env } from './env.js'\nenv.CC_DATA_DIR = '/x'"],
    ['a template key that cannot be told', "process.env[`${name}`] = '/x'"],
    ['passing it to a child process', "spawn('node', [], { env: { ...process.env, CC_DATA_DIR: dir } })"],
  ])('is not reported, and the write after it is: %s', async (_form, code) => {
    // The write after it keeps this from passing for want of a rule at all
    expect(await inTest(`${code}\nprocess.env.CC_DATA_DIR = '/x'`)).toEqual([code.split('\n').length + 1])
  })
})

describe('which files the rule reads', () => {
  const write = "process.env.CC_DATA_DIR = '/x'\n"
  it.each([
    'packages/agent-host/src/x.test.ts',
    'packages/ui/src/x.test.tsx',
    'tooling/x.test.ts',
    'apps/web/src/x.test.ts',
    'packages/agent-host/src/x.test-helpers.ts',
    'tooling/fake-gh.test-helpers.ts',
    'e2e/fixtures/x.ts',
    'e2e/x.spec.ts',
  ])('reads %s', async (file) => {
    expect(await reported(file, write)).toEqual([1])
  })

  it('leaves what is not a test file to its own code', async () => {
    const files = ['packages/agent-host/src/x.ts', 'packages/agent-host/scripts/x.mts', 'scripts/x.mjs', 'packages/agent-host/src/x.test.ts']
    const found = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await reported(file, write)] as const)))
    expect(found).toEqual({ 'packages/agent-host/src/x.ts': [], 'packages/agent-host/scripts/x.mts': [], 'scripts/x.mjs': [], 'packages/agent-host/src/x.test.ts': [1] })
  })

  it('cannot be switched off by a comment: the pass reads none as configuration', async () => {
    const code = ['// eslint-disable-next-line test-env/data-dir', write.trim(), '/* eslint-disable test-env/data-dir */', write.trim(), '/* eslint test-env/data-dir: off */', write.trim()].join('\n')
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, 'packages/agent-host/src/x.test.ts'), warnIgnored: false })
    expect(result?.messages.filter((m) => m.ruleId === 'test-env/data-dir').map((m) => m.line)).toEqual([2, 4, 6])
    expect(result?.suppressedMessages).toEqual([])
  })

  it('has no exceptions, and each one added later names its file and its reason', () => {
    // A ceiling: it is lowered when a line goes, never raised (#1602)
    expect(Object.keys(EXCEPTIONS).length).toBeLessThanOrEqual(0)
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'))
    for (const [file, reason] of Object.entries(EXCEPTIONS)) {
      expect(tracked.has(file), `${file} is a tracked file`).toBe(true)
      expect(String(reason).length, `${file} says why`).toBeGreaterThan(10)
    }
  })

  it('advises vi.stubEnv in a unit test and the process env in an e2e file, which has no vi', async () => {
    const message = async (file: string) => {
      const [result] = await eslint.lintText(write, { filePath: join(ROOT, file), warnIgnored: false })
      return result?.messages.find((m) => m.ruleId === 'test-env/data-dir')?.message
    }
    expect(await message('packages/agent-host/src/x.test.ts')).toContain('vi.stubEnv')
    const e2e = await message('e2e/x.spec.ts')
    expect(e2e).toContain('`env` of the process')
    expect(e2e).not.toContain('vi.stubEnv')
  })
})
