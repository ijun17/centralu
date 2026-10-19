/** The arguments after `centralu serve`, and its help */
import { DEFAULT_SERVE_PORT } from './serve-port.mjs'

export const SERVE_HELP = `centralu serve: run the Centralu host on this machine, without a window

  centralu serve                  Start the host in the foreground, on 127.0.0.1 only
  centralu serve --port <n>       ... on that port (kept for the next start; default ${DEFAULT_SERVE_PORT})
  centralu serve --detach         Start it in the background, outside this session; return once it answers
  centralu serve --stop           Ask the running host to stop, and wait until it has
  centralu serve --window         What the Centralu window on Windows runs here: start the host if
                                  none runs, print its port and token as a ready line, stay until
                                  stdin ends, and leave the host running
  centralu serve --connection     Print how to reach it as one JSON line, then exit
  centralu serve --rotate-token   Replace the token (a running serve keeps the old one until restarted)
  centralu serve --from <hub>     With serve or --detach: the name of the computer whose link asks,
                                  said by a second Centralu on this data folder when it is refused
  centralu serve --autostart on|off|status
                                  Start it when this machine starts (Linux: a systemd user unit;
                                  Windows and WSL: a scheduled task at sign-in), stop doing that,
                                  or say whether it does. Turning it on or off leaves a host that
                                  runs now as it is

The data folder is ~/.centralu (CC_DATA_DIR overrides it). The app on another computer reaches
this host through an SSH local forward, and starts it with --detach when it is not running.
Stop a foreground one with Ctrl+C or SIGTERM, a detached one with --stop. A detached one writes
how its start went to serve.log in the data folder; the host's own log is host.log.

serve, --detach and --connection keep ~/.centralu/bin/centralu up to date: a launcher with absolute
paths, for SSH sessions whose PATH has neither npm's global folder nor node. Not when they run
from an install the app made over SSH, which has a launcher of its own.`

/** The flags that each make serve a different command */
const MODE_FLAGS = { '--connection': 'connection', '--rotate-token': 'rotate', '--detach': 'detach', '--stop': 'stop', '--window': 'window' }
const FLAG_OF = { ...Object.fromEntries(Object.entries(MODE_FLAGS).map(([f, m]) => [m, f])), autostart: '--autostart' }

/** What `--autostart` takes */
export const AUTOSTART_ACTIONS = ['on', 'off', 'status']

/**
 * The argument a detached launcher is started with: what it needs from the `--detach` that started
 * it, which a process created through WMI does not inherit (it gets the account's default
 * environment, not this one). Never a secret: the token stays in serve.json. Internal, not in the help.
 */
export const CHILD_FLAG = '--detached-child='

/**
 * What `--from` takes (#1223): a hub's name, short and of characters that cannot break the sentence a refused host says
 * it in, nor a command line. The hub sends its own host name, cleaned the same way (`hubNameForRemote`, links/tunnel.ts)
 */
export const FROM_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * What the arguments after `serve` ask for: `{ mode, port }` (plus `child` for a detached launcher,
 * `autostart` for `--autostart`) or `{ error }`.
 *
 * `mode` is `serve`, `detach`, `stop`, `connection`, `rotate`, `autostart` or `help`; `port` is null
 * when not given. `--port` goes with `serve` and `--detach` only: `--connection` has to report the
 * port `serve` uses, not one the caller names, `--stop` stops the one that runs, and the entry
 * `--autostart` writes starts serve on the port it recorded.
 */
export function parseServeArgs(argv) {
  let mode = 'serve'
  let port = null
  let help = false
  let child = null
  let autostart = null
  let from = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--autostart' || a.startsWith('--autostart=')) {
      const raw = a === '--autostart' ? argv[++i] : a.slice('--autostart='.length)
      if (!AUTOSTART_ACTIONS.includes(raw)) return { error: `--autostart needs on, off or status (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})` }
      if (mode !== 'serve' && mode !== 'autostart') return { error: `${FLAG_OF[mode]} and --autostart are separate commands; pass one` }
      mode = 'autostart'
      autostart = raw
    } else if (Object.hasOwn(MODE_FLAGS, a)) {
      const m = MODE_FLAGS[a]
      if (mode !== 'serve' && mode !== m) return { error: `${FLAG_OF[mode]} and ${a} are separate commands; pass one` }
      mode = m
    } else if (a === '--help' || a === '-h') help = true
    else if (a.startsWith(CHILD_FLAG)) child = a.slice(CHILD_FLAG.length)
    else if (a === '--port' || a.startsWith('--port=')) {
      const raw = a === '--port' ? argv[++i] : a.slice('--port='.length)
      const n = parsePort(raw)
      if (n === null) return { error: `--port needs a port number between 1 and 65535 (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})` }
      port = n
    } else if (a === '--from' || a.startsWith('--from=')) {
      const raw = a === '--from' ? argv[++i] : a.slice('--from='.length)
      if (typeof raw !== 'string' || !FROM_RE.test(raw)) return { error: `--from needs a computer's name: letters, digits, '.', '_' and '-' (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})` }
      from = raw
    } else return { error: `unknown option for serve: ${a}\n\n${SERVE_HELP}` }
  }
  if (help) return { mode: 'help', port }
  if (from !== null && mode !== 'serve' && mode !== 'detach') return { error: `--from goes with \`centralu serve\` and --detach, which start a host; not with ${FLAG_OF[mode]}` }
  if (child !== null) {
    if (mode !== 'serve') return { error: `${CHILD_FLAG.slice(0, -1)} is how --detach starts serve, not an option of ${FLAG_OF[mode]}` }
    return { mode, port, child, ...(from !== null ? { from } : {}) }
  }
  if ((mode === 'connection' || mode === 'rotate') && port !== null) {
    return { error: '--port goes with `centralu serve`; `--connection` reports the port serve listens on' }
  }
  if (mode === 'stop' && port !== null) return { error: '--stop stops the serve that is running, on the port it recorded; it takes no --port' }
  if (mode === 'window' && port !== null) return { error: '--window uses the serve that runs, or starts one on the port it recorded; it takes no --port' }
  if (mode === 'autostart') {
    if (port !== null) return { error: '--autostart takes no --port: the entry it writes starts serve on the port serve recorded' }
    return { mode, port, autostart }
  }
  return { mode, port, ...(from !== null ? { from } : {}) }
}

function parsePort(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : null
}
