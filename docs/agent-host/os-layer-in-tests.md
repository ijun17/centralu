# The OS layer in tests

How a test of host code meets files, paths and processes: what to fake, where the fakes are, and what the two lint
rules allow in a test. The layer itself is [plans/os-layer.md](../plans/os-layer.md); this page is the test side of it.

## Pick the fake by what the test is about

| The test is about | Use | Where |
|---|---|---|
| Logic that reads files, paths or the process table, on either OS family | `memoryOs({ as: 'windows' \| 'posix' })`, given to the code under test as its `Os` | `packages/agent-host/src/os/memory.ts` |
| A program the code starts, without a real process (its arguments, output, exit, a child it starts, a stop) | `os.programs.add(path, program)` on a `memoryOs`; `{ sync }` for `runSync` | the same; examples in `os/exec.test.ts` |
| A tool the code finds on PATH and may read back through its shim (`execTool`, `whichTool`, `launchFor`, `resolveCommand`) | `fakeTool(dir, name, source)`: a `.cmd` shim and an sh script, as npm installs one; put `dir` on PATH | `packages/agent-host/src/fake-exe.test-helpers.ts` |
| A program started directly, where a shim cannot run (`ssh`, `gh`, a program killed by pid) | `fakeExe(dir, name, source)`: a real `.exe` launcher on Windows, a `#!` script elsewhere | the same file |
| An agent CLI process the adapter starts and ends | `fakeAgentCli({ ignoreTerm, crash, pidFile })` | `packages/agent-host/src/adapters/fake-agent-cli.test-helpers.ts` |
| A process tree that must end whole | `plantTreeScript(dir)`, then `treePids`, `alive`, `cleanUp` | `packages/agent-host/src/dev-services/process-tree.test-helpers.ts` |
| A temporary folder | `tempRoot(prefix)` and `removeTree(dir)` | `packages/agent-host/src/temp-dir.test-helpers.ts` |
| That the in-memory OS behaves as the real one | the contract, run against both | `os/contract.test-helpers.ts`, `os/real.test.ts`, `os/memory.test.ts` |

Prefer the in-memory OS. A test that reaches only `memoryOs` runs on Linux alone and still tests Windows' rules
(`as: 'windows'`); a test that reaches the real OS also runs in the Windows job (`tooling/os-tests.ts` picks it from
its imports), where it costs the most time. Use a real process only when the test is about one: a shim, a signal, a
tree, a handle Windows holds.

Code under test takes the OS as a parameter or a dependency with the real one as its default
(`os: Pick<Os, 'processes'> = realOs()`), so a test passes `memoryOs({ as })` and nothing else changes. A function that
reaches for `realOs()` inside its body cannot be faked: give it the parameter.

## What the lint rules allow in a test

- **`local/os-imports`** (`tooling/eslint-platform-checks.js`) reads tests too. What it refuses is listed once, in
  `tooling/os-layer.js` (`OS_MODULES`, `INSTALLED_OS_MODULES`, `OS_PROCESS_USES`, `OS_NAMED_EXPORTS`), with two
  exceptions:
  - the test or test helper of a layer module, named for it exactly (`inOsLayer`: `kill-tree.test.ts` for
    `kill-tree.ts`); another name is not one, `os.anything.test.ts` included, so moving a test beside the layer does
    not exempt it;
  - a file on `tooling/os-allowlist.txt`, which only shrinks: a new file never goes on it.

  A new test reaches the OS through the layer: `const { files, paths, processes, env } = realOs()`, then
  `files.writeFileSync`, `paths.path.join`, `env.execPath`, `env.get('PATH')`. When an edit leaves an allowlisted file
  with no OS import, take its line off the list.
- **`local/platform-checks`** does not read tests: `it.skipIf(process.platform !== 'win32')` and a constant such as
  `const posix = process.platform !== 'win32'` are fine in a test. Host code asks the layer a question named for what
  differs (`traits.hasProcessGroups`), never the platform.
- **`guard/timed-start`** (`timedStart` in `tooling/eslint-guards.js`; its scopes in `guardConfigs`) reads tests for
  probes only; its other checks read host code.

## An example

A tool on PATH, run through the code that looks it up (`tool-run.test.ts`):

```ts
const { paths, env } = realOs()
function toolOnPath(name: string, js: string): void {
  dir ||= tempRoot('cc-tool-run-')
  vi.stubEnv('PATH', `${fakeTool(dir, name, js)}${paths.path.delimiter}${env.get('PATH') ?? ''}`)
}

it('names the tool in a failure, not the Node its shim runs', async () => {
  toolOnPath('faketool', "process.stderr.write('not signed in'); process.exit(3)")
  await expect(execTool('faketool', ['auth', 'status'], { timeoutMs: 30_000 * SLOW })).rejects.toThrow(/^faketool exited 3: not signed in$/)
})
```

The same question with no process, on the POSIX family (`os/exec.test.ts`; `as: 'windows'` runs Windows' rules):

```ts
const os = memoryOs({ as: 'posix' })
os.programs.add('/usr/bin/tool', (ctx) => {
  ctx.start('/usr/bin/helper', [])
  return new Promise(() => {})
})
os.programs.add('/usr/bin/helper', (ctx) => new Promise(() => void ctx.ended))
const ran = execText('/usr/bin/tool', [], { timeoutMs: 1000 }, os).catch((e: ExecFailure) => e)
await os.clock.advance(1000)
expect(await ran).toMatchObject({ ended: 'timeout' })
```

## Keeping this page right

A new fake goes in one of the files above, or in a new `*.test-helpers.ts` named here, never copied into a test. A
row names a path and a function, never a copy of the code's rules: the rule stays in the code's own comment.
