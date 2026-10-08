//! Running and supervising one agent host, with no Tauri in sight.
//!
//! Two callers share this module (#280, option C step 1):
//!   - the app's **direct** path (`pnpm app:dev`, debug builds, non-unix targets), where the app
//!     itself is the host's parent, as it always was;
//!   - the **keeper** (`centralu-keeper`, #440), a detached executable of its own that holds the
//!     host so that quitting or replacing the app does not end it.
//!
//! The restart and backoff rules used to live inside `sidecar.rs`, tied to an `AppHandle`. They
//! moved here unchanged so the keeper restarts a crashed host by exactly the same rules the app
//! did: five consecutive failures, a 30 s stable-uptime reset, and an immediate stop when the
//! host says another owner holds the data folder (#184). Only where the status goes differs, and
//! that is the `StatusSink`.
//!
//! The keeper's own upgrade (#280 step 4) adds two things: a host's stdout is read by a
//! `HostOut` that can be stopped between lines and handed over with what it had read, and a
//! supervisor can take over a host **another keeper started** (`adopt_foreign`): it holds the
//! host's pipes but is not its parent, so it learns of the end from stdout closing and stops it by
//! pid, as it already did.
//!
//! **Where the operating system shows.** This file is the logic every OS shares, written once. What
//! differs lives in `unix.rs` and `windows.rs`, which provide the same small interface (`os`):
//! signalling a host and its group (`kill_pid`, `kill_group`), how a host is started (`own_group`,
//! `hide_console`), how it is asked to stop (`CLOSE_STDIN_TO_STOP`, `SIGNAL_GROUP_AFTER_EXIT`), how
//! its stdout is read (`host_lines`, `Gate`), how the source host's tsx is run (`tsx_program`), and
//! where Node is looked for first (`probe_first`, `fallback_node_paths`, the hints). `unix.rs` also
//! holds what only the keeper does, which is unix-only: the stdout reader that can be frozen
//! (`HostOut`) and the handoff of a running host (`freeze`, `adopt_foreign`). Finding Node is
//! `node.rs`, its per-OS candidate lists included, so they are tested on every OS.

use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

mod node;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as os;
#[cfg(windows)]
use windows as os;

pub use node::resolve_node;
pub use os::{hide_console, kill_group, kill_pid, Gate};
#[cfg(unix)]
pub use unix::{ForeignAdopt, HostFreeze, HostOut, LineGate, NextLine};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostStatus {
    Starting,
    Ready(HostInfo),
    /// A restart is in progress (which attempt number this is).
    Restarting { attempt: u32 },
    /// Gave up trying to revive it — the UI has to tell the person.
    Failed { message: String },
}

/// Where a supervisor's news goes: a Tauri event in the app, the attached windows in the keeper.
pub trait StatusSink: Send + Sync + 'static {
    fn status(&self, status: &HostStatus);
    /// A JSON line on the host's stdout that is not the ready line. Returns true when the sink
    /// used it, so it is not logged as the host's last words. The keeper reads the host's
    /// activity report here; the app's direct path has no use for one.
    fn json_line(&self, _line: &serde_json::Value) -> bool {
        false
    }
}

/// One way to run the host: a program, its arguments and the environment to add.
#[derive(Debug, Clone, PartialEq)]
pub struct HostLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Why a launch could not even be attempted.
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchError {
    /// Retrying gets the same answer (Node is missing): say so at once instead of burning five
    /// backoff rounds on it.
    Fatal(String),
    /// Worth another attempt after the backoff (a copy that failed half way, say).
    #[cfg_attr(not(unix), allow(dead_code))] // only the keeper (unix) builds a Retry
    Retry(String),
}

/// Builds the launch for the next attempt. Called once per attempt, so the keeper can change
/// which build the next attempt runs (a switch) without restarting the supervisor.
pub type Launcher = Arc<dyn Fn() -> Result<HostLaunch, LaunchError> + Send + Sync>;

/// A host's stdout, one line at a time: a blocking reader for a host the supervisor started, or a
/// channel for one the keeper started itself and then handed over (#280 step 3, `adopt`).
pub type Lines = Box<dyn Iterator<Item = String> + Send>;

/// A host that is already running and has said it is ready, handed to `Supervisor::adopt`.
#[cfg_attr(not(unix), allow(dead_code))]
pub struct Adopted {
    pub child: Child,
    pub lines: Lines,
    pub info: HostInfo,
    /// The reader behind `lines`, so this host can be frozen for a keeper handoff later (unix).
    pub gate: Option<Gate>,
}

#[derive(Default)]
struct Inner {
    child: Option<HostProc>,
    /// The running host's stdout reader, when it can be paused (unix: read by `freeze` and `thaw`).
    #[cfg_attr(not(unix), allow(dead_code))]
    gate: Option<Gate>,
    info: Option<HostInfo>,
    status_text: Option<String>,
    shutting_down: bool,
    /// A watcher thread is running. This flag is what stops restart (#184) from launching a
    /// second thread — if two of them alternate starting a host against the same data folder,
    /// they end up blocking each other's lock.
    running: bool,
    /// The host about to exit was stopped on purpose to start another one (the keeper's build
    /// switch). Its exit is not a crash: no backoff, no attempt counted.
    bouncing: bool,
    /// The host about to exit is draining for a blue-green swap (#280 step 3): its exit ends this
    /// watcher without a restart or a status, because the keeper hands the supervisor the next
    /// host itself (`adopt`).
    handing_over: bool,
    /// The last things the host said before it died (dogfooding: an installed build looked
    /// stuck on "Starting…" forever, and the real reason — another instance was holding the
    /// data — was something the host had spelled out plainly on stdout the whole time. The
    /// words were there; they just never reached the screen.)
    last_output: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

/// The cap on restart backoff. Failing **consecutively** this many times is a problem a
/// person has to look at.
pub const MAX_RESTARTS: u32 = 5;

/// Once it has stayed up this long, a death is a new incident, not part of "a run of failed
/// launches".
///
/// If the counter were never reset, keeping the app open for days would eventually accumulate
/// five rare, unrelated crashes and the supervisor would give up entirely — the cap must only
/// apply to consecutive failures.
pub const STABLE_UPTIME: Duration = Duration::from_secs(30);

/// How long a host gets to run its own `shutdown()` after TERM before its group is killed.
/// The old 300ms finished the process off before its WAL checkpoint had completed.
pub const STOP_GRACE: Duration = Duration::from_secs(3);

/// What the watcher does after one host run ended.
#[derive(Debug, PartialEq)]
pub enum AfterExit {
    /// Start again after this attempt's backoff.
    Retry { attempt: u32 },
    /// Start again at once, from attempt zero (a deliberate bounce).
    Again,
    /// Give up and show this.
    GiveUp(String),
}

/// The restart rule, pulled out so it can be tested without a process.
pub fn after_exit(attempt: u32, uptime: Duration, bounced: bool, reason: &str, code: Option<i32>) -> AfterExit {
    if bounced {
        return AfterExit::Again;
    }
    /*
     * If another instance is holding the data, or the data needs a newer Centralu, relaunching
     * just gets the same answer — instead of cycling through five backoff rounds (about 15
     * seconds) showing "Starting…", show the person right away exactly the reason the host gave
     * (what to close or update is spelled out in that message).
     */
    if is_final_refusal(reason) {
        return AfterExit::GiveUp(reason.to_string());
    }
    // If it stayed up long enough before dying, the earlier failure history no longer matters —
    // start counting over from zero.
    let attempt = if uptime >= STABLE_UPTIME { 1 } else { attempt + 1 };
    let msg = if reason.is_empty() {
        format!("agent-host exited (code {code:?})")
    } else {
        format!("agent-host exited (code {code:?})\n{reason}")
    };
    if attempt > MAX_RESTARTS {
        AfterExit::GiveUp(msg)
    } else {
        AfterExit::Retry { attempt }
    }
}

/// A host that exited with one of these sentences says the same thing on every relaunch, so the
/// supervisor reports it at once instead of retrying. The phrases are the host's own:
/// `lockConflictMessage` (instance-lock.ts) and `storeTooNewMessage` (store.ts, #292).
pub fn is_final_refusal(reason: &str) -> bool {
    reason.contains("already using this data") || reason.contains("written by a newer Centralu")
}

/// Exponential backoff (capped at 5 seconds).
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((200 * 2u64.pow(attempt.min(5))).min(5000))
}

impl Supervisor {
    #[cfg_attr(not(unix), allow(dead_code))] // the keeper (unix) is its only caller
    pub fn new() -> Self {
        Self::default()
    }

    pub fn info(&self) -> Option<HostInfo> {
        self.inner.lock().ok()?.info.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().ok()?.status_text.clone()
    }

    /// The running host's pid, if one is running.
    #[cfg_attr(not(unix), allow(dead_code))] // the keeper (unix) is its only caller
    pub fn pid(&self) -> Option<u32> {
        self.inner.lock().ok()?.child.as_ref().map(|c| c.id())
    }

    /// Launches the host and starts the watcher thread. Returns false if one is already running.
    pub fn start(&self, sink: Arc<dyn StatusSink>, launcher: Launcher) -> bool {
        if self.claim(false) {
            self.watch(sink, launcher, None);
            true
        } else {
            false
        }
    }

    /**
     * Starts again after giving up (#184 — Retry on the failure screen).
     *
     * The old Retry only reloaded the webview. The watcher thread had already ended once it
     * emitted `Failed`, and `start` was only ever called from setup, so even after the person
     * fixed the cause (closed another window, installed Node), the old message would show up
     * again after a 30-second wait. There was no way out short of force-quitting.
     *
     * Does nothing if a watcher is still running (mid-backoff) — that thread will produce an
     * answer soon. Returns true once one has started.
     */
    pub fn restart(&self, sink: Arc<dyn StatusSink>, launcher: Launcher) -> bool {
        if !self.claim(true) {
            return false;
        }
        self.watch(sink, launcher, None);
        true
    }

    /**
     * Takes over a host the keeper started and brought to ready itself: the new host of a
     * blue-green swap (#280 step 3). From here on it is supervised exactly like one this supervisor
     * launched: its ready status goes out now, its later lines reach the sink, and if it dies it is
     * restarted with `launcher` by the usual rules. Hands `host` back if a watcher is still running.
     */
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn adopt(&self, host: Adopted, sink: Arc<dyn StatusSink>, launcher: Launcher) -> Result<(), Adopted> {
        if !self.claim(true) {
            return Err(host);
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_output.clear();
            inner.child = Some(HostProc::Own(host.child));
            inner.info = Some(host.info.clone());
            inner.gate = host.gate.clone();
        }
        self.watch(sink, launcher, Some((host.lines, host.info)));
        Ok(())
    }

    /**
     * Marks the running host as draining for a swap (#280 step 3): when it exits, the watcher ends
     * quietly instead of restarting it. Returns its pid, or None when no host is running.
     */
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn hand_over(&self) -> Option<u32> {
        let mut inner = self.inner.lock().ok()?;
        let pid = inner.child.as_ref().map(|c| c.id())?;
        inner.handing_over = true;
        Some(pid)
    }

    /// Writes one line to the running host's stdin: the keeper's control lines (#280 step 3).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn send_line(&self, line: &str) -> std::io::Result<()> {
        let mut inner = self.inner.lock().map_err(|_| std::io::Error::other("supervisor lock poisoned"))?;
        let stdin = inner
            .child
            .as_mut()
            .and_then(|c| c.stdin())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotConnected, "no host is running"))?;
        stdin.write_all(format!("{line}\n").as_bytes())?;
        stdin.flush()
    }

    /// Stops the running host the usual way (TERM, a grace period, then its group) without telling
    /// the watcher anything: for a host already handed over that did not exit on its own.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn stop_current(&self) -> bool {
        let Some(pid) = self.pid() else { return false };
        let stdin = self.inner.lock().ok().and_then(|mut i| i.child.as_mut().and_then(|c| c.take_stdin()));
        stop_pid_gracefully(pid, stdin, || self.pid() != Some(pid));
        true
    }

    /// Whether a watcher thread is running: a host is up, starting, or between restarts.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|i| i.running).unwrap_or(false)
    }

    /// Claims the right to launch a watcher thread. Returns false if one is already running or
    /// the supervisor is shutting down. When `forget_error` is set, clears the old failure
    /// message so a fresh attempt does not look like it failed instantly for the old reason.
    fn claim(&self, forget_error: bool) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.running || inner.shutting_down {
            return false;
        }
        inner.running = true;
        if forget_error {
            inner.status_text = None;
        }
        true
    }

    fn watch(&self, sink: Arc<dyn StatusSink>, launcher: Launcher, mut adopted: Option<(Lines, HostInfo)>) {
        let me = self.clone();
        thread::spawn(move || {
            // Clear the running flag no matter which path this ends on — otherwise Retry could
            // never launch a new one.
            let _running = Running(me.clone());
            let mut attempt = 0u32;
            loop {
                if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                    return;
                }
                let started = Instant::now();
                let outcome = if let Some((lines, info)) = adopted.take() {
                    // Handed over by a swap, already up: report it and follow it to its end
                    sink.status(&HostStatus::Ready(info));
                    Ok(me.pump(&*sink, lines))
                } else {
                    sink.status(&if attempt == 0 { HostStatus::Starting } else { HostStatus::Restarting { attempt } });

                    let launch = match launcher() {
                        Ok(l) => l,
                        Err(LaunchError::Fatal(message)) => {
                            me.give_up(&*sink, message);
                            return;
                        }
                        Err(LaunchError::Retry(message)) => {
                            attempt += 1;
                            if attempt > MAX_RESTARTS {
                                me.give_up(&*sink, message);
                                return;
                            }
                            thread::sleep(backoff(attempt));
                            continue;
                        }
                    };
                    me.spawn_once(&*sink, &launch)
                };

                match outcome {
                    Ok(code) => {
                        // A clean exit (the owner itself requested it) ends the watcher.
                        if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                            return;
                        }
                        // Drained for a swap: the keeper adopts the next host itself
                        if me.inner.lock().map(|mut i| std::mem::take(&mut i.handing_over)).unwrap_or(false) {
                            return;
                        }
                        let bounced = me.inner.lock().map(|mut i| std::mem::take(&mut i.bouncing)).unwrap_or(false);
                        // The last things the host said — if it died before ready, this is why.
                        let reason = me.take_last_output();
                        match after_exit(attempt, started.elapsed(), bounced, &reason, code) {
                            AfterExit::Again => {
                                attempt = 0;
                                continue;
                            }
                            AfterExit::Retry { attempt: next } => attempt = next,
                            AfterExit::GiveUp(message) => {
                                me.give_up(&*sink, message);
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        attempt += 1;
                        if attempt > MAX_RESTARTS {
                            me.give_up(&*sink, format!("failed to start agent-host: {e}"));
                            return;
                        }
                    }
                }
                thread::sleep(backoff(attempt));
            }
        });
    }

    fn give_up(&self, sink: &dyn StatusSink, message: String) {
        self.set_error(&message);
        sink.status(&HostStatus::Failed { message });
    }

    /// Runs the host once → parses its ready line → waits for it to exit. The return value is
    /// the exit code.
    fn spawn_once(&self, sink: &dyn StatusSink, launch: &HostLaunch) -> Result<Option<i32>, String> {
        // Clear this before starting so it does not mix with the previous launch's last words.
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_output.clear();
        }
        let mut child = spawn_host(launch)?;
        let stdout = child.stdout.take().ok_or("could not open stdout")?;

        // unix: a reader that can be paused for a keeper handoff (#280 step 4)
        let (lines, gate) = os::host_lines(stdout);
        if let Ok(mut inner) = self.inner.lock() {
            inner.child = Some(HostProc::Own(child));
            inner.gate = gate;
        }
        Ok(self.pump(sink, lines))
    }

    /// Follows a running host's stdout to its end, then reaps it and returns its exit code.
    ///
    /// Waits for the ready line: on startup the host prints one line of
    /// {"ready":true,"port":..,"token":".."}.
    fn pump(&self, sink: &dyn StatusSink, lines: Lines) -> Option<i32> {
        for line in lines {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(info) = parse_ready(&v) {
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.info = Some(info.clone());
                        inner.status_text = None;
                    }
                    sink.status(&HostStatus::Ready(info));
                    continue;
                }
                if sink.json_line(&v) {
                    continue;
                }
            }
            // Every other line is streamed to the log, but the last several are also kept —
            // if it dies before ready, these lines are the only cause of death on record.
            eprintln!("[agent-host] {line}");
            if let Ok(mut inner) = self.inner.lock() {
                if !line.trim().is_empty() {
                    inner.last_output.push(line.clone());
                    if inner.last_output.len() > 6 {
                        inner.last_output.remove(0);
                    }
                }
            }
        }

        // stdout closing means the process has ended.
        // wait() blocks — waiting while holding the lock would stall IPC (info queries) and
        // shutdown at the same time. Take the child out, release the lock, then wait.
        let mut child = {
            let mut guard = self.inner.lock().ok()?;
            guard.info = None;
            guard.gate = None;
            guard.child.take()
        };
        child.as_mut().and_then(|c| c.wait())
    }

    fn set_error(&self, msg: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status_text = Some(msg.to_string());
        }
    }

    /// Takes and clears the last things a dead host said — so they do not mix with the next
    /// launch's words.
    fn take_last_output(&self) -> String {
        self.inner
            .lock()
            .map(|mut i| std::mem::take(&mut i.last_output).join("\n"))
            .unwrap_or_default()
    }

    /**
     * Stops the running host so the watcher starts the next one at once, from attempt zero. The
     * launcher decides what the next one runs. The keeper uses it for a `switch` while a host is
     * still starting; a host that is up is swapped blue-green instead (`keeper/swap.rs`).
     *
     * The host is stopped the same way as on shutdown — TERM, a grace period for its own
     * `shutdown()`, then the group. Returns false when no host is running.
     */
    #[cfg_attr(not(unix), allow(dead_code))] // the keeper (unix) is its only caller
    pub fn bounce(&self) -> bool {
        let pid = match self.inner.lock() {
            Ok(mut inner) => match inner.child.as_ref().map(|c| c.id()) {
                Some(id) => {
                    inner.bouncing = true;
                    inner.info = None;
                    id
                }
                None => return false,
            },
            Err(_) => return false,
        };
        let stdin = self.inner.lock().ok().and_then(|mut i| i.child.as_mut().and_then(|c| c.take_stdin()));
        stop_pid_gracefully(pid, stdin, || self.pid() != Some(pid));
        true
    }

    /// Stops the host for good. Kills it **as a whole group** — no zombies left behind.
    pub fn shutdown(&self) {
        // The lock is only held while taking the child out. Sleeping or calling wait() inside
        // the lock would leave the watcher thread and IPC waiting on the same lock, and shutdown
        // would block on them and vice versa.
        let child = match self.inner.lock() {
            Ok(mut inner) => {
                inner.shutting_down = true;
                inner.info = None;
                inner.child.take()
            }
            Err(_) => None,
        };
        if let Some(mut child) = child {
            let pid = child.id();
            let stdin = child.take_stdin();
            stop_pid_gracefully(pid, stdin, || child.has_exited());
            child.kill();
            let _ = child.wait();
        }
    }
}

/// The ready line `{"ready":true,"port":..,"token":".."}`, if this is it.
pub fn parse_ready(v: &serde_json::Value) -> Option<HostInfo> {
    if v.get("ready").and_then(|r| r.as_bool()) != Some(true) {
        return None;
    }
    Some(HostInfo {
        port: v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
        token: v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string(),
    })
}

/// Starts one host process the way every host is started: stdin and stdout piped, stderr to ours,
/// its own process group. Shared by the supervisor and the keeper's swap (#280 step 3), so a host
/// started for a swap is tied to the keeper and stopped exactly like any other.
pub fn spawn_host(launch: &HostLaunch) -> Result<Child, String> {
    let mut cmd = Command::new(&launch.program);
    // Keeping stdin open as a pipe is **the whole trick that prevents orphans.**
    // Whatever reason the parent dies for (including a crash or SIGKILL), this pipe closes,
    // and the host sees EOF and exits on its own (`--watch-parent`). Relying only on a
    // shutdown hook leaves a zombie behind when the parent is force-quit. Under a keeper the
    // parent is the keeper, so the host's life is tied to the keeper, not to the app.
    cmd.args(&launch.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (k, v) in &launch.env {
        cmd.env(k, v);
    }

    // Puts the child in a **process group where it is its own leader** (unix), so the whole tree
    // can be stopped: the node launcher (tsx) spawns children of its own. Windows has no groups;
    // what it needs is no console window (`hide_console`).
    os::own_group(&mut cmd);
    hide_console(&mut cmd);

    cmd.spawn().map_err(|e| format!("failed to run {}: {e}", launch.program))
}

/// Stops a host the supervisor does not hold (a swap's standby that failed its check, #280 step 3)
/// the same way the supervisor stops its own, and reaps it.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn stop_child(child: &mut Child) {
    let pid = child.id();
    let stdin = child.stdin.take().map(|s| Box::new(s) as Box<dyn Send>);
    stop_pid_gracefully(pid, stdin, || matches!(child.try_wait(), Ok(Some(_))));
    let _ = child.kill();
    let _ = child.wait();
}

/**
 * TERM to the host alone, a grace period, then TERM to its whole group.
 *
 * Must not start by sending TERM to the whole group — measured (#57): on SIGTERM, codex
 * app-server dies instantly and leaves behind its lock file (thread-writer-locks/<id>.lock),
 * but on stdin EOF it removes the lock and exits on its own within 18ms. A group-wide TERM takes
 * away the host's disposeAll's chance to close things via EOF and hits the codex children
 * directly instead. The group-wide TERM that follows is only a zombie-prevention backstop that
 * actually does anything when the host is stuck.
 *
 * Windows has no TERM. There the polite request is **closing the host's stdin**: the host runs
 * with `--watch-parent`, so EOF runs the same `shutdown()` a TERM does (agent-host main.ts).
 * Before this, both kill functions were empty off unix and stdin stayed open, so every quit
 * stalled the full grace period and then hard-killed the host, which never got to release
 * `host.lock` (#14). On unix stdin is kept open until the end, so EOF does not race the signal
 * into a second `shutdown()`.
 */
fn stop_pid_gracefully(pid: u32, stdin: Option<Box<dyn Send>>, mut gone: impl FnMut() -> bool) {
    let _stdin_until_the_end = if os::CLOSE_STDIN_TO_STOP {
        drop(stdin);
        None
    } else {
        stdin
    };
    kill_pid(pid);
    let deadline = Instant::now() + STOP_GRACE;
    let mut ended = false;
    while Instant::now() < deadline {
        if gone() {
            ended = true;
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    // unix: the group outlives its leader and its number is not reused while anyone is in it, so
    // it is signalled either way. Windows: `taskkill /T` walks the tree from a pid, and a pid that
    // has ended may already belong to someone else — so only a host still running is ended.
    if os::SIGNAL_GROUP_AFTER_EXIT || !ended {
        kill_group(pid);
    }
}

/// The host process a supervisor holds: one it started, or (unix) one another keeper started and
/// handed over, which it is not the parent of (`os::Foreign`; there is none on Windows).
pub enum HostProc {
    Own(Child),
    Foreign(os::Foreign),
}

impl HostProc {
    pub fn id(&self) -> u32 {
        match self {
            HostProc::Own(c) => c.id(),
            HostProc::Foreign(f) => f.id(),
        }
    }

    fn stdin(&mut self) -> Option<&mut dyn Write> {
        match self {
            HostProc::Own(c) => c.stdin.as_mut().map(|s| s as &mut dyn Write),
            HostProc::Foreign(f) => f.stdin(),
        }
    }

    fn take_stdin(&mut self) -> Option<Box<dyn Send>> {
        match self {
            HostProc::Own(c) => c.stdin.take().map(|s| Box::new(s) as Box<dyn Send>),
            HostProc::Foreign(f) => f.take_stdin(),
        }
    }

    fn has_exited(&mut self) -> bool {
        match self {
            HostProc::Own(c) => matches!(c.try_wait(), Ok(Some(_))),
            HostProc::Foreign(f) => f.has_exited(),
        }
    }

    fn kill(&mut self) {
        match self {
            HostProc::Own(c) => {
                let _ = c.kill();
            }
            HostProc::Foreign(f) => f.kill(),
        }
    }

    /// Waits for it to end and returns its exit code, when it is ours to read.
    fn wait(&mut self) -> Option<i32> {
        match self {
            HostProc::Own(c) => c.wait().ok().and_then(|s| s.code()),
            HostProc::Foreign(f) => f.wait(),
        }
    }
}

/// Clears `running` when the watcher thread ends. There are several `return` points, so this is
/// left to Drop.
struct Running(Supervisor);

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            inner.running = false;
        }
    }
}

/// `CC_HOST_CMD`, split on whitespace: the escape hatch for running some other host.
pub fn host_cmd_override() -> Option<(String, Vec<String>)> {
    let cmd = std::env::var("CC_HOST_CMD").ok()?;
    let mut parts = cmd.split_whitespace().map(String::from).collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    let program = parts.remove(0);
    Some((program, parts))
}

/// The bundled host, run through the system Node (decision F-0a). Node SEA was excluded from
/// the dogfooding scope because native addons made it too costly.
pub fn bundled_launch(main_mjs: &Path, extra: &[String]) -> Result<HostLaunch, LaunchError> {
    let node = resolve_node().map_err(LaunchError::Fatal)?;
    let mut args = vec![
        main_mjs.to_string_lossy().to_string(),
        "--port".into(),
        "0".into(),
        "--watch-parent".into(),
    ];
    args.extend(extra.iter().cloned());
    Ok(HostLaunch { program: node, args, env: Vec::new() })
}

/// dev: runs the source directly through the workspace's tsx.
/// Marking it with CC_DEV makes the host use a **different data folder** than the release app
/// — the two can be running at once without the session lists getting mixed up.
///
/// **Never goes through a package manager** — launching through the pnpm wrapper only kills
/// the wrapper, leaving the actual host (a grandchild) orphaned (confirmed by measurement).
pub fn source_launch(extra: &[String]) -> HostLaunch {
    let root = workspace_root();
    let mut args = vec![
        format!("{root}/packages/agent-host/src/main.ts"),
        "--port".into(),
        "0".into(),
        "--watch-parent".into(),
    ];
    args.extend(extra.iter().cloned());
    let program = os::tsx_program(&root, &mut args);
    HostLaunch { program, args, env: vec![("CC_DEV".into(), "1".into())] }
}

pub fn workspace_root() -> String {
    // This crate is apps/desktop/src-tauri/keeper: four levels up is the workspace root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(test)]
mod tests;
