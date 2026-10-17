/**
 * A stand-in host for work-job.test.ts, run as its own process: joins the work job (argv `join`) or not, then starts
 * work the way the host does, each with a child started by a program that is not Node (PowerShell's Start-Process, as
 * codex starts its MCP servers or a dev script starts a server): through `spawnGrouped` (an agent CLI, an app server,
 * git), under git's sh (a hook) and in a pty (a terminal, a Run command). Each grandchild writes its pid to
 * `<out>/<name>.pid`; `<out>/job.json` says how joining went once everything is started.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { spawnGrouped } from '../dev-services/grouped-child.js'
import { spawnPty, type PtyModule } from '../dev-services/pty-slot.js'
import { systemTool } from '../os.js'
import { joinWorkJob } from './work-job.js'

const [out, mode] = process.argv.slice(2) as [string, string]
const job = mode === 'join' ? await joinWorkJob() : { state: 'not joined' }

const powershell = systemTool(['WindowsPowerShell', 'v1.0', 'powershell.exe'])
const sleeper = join(out, 'sleeper.cjs')
writeFileSync(sleeper, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 120000)\n")
/** A PowerShell script that starts a sleeper through Start-Process, then waits */
const startsSleeper = (name: string) =>
  Buffer.from(
    `Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '"${sleeper}" "${join(out, `${name}.pid`)}"'; Start-Sleep 120`,
    'utf16le',
  ).toString('base64')

spawnGrouped(powershell, ['-NoProfile', '-EncodedCommand', startsSleeper('grouped')], { stdio: 'ignore' })
// Under Git for Windows' sh (MSYS), as a git hook or Claude Code's Bash tool runs: a git alias starting with `!`
spawnGrouped('git', ['-c', `alias.sleeper=!'${powershell.replaceAll('\\', '/')}' -NoProfile -EncodedCommand ${startsSleeper('gitsh')}`, 'sleeper'], { stdio: 'ignore', cwd: tmpdir() })
const pty = createRequire(import.meta.url)('node-pty') as PtyModule
spawnPty(pty, { file: powershell, args: ['-NoProfile', '-EncodedCommand', startsSleeper('pty')] }, { cols: 80, rows: 24, cwd: tmpdir() })

writeFileSync(join(out, 'job.json'), JSON.stringify(job))
setInterval(() => {}, 60_000)
