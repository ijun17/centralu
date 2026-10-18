import { execFile } from 'node:child_process'
import { elevatedFromGroups, elevationSource, type Platform, HOST_PLATFORM } from './os.js'

/**
 * Whether this host runs with administrator rights (#702): an elevated token on Windows, root elsewhere
 * (`elevationSource`). Said in every `hello_ok` (`HelloServer.elevated`), so a hub can tell the person that agents on a
 * linked machine run as an administrator. Null when it could not be told: then nothing is said.
 *
 * Asked once, in the background, at startup: `whoami` takes tens of milliseconds on Windows, and a hello sent before
 * the answer simply says nothing yet.
 */
export function detectElevation(
  o: {
    platform?: Platform
    env?: Record<string, string | undefined>
    getuid?: (() => number) | undefined
    run?: (file: string, args: string[]) => Promise<string>
  } = {},
): Promise<boolean | null> {
  const source = elevationSource(o.platform ?? HOST_PLATFORM, o.env ?? process.env)
  if (source.kind === 'uid') {
    const getuid = 'getuid' in o ? o.getuid : process.getuid?.bind(process)
    return Promise.resolve(getuid ? getuid() === 0 : null)
  }
  const run =
    o.run ??
    ((file: string, args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      ))
  return run(source.file, source.args).then(elevatedFromGroups, () => null)
}
