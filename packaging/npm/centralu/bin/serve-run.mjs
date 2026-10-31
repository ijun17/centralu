/** `centralu serve` in the foreground, `--connection` and `--rotate-token` */
import { spawn } from 'node:child_process'
import { writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { isAlive, say } from './serve-util.mjs'
import { SERVE_STATE_FILE, SERVE_PID_FILE, readStopped, serveDataDir, ensureServeState, recordServePort, rotateServeToken, heldHere, lockHolder, lockHolderPid, removeServePid, pairServe, pairKeyServe, dropVerifierUnder, revokeServe, legacyHostTokenOf, dropLegacyHostToken } from './serve-files.mjs'
import { DEFAULT_SERVE_PORT, SERVE_PORT_TRIES, chooseServePort, listensHere, windowsListening } from './serve-port.mjs'
import { keepLauncher, installInfo } from './serve-install.mjs'
import { protocolVersionOf, connectionLine, hostEnv, hostCommand, readyPort, hostProvesOf, probeHost, probeKeyProof, serveFrom, takesTokenOnStdin, tokenLine, keyLine, takesVerifiers, takesKeyHellos, ownCredentials } from './serve-host.mjs'
import { hostLinkPublicKey } from './serve-keys.mjs'
import { autostartInfo } from './serve-autostart.mjs'
import { moveIntoSignIn } from './serve-handover.mjs'

/**
 * The data folder a command that may start or describe a host works in: its state, created on first use, and the
 * launcher serve keeps there brought up to date (`keepLauncher`).
 */
export function serveFolder({ env, home, cliPath, platform = process.platform }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir, platform)
  keepLauncher(dataDir, cliPath, env)
  return { dataDir, state }
}

/**
 * What `--connection` answers, as fields: the running host's versions when one answers, else the installed ones.
 *
 * The credentials (#1405): `paired` (`--pair`, `{ token, id }`) is a full credential just made for whoever asked, and
 * the only one this ever prints; without it the line carries the limited credential, which reads and does the everyday
 * things. An installed host from before verifiers knows one token: `--pair` hands out that one (`legacyHostTokenOf`).
 * `others` names the full credentials the folder holds besides the one just paired, never their values, each marked
 * `replaced` when its pairing took the place of an earlier one of its label.
 */
export async function describe({ env, dataDir, state, entry, version, paired = null, keyPaired = null }) {
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry)
  // Whether the installed host proves it holds the token (#838): asked of the running one before its hello, and said in the line
  const proof = hostProvesOf(entry)
  const own = ownCredentials(state, entry)
  const probe = await probeHost({ port, ...own, protocolVersion: installed, prove: proof })
  const protocolVersion = (probe.running ? probe.protocolVersion : undefined) ?? installed
  if (protocolVersion === null) return null
  const hostRunning = heldHere(probe, dataDir, undefined, state.port != null)
  // The person stopped it here (#1143): said while no host runs, so a hub starts none by itself
  const stopped = hostRunning ? null : readStopped(dataDir)
  const verifiers = takesVerifiers(entry)
  return {
    proof,
    port,
    ...(paired ? { token: paired.token, ...(paired.id ? { credential: paired.id } : {}) } : {}),
    // A key pairing (#1711): the key the running host signs with and the entry it signs for, never a credential
    ...(keyPaired ? { hostKey: keyPaired.hostKey, keyId: keyPaired.keyId } : {}),
    ...(verifiers ? { limited: state.token } : {}),
    /*
     * The hubs' key entries are listed too, with their public keys (#1711, §4.4), which a hub compares with its own; the
     * one this line pairs is left out, as the full credential just paired is
     */
    others: [
      ...state.full.filter((e) => e.id !== paired?.id).map(({ id, label, created, replaced }) => ({ id, label, created, ...(replaced ? { replaced: true } : {}) })),
      ...(state.keys ?? []).filter((k) => k.id !== keyPaired?.keyId).map(({ id, label, created, replaced, publicKey }) => ({ id, label, created, publicKey, ...(replaced ? { replaced: true } : {}) })),
    ],
    version: (probe.running ? probe.version : undefined) ?? version,
    protocolVersion,
    dataDir,
    hostRunning,
    install: installInfo(dataDir, env),
    autostart: autostartInfo(dataDir, process.platform, env),
    ...(stopped ? { stopped } : {}),
  }
}

/**
 * `centralu serve --connection`. stdout carries exactly one line, the JSON; everything else goes to
 * stderr. Exit 1 when there is no host to describe.
 */
export async function printConnection({ env, home, entry, version, cliPath, pair = null, pairKey = null, keyPaired = false, probeKey = probeKeyProof }) {
  const folder = serveFolder({ env, home, cliPath })
  const { dataDir } = folder
  let { state } = folder
  // `--pair <label>` (#1405): a full credential for whoever asked, printed once and written down as its verifier only
  let paired = null
  // `--pair-key <label> <key>` (#1711): a key pairing when the host that will check it signs; else a verifier pairing as `--pair`
  let keyLine = null
  if (pairKey !== null) {
    const made = pairKeyServe(dataDir, pairKey.label, pairKey.publicKey)
    state = made.state
    const hostKey = await signingHostKey({ dataDir, state, entry, keyId: made.entry.id, hubKey: pairKey.publicKey, probeKey })
    if (hostKey) {
      keyLine = { hostKey, keyId: made.entry.id }
      // The hub paired by key here before (§4.2): its verifier entry under the label is no longer its own, and goes now
      if (keyPaired) state = dropVerifierUnder(dataDir, pairKey.label)
      say(`paired the key of ${JSON.stringify(pairKey.label)} (${made.entry.id}); serve --revoke ${made.entry.id} withdraws it`)
    } else {
      // The key entry stays: it is public, and a host that signs uses it once one runs here
      pair = pairKey.label
    }
  }
  if (pair !== null) {
    if (takesVerifiers(entry)) {
      const made = pairServe(dataDir, pair)
      state = made.state
      paired = { token: made.token, id: made.id }
      say(`made a full credential for ${JSON.stringify(pair)} (${made.id}); serve --revoke ${made.id} withdraws it`)
    } else {
      paired = { token: legacyHostTokenOf(dataDir), id: null }
    }
  }
  const d = await describe({ env, dataDir, state, entry, version, paired, keyPaired: keyLine })
  if (!d) {
    say(`cannot read the protocol version of the host at ${entry}`)
    return 1
  }
  process.stdout.write(`${connectionLine(d)}\n`)
  return 0
}

/**
 * The key the host that checks a key hello signs with (#1711, docs/plans/key-pairing.md §4.2), or null when a key
 * pairing cannot be made now and the line pairs by verifier:
 *
 * - the running host signs a `prove` for the entry: the key it signs with, which after `--rotate-token` is still its old
 *   one until it restarts;
 * - nothing listens on the port (the connection refused), nothing holds the data folder (`host.lock`: no keeper's host,
 *   no host starting) and the installed host takes key hellos: the key derived from serve.json's `key`, which the host
 *   started next is handed;
 * - otherwise (a host that does not sign, no answer in time, a proof that does not verify, a holder of the folder):
 *   null. A slow old host never gets a key line, and no line reports a key the running host does not sign with.
 */
async function signingHostKey({ dataDir, state, entry, keyId, hubKey, probeKey }) {
  const port = state.port ?? DEFAULT_SERVE_PORT
  const probe = await probeKey({ port, keyId, hubKey })
  if (probe.outcome === 'signed') return probe.hostKey
  if (probe.outcome !== 'none' || !takesKeyHellos(entry)) return null
  const holder = lockHolder(dataDir)
  if (holder && isAlive(holder.pid)) return null
  return hostLinkPublicKey(state.key)
}

/**
 * `centralu serve`. Resolves with the exit code once the host has exited.
 *
 * The host's stdout is read here and never passed on: its ready line carries the token, which is
 * printed nowhere but `--connection`. Every other line the host writes to stdout (a lock conflict,
 * a store from a newer build) it also writes to stderr, which is passed through untouched.
 *
 * `logFd` is serve.log of a detached launcher (`runDetachedChild`): the host's stderr goes there
 * until it is ready, so a host that dies while starting (a native module that does not load, a store
 * from a newer build) says why in a file `--detach` can quote. From then on host.log has every line,
 * and serve.log stops growing.
 */
export async function runServe({ env, home, entry, version, cliPath, port: askedPort, from = null, platform = process.platform, execPath = process.execPath, logFd = null, handOver = moveIntoSignIn }) {
  const { dataDir, state } = serveFolder({ env, home, cliPath, platform })
  const protocolVersion = protocolVersionOf(entry)

  // A serve that is already up answers on the port it recorded; say so before starting a host that
  // would only fail on the data folder's lock with a less specific message.
  const recorded = state.port ?? DEFAULT_SERVE_PORT
  const existing = await probeHost({ port: recorded, ...ownCredentials(state, entry), protocolVersion, prove: hostProvesOf(entry) })
  // A host the hub's ssh started before anyone signed in moves into this sign-in, once idle (#1224, serve-handover.mjs)
  if (heldHere(existing, dataDir, undefined, state.port != null) && !(await handOver({ dataDir, entry, env, existing, platform }))) {
    const pid = lockHolderPid(dataDir)
    say(`centralu serve is already running for ${dataDir} on 127.0.0.1:${recorded}${pid ? ` (pid ${pid})` : ''}. Not starting a second one.`)
    return 1
  }

  const onWindows = await windowsListening(env, platform)
  const chosen = await chooseServePort({ asked: askedPort, recorded: state.port, taken: async (p) => onWindows.has(p) || (await listensHere(p)) })
  if (chosen === null) {
    say(`another program listens on 127.0.0.1:${recorded} and on the ${SERVE_PORT_TRIES - 1} ports above it. Give a free one with --port <n>.`)
    return 1
  }
  const port = chosen.port
  if (chosen.from !== null) {
    const who = onWindows.has(chosen.from) ? 'Windows' : 'another program'
    say(`127.0.0.1:${chosen.from} is in use by ${who}; starting on ${port} instead (kept for the next start)`)
  }

  const plan = hostCommand(execPath, entry, { port, dataDir, platform })
  const onStdin = takesTokenOnStdin(entry)
  /*
   * A host that takes verifiers (#1405) gets the key on stdin and the path of serve.json, whose full credentials it
   * checks at each hello; nothing it gets opens it whole. An older host gets the one token it knows, kept for it
   */
  const verifiers = takesVerifiers(entry)
  if (verifiers) dropLegacyHostToken(dataDir, platform)
  const legacy = verifiers ? null : legacyHostTokenOf(dataDir, platform)
  const child = spawn(plan.command, plan.args, {
    stdio: ['pipe', 'pipe', logFd === null ? 'inherit' : 'pipe'],
    env: hostEnv(env, {
      dataDir,
      version,
      hostDir: dirname(entry),
      from: serveFrom(env, from),
      ...(verifiers ? { serveState: join(dataDir, SERVE_STATE_FILE) } : {}),
      ...(onStdin ? {} : { legacyToken: legacy ?? state.token }),
    }),
    detached: plan.detached,
    windowsHide: true,
  })
  // What the host holds, before anything else on the pipe it watches (#538); stdin stays open for --watch-parent
  if (onStdin) child.stdin.write(verifiers ? keyLine(state.key) : tokenLine(legacy))

  let ready = false
  if (logFd !== null) {
    // Read to the end in any case: a pipe nobody drains stops the host once its buffer is full
    child.stderr.on('data', (b) => {
      if (ready) return
      try {
        writeSync(logFd, b)
      } catch {
        // the log is a convenience
      }
    })
  }
  if (child.pid) {
    try {
      writeFileSync(join(dataDir, SERVE_PID_FILE), `${JSON.stringify({ pid: process.pid, hostPid: child.pid, port })}\n`)
    } catch (e) {
      say(`could not write ${SERVE_PID_FILE}: ${e.message}`)
    }
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const p = readyPort(line)
    if (p === null || ready) return
    ready = true
    try {
      recordServePort(dataDir, p, platform)
    } catch (e) {
      say(`could not record the port in ${join(dataDir, SERVE_STATE_FILE)}: ${e.message}`)
    }
    say(`listening on 127.0.0.1:${p} (Centralu ${version}, protocol ${protocolVersion ?? 'unknown'}, data ${dataDir})`)
    if (logFd === null) say(`from your computer: ssh -N -L ${p}:127.0.0.1:${p} <this machine>, or let the app connect over SSH`)
    else say(`the host's own log continues in ${join(dataDir, 'host.log')}`)
  })

  /*
   * One signal to the host alone, whatever reached this launcher. SIGHUP (the terminal closed) is
   * passed as SIGTERM: the host has no SIGHUP handler, and Node's default for it is to exit on the
   * spot, skipping the shutdown that stops the agents. A second signal changes nothing on the host
   * side (its shutdown runs once), so forwarding every one is safe.
   */
  const forward = (sig) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (platform === 'win32') return // the host shares the console and received Ctrl+C itself
    try {
      child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig)
    } catch {
      // already gone
    }
  }
  const signals = platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, forward)

  return await new Promise((resolve) => {
    child.on('error', (e) => {
      removeServePid(dataDir, process.pid)
      say(`could not start the host (${plan.command}): ${e.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      for (const s of signals) process.off(s, forward)
      removeServePid(dataDir, process.pid)
      if (!ready && code !== 0) {
        const holder = lockHolder(dataDir)
        if (holder && holder.pid !== child.pid && isAlive(holder.pid)) {
          // Who it is, when its host.lock says (#1223)
          const who = { app: 'the Centralu window on this machine', keeper: "Centralu's keeper on this machine", serve: 'another centralu serve' }[holder.by] ?? 'probably the Centralu app on this machine'
          say(`the host did not start. ${dataDir} belongs to another Centralu host (pid ${holder.pid}), ${who}. Quit it, or point CC_DATA_DIR at another folder.`)
        }
      }
      if (logFd !== null) say(`the host exited (${signal ?? code})`)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

/** `centralu serve --rotate-token`: a new key, and every full credential withdrawn (#1405) */
export function rotateToken({ env, home }) {
  const dataDir = serveDataDir(env, home)
  rotateServeToken(dataDir)
  say(`replaced the key and withdrew every full credential in ${join(dataDir, SERVE_STATE_FILE)}.`)
  say('A linked computer pairs again at its next connection, and a window at its next start. A serve that is running keeps its old key until it restarts: the limited credential --connection prints works once it has.')
  return 0
}

/** `centralu serve --revoke <id>`: one full credential withdrawn (#1405); its next hello is refused, and the host closes a socket already in with it */
export function revokeCredential({ env, home, id, write = (line) => process.stdout.write(line) }) {
  const dataDir = serveDataDir(env, home)
  const revoked = revokeServe(dataDir, id)
  // One JSON line on stdout, as every serve command a hub runs prints one: whether there was one to withdraw
  write(`${JSON.stringify({ v: 1, revoked, id })}
`)
  if (!revoked) {
    say(`no full credential ${JSON.stringify(id)} in ${join(dataDir, SERVE_STATE_FILE)}; --connection lists them under others.`)
    return 1
  }
  say(`withdrew the full credential ${id}. A running host refuses its next hello and closes a connection already open with it within a second.`)
  return 0
}
