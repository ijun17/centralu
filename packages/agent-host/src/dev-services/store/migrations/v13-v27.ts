import { isObj } from '../../../json-value.js'
import { oneRow } from '../rows.js'
import { indexedText } from '../search-index.js'
import { APP_SETTINGS_DDL, MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v13 to v27, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV13ToV27 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 13,
        // Drops the grid's old-named table: an older schema.sql recreates it empty, and the older build loses every placement
        breaksOlderReaders: true,
        run: () => {
          /*
           * Finishing the rename: move any grid placements left in the old-named table into
           * `grid_panels`. (legacy-name)
           *
           * **Do not do this with `ALTER TABLE ... RENAME TO`.** Every run of `schema.sql`
           * used to reset `user_version` to 1, so this list of steps **replayed from scratch
           * every time** — which meant step 9 would first create an empty `grid_panels`, and
           * this step would then see "it already exists" and skip. The user's saved placement
           * was left orphaned in the old table (a real defect a test caught).
           *
           * So it is moved, then dropped. From the second run onward the old table no longer
           * exists, so this does nothing.
           */
          const has = (name: string) =>
            this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !==
            undefined
          // The marker has to sit **on the line where the old name is written** for the check to
          // see it — putting it on the next line means the check misses it
          if (has('control_center')) { // legacy-name
            this.db.exec(
              `INSERT OR IGNORE INTO grid_panels (session_id, position)
               SELECT session_id, position FROM control_center`, // legacy-name
            )
            this.db.exec(`DROP TABLE control_center`) // legacy-name
          }
        },
      },
      {
        to: 14,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The directory a session was created in. Stored, not recomputed. (issue #28)
           *
           * Until now every start derived the cwd again — the project's path, or
           * `orchestratorHome()` (= `dataRoot()/orchestrator`) for the orchestrator. Then the
           * data directory was renamed to `~/.centralu` from the folder named just below, and
           * the orchestrator's cwd moved with it. Claude Code keys its session store **by
           * working directory**, so the tool went looking in a project slug that had never
           * existed and answered "not found". The 821KB transcript sat untouched under the old
           * slug the whole time, and the app told its owner the conversation had been deleted.
           *
           *   old cwd `~/.control-center/orchestrator` → transcript filed here, still there // legacy-name
           *   new cwd `~/.centralu/orchestrator`       → no such slug, so "not found"
           *
           * The old name is spelled out because naming it is the whole explanation; nothing
           * here goes near that path (see DATA_DIR_LEGACY in brand.ts).
           *
           * A derived cwd is a promise we cannot keep: anything that moves a folder — our own
           * rename, the user moving a project — silently repoints a live session at a place
           * its history was never written to. So we write it down once and read it back.
           *
           * Backfill is what SQL can prove: a worktree session's worktree, otherwise the
           * project's path. Orchestrator rows (no project, no worktree) stay NULL — resolving
           * them here would mean calling `orchestratorHome()`, which creates a directory, and
           * a migration that touches the user's home on every open is how `pnpm verify` once
           * blocked the real data move (see data-dir.ts). The manager fills those in the first
           * time it actually needs the path, and from then on they are stored too.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'cwd')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN cwd TEXT`)
          }
          // `WHERE cwd IS NULL` matters: schema.sql resets user_version to 1, so every step
          // replays on every open (see v13's note). Without it this would overwrite the
          // stored path with a freshly derived one — exactly the bug being fixed.
          this.db.exec(`
            UPDATE sessions
               SET cwd = COALESCE(worktree_path, (SELECT p.path FROM projects p WHERE p.id = sessions.project_id))
             WHERE cwd IS NULL
               AND (worktree_path IS NOT NULL OR project_id IS NOT NULL)
          `)
        },
      },
      {
        to: 15,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Shell commands saved on a project (issue #44).
           *
           * A column on the project row, not a table of its own. The list is short, it is
           * always read and written whole, and it has no life apart from the project it
           * belongs to — a table would buy per-row identity nobody asks for and would need
           * its own rule for what happens when the project goes.
           *
           * That also keeps `listProjects` a single query, which is what lets the Run menu
           * say "nothing saved yet" as a fact instead of as "not loaded yet". Contrast
           * `grid_panels` (v9), which is a table because being on the grid and existing as a
           * session are two different facts; a saved command has no such second life.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols.some((c) => c.name === 'commands')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN commands TEXT NOT NULL DEFAULT '[]'`)
          }
        },
      },
      {
        to: 16,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Settings that belong to the host itself (issue #43).
           *
           * The first one is whether to check for updates on a schedule, and it cannot live
           * in `workspace` with the rest of the preferences: that row is a single blob the
           * UI writes whole, and the host reading its own setting out of the other side's
           * document would be a second reader of a record with exactly one author. Worse,
           * the thing this governs is a **timer in this process**, which has to know its
           * answer before any UI has connected.
           *
           * A key/value table rather than a column, because there is no row it belongs to —
           * this is about the install, not about a project or a session.
           */
          this.db.exec(APP_SETTINGS_DDL)
        },
      },
      {
        to: 17,
        breaksOlderReaders: false,
        run: () => {
          /*
           * How full a conversation's context is (issue #48).
           *
           * The reading was right and arrived once a turn; it simply lived in memory and
           * died with the host. So a cold start showed `Context —` on every session until
           * that session happened to work again — a gauge that read as broken when in fact
           * nobody had ever written the number down. This is the third time for this shape:
           * model/effort/permission (v4/v7) and the worktree (v12) were the same bug, a
           * runtime fact coming back as a default.
           *
           * Three flat columns rather than one JSON blob, following `worktree_path` /
           * `worktree_branch` (v12) — the record is small, fixed, and always read whole, so
           * columns buy the same thing without a decoding rule that can fail. `commands`
           * (v15) is JSON because it is a list of unknown length; this is not.
           *
           * `context_used IS NULL` is the honest "never reported one", which is exactly the
           * state the gauge already tells apart from 0%. Both adapters feed this through the
           * one `context_update` event, so nothing here is Claude-shaped (Codex started
           * sending it in 3ae2029).
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'context_used')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_used INTEGER`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_window INTEGER`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN context_exactness TEXT`)
          }
        },
      },
      {
        to: 18,
        breaksOlderReaders: false,
        run: () => {
          // Response length (codex's model_verbosity, #54) — the same kind of property as
          // model/effort (v4/v7), so it lives in the same place
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'verbosity')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN verbosity TEXT`)
          }
          /*
           * Guarantee is_orchestrator here too (#13). It is present in the new database's DDL
           * and in the v10 rebuild, but **a database where v10 returned early** (an old schema
           * where project_id was already nullable) reached v17 without this column — a mine
           * waiting to go off the moment orchestratorId() read it, which surfaced once
           * listSessions started reading it too (#13).
           */
          if (!cols.some((c) => c.name === 'is_orchestrator')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN is_orchestrator INTEGER NOT NULL DEFAULT 0`)
          }
        },
      },
      {
        to: 19,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Commit attribution (#50). The other half of the decision (2026-08-23) to write
           * nothing to the repository itself — the record lives only here, in our own
           * database. The hash is picked up from the agent's git commit tool output, so it can
           * be short (resolved by prefix matching).
           */
          this.db.exec(`CREATE TABLE IF NOT EXISTS commit_sessions (
            project_id TEXT NOT NULL,
            sha        TEXT NOT NULL,
            session_id TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            PRIMARY KEY (project_id, sha)
          )`)
        },
      },
      {
        to: 20,
        breaksOlderReaders: false,
        run: () => {
          // Response speed (codex's service_tier) — the same kind of property as verbosity
          // (v18), so it lives in the same place
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'service_tier')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN service_tier TEXT`)
          }
        },
      },
      {
        to: 21,
        // Rewrites every message and rebuilds the index, then vacuums. Whole messages read fine in an older build
        breaksOlderReaders: false,
        heavy: true,
        run: () => this.mergeDeltaRows(),
      },
      {
        to: 22,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The session tree (#69): a worktree session hangs off its manager session.
           * No FK constraint is added — if CASCADE killed children when the parent was
           * deleted, a worktree session's whole conversation would vanish along with one
           * delete of the parent. A child left with a broken link gets reattached by the next
           * startup's adoption (adoptOrphanWorktrees).
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'parent_session_id')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`)
          }
        },
      },
      {
        to: 23,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Worktree provisioning (#69): a fresh worktree is an empty workbench — no
           * node_modules, no .env. Each project remembers its setup command and the list of
           * files to copy over. Why this lives here (in our database) and not in the repo:
           * nothing is written to the repo (#50).
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols.some((c) => c.name === 'worktree_setup')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN worktree_setup TEXT`)
          }
        },
      },
      {
        to: 24,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The baseline for merge detection (#69): the HEAD sha at the moment the worktree
           * branch was created. A brand-new branch is an ancestor of HEAD, so checking
           * is-ancestor alone without this baseline would read it as "merged" the instant it
           * is created. Existing rows (no base) are excluded from automatic detection —
           * guessing a value would produce a wrong badge, and the person can always remove one
           * by hand.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'worktree_base')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_base TEXT`)
          }
        },
      },
      {
        to: 25,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The last reasoning effort chosen also becomes the project default (#69 dogfooding
           * finding 5). default_model has existed since v1, but there was no place for effort,
           * so a person who chose Opus and high had to click high again in every new session —
           * the exact lesson default_tool already taught.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols.some((c) => c.name === 'default_effort')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN default_effort TEXT`)
          }
        },
      },
      {
        to: 26,
        // One-way, but an older build reads the cleared marker as an ordinary session
        breaksOlderReaders: false,
        run: () => {
          /*
           * Retiring the project orchestrator (2026-09-01, reverting #13).
           *
           * **There is a reason the data has to be fixed first.** Once the project-scoped
           * tier is gone from the code, a session that still carries the marker is not
           * demoted — it **gains central visibility**: a session that used to see only its own
           * project can, the next time it wakes, direct sessions across every project. That is
           * a silent privilege escalation, and nothing on screen shows it.
           *
           * So the marker is cleared. All that is lost is a handful of tools; the conversation
           * is untouched. The central orchestrator (project_id IS NULL) is left alone.
           */
          this.db.exec(
            `UPDATE sessions SET is_orchestrator = 0 WHERE is_orchestrator = 1 AND project_id IS NOT NULL`,
          )
        },
      },
      {
        to: 27,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The worktree manager's place, and the trunk (#76).
           *
           * **Why hang this off the project.** Until now, being the manager was purely
           * relational — having a worktree child made a session the manager. That rule had the
           * merit that a marker and a link could never disagree, but it also meant a manager
           * could not exist before it had a child: the first branch always had to be chosen by
           * a person alone, and the manager's suggestion feature only became useful from the
           * second branch onward.
           *
           * Instead of a marker column on the session, **the project points at its manager.**
           * This is still a link, not a flag, and "one per project" becomes structural through
           * a single column (it used to be an imperative check). If the session it points at
           * is gone or archived, it counts as absent — reading a broken link as "no manager"
           * is safer than holding on to a ghost.
           *
           * Why baseBranch lives alongside it: the trunk is a property of the manager, and a
           * project has one manager, so the two belong in the same place. This one value
           * settles three questions at once — where a branch forks from, where it merges to,
           * and what "merged" is measured against.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols.some((c) => c.name === 'worktree_manager')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN worktree_manager TEXT`)
          }
        },
      },
    ]
  }

  /**
   * v21: merges rows left over from the delta era into whole messages (#66).
   *
   * Writes had already switched to whole messages (persistMessage), but the rows accumulated
   * before that are **one token per row.** Reads already merged them back together, so nothing
   * was broken and this move was not urgent — it was **something that could wait**, done for
   * size and for search. (Measured: one session went from 32,698 rows per hour to 761, and from
   * 2.1 characters per row to 222.)
   *
   * Only consecutive assistant text is joined with text, and reasoning with reasoning — the
   * same rule the read path (loadMessages) used at the time of the move, so the conversation
   * looked the same before and after. Reads no longer join rows (#77): a row that ended up
   * neighboring another after the move is a genuinely different message.
   *
   * The seq at the merged spot keeps **the first chunk's value** — the read position
   * (last_read_seq) and the fresh_start boundary are both plain numeric comparisons, so a gap
   * left by a disappearing seq in the middle is safe. Keeping the last chunk's seq instead
   * would bring back "unread" states that had already been read.
   *
   * The index is rebuilt from scratch (same reason as v11: once rows are deleted, an index
   * pinned to rowid points at the wrong place). VACUUM is called outside the transaction.
   */
  private mergeDeltaRows(): void {
    const before = oneRow(this.db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) as n FROM messages`).get())
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare<unknown[], {
        rowid: number
        session_id: string
        seq: number
        role: string
        kind: string
        payload: string
        ts: number
      }>(`SELECT rowid, session_id, seq, role, kind, payload, ts FROM messages ORDER BY session_id, seq`)
        .all()

      const update = this.db.prepare(`UPDATE messages SET payload = ?, ts = ? WHERE rowid = ?`)
      const del = this.db.prepare(`DELETE FROM messages WHERE rowid = ?`)

      /** The run currently being joined — the body is accumulated onto the first chunk's row */
      let head: {
        rowid: number
        sessionId: string
        kind: string
        payload: Record<string, unknown>
        text: string
        merged: boolean
      } | null = null
      let lastTs = 0
      const closeRun = () => {
        if (!head) return
        /*
         * **Only a run that was actually joined is rewritten.** This used to run an UPDATE even
         * on a row that was the only chunk, and it stamped ts with `Date.now()` instead of the
         * original time — so every run of this migration overwrote every assistant row's
         * timestamp with "now" (real incident, 2026-09-03: beta.4 rewound user_version and
         * this step replayed, stamping an entire night's conversation with 13:44). The
         * timestamp kept is the last chunk's — a fact the chunks themselves actually carried.
         */
        if (head.merged) update.run(JSON.stringify({ ...head.payload, text: head.text }), lastTs, head.rowid)
        head = null
      }

      for (const r of rows) {
        const streaming = r.role === 'assistant' && (r.kind === 'text' || r.kind === 'reasoning')
        if (!streaming) {
          closeRun()
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(r.payload)
        } catch {
          closeRun() // leave an unparsable row untouched — keeping it is better than losing it while trying to merge
          continue
        }
        if (!isObj(parsed)) {
          closeRun() // JSON that is no object is no streamed event either: left as it is
          continue
        }
        const payload = parsed
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (head && head.sessionId === r.session_id && head.kind === r.kind) {
          head.text += text
          head.merged = true
          lastTs = r.ts
          del.run(r.rowid)
        } else {
          closeRun()
          head = { rowid: r.rowid, sessionId: r.session_id, kind: r.kind, payload, text, merged: false }
          lastTs = r.ts
        }
      }
      closeRun()

      // Rebuild the index (same approach as v11) — reclaim the room deleted rows left behind
      this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
      this.db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
        );
      `)
      const fresh = this.db.prepare<unknown[], {
        rowid: number
        session_id: string
        seq: number
        kind: string
        payload: string
      }>(`SELECT rowid, session_id, seq, kind, payload FROM messages`).all()
      const insert = this.db.prepare(
        `INSERT INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
      )
      for (const r of fresh) {
        const body = indexedText(r.kind, r.payload)
        if (body) insert.run(r.rowid, body, r.session_id, r.seq)
      }
    })
    tx()
    const after = oneRow(this.db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) as n FROM messages`).get())
    if (after.n < before.n) {
      /*
       * stderr, not stdout. The host tees **stderr** to `~/.centralu/host.log`
       * (`teeStderrToFile`); a `.app` launched from Finder has no stdout anywhere, so a
       * `console.log` here reaches nobody. This line was written with `console.log` and
       * was duly lost — the v21 migration ran on the real store, rewrote 349,825 rows
       * into 57,709, and left no trace of having run. The one irreversible thing this
       * process does was also the one thing it did silently.
       */
      console.error(`[store] merged streaming rows into messages: ${before.n} -> ${after.n} rows`)
      this.vacuumAfterStep() // SQLite does not hand back freed space on its own (see v11's note)
    }
  }
}
