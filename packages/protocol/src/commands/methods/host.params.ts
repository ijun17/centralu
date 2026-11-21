import { z } from 'zod'
import { SessionId } from '../../entities.js'
import { HostHandover } from '../../host-logon.js'
import { MachineId, RemoteShell } from '../../machines.js'
import { HostMailParams, HubOffer, LinkedAppCallParams, LinkedAppCancelParams, LinkedAppNoticeParams, LinkedAppsParams, MailMoveParams, MailRowsParams } from '../../machines-hub.js'

/** A session of the hub, by its id there: one piece of a mail address (`session:<hub id>/<id>`) */
const HubCaller = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/)

/** Params of the `host` methods, parsed by the host (docs/protocol.md §3). Results: ./host.results.ts */
export const hostParams = {
  /**
   * `force`: look now (Check now) rather than answer what is known (no network). Never rejects for a network failure: a
   * check that can break the screen it decorates is worse than none, so the failure comes back in `error`.
   */
  'updates.status': z.object({ force: z.boolean().default(false) }),
  /** Held by the host, which owns the timer it governs */
  'updates.setAuto': z.object({ enabled: z.boolean() }),
  /**
   * Held by the host, which installs. On with a newer version known starts the install at once; the window applies it
   * once nothing is busy (docs/agent-host/lifecycle/updates.md).
   */
  'updates.setAutoApply': z.object({ enabled: z.boolean() }),
  /**
   * Asked only by the person or by `autoApply`. Answers once the install has started: `npm i -g` routinely outruns the
   * 30 s RPC deadline. Progress comes as `update_status`.
   */
  'updates.apply': z.object({}),
  /** The first ready window gets a ticket; every other answer, and one after the host stopped asking, gets null */
  'updates.answerApply': z.object({
    requestId: z.string(),
    ready: z.boolean(),
    reason: z.string().optional(),
    version: z.string().optional(),
  }),
  /**
   * `started` right before the relaunch, then `error`, or neither once the shell accepted it. The window may close before
   * that last report: the host reads its connection ending as the relaunch only after `started`.
   */
  'updates.reportApply': z.object({
    requestId: z.string(),
    ticket: z.string(),
    started: z.boolean().optional(),
    error: z.string().optional(),
  }),
  /**
   * Written to the host's log (stderr), since the window's console is lost on a reload. Fields are cut and lines limited,
   * so a crash that repeats does not flood the log.
   */
  'ui.reportCrash': z.object({
    message: z.string().max(20_000),
    stack: z.string().max(20_000).default(''),
    componentStack: z.string().max(20_000).default(''),
    /** The build the window runs, to tell windows of a mixed host swap apart */
    version: z.string().max(100).optional(),
  }),
  /** Read on every (re)connect: a missed `host_request` event is not sent again */
  'requests.list': z.object({}),
  /**
   * Only from a window holding the token; the limited credential is refused. `ok: false`: no longer waiting (answered in
   * another window, withdrawn by its program, or past its time).
   */
  'requests.answer': z.object({ requestId: z.string().min(1).max(100), decision: z.enum(['allow', 'deny']) }),
  /**
   * The hub's own, never forwarded (docs/protocol.md §6). Adding a machine is the consent to reach it: the person can
   * already ssh there. The link uses their `ssh` and keys (`BatchMode`) and expects `centralu serve` there.
   */
  'machines.list': z.object({}),
  'machines.add': z.object({
    name: z.string().min(1).max(64),
    sshTarget: z.string().min(1).max(255),
    shell: RemoteShell.default('posix'),
    wslDistro: z.string().max(64).nullable().optional(),
    command: z.string().max(1024).nullable().optional(),
    /** Used there in place of `~/.centralu`: a temporary one, for trying updates */
    dataDir: z.string().max(255).nullable().optional(),
  }),
  /**
   * `~/.ssh/config` and its `Include`s, read by the host (never the window), each alias resolved by `ssh -G`; pattern-only
   * entries and `Match` blocks are left out. Nothing is connected to and no key file is opened.
   */
  'machines.sshHosts': z.object({}),
  /**
   * One BatchMode ssh, never a password or host-key prompt: a Unix shell, or Windows with its shell and WSL distros. An
   * unreachable target answers `reachable: false` with ssh's reason. Nothing there is changed.
   */
  'machines.probe': z.object({ sshTarget: z.string().min(1).max(255) }),
  /** Nothing on the machine changes */
  'machines.remove': z.object({ machineId: MachineId }),
  /**
   * Tries now instead of after the backoff; the machine then stays connected until `machines.disconnect` or the hub
   * stops. With Auto reconnect off, the only way to try again after a drop.
   */
  'machines.reconnect': z.object({ machineId: MachineId }),
  /** Tries none until the person connects or the hub restarts. Stays linked; its sessions keep running there */
  'machines.disconnect': z.object({ machineId: MachineId }),
  /** Runs `centralu serve --revoke <id>` there over ssh. Never the hub's own, which is made again at each link */
  'machines.revokeCredential': z.object({ machineId: MachineId, credentialId: z.string().regex(/^[0-9a-f]{8}$/) }),
  /** Off while connected leaves the link up; on while the link is away tries now */
  'machines.setAutoReconnect': z.object({ machineId: MachineId, autoReconnect: z.boolean() }),
  /**
   * Connects across two versions of one protocol the person declined to align (docs/plans/remote-hub.md §4); remembered
   * for this pair of versions only. Refused when the protocols differ.
   */
  'machines.acceptVersions': z.object({ machineId: MachineId }),
  /**
   * docs/plans/remote-hub.md §10.2, §10.3. A host running there is not touched; its next start runs the new version.
   * Refused by a development hub (not on npm) and for a machine with a command of its own. Answers when done or refused
   */
  'machines.install': z.object({ machineId: MachineId }),
  /**
   * docs/plans/remote-hub.md §10.5: without a keeper there, a turn in progress is lost; with no hello from the new version
   * within 30 s the old one is put back and the call fails with the new host's log. Progress is `machine_status`'s
   * `operation`; `when`: docs/protocol.md §3 "machines". Refused like `machines.install`
   */
  'machines.update': z.object({ machineId: MachineId, when: z.enum(['idle', 'now']).optional() }),
  /** The update fails saying so; nothing was switched */
  'machines.cancelUpdate': z.object({ machineId: MachineId }),
  /** One step only: `previous` is cleared, since a store migrated twice may not read on the older build */
  'machines.rollback': z.object({ machineId: MachineId }),
  /** Removes `<data>/remote/`; the machine's data and its own npm install stay, and it stays linked */
  'machines.uninstall': z.object({ machineId: MachineId }),
  /**
   * Without `on`, reads (docs/plans/remote-hub.md §10.4: per machine, off by default). The Centralu there writes the entry:
   * a systemd user unit with lingering on Linux, a scheduled task at sign-in on Windows and WSL. A running host is left
   * as it is. Refused where it predates this or offers none (macOS)
   */
  'machines.autostart': z.object({ machineId: MachineId, on: z.boolean().optional() }),
  /** For the "Update <machine>" prompt. Null when the machine cannot say (unreachable, other protocol, older) */
  'machines.activity': z.object({ machineId: MachineId }),
  /** The person's say, read by the machine at each start; no boundary against the hub (docs/protocol.md §3 "machines") */
  'machines.hubAuto': z.object({ machineId: MachineId, allowed: z.boolean().optional() }),
  /**
   * docs/plans/remote-hub.md §12.7: off by default. Each pair (a session there, a project here) is asked once on this
   * computer's card; off forgets every pair approved for the machine.
   */
  'machines.setAsks': z.object({ machineId: MachineId, on: z.boolean() }),
  'machines.askConsents': z.object({}),
  /** That session's next ask into that project raises the card again */
  'machines.withdrawAsk': z.object({
    machineId: MachineId,
    sessionId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  /** What would stop if this host stopped now (the `hostBusy` rule); for a hub's `machines.activity` */
  'host.activity': z.object({}),
  /**
   * What a hub's Assistant reads (docs/plans/remote-hub.md §12), asked by the hub directly, never routed: not this host's
   * assistant or coordinators. A read is capped at 200 lines, a search at 50 hits
   */
  'host.sessions': z.object({}),
  'host.readSession': z.object({
    sessionId: SessionId,
    limit: z.number().int().positive().optional(),
    /** A `seq` `host.recall` gave: reads around it rather than the end */
    around: z.number().int().optional(),
    /** Tool calls in full rather than one line each */
    tools: z.boolean().optional(),
    /** With `around`: that one line from this character on; a cut line names the offset to read on from. Older: ignored */
    offset: z.number().int().min(0).optional(),
    /** Read first; `tools` stays for a 0.1.0-beta.45 hub, which sends both */
    toolLines: z.enum(['none', 'titles', 'full']).optional(),
    /** The lines' total; 12,000 by default. An older machine ignores it */
    maxChars: z.number().int().min(2000).max(40_000).optional(),
    /** A budget note's read: the lines older than this seq, back from it. An older machine ignores it */
    before: z.number().int().optional(),
    /** A budget note's read: the lines from this seq on. An older machine ignores it */
    from: z.number().int().optional(),
  }),
  'host.recall': z.object({ query: z.string(), limit: z.number().int().positive().optional() }),
  /**
   * docs/protocol.md §3 "host": read by the hub before its start_agent card; `fromHub` reads the switch again. Every host
   * from 0.1.0-beta.45 on has it.
   */
  'host.hubAuto': z.object({}),
  /** Restricts what the person allows; no boundary against the hub, which holds this host's token and could ask `auto` outright */
  'host.setHubAuto': z.object({ allowed: z.boolean() }),
  /**
   * docs/protocol.md §3 "host"; never the values. An older host answers "Unknown method", and the hub keeps what the
   * connection line said
   */
  // `nonce`: each entry then carries a `check` of it, so the hub tells its own credential from one that reuses its id
  'host.credentials': z.object({ nonce: z.string().min(8).max(64).optional() }),
  /** docs/protocol.md §3 "host". A failure is the hub's answer, not a read of the lines instead */
  'host.lastAnswer': z.object({
    sessionId: SessionId,
    maxChars: z.number().int().positive().max(100_000).optional(),
    turn: z.boolean().optional(),
    since: z.number().int().optional(),
  }),
  /**
   * Delivered as the Assistant's `send_to_session` is here, recorded as sent by `from.name` (docs/plans/remote-hub.md §12);
   * only to a session a hub is shown. Asked by the hub directly, never routed
   */
  'host.send': z.object({
    sessionId: SessionId,
    text: z.string(),
    from: z.object({ name: z.string() }),
    /**
     * An ask_project task, worked at this depth (the hub caller's plus one) until the turn that consumes it is recorded.
     * Absent from an older hub, and from an Assistant's instruction.
     */
    ask: z.object({ depth: z.number().int().min(1).max(64) }).optional(),
  }),
  /**
   * Stops as a signal would, for `centralu serve --stop`: on Windows a launcher can only be killed, which skips the
   * shutdown. Answers first. Refused under the app's keeper, which would only start it again. `ifIdle` and `forUpdate`:
   * docs/protocol.md §3 "host", docs/agent-host/lifecycle/continue-after-update.md
   */
  'host.stop': z.object({ ifIdle: z.boolean().optional(), forUpdate: z.boolean().optional() }),
  /** What a `serve` in the person's Windows sign-in says about taking over; said in hellos and `host_handover`. Null clears it */
  'host.handover': z.object({ handover: HostHandover.nullable() }),
  /**
   * Told by the window where the host cannot hear the system end: on Windows the desktop window runs `centralu serve
   * --window` and cannot write to a host it did not start. `cancelled`: the announced end was called off
   */
  'host.systemEnding': z.object({ cancelled: z.boolean().optional() }),
  /**
   * docs/plans/remote-hub.md §12.7: sent at every connect and when its switch changes. This host calls that hub back only
   * on the connection the offer came in on, and shows it "not reachable" once that is gone.
   */
  'host.hubOffer': HubOffer,
  /** docs/plans/linked-mail.md §6: only on a connection a hub offered on, from that hub's addresses; never routed */
  'host.mail': HostMailParams,
  'host.mailRows': MailRowsParams,
  /** A handoff on the hub moved the tasks its session gave here to another of its sessions */
  'host.mailMove': MailMoveParams,
  /**
   * docs/plans/mailbox.md §10.6.4: this host alone judges which cards, and whether that giver may answer, by its own rule.
   * Only on a connection a hub offered on, the giver read as that hub's session
   */
  'host.cards': z.object({ sessionId: SessionId, caller: HubCaller }),
  'host.answerCard': z.object({ sessionId: SessionId, caller: HubCaller, card: z.string().min(1).max(200), text: z.string().max(20_000) }),
  /** docs/plans/remote-hub.md §13. Only on a connection a hub offered apps on; never routed */
  'host.apps': LinkedAppsParams,
  'host.appCall': LinkedAppCallParams,
  'host.appCancel': LinkedAppCancelParams,
  'host.appNotice': LinkedAppNoticeParams,
} as const
