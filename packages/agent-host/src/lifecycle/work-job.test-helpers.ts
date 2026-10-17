/**
 * A stand-in host for work-job.test.ts, run as its own process, in the real host's order: starts the terminal broker,
 * then joins the work job (argv `join`; `none` does not), then starts work the way the host does, each with a child
 * started by a program that is not Node (PowerShell's Start-Process, as codex starts its MCP servers or a dev script
 * starts a server): through `spawnGrouped` (an agent CLI, an app server, git), under git's sh (a hook), in a pty in the
 * host (a Run command), and in a terminal through the broker. Each grandchild writes its pid to `<out>/<name>.pid`;
 * `<out>/job.json` says how joining went once everything is started.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { spawnGrouped } from '../dev-services/grouped-child.js'
import { spawnPty, type PtyModule } from '../dev-services/pty-slot.js'
import { PtyBroker, brokerPtyModule } from '../dev-services/broker-pty.js'
import { systemTool } from '../os.js'
import { joinWorkJob } from './work-job.js'

const [out, mode] = process.argv.slice(2) as [string, string]
const broker = PtyBroker.start()
const job = mode === 'join' ? await joinWorkJob({ underKeeper: false }) : { state: 'not joined' }

const powershell = systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'])
const sleeper = join(out, 'sleeper.cjs')
writeFileSync(sleeper, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 120000)\n")
/** A PowerShell script that starts a sleeper through Start-Process, then waits */
const startsSleeper = (name: string) =>
  Buffer.from(
    `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '"${sleeper}" "${join(out, `${name}.pid`)}"'; Start-Sleep 120`,
    'utf16le',
  ).toString('base64')
const pty = { cols: 80, rows: 24, cwd: tmpdir(), env: process.env }

spawnGrouped(powershell, ['-NoProfile', '-EncodedCommand', startsSleeper('grouped')], { stdio: 'ignore' })
// Under Git for Windows' sh (MSYS), as a git hook or Claude Code's Bash tool runs: a git alias starting with `!`
spawnGrouped('git', ['-c', `alias.sleeper=!'${powershell.replaceAll('\\', '/')}' -NoProfile -EncodedCommand ${startsSleeper('gitsh')}`, 'sleeper'], { stdio: 'ignore', cwd: tmpdir() })
// A Run command: node-pty in the host
spawnPty(createRequire(import.meta.url)('node-pty') as PtyModule, { file: powershell, args: ['-NoProfile', '-EncodedCommand', startsSleeper('command')] }, pty)
// A terminal: through the broker, which was started before the job
brokerPtyModule(broker).spawn(powershell, ['-NoProfile', '-EncodedCommand', startsSleeper('terminal')], pty)

writeFileSync(join(out, 'job.json'), JSON.stringify({ ...job, broker: broker.pid }))
setInterval(() => {}, 60_000)
