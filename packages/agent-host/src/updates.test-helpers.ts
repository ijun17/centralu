import type { UpdateStatus } from '@cc/protocol'
import { UpdateService, type UpdateMachine, type UpdateServiceOptions } from './updates.js'

/**
 * The update service of a test that is not about what the machine offers (#2299): a registry that cannot be reached, a
 * command that does nothing, and no global package or installed copy, unless the test gives its own. The service takes
 * these as required (`UpdateMachine`), so the real ones are the host's alone (`realUpdateService`).
 */
export function isolatedUpdateService(publish: (status: UpdateStatus) => void = () => {}, deps: Partial<UpdateMachine> & UpdateServiceOptions = {}): UpdateService {
  return new UpdateService(publish, {
    ...deps,
    fetchLatest: deps.fetchLatest ?? (async () => ({ ok: false, reason: 'Could not reach the registry: this test has none' })),
    run: deps.run ?? (async () => {}),
    installedCopy: deps.installedCopy ?? (() => null),
    installedCopyVersion: deps.installedCopyVersion ?? (() => null),
    globalPackage: deps.globalPackage ?? (async () => null),
  })
}
