import { execFile } from 'node:child_process'
import type { HostLogon } from '@cc/protocol'
import { elevatedFromGroups, elevationSource, logonFromGroups, type Platform, HOST_PLATFORM } from './os.js'

type Probe = {
  platform?: Platform
  env?: Record<string, string | undefined>
  getuid?: (() => number) | undefined
  run?: (file: string, args: string[]) => Promise<string>
}

/** What this host's token says about it: `elevated` (#702) and, on Windows, which logon it runs in (#1224) */
export type HostToken = { elevated: boolean | null; logon: HostLogon | null }

/**
 * Whether this host runs with administrator rights (#702): an elevated token on Windows, root elsewhere
 * (`elevationSource`), and on Windows which logon it runs in (`logonFromGroups`, #1224). Both are said in every
 * `hello_ok` (`HelloServer.elevated`, `HelloServer.logon`), so a hub can tell the person that agents on a linked
 * machine run as an administrator, or without the person's Windows sign-in. Null when it could not be told: then
 * nothing is said. Elsewhere the logon is always null: the person's saved sign-ins there do not depend on it.
 *
 * Asked once, in the background, at startup: `whoami` takes tens of milliseconds on Windows, and a hello sent before
 * the answer simply says nothing yet. One `whoami` answers both.
 */
export function detectToken(o: Probe = {}): Promise<HostToken> {
  const source = elevationSource(o.platform ?? HOST_PLATFORM, o.env ?? process.env)
  if (source.kind === 'uid') {
    const getuid = 'getuid' in o ? o.getuid : process.getuid?.bind(process)
    return Promise.resolve({ elevated: getuid ? getuid() === 0 : null, logon: null })
  }
  const run =
    o.run ??
    ((file: string, args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      ))
  return run(source.file, source.args).then(
    (out) => ({ elevated: elevatedFromGroups(out), logon: logonFromGroups(out) }),
    () => ({ elevated: null, logon: null }),
  )
}

/** `detectToken`'s `elevated` alone */
export function detectElevation(o: Probe = {}): Promise<boolean | null> {
  return detectToken(o).then((t) => t.elevated)
}
