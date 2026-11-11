# The process runtime: lessons already paid for

> Collected 2026-10-08 for the runtime redesign ([plans/runtime-unification.md](../plans/runtime-unification.md)), at
> main after 0.1.0-beta.13 (#456–#463). Sources: the code comments of the window, the macOS shell, the keeper crate,
> the host's process code and the npm launcher; [agent-host/lifecycle/README.md](../agent-host/lifecycle/README.md), [architecture.md](../architecture.md) §4,
> [plans/](../plans) and [spikes/](../spikes); and the closed issues and pull requests they cite.

The process runtime is how the window, the macOS shell, the keeper, the host, the agent CLIs, terminals, commands and
a remote's `centralu serve` start, are supervised, hand over, update and stop, on macOS, Linux, Windows and remotes.
It is being redesigned in steps that each replace one module wholesale. This document is the precondition: every
rule below was learned by a failure or a measurement, and a new implementation is checked against it, not rediscovered.

**How to read an entry.**

- **Happened**: the failure or the measurement, with its issue, pull request or commit.
- **Rule**: an invariant stated so a new implementation can be checked against it.
- **Guard**: the test that fails when the rule is broken. **UNGUARDED** means nothing fails; every UNGUARDED rule is
  listed again in the [work list](work-list.md#the-work-list-unguarded-rules) at the end, which is what has to be written before
  the module it concerns is replaced. *Manual* means a check done by hand (on a release, on another machine) that no
  CI job repeats.
- **Platforms**: where the rule applies.
- *Changed by #N* marks an entry that #458–#462 fixed, moved or newly guarded.

**Where the tests are.** Paths are shortened:

| Prefix | Folder |
|---|---|
| `keeper/` | `apps/desktop/src-tauri/keeper/src/` (crate `centralu-keeper-core`) |
| `window/` | `apps/desktop/src-tauri/src/` (the Tauri window) |
| `shell/` | `apps/desktop/src-tauri/shell/src/` (crate `centralu-shell`, the macOS shell) |
| `verify/` | `apps/desktop/content-verify/src/` (the verifier shared by shell and keeper) |
| `host/` | `packages/agent-host/src/` |
| `platform/` | `packages/platform/src/` |
| `tooling/`, `scripts/`, `e2e/` | as in the repository |

A Rust test is named by its function (`` `keeper/os/unix.rs` `a_second_lock_…` ``), a vitest or Playwright test by its
title in double quotes, and a check inside an integration script as `check "…"`. Every name below was checked with
`grep` against the tree at the commit that adds this file.

## Contents

1. [Who starts what](who-starts-what.md) (ST)
2. [Finding and launching programs](finding-programs.md) (PA)
3. [The host process contract](host-contract.md) (HO)
4. [One instance per data folder](single-instance-and-supervision.md#one-instance-per-data-folder) (LK)
5. [Supervising the host](single-instance-and-supervision.md#supervising-the-host) (SU)
6. [Stopping process trees](stopping-process-trees.md) (KL)
7. [Children the keeper holds](keeper-children-and-handoff.md#children-the-keeper-holds) (CH)
8. [Front door, swap and the store across builds](front-door-and-store.md) (SW)
9. [The keeper handoff](keeper-children-and-handoff.md#the-keeper-handoff) (HD)
10. [Files a running process depends on](files.md) (FI)
11. [macOS permissions and the shell](macos-permissions.md) (TC)
12. [Quit, relaunch and update](quit-relaunch-update.md) (UP)
13. [Remotes: serve, ssh, PowerShell, WSL](remotes.md) (RE)
14. [How the runtime is tested](testing.md) (TE)
15. [The work list: UNGUARDED rules](work-list.md#the-work-list-unguarded-rules)

## Where each rule is

A rule keeps its id wherever it is cited (`HO1`, `docs/runtime-lessons/host-contract.md HO1`). Every id and its file:

| File | Rules |
|---|---|
| [who-starts-what.md](who-starts-what.md) | ST1, ST2, ST3, ST4, ST5, ST6, ST7, ST8, ST9, ST10, ST11, ST12, ST13, ST14, ST15, ST16 |
| [finding-programs.md](finding-programs.md) | PA1, PA2, PA3, PA4, PA5, PA6, PA7, PA8, PA9, PA10, PA11, PA12, PA13, PA14, PA15 |
| [host-contract.md](host-contract.md) | HO1, HO2, HO3, HO4, HO5, HO6, HO7, HO8, HO9, HO10, HO11, HO12, HO13, HO14, HO15 |
| [single-instance-and-supervision.md](single-instance-and-supervision.md) | LK1, LK2, LK3, LK4, LK5, LK6, LK7, LK8, SU1, SU2, SU3, SU4, SU5, SU6, SU7, SU8 |
| [stopping-process-trees.md](stopping-process-trees.md) | KL1, KL2, KL3, KL4, KL5, KL6, KL7, KL8, KL9, KL10, KL11, KL12, KL13, KL14, KL15, KL16, KL17, KL18, KL19, KL20 |
| [keeper-children-and-handoff.md](keeper-children-and-handoff.md) | CH5, CH8, CH13, CH14, HD13 |
| [front-door-and-store.md](front-door-and-store.md) | SW1, SW2, SW3, SW3a, SW4, SW5, SW7, SW8, SW9, SW10, SW11, SW12, SW13, SW14, SW15, SW16 |
| [files.md](files.md) | FI1, FI2, FI3, FI4, FI5, FI6, FI7, FI8, FI9, FI10, FI11, FI12, FI13 |
| [macos-permissions.md](macos-permissions.md) | TC1, TC2, TC3, TC4, TC5, TC6, TC7, TC8, TC9, TC10, TC11, TC12, TC13, TC14, TC15, TC17 |
| [quit-relaunch-update.md](quit-relaunch-update.md) | UP1, UP2, UP3, UP4, UP5, UP6, UP7, UP8, UP9, UP10, UP11 |
| [remotes.md](remotes.md) | RE1, RE2, RE3, RE4, RE5, RE6, RE7, RE8, RE9, RE10, RE11, RE12, RE13, RE14, RE15, RE16, RE17, RE18 |
| [testing.md](testing.md) | TE1, TE2, TE3, TE4, TE5, TE6, TE7, TE8 |
