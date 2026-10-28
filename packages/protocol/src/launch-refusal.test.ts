import { describe, expect, it } from 'vitest'
import { AdapterCapabilities, launchRefusal } from './entities.js'

const base = AdapterCapabilities.parse({
  approvals: true,
  contextUsage: 'none',
  resume: true,
  autoTitle: true,
})
const limited = {
  ...base,
  presets: ['normal', 'edits', 'auto'] as const,
  keepsRepoFilesOut: false,
  roleText: false,
}
const ordinary = { permissionPreset: 'normal' as const, projectTrusted: true }

describe('launchRefusal', () => {
  it('lets a tool that declares no limits run anything, as Claude and Codex always have', () => {
    expect(
      launchRefusal(base, 'Codex', { permissionPreset: 'safe', noSettingFiles: true, roleText: true }),
    ).toBeNull()
  })

  it('lets a limited tool run an ordinary session in a trusted project', () => {
    expect(launchRefusal({ ...limited, presets: [...limited.presets] }, 'Cursor', ordinary)).toBeNull()
  })

  it('refuses a preset the tool does not list, naming it', () => {
    expect(
      launchRefusal({ ...limited, presets: [...limited.presets] }, 'Cursor', {
        ...ordinary,
        permissionPreset: 'safe',
      }),
    ).toMatch(/Cursor.*Safe/)
  })

  it('refuses an untrusted project when the tool cannot keep the repository files out', () => {
    expect(
      launchRefusal({ ...limited, presets: [...limited.presets] }, 'Cursor', {
        ...ordinary,
        projectTrusted: false,
      }),
    ).toMatch(/Cursor.*trusted/)
    expect(
      launchRefusal({ ...limited, presets: [...limited.presets] }, 'Cursor', { permissionPreset: 'normal' }),
    ).toMatch(/trusted/)
  })

  it('refuses a session given role text or reading no setting files when the tool takes no role text', () => {
    const caps = { ...limited, presets: [...limited.presets] }
    expect(launchRefusal(caps, 'Cursor', { ...ordinary, roleText: true })).toMatch(/Cursor.*orchestrator/)
    expect(launchRefusal(caps, 'Cursor', { ...ordinary, noSettingFiles: true })).toMatch(
      /Cursor.*orchestrator/,
    )
  })
})
