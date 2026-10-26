/** `test-env/data-dir` keeps a test file from writing CC_DATA_DIR by hand (#845, #1602). */
import { describe, expect, it } from 'vitest'
import { virtualFileLinter } from './eslint-virtual.test-helpers.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = virtualFileLinter()

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
    ['delete through an optional chain', 'delete process?.env.CC_DATA_DIR'],
    ['delete behind an assertion', 'delete (process.env as Env).CC_DATA_DIR'],
  ])('is reported, in a spelling the old check did not name: %s', async (_form, code) => {
    expect(await inTest(code)).toEqual([1])
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
    ['passing it to a child process', "spawn('node', [], { env: { ...process.env, CC_DATA_DIR: dir } })"],
  ])('is not reported: %s', async (_form, code) => {
    expect(await inTest(code)).toEqual([])
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

  it.each(['packages/agent-host/src/x.ts', 'packages/agent-host/scripts/x.mts', 'scripts/x.mjs'])('leaves %s, which is not a test file, to its own code', async (file) => {
    expect(await reported(file, write)).toEqual([])
  })

  it('accepts an explained eslint-disable line', async () => {
    const code = '// eslint-disable-next-line test-env/data-dir -- This test checks what the host does with a bad folder.\n' + write
    expect(await inTest(code)).toEqual([])
  })
})
