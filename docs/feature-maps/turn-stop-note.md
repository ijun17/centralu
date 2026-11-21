# Turn stop note

What a session and the person are told when a turn stopped without anyone asking: a quit, a shutdown, a crash, an
update's cut, a stop the tool did not confirm. The session keeps the reason (`interruption`), the screen shows it above
the composer and in the lists, and the mailbox tells whoever is owed an answer. Rules:
[turn-endings-and-mail.md](../agent-host/lifecycle/turn-endings-and-mail.md),
[plans/mailbox.md](../plans/mailbox.md) §10.6.1.

| Part | Where |
|---|---|
| Screen | `packages/ui/src/features/session/SessionNotes.tsx` (`InterruptedNote`); `packages/ui/src/components/primitives.tsx` (`interruptionLabel`); `packages/ui/src/features/session/look.ts` (the `stopped` look); `packages/ui/src/features/sidebar/marks/ToolMark.tsx`; `packages/ui/src/features/inbox/inboxLabel.ts` (`inboxStateLabel`) |
| Host | `packages/agent-host/src/sessions/interruptions.ts` (`interruptionAfter`); `packages/agent-host/src/sessions/interruption-watch.ts`; `packages/agent-host/src/sessions/host-tenure.ts` (`resetLiveState`); `packages/agent-host/src/lifecycle/system-end.ts` (`cutBySystemEnd`, `crashedInSystemEnd`); `packages/agent-host/src/keeper-control.ts` (`system-ending`); `apps/desktop/src-tauri/src/sidecar/ending.rs`; `packages/agent-host/src/lifecycle/stopped-mark.ts` (`takeSystemEnd`, `writeSystemEnd`, `markQuit`); `packages/agent-host/src/mail/stop-notices.ts` (`StopNotices.sessionsStopped`, `relayToMailless`); `packages/agent-host/src/sessions/child-reports.ts` (`relayStop`); `packages/agent-host/src/adapters/session-kit.ts` (`stopNotConfirmed`, `stopNotEnded`); `packages/agent-host/src/adapters/core/ledger.ts` |
| Protocol | `packages/protocol/src/entities/sessions.ts` (`Interruption`, `InterruptionReason`, `SHUTDOWN_WORDS`); `packages/protocol/src/events.ts` (the `interruption` event, `STOP_NOT_CONFIRMED_LABEL`); `packages/protocol/src/commands/sessions.ts` (`SessionInfo.interruption`); `packages/protocol/src/session-state.ts` (`agentLook`); `host.systemEnding` in `packages/protocol/src/commands/methods/host.params.ts` |
| Store | `sessions.interruption` (`packages/agent-host/src/dev-services/store/sessions.ts`); `<data>/system-end.json`, `<data>/stopped.json`; `mail`, `mail_recipients` (`packages/agent-host/src/dev-services/store/mailbox.ts`) |
| Documents | `docs/agent-host/lifecycle/turn-endings-and-mail.md` "Turns that stopped without anyone asking"; `docs/plans/mailbox.md` §10.6.1; `docs/agent-host/remote/hub-links.md`; `docs/agent-host/lifecycle/keeper.md`; `docs/protocol.md` |
| Tests | `packages/agent-host/src/mail/stop-notices.test.ts`, `packages/agent-host/src/sessions/stop-notices.test.ts`, `packages/agent-host/src/sessions/system-end.test.ts`, `packages/agent-host/src/sessions/unconfirmed-stop.test.ts`, `packages/agent-host/src/sessions/interruptions.test.ts`, `packages/agent-host/src/lifecycle/system-end.test.ts`, `packages/ui/src/features/session/look.test.ts`, `packages/ui/src/features/inbox/inboxLabel.test.ts`; `e2e/interrupted-sessions.spec.ts` |
