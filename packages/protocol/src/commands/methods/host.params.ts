import { z } from 'zod'
import { SessionId } from '../../entities.js'
import { HostHandover } from '../../host-logon.js'
import { MachineConnect, MachineId, RemoteShell } from '../../machines.js'
import { HubOffer } from '../../machines-hub.js'

/** The parameters of the `host` methods, which the host validates (docs/protocol.md §3). Their results: ./host.results.ts */
export const hostParams = {
  /**
   * Where this install stands against the registry (issue #43).
   *
   * `force` is the difference between "what do you already know" (app start, cheap,
   * no network) and "go look now" (the Check now button). One method rather than two
   * because the answer is the same shape either way, and a caller that wants a fresh
   * answer wants the same fields a stale one has.
   *
   * **This never rejects for a network failure.** A version check that can break the
   * screen it decorates is worse than no version check; what went wrong comes back in
   * `error` instead, where the person who pressed the button can read it.
   */
  'updates.status': z.object({ force: z.boolean().default(false) }),
  /**
   * Turn the periodic check on or off.
   *
   * The host holds this, not the UI, because the host is what owns the timer — a
   * preference kept on the other side of the wire from the thing it governs is one
   * that eventually stops governing it.
   */
  'updates.setAuto': z.object({ enabled: z.boolean() }),
  /**
   * "Apply updates automatically when idle" on or off (#352). The host holds it for the same
   * reason as `updates.setAuto`: the host is what installs. Turning it on with a newer version
   * already known starts the install at once; the window applies it once nothing is busy.
   */
  'updates.setAutoApply': z.object({ enabled: z.boolean() }),
  /**
   * Install the newer version. Asked for by the person, or by `autoApply` (#352) when a check
   * finds a newer version — never otherwise.
   *
   * Answers as soon as the work has *started*, not when it has finished: `npm i -g`
   * routinely outruns the 30s RPC deadline, and a call that times out while the
   * install keeps going leaves the screen saying the opposite of what happened.
   * Progress arrives as `update_status` events instead.
   */
  'updates.apply': z.object({}),
  /**
   * A window's answer to `update_apply_request` (#665): whether its "Apply now" could relaunch into the installed build
   * right now, and why not. The first window that is ready gets a ticket; every other answer, and any answer after the
   * host stopped asking, gets null.
   */
  'updates.answerApply': z.object({
    requestId: z.string(),
    ready: z.boolean(),
    reason: z.string().optional(),
    version: z.string().optional(),
  }),
  /**
   * The picked window's outcome (#665): `started` right before it relaunches, then with `error` when it did not, or
   * with neither once the shell accepted the relaunch. A relaunching window may close before that last report; the
   * host reads its connection ending as the relaunch only after `started`.
   */
  'updates.reportApply': z.object({
    requestId: z.string(),
    ticket: z.string(),
    started: z.boolean().optional(),
    error: z.string().optional(),
  }),
  /**
   * The host requests waiting for the person (#1405, `HostRequest`), oldest first: what a window shows after it
   * connects or reconnects, since a `host_request` event it missed is not sent again. Additive
   */
  'requests.list': z.object({}),
  /**
   * The person's answer to a host request (#1405). Only a window holding the token may answer (the limited credential
   * is refused it). `ok` is false when the request is no longer waiting: answered in another window, withdrawn by the
   * program that asked, or past its time. Additive
   */
  'requests.answer': z.object({ requestId: z.string().min(1).max(100), decision: z.enum(['allow', 'deny']) }),
  /**
   * Linked machines (#82, docs/plans/remote-hub.md). The hub's own: these are never forwarded.
   * Adding one is the consent for this computer to reach that machine (plan §3.2): the person can
   * already open an SSH connection to it. The link uses the person's own `ssh` and keys
   * (`BatchMode`), and expects `centralu serve` running there (docs/agent-host.md §4.7).
   */
  'machines.list': z.object({}),
  'machines.add': z.object({
    name: z.string().min(1).max(64),
    sshTarget: z.string().min(1).max(255),
    shell: RemoteShell.default('posix'),
    wslDistro: z.string().max(64).nullable().optional(),
    command: z.string().max(1024).nullable().optional(),
  }),
  /**
   * The concrete `Host` aliases of the ssh config of the computer this host runs on (#514): `~/.ssh/config`
   * and what it `Include`s, read by the host (never the window), each resolved by `ssh -G`, with the
   * machines already linked through it. Pattern-only entries and `Match` blocks are left out. Nothing
   * is connected to and no key file is opened. Additive
   */
  'machines.sshHosts': z.object({}),
  /**
   * One BatchMode ssh to a target, to tell what runs there before it is linked (#514): a Unix shell, or
   * Windows with its default shell and WSL distros. Never a password or host-key prompt; a target that
   * cannot be reached answers `reachable: false` with ssh's reason. Nothing there is changed. Additive
   */
  'machines.probe': z.object({ sshTarget: z.string().min(1).max(255) }),
  /** Unlinks a machine: its sessions and projects leave this computer's lists. Nothing on the machine changes */
  'machines.remove': z.object({ machineId: MachineId }),
  /**
   * Tries the link again now instead of waiting out its backoff. A disconnected machine is connected (the row's
   * Connect, #1134), and stays connected until `machines.disconnect` or the hub stops. With Auto reconnect off (#1341) it is
   * the only way to try again after a drop or a failed attempt
   */
  'machines.reconnect': z.object({ machineId: MachineId }),
  /**
   * Closes the link and tries none until the person connects it again or the hub starts again (#1134). The machine stays linked, with its sessions and projects listed as last
   * known; they keep running there. Additive
   */
  'machines.disconnect': z.object({ machineId: MachineId }),
  /**
   * Auto reconnect on or off for this machine (#1341, `MachineInfo.autoReconnect`). Kept with the machine. Turning it
   * off while connected leaves the link up; turning it on while the link is away tries again now. Additive
   */
  'machines.setAutoReconnect': z.object({ machineId: MachineId, autoReconnect: z.boolean() }),
  /**
   * The older connect mode (#1134), kept for one release (#1341): `at_start` is Auto reconnect on, `when_needed` off.
   * Use `machines.setAutoReconnect`
   */
  'machines.setConnect': z.object({ machineId: MachineId, connect: MachineConnect }),
  /**
   * Said by a window of the connect mode (#1134) while one of a machine's projects or sessions was open. Nothing connects
   * a machine on a need any more (#1341): it answers the row as it is and does nothing. Accepted for one release so an
   * older window does not fail
   */
  'machines.need': z.object({ machineId: MachineId, repeat: z.boolean().optional() }),
  /**
   * Connects although the two sides run different versions of one protocol: the person declined to
   * align them (plan §4). Remembered for this pair of versions only; when either side moves, the
   * question comes again. Refused when the protocols differ.
   */
  'machines.acceptVersions': z.object({ machineId: MachineId }),
  /**
   * Installs this hub's version on a linked machine over its ssh (docs/plans/remote-hub.md §10.2):
   * the pinned Node and the npm packages, checked against the release's pin and the registry's
   * signed metadata, beside what is there, with `current` switched to it and `previous` kept. A
   * host running there is not touched; the next start runs the new version (`machines.update` stops
   * and starts it in order). Refused by a development hub (its version is not on npm) and for
   * a machine that runs a command of its own; answers when the install is done or refused
   */
  'machines.install': z.object({ machineId: MachineId }),
  /**
   * Updates a linked machine to this hub's version (docs/plans/remote-hub.md §10.5): installs it beside
   * the running one, stops the running host in order (`centralu serve --stop`; without a keeper its
   * agents end and resume on the new host, a turn in progress is lost), switches `current`, starts it
   * (`serve --detach`) and waits at most 30 s for a hello from the new version. When none comes, the
   * old version is put back and started, and the call fails with the end of the new host's log. On
   * success only the current and previous versions are kept. Progress is the machine's `operation`
   * in `machine_status`. Refused like `machines.install`
   */
  /**
   * `when` (#1399, additive): `idle`, the default and what an older window means, installs beside and then waits until no session
   * there is in a turn (`MachineInfo.operation.step` is `wait_idle` meanwhile; `machines.cancelUpdate` ends the wait) before it
   * stops the host; `now` stops it at once and says what it stopped (the person chose it)
   */
  'machines.update': z.object({ machineId: MachineId, when: z.enum(['idle', 'now']).optional() }),
  /** Ends an update's wait for the sessions there to finish (#1399); the update fails saying so and nothing was switched. Additive */
  'machines.cancelUpdate': z.object({ machineId: MachineId }),
  /**
   * Switches a machine back to the version the hub installed before (`previous`), stopping and starting
   * its host as `machines.update` does and checking the same way. One step only: `previous` is cleared,
   * so a second rollback is not offered (a store migrated twice may not read on the older build)
   */
  'machines.rollback': z.object({ machineId: MachineId }),
  /**
   * Stops the host there and removes what the hub installed (`<data>/remote/`), keeping the machine's
   * data and an npm install of its own. The machine stays linked
   */
  'machines.uninstall': z.object({ machineId: MachineId }),
  /**
   * Starts a linked machine's host at boot, or stops doing that, or (without `on`) reads whether it
   * does (docs/plans/remote-hub.md §10.4, owner decision 4: per machine, off by default). The
   * Centralu there writes its own entry (`centralu serve --autostart`): a systemd user unit with
   * lingering on Linux, a scheduled task at sign-in on Windows and for WSL. A host running there is
   * neither started nor stopped. Refused by a machine that predates it or offers none (macOS)
   */
  'machines.autostart': z.object({ machineId: MachineId, on: z.boolean().optional() }),
  /**
   * What would stop on a linked machine if its host stopped now (`host.activity`, asked of it), for the
   * "Update <machine>" prompt. Null when the machine cannot say (unreachable, other protocol, older)
   */
  'machines.activity': z.object({ machineId: MachineId }),
  /**
   * A linked machine's own "Allow auto from a linked computer" switch (#1273 review, owner decision 2026-10-19), read,
   * or set when `allowed` is given (`host.hubAuto` / `host.setHubAuto` there), for the hub's Settings → Machines: a
   * machine with no window of its own (`centralu serve`) is set here. The machine reads it at each start; this is the
   * person's say, no boundary against the hub. `older`: that machine's Centralu predates it; `unreachable`: the link is
   * not up. Additive
   */
  'machines.hubAuto': z.object({ machineId: MachineId, allowed: z.boolean().optional() }),
  /**
   * Lets a linked machine's sessions ask this computer's projects, or stops it (#550, docs/plans/remote-hub.md §12.7,
   * owner decision 2026-10-18): the per-machine switch, off by default, stored with the machine. Each pair (a session
   * there, a project here) is asked on this computer's card once; off forgets every pair approved for it. Additive
   */
  'machines.setAsks': z.object({ machineId: MachineId, on: z.boolean() }),
  /** The pairs approved for the reverse direction, every machine's, newest first (#550). Additive */
  'machines.askConsents': z.object({}),
  /** Withdraws one approved pair: that session's next ask into that project raises the card again (#550). Additive */
  'machines.withdrawAsk': z.object({
    machineId: MachineId,
    sessionId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  /** What would stop if this host stopped now (the `hostBusy` rule); for a hub's `machines.activity` */
  'host.activity': z.object({}),
  /**
   * What a hub's orchestrator reads about this host's sessions (docs/plans/remote-hub.md §12): the sessions a hub's
   * window shows (not this host's orchestrator or coordinators), one conversation, and a search over them. Asked of a
   * linked machine by the hub directly, never routed; this host's own window has no use for them. A read is capped at
   * 200 lines and a search at 50 hits
   */
  'host.sessions': z.object({}),
  'host.readSession': z.object({
    sessionId: SessionId,
    limit: z.number().int().positive().optional(),
    /** A `seq` `host.recall` gave: reads around it rather than the end */
    around: z.number().int().optional(),
    /** Tool calls in full rather than one line each */
    tools: z.boolean().optional(),
    /**
     * With `around`, the one line that starts there, from this character of its text on (#1186): a long line is cut,
     * and says this offset to read on from. Additive: an older machine ignores it and answers the plain read
     */
    offset: z.number().int().min(0).optional(),
    /**
     * What to show of a tool call (#1480): `none`, `titles` or `full`; `tools: true` is `full`. Additive, and `tools`
     * stays a boolean for a machine from before it, which would refuse the words: an older machine ignores this one
     */
    toolLines: z.enum(['none', 'titles', 'full']).optional(),
    /** The most characters the lines come to in all (#1480); 12,000 by default, 2,000 to 40,000. Additive: an older machine ignores it */
    maxChars: z.number().int().min(2000).max(40_000).optional(),
    /** The read on a budget's note names (#1480): the lines older than this seq, back from it. Additive: an older machine ignores it */
    before: z.number().int().optional(),
    /** The read on a budget's note names (#1480): the lines from this seq on, forward. Additive: an older machine ignores it */
    from: z.number().int().optional(),
  }),
  'host.recall': z.object({ query: z.string(), limit: z.number().int().positive().optional() }),
  /**
   * Whether this host takes `auto` for a session a hub's `auto` session starts here (#1273, start_agent with a
   * machine): its own "Allow auto from a linked computer" switch (`UiPreferences.hubAuto`, on by default). The hub reads
   * it before it decides whether to raise its card; `agents.createSession`'s `fromHub` reads the switch again. Asked by
   * the hub directly, never routed. A host from before it answers "Unknown method", and the hub keeps `normal`.
   */
  'host.hubAuto': z.object({}),
  /**
   * Sets that switch from the hub (#1273 review, owner decision 2026-10-19): the hub's Settings → Machines shows it for
   * each machine, so a machine with no window of its own (`centralu serve`) can be set too. It restricts what the
   * person allows and is no boundary against the hub, which holds this host's token and could ask for `auto` outright.
   * Answers the switch as it now reads. Asked by the hub directly, never routed; an older host answers "Unknown method".
   */
  'host.setHubAuto': z.object({ allowed: z.boolean() }),
  /**
   * A session's last response, whole up to `maxChars` (100,000 at most), for a hub's ask_project, start_agent and
   * reports (#1186). Asked by the hub directly, never routed, of a session a hub is shown. Additive: a hub reads an
   * older machine's lines instead. `turn` (#1604): the answer of the turn it last ran, from where this host saw that turn
   * begin, not the last response of the record (an older machine ignores it)
   */
  'host.lastAnswer': z.object({
    sessionId: SessionId,
    maxChars: z.number().int().positive().max(100_000).optional(),
    turn: z.boolean().optional(),
  }),
  /**
   * An instruction from a hub's orchestrator to one of this host's sessions (docs/plans/remote-hub.md §12, phase 4
   * step 2): delivered as the orchestrator's `send_to_session` is here, recorded as sent by `from.name`. Only a session
   * a hub is shown (not this host's orchestrator or coordinators). Asked by the hub directly, never routed
   */
  'host.send': z.object({
    sessionId: SessionId,
    text: z.string(),
    from: z.object({ name: z.string() }),
    /**
     * The text is an ask_project task (#838 item 12), and the session works on it at this agent depth until the turn
     * that consumes it is recorded: the hub's caller's depth, plus one. Absent from an older hub, and from an
     * orchestrator's instruction.
     */
    ask: z.object({ depth: z.number().int().min(1).max(64) }).optional(),
  }),
  /**
   * Stops this host the way a signal would: agents, terminals, command runs and app processes
   * stopped in order, the store closed, then exit. For `centralu serve --stop` (docs/agent-host.md
   * §4.7): on Windows a launcher can only be killed, and killing it ends the host without its
   * shutdown. Answers before the host starts to leave. Refused by a host under the app's keeper,
   * which the app stops (and which would only start the host again).
   *
   * `ifIdle` (#1224, additive): only if nothing a person would lose runs (the `hostBusy` rule) and no other call is in
   * flight, decided and acted on at once: from the answer `ok: true` on, the host takes no new call (no turn, terminal or
   * command can start), so a turn cannot slip in between the check and the stop. Otherwise `{ ok: false, busy, calls }`
   * and nothing changes. A host older than `ifIdle` ignores it and stops; the hand-over sends it only to a host that says
   * its logon, which came with it
   */
  'host.stop': z.object({ ifIdle: z.boolean().optional() }),
  /**
   * What a `serve` in the person's Windows sign-in says about taking over from this host (#1224): this host keeps it,
   * says it in its hellos and sends `host_handover`, so a hub's row can say it. `handover: null` clears it. Additive
   */
  'host.handover': z.object({ handover: HostHandover.nullable() }),
  /**
   * A hub linked to this host says who it is and whether this host's sessions may ask its projects (#550, the reverse
   * direction, docs/plans/remote-hub.md §12.7). Sent by the hub at every connect and when its switch for this machine
   * changes. This host calls that hub back (`hub.projects`, `hub.askProject`) on the connection the offer came in on
   * only, and shows it to its sessions by its name, "not reachable" once that connection is gone. Asked by the hub
   * directly, never routed. Additive
   */
  'host.hubOffer': HubOffer,
} as const
