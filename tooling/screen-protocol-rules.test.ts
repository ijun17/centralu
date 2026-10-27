import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cruise } from 'dependency-cruiser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error — a CommonJS config, read by the depcruise command too
import config from './dependency-cruiser.cjs'

/*
 * dependency-cruiser's two rules for the screen's protocol entry (#1648). They resolve a specifier to a file, so a relative path
 * into the protocol package is caught, which the lint guard (it reads the specifier) cannot do; an alias is the file it names too
 * (probed on the repository's own tree, where tsconfig.json's paths resolve it). Run on a small tree of its own, laid out like the repository's.
 */
const FILES: Record<string, string> = {
  'packages/protocol/src/client.ts': 'export const A = 1\n',
  'packages/protocol/src/index.ts': 'export const B = 2\n',
  'packages/protocol/src/commands.ts': 'export const RpcMethods = {}\n',
  'packages/ui/src/ok.ts': "export { A } from '@cc/protocol/client'\n",
  'packages/ui/src/whole.ts': "export { B } from '../../protocol/src/index.js'\n",
  'packages/ui/src/relative.ts': "export { RpcMethods } from '../../protocol/src/commands.js'\n",
  'packages/platform/src/web/relative-client.ts': "export { A } from '../../../protocol/src/client.js'\n",
  'packages/core/src/whole.ts': "import { B } from '../../protocol/src/index.js'\nexport const b = B\n",
  'apps/web/src/whole.ts': "import { B } from '../../../packages/protocol/src/index.js'\nexport const b = B\n",
  'packages/agent-host/src/whole.ts': "import { B } from '../../protocol/src/index.js'\nexport const b = B\n",
  'packages/ui/src/store/x.test-helpers.ts': "import { B } from '../../../protocol/src/index.js'\nexport const b = B\n",
  'packages/ui/src/uses-helper.ts': "import { b } from './store/x.test-helpers.js'\nexport const c = b\n",
  'packages/ui/src/store/other.test-helpers.ts': "import { b } from './x.test-helpers.js'\nexport const c = b\n",
}

let root = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-screen-protocol-'))
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function violations(): Promise<string[]> {
  const result = await cruise(['packages', 'apps'], { ...config.options, ruleSet: config, validate: true, baseDir: root })
  if (typeof result.output === 'string') throw new Error('expected the cruise result as an object')
  return result.output.summary.violations.filter((v) => v.rule.name.startsWith('screen-') || v.rule.name.startsWith('no-test-helpers')).map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)
}

describe("the screen's protocol entry in dependency-cruiser (#1648)", () => {
  it('flags the whole entry, a relative path into the package, and a test-helper in shipped code; not the client entry, the host, or a helper importing a helper', async () => {
    expect((await violations()).sort()).toEqual([
      'no-test-helpers-in-shipped-code: packages/ui/src/uses-helper.ts -> packages/ui/src/store/x.test-helpers.ts',
      'screen-takes-protocol-through-client: apps/web/src/whole.ts -> packages/protocol/src/index.ts',
      'screen-takes-protocol-through-client: packages/core/src/whole.ts -> packages/protocol/src/index.ts',
      'screen-takes-protocol-through-client: packages/ui/src/relative.ts -> packages/protocol/src/commands.ts',
      'screen-takes-protocol-through-client: packages/ui/src/whole.ts -> packages/protocol/src/index.ts',
    ])
  })
})
