import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v48 to v54, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV48ToV54 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 48,
        breaksOlderReaders: false,
        /**
         * The worktree manager folded into ordinary sessions (#561 part 3): a former manager now owns the worktree
         * sessions it held as the agents it started, so `agent_session` reaches them and they cannot start agents of
         * their own (depth one). `asked_by_session_id` is set to `parent_session_id` on every worktree session that has a
         * parent and no `askedBy` yet; `parent_session_id` stays, so the sidebar still hangs them under it.
         *
         * **Expand only (#292's rule).** A one-way data rewrite into a column v45 added: an older host reads it and shows
         * the child's "asked by" mark. `projects.worktree_manager` stays: it still holds the project's trunk, and an
         * older host still finds its manager there; dropping it is a later, breaking step.
         */
        run: () => {
          // A store an older step's test built by hand may lack a column: there is then nothing to rewrite
          const cols = new Set((this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name))
          if (!['asked_by_session_id', 'parent_session_id', 'worktree_path'].every((c) => cols.has(c))) return
          this.db.exec(`
            UPDATE sessions SET asked_by_session_id = parent_session_id
             WHERE asked_by_session_id IS NULL AND parent_session_id IS NOT NULL AND worktree_path IS NOT NULL
          `)
        },
      },
      {
        to: 49,
        breaksOlderReaders: false,
        /**
         * "You will be told when it ends" (#646) — `report_marks`, one row per session that owes a report to the session
         * that gave it work (`start_agent` with `wait: false` or past the bound, `send_to_session` with `reportBack`).
         *
         *   session_id         the session whose turn end is reported
         *   caller_session_id  the session told about it
         *   marked_at          when the report was asked for
         *
         * The mark used to live in the host's memory alone (`ChildOwnership.awaitingReport`), so a host swap (#280) lost
         * it: the keeper kept the child's process, it finished under the new host, and the parent was never woken. The
         * new host reads the rows at startup and keeps the marks of the sessions the keeper kept; a mark whose session
         * has no process any more is dropped, since the turn it was about died with the old host.
         *
         * Not foreign keys: a caller in the trash still has its mark cleared by the manager, and purging either session
         * deletes the row (`purgeSession`).
         *
         * **Expand only (#292's rule).** A new table; an older host never reads it.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS report_marks (
              session_id        TEXT PRIMARY KEY,
              caller_session_id TEXT NOT NULL,
              marked_at         INTEGER NOT NULL
            )
          `)
        },
      },
      {
        to: 50,
        breaksOlderReaders: false,
        /**
         * start_agent requests still waiting for the person (#673) — `agent_start_requests`, one row per consent card
         * a session raised to start another agent, from the moment the card stands until the person answers it or it is
         * withdrawn.
         *
         *   request_id         the card's request id, which is also the handle the caller follows with agent_session
         *   caller_session_id  the session that asked
         *   request            what the start needs once allowed, as JSON (`AgentStartRequest` in the manager)
         *   asked_at           when the card was raised
         *
         * The card used to be withdrawn after 200 seconds, so an absent person never saw it. It now stands until it is
         * answered, which can outlive the host: a host swap (#280) or a restart reads these rows and raises the cards
         * again, and an approval starts the child then. A row whose caller is no longer there is dropped.
         *
         * Not foreign keys, as `report_marks`: trashing the caller withdraws its rows through the manager, and purging
         * deletes them (`purgeSession`).
         *
         * **Expand only (#292's rule).** A new table; an older host never reads it.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_start_requests (
              request_id        TEXT PRIMARY KEY,
              caller_session_id TEXT NOT NULL,
              request           TEXT NOT NULL,
              asked_at          INTEGER NOT NULL
            )
          `)
        },
      },
      {
        to: 51,
        breaksOlderReaders: false,
        /**
         * Delegated turns (#676) — `delegated_turns`, one row per session whose running turn another session gave it
         * (`ask_project`, `start_agent`, `agent_session` send, `send_to_session` to a session at rest). The turn's
         * question cards go to that session as well as to the person, for as long as the turn runs.
         *
         *   session_id         the session running the delegated turn
         *   caller_session_id  the session that gave it (the turn's owner)
         *   started_at         when the turn was given
         *   told_cards         the cards the caller was already told of, space-separated card handles: a kept CLI sends
         *                      its standing card again to the next host, which then does not tell the caller twice
         *   turn_id            the delegated turn, bound into each card's handle so an answer meets only the card read
         *
         * Kept beside the host's memory (`ChildOwnership.turnOwners`) so a host swap (#280) does not cut the link while
         * the kept session waits on a question: the new host reads the rows of the sessions the keeper kept and still
         * running, and drops the rest, as it does `report_marks`.
         *
         * Not foreign keys, for the same reasons as `report_marks`; purging either session deletes the row.
         *
         * **Expand only (#292's rule).** A new table; an older host never reads it.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS delegated_turns (
              session_id        TEXT PRIMARY KEY,
              caller_session_id TEXT NOT NULL,
              started_at        INTEGER NOT NULL,
              told_cards        TEXT NOT NULL DEFAULT '',
              turn_id           TEXT NOT NULL DEFAULT ''
            )
          `)
        },
      },
      {
        to: 52,
        breaksOlderReaders: false,
        /**
         * Requests to a busy session (#677). `queued_requests`: work another session asked a busy session for, held to
         * be delivered as a new turn when the running one ends (the requester's `ifBusy: "queue"`).
         *
         *   id                 the handle the requester was given
         *   session_id         the busy session it waits for
         *   caller_session_id  the requester, told when the delivered turn ends
         *   via                the tool it came through: `ask_project`, `agent_session` or `send_to_session`
         *   text               the requester's words, framed as that tool frames them when delivered
         *   queued_at          the order it is delivered in
         *   delivering_at      set when delivery began; the row goes only once the session's turn has started, so a
         *                      swap or crash while the session wakes leaves it for the next host, which delivers it
         *                      again (at least once: an input the old process took without a word may run twice)
         *
         * Kept in the store so a host swap (#280) does not lose it: the next host delivers it when the session's turn
         * ends, or at once for a session already at rest. Not foreign keys; purging either session deletes the rows.
         *
         * `sessions.forked_from_session_id`: the session whose conversation a forked sub-session was copied from
         * (`ifBusy: "fork"`). The sidebar hangs the fork under it; the requester stays in `asked_by_session_id`.
         *
         * **Expand only (#292's rule).** A new table and a nullable column; an older host reads neither.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS queued_requests (
              id                TEXT PRIMARY KEY,
              session_id        TEXT NOT NULL,
              caller_session_id TEXT NOT NULL,
              via               TEXT NOT NULL,
              text              TEXT NOT NULL,
              queued_at         INTEGER NOT NULL,
              delivering_at     INTEGER
            )
          `)
          const cols = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name)
          if (!cols.includes('forked_from_session_id')) this.db.exec(`ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT`)
        },
      },
      {
        to: 53,
        breaksOlderReaders: false,
        /**
         * Why a session's last turn did not run to its end (#698): `sessions.interruption`, the JSON of
         * `SessionInfo.interruption` (`network`, `quit`, `interrupted`), null when nothing stopped it. Stored so the
         * inbox and the orchestrator's list still say it after a restart: a quit is exactly when it is written, and the
         * person reads it on the next start.
         *
         * **Expand only (#292's rule).** A nullable column; an older host neither reads nor writes it, so a session it
         * serves during a swap keeps the last value until this build writes the row again.
         */
        run: () => {
          const cols = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name)
          if (!cols.includes('interruption')) this.db.exec(`ALTER TABLE sessions ADD COLUMN interruption TEXT`)
        },
      },
      {
        to: 54,
        breaksOlderReaders: false,
        /**
         * `queued_requests.opened_by_auto`: 1 for an ask_project request that passed only because its requester was
         * `auto` (no remembered consent for the pair), 0 otherwise (`QueuedRequest.openedByAuto`). The delivery gate
         * reads it when the requester is no longer `auto`, so a host swap carries it with the row.
         *
         * **Expand only (#292's rule).** A nullable column; an older host neither reads nor writes it, and a row it
         * queues during a swap is read as not saying (null), which this build treats as passed by `auto` when the pair
         * has no remembered consent.
         */
        run: () => {
          const cols = (this.db.prepare(`PRAGMA table_info(queued_requests)`).all() as { name: string }[]).map((c) => c.name)
          if (!cols.includes('opened_by_auto')) this.db.exec(`ALTER TABLE queued_requests ADD COLUMN opened_by_auto INTEGER`)
        },
      },
    ]
  }
}
