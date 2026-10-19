import { z } from 'zod'
import { SessionId, UpdateStatus } from '../../entities.js'
import {
  HostActivity,
  HostReadSessionResult,
  HostRecallHit,
  HostSessionRow,
  HubOffer,
  MachineAskConsent,
  MachineAutostartResult,
  MachineConnect,
  MachineId,
  MachineInfo,
  MachineInstallResult,
  MachineProbe,
  MachineUninstallResult,
  RemoteShell,
  SshHostList,
} from '../../machines.js'

export const hostMethods = {
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
  'updates.status': {
    params: z.object({ force: z.boolean().default(false) }),
    result: UpdateStatus,
  },
  /**
   * Turn the periodic check on or off.
   *
   * The host holds this, not the UI, because the host is what owns the timer — a
   * preference kept on the other side of the wire from the thing it governs is one
   * that eventually stops governing it.
   */
  'updates.setAuto': {
    params: z.object({ enabled: z.boolean() }),
    result: UpdateStatus,
  },
  /**
   * "Apply updates automatically when idle" on or off (#352). The host holds it for the same
   * reason as `updates.setAuto`: the host is what installs. Turning it on with a newer version
   * already known starts the install at once; the window applies it once nothing is busy.
   */
  'updates.setAutoApply': {
    params: z.object({ enabled: z.boolean() }),
    result: UpdateStatus,
  },
  /**
   * Install the newer version. Asked for by the person, or by `autoApply` (#352) when a check
   * finds a newer version — never otherwise.
   *
   * Answers as soon as the work has *started*, not when it has finished: `npm i -g`
   * routinely outruns the 30s RPC deadline, and a call that times out while the
   * install keeps going leaves the screen saying the opposite of what happened.
   * Progress arrives as `update_status` events instead.
   */
  'updates.apply': {
    params: z.object({}),
    result: UpdateStatus,
  },
  /**
   * A window's answer to `update_apply_request` (#665): whether its "Apply now" could relaunch into the installed build
   * right now, and why not. The first window that is ready gets a ticket; every other answer, and any answer after the
   * host stopped asking, gets null.
   */
  'updates.answerApply': {
    params: z.object({ requestId: z.string(), ready: z.boolean(), reason: z.string().optional(), version: z.string().optional() }),
    result: z.object({ ticket: z.string().nullable() }),
  },
  /**
   * The picked window's outcome (#665): `started` right before it relaunches, then with `error` when it did not, or
   * with neither once the shell accepted the relaunch. A relaunching window may close before that last report; the
   * host reads its connection ending as the relaunch only after `started`.
   */
  'updates.reportApply': {
    params: z.object({ requestId: z.string(), ticket: z.string(), started: z.boolean().optional(), error: z.string().optional() }),
    result: z.object({}),
  },
  /**
   * Linked machines (#82, docs/plans/remote-hub.md). The hub's own: these are never forwarded.
   * Adding one is the consent for this computer to reach that machine (plan §3.2): the person can
   * already open an SSH connection to it. The link uses the person's own `ssh` and keys
   * (`BatchMode`), and expects `centralu serve` running there (docs/agent-host.md §4.7).
   */
  'machines.list': { params: z.object({}), result: z.array(MachineInfo) },
  'machines.add': {
    params: z.object({
      name: z.string().min(1).max(64),
      sshTarget: z.string().min(1).max(255),
      shell: RemoteShell.default('posix'),
      wslDistro: z.string().max(64).nullable().optional(),
      command: z.string().max(1024).nullable().optional(),
    }),
    result: MachineInfo,
  },
  /**
   * The concrete `Host` aliases of the ssh config of the computer this host runs on (#514): `~/.ssh/config`
   * and what it `Include`s, read by the host (never the window), each resolved by `ssh -G`, with the
   * machines already linked through it. Pattern-only entries and `Match` blocks are left out. Nothing
   * is connected to and no key file is opened. Additive
   */
  'machines.sshHosts': { params: z.object({}), result: SshHostList },
  /**
   * One BatchMode ssh to a target, to tell what runs there before it is linked (#514): a Unix shell, or
   * Windows with its default shell and WSL distros. Never a password or host-key prompt; a target that
   * cannot be reached answers `reachable: false` with ssh's reason. Nothing there is changed. Additive
   */
  'machines.probe': { params: z.object({ sshTarget: z.string().min(1).max(255) }), result: MachineProbe },
  /** Unlinks a machine: its sessions and projects leave this computer's lists. Nothing on the machine changes */
  'machines.remove': { params: z.object({ machineId: MachineId }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Tries the link again now instead of waiting out its backoff. A disconnected machine is connected (the row's
   * Connect, #1134), and stays connected until `machines.disconnect` or the hub stops, whatever its `connect` says
   */
  'machines.reconnect': { params: z.object({ machineId: MachineId }), result: MachineInfo },
  /**
   * Closes the link and tries none until the person connects it again, something needs a machine that connects when
   * needed, or the hub starts again (#1134). The machine stays linked, with its sessions and projects listed as last
   * known; they keep running there. Additive
   */
  'machines.disconnect': { params: z.object({ machineId: MachineId }), result: MachineInfo },
  /** When the hub opens the link: at start, or when needed (`MachineConnect`, #1134). Kept with the machine. Additive */
  'machines.setConnect': { params: z.object({ machineId: MachineId, connect: MachineConnect }), result: MachineInfo },
  /**
   * The window needs the machine now: one of its projects is open, or one of its sessions is focused (#1134). A machine
   * that connects when needed is connected, and kept so for a while after the last of these; the window says it again
   * while that project or session stays open, with `repeat`, which does not bring back a machine the person
   * disconnected. Answers at once, not when the link is up. Any other machine is left as it is. Additive: a window
   * ignores an older host's refusal
   */
  'machines.need': { params: z.object({ machineId: MachineId, repeat: z.boolean().optional() }), result: MachineInfo },
  /**
   * Connects although the two sides run different versions of one protocol: the person declined to
   * align them (plan §4). Remembered for this pair of versions only; when either side moves, the
   * question comes again. Refused when the protocols differ.
   */
  'machines.acceptVersions': { params: z.object({ machineId: MachineId }), result: MachineInfo },
  /**
   * Installs this hub's version on a linked machine over its ssh (docs/plans/remote-hub.md §10.2):
   * the pinned Node and the npm packages, checked against the release's pin and the registry's
   * signed metadata, beside what is there, with `current` switched to it and `previous` kept. A
   * host running there is not touched; the next start runs the new version (`machines.update` stops
   * and starts it in order). Refused by a development hub (its version is not on npm) and for
   * a machine that runs a command of its own; answers when the install is done or refused
   */
  'machines.install': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Updates a linked machine to this hub's version (docs/plans/remote-hub.md §10.5): installs it beside
   * the running one, stops the running host in order (`centralu serve --stop`; without a keeper its
   * agents end and resume on the new host, a turn in progress is lost), switches `current`, starts it
   * (`serve --detach`) and waits at most 30 s for a hello from the new version. When none comes, the
   * old version is put back and started, and the call fails with the end of the new host's log. On
   * success only the current and previous versions are kept. Progress is the machine's `operation`
   * in `machine_status`. Refused like `machines.install`
   */
  'machines.update': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Switches a machine back to the version the hub installed before (`previous`), stopping and starting
   * its host as `machines.update` does and checking the same way. One step only: `previous` is cleared,
   * so a second rollback is not offered (a store migrated twice may not read on the older build)
   */
  'machines.rollback': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Stops the host there and removes what the hub installed (`<data>/remote/`), keeping the machine's
   * data and an npm install of its own. The machine stays linked
   */
  'machines.uninstall': { params: z.object({ machineId: MachineId }), result: MachineUninstallResult },
  /**
   * Starts a linked machine's host at boot, or stops doing that, or (without `on`) reads whether it
   * does (docs/plans/remote-hub.md §10.4, owner decision 4: per machine, off by default). The
   * Centralu there writes its own entry (`centralu serve --autostart`): a systemd user unit with
   * lingering on Linux, a scheduled task at sign-in on Windows and for WSL. A host running there is
   * neither started nor stopped. Refused by a machine that predates it or offers none (macOS)
   */
  'machines.autostart': { params: z.object({ machineId: MachineId, on: z.boolean().optional() }), result: MachineAutostartResult },
  /**
   * What would stop on a linked machine if its host stopped now (`host.activity`, asked of it), for the
   * "Update <machine>" prompt. Null when the machine cannot say (unreachable, other protocol, older)
   */
  'machines.activity': { params: z.object({ machineId: MachineId }), result: z.object({ activity: HostActivity.nullable() }) },
  /**
   * Lets a linked machine's sessions ask this computer's projects, or stops it (#550, docs/plans/remote-hub.md §12.7,
   * owner decision 2026-10-18): the per-machine switch, off by default, stored with the machine. Each pair (a session
   * there, a project here) is asked on this computer's card once; off forgets every pair approved for it. Additive
   */
  'machines.setAsks': { params: z.object({ machineId: MachineId, on: z.boolean() }), result: MachineInfo },
  /** The pairs approved for the reverse direction, every machine's, newest first (#550). Additive */
  'machines.askConsents': { params: z.object({}), result: z.array(MachineAskConsent) },
  /** Withdraws one approved pair: that session's next ask into that project raises the card again (#550). Additive */
  'machines.withdrawAsk': {
    params: z.object({ machineId: MachineId, sessionId: z.string().min(1), projectId: z.string().min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** What would stop if this host stopped now (the `hostBusy` rule); for a hub's `machines.activity` */
  'host.activity': { params: z.object({}), result: HostActivity },
  /**
   * What a hub's orchestrator reads about this host's sessions (docs/plans/remote-hub.md §12): the sessions a hub's
   * window shows (not this host's orchestrator or coordinators), one conversation, and a search over them. Asked of a
   * linked machine by the hub directly, never routed; this host's own window has no use for them. A read is capped at
   * 200 lines and a search at 50 hits
   */
  'host.sessions': { params: z.object({}), result: z.array(HostSessionRow) },
  'host.readSession': {
    params: z.object({
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
    }),
    result: HostReadSessionResult,
  },
  'host.recall': { params: z.object({ query: z.string(), limit: z.number().int().positive().optional() }), result: z.array(HostRecallHit) },
  /**
   * An instruction from a hub's orchestrator to one of this host's sessions (docs/plans/remote-hub.md §12, phase 4
   * step 2): delivered as the orchestrator's `send_to_session` is here, recorded as sent by `from.name`. Only a session
   * a hub is shown (not this host's orchestrator or coordinators). Asked by the hub directly, never routed
   */
  'host.send': {
    params: z.object({
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
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Stops this host the way a signal would: agents, terminals, command runs and app processes
   * stopped in order, the store closed, then exit. For `centralu serve --stop` (docs/agent-host.md
   * §4.7): on Windows a launcher can only be killed, and killing it ends the host without its
   * shutdown. Answers before the host starts to leave. Refused by a host under the app's keeper,
   * which the app stops (and which would only start the host again).
   */
  'host.stop': { params: z.object({}), result: z.object({ ok: z.literal(true) }) },
  /**
   * A hub linked to this host says who it is and whether this host's sessions may ask its projects (#550, the reverse
   * direction, docs/plans/remote-hub.md §12.7). Sent by the hub at every connect and when its switch for this machine
   * changes. This host calls that hub back (`hub.projects`, `hub.askProject`) on the connection the offer came in on
   * only, and shows it to its sessions by its name, "not reachable" once that connection is gone. Asked by the hub
   * directly, never routed. Additive
   */
  'host.hubOffer': { params: HubOffer, result: z.object({ ok: z.literal(true) }) },
} as const
