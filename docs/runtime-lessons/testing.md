# How the runtime is tested

These are practices, not invariants of the code; they say how a replacement module is proven.

**TE1. A boundary gets a sweep, not one value.** A channel failed only near 8,000 bytes before a batch (#387). Run buffers, batches, caps and limits from zero to a few times the limit,
and at the scale people reach (several agents, terminals and app views, a large store). CONTRIBUTING.md. Ask of every compatibility fix which side runs the code during an update (#387: the fix lived in the sending keeper, which an update does not replace).

**TE2. CI starts a real keeper on each OS it ships on.** CI never started a keeper, so a host crash loop stayed green
(#329, #348); the `keeper e2e` job runs the keeper scripts on macOS (#349). They ran on ubuntu-24.04 too
(`keeper e2e (linux)`, #458) until #1895 step 4 PR 7 made Linux direct; that job keeps the keeper crate's unit tests,
since `host_proc` supervises Linux's direct host. A Windows keeper needs its own job before it ships.

**TE3. Test processes are ended by recorded pid, never by name.** `scripts/keeper-test-processes.mjs` reads one process
table and ends every descendant and group of each recorded pid; the installed app, its keeper and host match the same
names (#349, AGENTS.md).

**TE4. The oldest supported OS is the one that fails.** #445 merged with CI red and failed only on macOS 14 (FI8). Do
not merge on red; keep the oldest supported macOS in CI. Since 2026-11-02, when GitHub retired the macOS 14
images, CI's oldest macOS is 15: the behavior FI8 describes is no longer run by any job, so a change near it needs a
manual run on a macOS 14 machine.

**TE5. Wall-clock waits fail under load.** #368 collects them; Windows needed 3× limits, a process stops answering
`kill(pid, 0)` before it releases its working directory, and probes outlive the host and write into the workspace
(#415, #373, #437). Wait for an event, or give generous bounds.

**TE6. What only the packaged app does is checked in the packaged app.** PATH, bundling, native modules, TCC and a
handoff between two real builds have repeatedly gone unproven (#280: "mid-turn survival in the packaged app is still
unverified"). The pull request's **Not exercised** field names them.

**TE7. Fixtures that start processes start them inside `try`/`finally`** (#281).

**TE8. Linux's `sh` is dash**: job control needs `bash` in a fixture (#301).
