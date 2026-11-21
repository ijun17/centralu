# Store update and store work

The store moved to a new build's step as a host starts: the steps in order, a copy kept before a step older builds
cannot read, an older build refusing a store too new for it, and the long work a step does before the host answers,
which the keeper, the window and the npm launcher wait for and show. Rules:
[store-migrations.md](../agent-host/store-migrations.md), [stored-shapes.md](../stored-shapes.md).

| Part | Where |
|---|---|
| Screen | `apps/desktop/src/main.tsx` (`Starting`, `StartupFailure`); `packages/platform/src/tauri/index.ts` (`waitForHost`, `onStoreWork`); `apps/desktop/src-tauri/src/lib.rs` (`host_store_work`); `apps/desktop/src-tauri/src/sidecar/mod.rs` (`Supervisor::store_work`); `apps/desktop/src-tauri/keeper/src/host_proc/store_work.rs` (`StoreWork`); `packages/agent-host/src/mail/rules.ts` (`WARNING_TEXT.noStoreCopy`, the Inbox notice) |
| Host | `packages/agent-host/src/dev-services/store/migrate-runner.ts` (`MigrationRunner.migrate`, `runStep`); `packages/agent-host/src/dev-services/store/reader-gate.ts` (`ReaderGate`, `StoreTooNewError`, `storeTooNewMessage`); `packages/agent-host/src/dev-services/store/store-copy.ts` (`StoreCopies.copyBefore`); `packages/agent-host/src/dev-services/store/vacuum.ts` (`OwedVacuum`); `packages/agent-host/src/dev-services/store/store-work.ts` (`SayStoreWork`); `packages/agent-host/src/dev-services/instance-lock.ts` (`sayWork`); `packages/agent-host/src/links/linked-machine-connection.ts` (`waitForStoreWork`); `packages/agent-host/src/links/tunnel.ts` (`startingOf`); `packaging/npm/centralu/bin/serve-files.mjs` (`storeWork`) |
| Protocol | `packages/protocol/src/store-work.ts` (`StoreWork`, `storeWorkOf`, `storeWorkWords`) |
| Store | `packages/agent-host/src/dev-services/store/migrations/index.ts` (`migrationSteps`); `packages/agent-host/src/dev-services/store/migrations/context.ts` (`MigrationStep`: `breaksOlderReaders`, `heavy`, `minReader`); the steps beside them in `packages/agent-host/src/dev-services/store/migrations/`; `packages/protocol/src/schema/schema.sql`; `docs/generated/schema.md` (`pnpm docs:schema`) |
| Documents | `docs/agent-host/store-migrations.md` "Migration steps: expand, then contract (#292)", "Getting the copy back"; `docs/stored-shapes.md`; `docs/agent-host/remote/serve.md` |
| Tests | `packages/agent-host/src/dev-services/store-migrations.test.ts`, `packages/agent-host/src/dev-services/store-older-builds.test.ts`, `packages/agent-host/src/dev-services/store-min-reader.test.ts`, `packages/agent-host/src/dev-services/store-copy.test.ts`, `packages/agent-host/src/dev-services/schema-doc.test.ts`, `packages/agent-host/src/dev-services/instance-lock.test.ts`, `packages/agent-host/src/mail/store-copy-notice.test.ts`, `packages/platform/src/tauri/startup.test.ts`, `tooling/launcher-serve.test.ts`; the keeper's `apps/desktop/src-tauri/keeper/src/host_proc/tests.rs` |
