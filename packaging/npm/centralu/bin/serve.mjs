/**
 * `centralu serve`: the host without the app, for the remote mode's first phase (#82).
 *
 * The person starts this by hand on another machine (an SSH server, later a laptop). It runs the
 * same bundled host the app runs (`resources/host/main.mjs`, on the system Node), with no window
 * and no keeper, bound to 127.0.0.1 only. The app on the person's own computer reaches it through
 * an SSH local forward, so nothing ever listens on a public interface. The design and its limits
 * are in docs/agent-host.md §4.7; the trust argument in docs/security-boundaries.md.
 *
 * `centralu serve --connection` is the one question the client asks over `ssh <target>`: where to
 * forward and how to authenticate. It answers with one JSON line on stdout and nothing else.
 *
 * Everything here takes its inputs as arguments (environment, home, platform) instead of reading
 * `process`, so `tooling/launcher-serve.test.ts` can import it: `centralu.mjs` runs a command at
 * import time and cannot be imported by a test. package.json "files" lists the whole bin/
 * directory, so this ships automatically.
 *
 * This file is the launcher's `serve` as one module, for `centralu.mjs`, the tests, and the hub's
 * installer (which imports an installed version's `serve.mjs` for `managedLauncherScript`). The code
 * lives beside it, one concern per file: the arguments (`serve-args.mjs`), the files in the data
 * folder (`serve-files.mjs`), the port (`serve-port.mjs`), the launchers and the managed install
 * (`serve-install.mjs`), the host and its socket (`serve-host.mjs`), the foreground serve
 * (`serve-run.mjs`), `--detach` and `--stop` (`serve-detach.mjs`), `--autostart`
 * (`serve-autostart.mjs`), Windows, WSL and PowerShell (`serve-windows.mjs`), and small helpers
 * (`serve-util.mjs`).
 */
export { SERVE_STATE_FILE, SERVE_LOG_FILE, SERVE_PID_FILE, serveDataDir, readServeState, ensureServeState, recordServePort, rotateServeToken, pairServe, revokeServe, verifierOf, limitedOf, legacyHostTokenOf, changeServeState, heldHere, lockHolderIsAlive, processStartTime, lockHolder, lockHolderPid, readServePid, SERVE_STOPPED_FILE, SERVE_LOGS_KEPT, markStopped, readStopped, rotateServeLog } from './serve-files.mjs'
export { detachHow, windowsArg, wmiScript, parseWmiAnswer, wmiBlockedMessage, windowsPowershell, ownLogon } from './serve-windows.mjs'
export { DEFAULT_SERVE_PORT, SERVE_PORT_TRIES, chooseServePort, listensHere, parseNetstatListening } from './serve-port.mjs'
export { SERVE_HELP, AUTOSTART_ACTIONS, parseServeArgs, PAIR_LABEL_RE, CREDENTIAL_ID_RE } from './serve-args.mjs'
export { launcherScript, ensureLauncher, remoteLayout, parsePointer, installInfo, managedLauncherScript } from './serve-install.mjs'
export { protocolVersionOf, connectionLine, hostEnv, hostCommand, readyPort, mismatchServerVersion, hostProvesOf, probeHost, askHostToStop, askHostRpc, serveFrom, takesTokenOnStdin, tokenLine, keyLine, takesVerifiers, ownCredentials } from './serve-host.mjs'
export { stopServedHost, moveIntoSignIn, HANDOVER_WAIT_MS } from './serve-handover.mjs'
export { runWindow } from './serve-window.mjs'
export { AUTOSTART_FILE, AUTOSTART_ENV, autostartHow, autostartUnsupported, pathKey, autostartName, autostartLauncher, systemdUnit, taskActionScript, taskScript, parseTaskAnswer, readAutostartMark, autostartInfo, lingerMessage, runAutostart, startInSignIn } from './serve-autostart.mjs'
export { printConnection, runServe, rotateToken, revokeCredential } from './serve-run.mjs'
export { CARRIED_ENV, encodeChildSpec, decodeChildSpec, startDetached, runDetach, runDetachedChild, runStop } from './serve-detach.mjs'
