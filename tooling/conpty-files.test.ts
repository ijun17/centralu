import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs, so bundle.mjs reads the same list under plain node
import { CONPTY_FILES } from '../scripts/conpty-files.mjs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/**
 * A Windows host's terminals run on the ConPTY node-pty ships (#849): conpty.node loads conpty.dll, which starts
 * OpenConsole.exe for every pty. The bundling script and the Tauri package's check asked for the DLL alone, so a
 * bundle with the DLL but no OpenConsole.exe passed, and every terminal in it would have been dead, with no fallback
 * (the DLL loads, so Windows' own ConPTY is never tried). Every check reads one list.
 */
describe("the node-pty files a Windows host's terminals need", () => {
  it('are conpty.node, the DLL it loads and the OpenConsole.exe that starts', () => {
    expect(CONPTY_FILES).toEqual(['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'])
  })

  it.each(['packages/agent-host/scripts/bundle.mjs', 'scripts/release-npm.mts', 'scripts/host-package.mts'])('%s checks every one of them, from that list', (file) => {
    const text = code(read(file))
    expect(text).toMatch(/import \{ CONPTY_FILES[^}]*\} from '[./]*(?:\.\.\/)*(?:scripts\/)?conpty-files\.mjs'/)
    // No list of its own beside it, which could name the DLL and not OpenConsole.exe again
    expect(text).not.toMatch(/['"`][^'"`]*conpty\.dll['"`]/)
  })
})
