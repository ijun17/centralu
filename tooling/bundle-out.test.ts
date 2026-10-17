import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error — plain .mjs beside bundle.mjs, which runs under plain node
import { bundleOutFolder } from '../packages/agent-host/scripts/bundle-out.mjs'

/** `CC_BUNDLE_OUT` is removed and written whole by bundle.mjs (#1036): never the checkout, nothing in it, nothing above it */
describe('the folder a host bundle may be written to', () => {
  const root = resolve(tmpdir(), 'cc-checkout')

  it('takes an absolute folder outside the checkout', () => {
    const out = join(tmpdir(), 'cc-data', 'remote', '.partial-1', 'node_modules', '@centralu', 'host-win32-x64', 'host')
    expect(bundleOutFolder(out, root)).toBe(resolve(out))
  })

  it('refuses the checkout, any folder in it, a folder above it, and a relative path', () => {
    for (const out of [root, join(root, 'packages'), join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'host'), tmpdir()]) {
      expect(() => bundleOutFolder(out, root), out).toThrow(/must be outside the checkout/)
    }
    expect(() => bundleOutFolder('out/host', root)).toThrow(/must be an absolute path/)
  })
})
