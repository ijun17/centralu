//! Running and supervising one agent host, with no Tauri in sight.
//!
//! Two callers share this module (#280, option C step 1):
//!   - the app's **direct** path (`pnpm app:dev`, debug builds, non-unix targets), where the app
//!     itself is the host's parent, as it always was;
//!   - the **keeper** (`centralu --keeper`), a detached copy of the same executable that holds
//!     the host so that quitting or replacing the app does not end it.
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

use std::io::{BufReader, Write};
#[cfg(not(unix))]
use std::io::BufRead;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

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
    /// The reader behind `lines`, so this host can be frozen for a keeper handoff later.
    #[cfg(unix)]
    pub gate: Option<Arc<LineGate>>,
}

#[derive(Default)]
struct Inner {
    child: Option<HostProc>,
    /// The running host's stdout reader, when it can be paused (unix).
    #[cfg(unix)]
    gate: Option<Arc<LineGate>>,
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

    /**
     * Stops reading the running host's stdout for a keeper handoff (#280 step 4) and returns what
     * the next keeper needs to go on supervising it. `Ok(None)` when no host is running (it gave
     * up): there is nothing to hand over. Refused while a host is starting, restarting, being
     * stopped or swapped: those are moments with a second process or a half-read ready line.
     */
    #[cfg(unix)]
    pub fn freeze(&self, wait: Duration) -> Result<Option<HostFreeze>, String> {
        let gate = {
            let inner = self.inner.lock().map_err(|_| "supervisor lock poisoned")?;
            if inner.shutting_down || inner.bouncing || inner.handing_over {
                return Err("the host is being stopped or swapped".into());
            }
            if !inner.running {
                return Ok(None);
            }
            match (&inner.child, &inner.gate, &inner.info) {
                (Some(_), Some(g), Some(_)) => g.clone(),
                _ => return Err("the host is starting or restarting".into()),
            }
        };
        let buffered = gate.freeze(wait)?;
        let frozen = (|| {
            let inner = self.inner.lock().map_err(|_| "supervisor lock poisoned".to_string())?;
            let child = inner.child.as_ref().ok_or("the host is gone")?;
            Ok::<_, String>(HostFreeze {
                pid: child.id(),
                stdin: child.dup_stdin().map_err(|e| e.to_string())?,
                stdout: gate.fd().try_clone_to_owned().map_err(|e| e.to_string())?,
                buffered,
                info: inner.info.clone(),
            })
        })();
        if frozen.is_err() {
            gate.thaw();
        }
        frozen.map(Some)
    }

    /// Resumes reading the host's stdout: the handoff was rolled back.
    #[cfg(unix)]
    pub fn thaw(&self) {
        if let Some(g) = self.inner.lock().ok().and_then(|i| i.gate.clone()) {
            g.thaw();
        }
    }

    /**
     * Takes over a host another keeper started and handed over (#280 step 4). From here it is
     * supervised like any other: its later lines reach the sink, and when it dies the next host is
     * started with `launcher` (as this supervisor's own child) by the usual rules.
     */
    #[cfg(unix)]
    pub fn adopt_foreign(&self, h: ForeignAdopt, sink: Arc<dyn StatusSink>, launcher: Launcher) -> Result<(), String> {
        if !self.claim(true) {
            return Err("the supervisor is already running a host".into());
        }
        let out = HostOut::new(h.stdout, h.buffered);
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_output.clear();
            inner.child = Some(HostProc::Foreign { pid: h.pid, stdin: Some(std::fs::File::from(h.stdin)) });
            inner.gate = Some(out.gate());
            inner.info = Some(h.info.clone());
        }
        self.watch(sink, launcher, Some((Box::new(out), h.info)));
        Ok(())
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
            #[cfg(unix)]
            {
                inner.gate = host.gate.clone();
            }
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
        #[cfg(unix)]
        let (lines, gate): (Lines, _) = {
            let out = HostOut::new(stdout.into(), Vec::new());
            let gate = out.gate();
            (Box::new(out), Some(gate))
        };
        #[cfg(not(unix))]
        let lines: Lines = Box::new(BufReader::new(stdout).lines().map_while(Result::ok));
        if let Ok(mut inner) = self.inner.lock() {
            inner.child = Some(HostProc::Own(child));
            #[cfg(unix)]
            {
                inner.gate = gate;
            }
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
            #[cfg(unix)]
            {
                guard.gate = None;
            }
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

    // Puts the child in a **process group where it is its own leader**.
    // The node launcher (tsx) spawns children of its own, so killing only the direct child
    // and not the whole group leaves the grandchild orphaned.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // Windows has no process groups to join; the tree is ended with `taskkill /T` instead
    // (`kill_group`). What it does need is no console: the release app is a GUI-subsystem
    // program, so `node.exe` would otherwise get a console window of its own, visible for as
    // long as the host runs. The host's own children (git, codex, claude) inherit that
    // windowless console rather than each opening one.
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
    #[cfg(unix)]
    let _stdin_until_the_end = stdin;
    #[cfg(not(unix))]
    drop(stdin);
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
    if cfg!(unix) || !ended {
        kill_group(pid);
    }
}


/**
 * A host's stdout, one line at a time, that can be **stopped between two lines** and handed to
 * another keeper (#280 step 4) with every byte it had read but not yet delivered.
 *
 * A `BufReader` would read ahead into a buffer nobody else can see, and a thread blocked in
 * `read` cannot be told to stop. So the bytes live in a buffer shared with whoever freezes it, and
 * the reading thread polls with a short timeout and parks when asked. The next keeper starts its
 * own reader with those bytes first: no status line is lost or seen twice.
 */
#[cfg(unix)]
pub struct LineGate {
    st: Mutex<GateState>,
    cv: std::sync::Condvar,
    fd: std::os::fd::OwnedFd,
}

#[cfg(unix)]
#[derive(Default)]
struct GateState {
    /// Read from the host and not yet returned as a line.
    buf: Vec<u8>,
    frozen: bool,
    parked: bool,
    eof: bool,
}

#[cfg(unix)]
impl LineGate {
    /// Stops the reader at its next line boundary and returns the bytes it holds. Refused if the
    /// reader does not come back within `wait` (it is inside the sink, which should not happen).
    pub fn freeze(&self, wait: Duration) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + wait;
        let mut st = self.st.lock().map_err(|_| "host reader poisoned")?;
        st.frozen = true;
        while !st.parked {
            if st.eof {
                st.frozen = false;
                return Err("the host has exited".into());
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                st.frozen = false;
                self.cv.notify_all();
                return Err("the host's output reader did not pause in time".into());
            };
            st = self.cv.wait_timeout(st, left).map_err(|_| "host reader poisoned")?.0;
        }
        Ok(st.buf.clone())
    }

    pub fn thaw(&self) {
        if let Ok(mut st) = self.st.lock() {
            st.frozen = false;
        }
        self.cv.notify_all();
    }

    pub fn fd(&self) -> std::os::fd::BorrowedFd<'_> {
        use std::os::fd::AsFd;
        self.fd.as_fd()
    }
}

/// What `HostOut::next_line` found.
#[cfg(unix)]
#[derive(Debug, PartialEq)]
pub enum NextLine {
    Line(String),
    Timeout,
    End,
}

#[cfg(unix)]
pub struct HostOut(Arc<LineGate>);

#[cfg(unix)]
impl HostOut {
    /// A reader over the host's stdout. `initial` is what a previous keeper had read and not yet
    /// delivered.
    pub fn new(fd: std::os::fd::OwnedFd, initial: Vec<u8>) -> HostOut {
        HostOut(Arc::new(LineGate {
            st: Mutex::new(GateState { buf: initial, ..Default::default() }),
            cv: std::sync::Condvar::new(),
            fd,
        }))
    }

    pub fn gate(&self) -> Arc<LineGate> {
        self.0.clone()
    }

    /// The next line, waiting until `deadline` (forever with None).
    pub fn next_line(&self, deadline: Option<Instant>) -> NextLine {
        use std::os::fd::AsRawFd;
        let g = &self.0;
        loop {
            {
                let Ok(mut st) = g.st.lock() else { return NextLine::End };
                if st.frozen {
                    st.parked = true;
                    g.cv.notify_all();
                    while st.frozen {
                        st = match g.cv.wait(st) {
                            Ok(s) => s,
                            Err(_) => return NextLine::End,
                        };
                    }
                    st.parked = false;
                }
                if let Some(i) = st.buf.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = st.buf.drain(..=i).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    return NextLine::Line(String::from_utf8_lossy(&line).into_owned());
                }
                if st.eof {
                    if st.buf.is_empty() {
                        return NextLine::End;
                    }
                    let rest = std::mem::take(&mut st.buf);
                    return NextLine::Line(String::from_utf8_lossy(&rest).into_owned());
                }
            }
            let mut wait_ms = 100;
            if let Some(d) = deadline {
                let Some(left) = d.checked_duration_since(Instant::now()) else { return NextLine::Timeout };
                wait_ms = wait_ms.min(left.as_millis() as i32 + 1);
            }
            let mut p = libc::pollfd { fd: g.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            if unsafe { libc::poll(&mut p, 1, wait_ms) } <= 0 {
                continue;
            }
            let mut tmp = [0u8; 16 * 1024];
            // SAFETY: tmp is valid for its length.
            let n = unsafe { libc::read(g.fd.as_raw_fd(), tmp.as_mut_ptr() as *mut libc::c_void, tmp.len()) };
            let Ok(mut st) = g.st.lock() else { return NextLine::End };
            if n > 0 {
                st.buf.extend_from_slice(&tmp[..n as usize]);
            } else if n == 0 {
                st.eof = true;
            } else {
                let e = std::io::Error::last_os_error();
                if !matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock) {
                    st.eof = true;
                }
            }
        }
    }
}

#[cfg(unix)]
impl Iterator for HostOut {
    type Item = String;
    fn next(&mut self) -> Option<String> {
        match self.next_line(None) {
            NextLine::Line(l) => Some(l),
            _ => None,
        }
    }
}

/// A running host frozen for a keeper handoff (#280 step 4): what the next keeper needs to go on
/// supervising it.
#[cfg(unix)]
pub struct HostFreeze {
    pub pid: u32,
    pub stdin: std::os::fd::OwnedFd,
    pub stdout: std::os::fd::OwnedFd,
    /// Read from its stdout and not yet delivered.
    pub buffered: Vec<u8>,
    pub info: Option<HostInfo>,
}

/// A host another keeper started, handed over at a commit (#280 step 4).
#[cfg(unix)]
pub struct ForeignAdopt {
    pub pid: u32,
    pub stdin: std::os::fd::OwnedFd,
    pub stdout: std::os::fd::OwnedFd,
    pub buffered: Vec<u8>,
    pub info: HostInfo,
}

/// The host process a supervisor holds: one it started, or (unix) one another keeper started and
/// handed over, which it is not the parent of.
pub enum HostProc {
    Own(Child),
    #[cfg(unix)]
    Foreign { pid: u32, stdin: Option<std::fs::File> },
}

impl HostProc {
    pub fn id(&self) -> u32 {
        match self {
            HostProc::Own(c) => c.id(),
            #[cfg(unix)]
            HostProc::Foreign { pid, .. } => *pid,
        }
    }

    fn stdin(&mut self) -> Option<&mut dyn Write> {
        match self {
            HostProc::Own(c) => c.stdin.as_mut().map(|s| s as &mut dyn Write),
            #[cfg(unix)]
            HostProc::Foreign { stdin, .. } => stdin.as_mut().map(|s| s as &mut dyn Write),
        }
    }

    fn take_stdin(&mut self) -> Option<Box<dyn Send>> {
        match self {
            HostProc::Own(c) => c.stdin.take().map(|s| Box::new(s) as Box<dyn Send>),
            #[cfg(unix)]
            HostProc::Foreign { stdin, .. } => stdin.take().map(|s| Box::new(s) as Box<dyn Send>),
        }
    }

    #[cfg(unix)]
    fn dup_stdin(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        use std::os::fd::AsFd;
        let missing = || std::io::Error::new(std::io::ErrorKind::NotConnected, "the host's stdin is closed");
        match self {
            HostProc::Own(c) => c.stdin.as_ref().ok_or_else(missing)?.as_fd().try_clone_to_owned(),
            HostProc::Foreign { stdin, .. } => stdin.as_ref().ok_or_else(missing)?.as_fd().try_clone_to_owned(),
        }
    }

    fn has_exited(&mut self) -> bool {
        match self {
            HostProc::Own(c) => matches!(c.try_wait(), Ok(Some(_))),
            #[cfg(unix)]
            HostProc::Foreign { pid, .. } => !pid_alive(*pid),
        }
    }

    fn kill(&mut self) {
        match self {
            HostProc::Own(c) => {
                let _ = c.kill();
            }
            #[cfg(unix)]
            HostProc::Foreign { pid, .. } => {
                if pid_alive(*pid) {
                    // SAFETY: a plain syscall; the pid is the host we supervise and is still there.
                    unsafe { libc::kill(*pid as i32, libc::SIGKILL) };
                }
            }
        }
    }

    /// Waits for it to end. A foreign host is not ours to reap: its parent (init, once the keeper
    /// that started it has gone) does, and its exit code is not ours to read.
    fn wait(&mut self) -> Option<i32> {
        match self {
            HostProc::Own(c) => c.wait().ok().and_then(|s| s.code()),
            #[cfg(unix)]
            HostProc::Foreign { pid, .. } => {
                let end = Instant::now() + Duration::from_secs(10);
                while pid_alive(*pid) && Instant::now() < end {
                    thread::sleep(Duration::from_millis(50));
                }
                None
            }
        }
    }
}

/// Whether a process exists and is not a zombie waiting for someone else to reap it.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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

/// SIGTERM to the single host process only — children (codex, etc.) are cleaned up by the
/// host itself via EOF (#57).
#[cfg(unix)]
pub fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Windows: nothing to send. Closing stdin (in `stop_pid_gracefully`) is the request to stop.
#[cfg(not(unix))]
pub fn kill_pid(_pid: u32) {}

/// SIGTERM to the whole process group (a negative pid means the group).
#[cfg(unix)]
pub fn kill_group(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Windows: the host and every process under it, forcibly. `taskkill` is named by its full path
/// under the system folder, so a `taskkill.exe` in the working directory or on PATH is never the
/// one that runs.
#[cfg(windows)]
pub fn kill_group(pid: u32) {
    let mut cmd = Command::new(windows_system_tool("taskkill.exe"));
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    let _ = cmd.status();
}

#[cfg(not(any(unix, windows)))]
pub fn kill_group(_pid: u32) {}

/// `%SystemRoot%\System32\<name>`.
#[cfg(windows)]
fn windows_system_tool(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::path::PathBuf::from(root).join("System32").join(name)
}

/// Starts a console program with no console window (`CREATE_NO_WINDOW`). A no-op off Windows.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
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
    // Windows: `.bin/tsx` is a sh script, and its siblings `tsx.CMD` / `tsx.ps1` cannot be
    // started without a shell either (Rust would hand the sh script to CreateProcessW and fail).
    // So Node runs tsx's own entry directly, the file `.bin/tsx` points at anyway.
    let program = if cfg!(windows) {
        args.insert(0, format!("{root}/node_modules/tsx/dist/cli.mjs"));
        resolve_node().unwrap_or_else(|_| "node".into())
    } else {
        format!("{root}/node_modules/.bin/tsx")
    };
    HostLaunch { program, args, env: vec![("CC_DEV".into(), "1".into())] }
}

pub fn workspace_root() -> String {
    // Two levels up from src-tauri/ is apps/, three levels up is the workspace root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// The guidance shown to the person verbatim when Node cannot be found.
///
/// **A silent failure is the worst outcome.** It used to just run `"node"` bare when it
/// could not find it, which left only `No such file or directory`, and that raw text is
/// what showed up on screen. There was no way to tell apart Node truly being missing, Node
/// being present but not found, and the version being too low.
fn node_missing_message(looked: &[String]) -> String {
    format!(
        "Could not find Node.js. Centralu requires Node {MIN_NODE_MAJOR} or newer.\n\
         Check with `node --version` in a terminal, and if it is missing, install it with \
         {INSTALL_NODE_HINT} or from https://nodejs.org, then restart the app.\n\
         Looked in: {}",
        looked.join(", ")
    )
}

/// Told to someone who has no Node at all, so it has to name a command they can actually
/// run. `brew` was hardcoded, which on Linux points at a package manager that is not
/// there — the one message whose whole job is to unblock a stuck user would have sent
/// them somewhere else.
#[cfg(target_os = "macos")]
const INSTALL_NODE_HINT: &str = "`brew install node`";
#[cfg(windows)]
const INSTALL_NODE_HINT: &str = "`winget install OpenJS.NodeJS.LTS`";
#[cfg(not(any(target_os = "macos", windows)))]
const INSTALL_NODE_HINT: &str = "your distribution's package manager (for example, `apt install nodejs`)";

#[cfg(target_os = "macos")]
const UPGRADE_NODE_HINT: &str = "`brew upgrade node`";
#[cfg(windows)]
const UPGRADE_NODE_HINT: &str = "`winget upgrade OpenJS.NodeJS.LTS`";
#[cfg(not(any(target_os = "macos", windows)))]
const UPGRADE_NODE_HINT: &str = "your distribution's package manager";

/// The first place `pick_node` asks, named in the "looked in" list.
#[cfg(unix)]
const FIRST_LOOK: &str = "login shell PATH";
#[cfg(not(unix))]
const FIRST_LOOK: &str = "PATH";

/// The host bundle's esbuild target is node22 — below that, even the syntax breaks.
const MIN_NODE_MAJOR: u32 = 22;

/// Finding Node takes around one second because it launches the whole login shell. Since the
/// restart loop calls this every time, a successful find is cached. **A failed find is never
/// cached** (#184) — someone who installs Node after opening the app and presses Retry must
/// not be shown the old "not found" again.
static NODE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Finds the **absolute path** to the Node the release build will use to run the host.
///
/// **Why a fixed path does not work (measured):** a `.app` launched from the GUI does not
/// inherit the login shell's PATH, and only gets
/// `/usr/bin:/bin:/usr/sbin:/sbin`. This used to only check the two Homebrew locations and
/// `/usr/bin`, but Node installed via nvm, mise or volta lives under the home directory, so
/// **the app would not start even on a Mac where Node was perfectly well installed.** The
/// claude and codex CLI lookups had already hit the same problem and were fixed to ask the
/// login shell (`packages/agent-host/src/env-path.ts`); only node was left using the old
/// approach.
///
/// **Windows** has no login shell to ask, and does not need one: a program started from Explorer
/// inherits the user's PATH from the registry, which is where the Node installer, nvm-windows,
/// Volta and Scoop put themselves. So PATH is searched first, then the places those installers use.
pub fn resolve_node() -> Result<String, String> {
    remember_found(&NODE, || pick_node(probe_first(), fallback_node_paths()))
}

#[cfg(unix)]
fn probe_first() -> Option<String> {
    probe_login_shell()
}

#[cfg(not(unix))]
fn probe_first() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    first_on_path(std::env::split_paths(&path), "node.exe", |p| p.is_file())
}

/// The first `<dir>\<name>` that exists, over the absolute entries of PATH only: a relative entry
/// would be resolved against whatever the working directory happens to be.
#[cfg_attr(unix, allow(dead_code))]
fn first_on_path(
    dirs: impl IntoIterator<Item = std::path::PathBuf>,
    name: &str,
    exists: impl Fn(&Path) -> bool,
) -> Option<String> {
    dirs.into_iter()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| exists(p))
        .map(|p| p.to_string_lossy().to_string())
}

/// Only caches a successful find. If it was not found, asks again next time.
fn remember_found(
    cache: &std::sync::OnceLock<String>,
    probe: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(found) = cache.get() {
        return Ok(found.clone());
    }
    let found = probe()?;
    Ok(cache.get_or_init(|| found).clone())
}

/// The selection rule pulled out on its own, so it can be tested with neither a shell nor a
/// real filesystem.
///
/// Order: whatever the login shell knows about (the exact node the person already uses in a
/// terminal), then the common install locations. **Does not stop just because it is old** — a
/// Mac with nvm defaulting to v18 while Homebrew has v22 is common. But it carries forward the
/// fact that it hit an old one, and shows that as the reason if nothing newer turns up
/// ("needs an upgrade" is closer to what the person actually has to do than "not found").
fn pick_node(from_shell: Option<String>, fallbacks: Vec<String>) -> Result<String, String> {
    let mut looked = vec![FIRST_LOOK.to_string()];
    let mut ordered: Vec<String> = from_shell.into_iter().collect();

    for candidate in fallbacks {
        looked.push(candidate.clone());
        if Path::new(&candidate).exists() {
            ordered.push(candidate);
        }
    }

    let mut too_old: Option<String> = None;
    for path in ordered {
        match check_node_version(&path) {
            Ok(found) => return Ok(found),
            Err(why) => {
                too_old.get_or_insert(why);
            }
        }
    }

    Err(too_old.unwrap_or_else(|| node_missing_message(&looked)))
}

/// Asks the login shell where node is. It has to be interactive (-i) for .zshrc's nvm/mise
/// initialization to run.
///
/// Only the line carrying the marker is picked out, so it does not matter what else the shell
/// configuration prints.
#[cfg(unix)]
fn probe_login_shell() -> Option<String> {
    use std::io::Read;

    let shell = std::env::var("SHELL").ok()?;
    if !Path::new(&shell).exists() {
        return None;
    }

    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "command -p echo \"__CC_NODE__:$(command -v node)\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // So the shell's initialization script does not put up an interactive prompt.
        .env("TERM", "dumb")
        .env("CI", "1");
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take()?;

    // **Getting stuck here would fail the whole app's launch.** Shell configurations really do
    // sometimes wait forever (waiting on prompt input, for example), so this cuts it off on a
    // timer and kills the whole group.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    parse_probe_output(&out)
}

/// Pulls the path out of the marked line among whatever the shell printed.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_probe_output(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("__CC_NODE__:"))
        .map(str::trim)
        .filter(|p| !p.is_empty() && Path::new(p).exists())
        .map(str::to_string)
}

/// The fallback for when the shell cannot be used. Checks not just Homebrew but the common
/// locations of version managers too.
#[cfg(unix)]
fn fallback_node_paths() -> Vec<String> {
    node_paths_under(&std::env::var("HOME").unwrap_or_default())
}

#[cfg(not(unix))]
fn fallback_node_paths() -> Vec<String> {
    windows_node_paths(|name| std::env::var(name).ok().filter(|v| !v.is_empty()), nvm_windows_versions)
}

/// Where Windows installers put `node.exe`, read from the environment variables they set.
///
/// Built with `\` by hand rather than `Path::join`, so the list is the same string on every OS
/// and its test runs anywhere. `versions` lists nvm-windows' installed versions, newest first.
#[cfg_attr(unix, allow(dead_code))]
fn windows_node_paths(env: impl Fn(&str) -> Option<String>, versions: impl Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut paths = Vec::new();
    // The official installer (Chocolatey and winget wrap it), machine-wide.
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = env(var) {
            paths.push(format!("{dir}\\nodejs\\node.exe"));
        }
    }
    if let Some(local) = env("LOCALAPPDATA") {
        // A per-user install of the same.
        paths.push(format!("{local}\\Programs\\nodejs\\node.exe"));
        // Volta's per-user shims.
        paths.push(format!("{local}\\Volta\\bin\\node.exe"));
    }
    // nvm-windows: the active version is a symlink at NVM_SYMLINK; every version sits in NVM_HOME.
    if let Some(link) = env("NVM_SYMLINK") {
        paths.push(format!("{link}\\node.exe"));
    }
    if let Some(home) = env("NVM_HOME") {
        paths.extend(versions(&home).into_iter().map(|v| format!("{home}\\{v}\\node.exe")));
    }
    if let Some(profile) = env("USERPROFILE") {
        paths.push(format!("{profile}\\scoop\\shims\\node.exe"));
        paths.push(format!("{profile}\\scoop\\apps\\nodejs\\current\\node.exe"));
        paths.push(format!("{profile}\\scoop\\apps\\nodejs-lts\\current\\node.exe"));
    }
    // ProgramFiles and ProgramW6432 are usually the same folder; Windows paths ignore case.
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.to_ascii_lowercase()));
    paths
}

/// nvm-windows' version folders (`v22.3.1`), newest first, compared as numbers.
#[cfg(not(unix))]
fn nvm_windows_versions(home: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = version_parts(&name);
            (name.starts_with('v') && !parts.is_empty()).then_some((parts, name))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, n)| n).collect()
}

#[cfg_attr(not(unix), allow(dead_code))]
fn node_paths_under(home: &str) -> Vec<String> {
    let mut paths = vec![
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ];
    if !home.is_empty() {
        paths.push(format!("{home}/.volta/bin/node"));
        paths.push(format!("{home}/.local/share/mise/shims/node"));
        paths.push(format!("{home}/.asdf/shims/node"));
        paths.push(format!("{home}/.local/bin/node"));
        // nvm keeps a separate directory per version — pick the highest one.
        paths.extend(nvm_versions(&format!("{home}/.nvm/versions/node")));
    }
    paths
}

/// `~/.nvm/versions/node/*/bin/node`, in descending version order.
///
/// The names look like `v22.3.1`, so a lexical sort would wrongly put v9 ahead of v22.
/// Compared as numbers instead.
#[cfg_attr(not(unix), allow(dead_code))]
fn nvm_versions(root: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = version_parts(&name);
            (!parts.is_empty()).then(|| (parts, format!("{root}/{name}/bin/node")))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

/// `v22.3.1` → `[22, 3, 1]`. An empty vector if it does not parse as numbers.
fn version_parts(raw: &str) -> Vec<u32> {
    let trimmed = raw.trim().trim_start_matches('v');
    let parts: Vec<u32> = trimmed.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() {
        Vec::new()
    } else {
        parts
    }
}

/// Checks whether the Node that was found is actually a usable version.
///
/// **A too-low version and a missing one call for different actions from the person** — an
/// upgrade, not an install. So the messages are kept separate. If the version cannot be read,
/// it is let through (there is no basis for blocking it).
fn check_node_version(path: &str) -> Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version").stdin(Stdio::null());
    hide_console(&mut cmd);
    let Ok(out) = cmd.output() else {
        return Ok(path.to_string());
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let Some(&major) = version_parts(raw.trim()).first() else {
        return Ok(path.to_string());
    };
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Node {MIN_NODE_MAJOR} or newer is required, but {path} is {}.\n\
             {UPGRADE_NODE_HINT}, or switch to {MIN_NODE_MAJOR} or newer with nvm or mise, then restart the app.",
            raw.trim()
        ));
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store a newer Centralu wrote is reported at once, like a lock conflict; a plain crash is
    /// still retried (#292).
    #[test]
    fn a_store_too_new_is_final_like_a_lock_conflict() {
        assert!(is_final_refusal("[agent-host] Another Centralu is already using this data (pid 42)."));
        assert!(is_final_refusal(
            "[agent-host] This data was written by a newer Centralu.\n  It can be read from store version 45 on"
        ));
        assert!(!is_final_refusal("agent-host exited (code Some(1))\nTypeError: x is undefined"));
        let too_new = "[agent-host] This data was written by a newer Centralu.";
        assert_eq!(after_exit(0, Duration::ZERO, false, too_new, Some(1)), AfterExit::GiveUp(too_new.into()));
    }

    #[test]
    fn counts_consecutive_failures_and_gives_up_after_five() {
        let quick = Duration::from_secs(1);
        assert_eq!(after_exit(0, quick, false, "", Some(1)), AfterExit::Retry { attempt: 1 });
        assert_eq!(after_exit(4, quick, false, "", Some(1)), AfterExit::Retry { attempt: 5 });
        match after_exit(5, quick, false, "boom", Some(1)) {
            AfterExit::GiveUp(m) => assert!(m.contains("boom") && m.contains("Some(1)"), "{m}"),
            other => panic!("expected to give up, got {other:?}"),
        }
    }

    #[test]
    fn a_death_after_a_stable_run_starts_the_count_over() {
        assert_eq!(after_exit(5, STABLE_UPTIME, false, "", None), AfterExit::Retry { attempt: 1 });
    }

    #[test]
    fn another_owner_of_the_data_is_reported_at_once() {
        let reason = "[agent-host] Another Centralu is already using this data (pid 7).";
        assert_eq!(after_exit(0, Duration::ZERO, false, reason, Some(1)), AfterExit::GiveUp(reason.into()));
    }

    /// The keeper's build switch stops the host on purpose; that exit must not count as a
    /// crash, or five switches in a row would leave the person with "gave up".
    #[test]
    fn a_deliberate_bounce_starts_again_without_counting() {
        assert_eq!(after_exit(5, Duration::ZERO, true, "anything", Some(0)), AfterExit::Again);
    }

    #[test]
    fn backoff_doubles_and_stops_at_five_seconds() {
        assert_eq!(backoff(1), Duration::from_millis(400));
        assert_eq!(backoff(2), Duration::from_millis(800));
        assert_eq!(backoff(9), Duration::from_millis(5000));
    }

    /// The keeper handoff (#280 step 4): a host's stdout reader stops between two lines and hands
    /// over every byte it read but did not deliver, the half line included; while frozen it reads
    /// nothing more, and a thaw carries on where it stopped.
    #[cfg(unix)]
    #[test]
    fn a_frozen_host_reader_hands_over_what_it_read_and_stops_between_lines() {
        use std::os::unix::net::UnixStream;
        let (r, mut w) = UnixStream::pair().unwrap();
        w.write_all(b"one\ntwo\nfour-five\nthr").unwrap();
        let out = HostOut::new(r.into(), Vec::new());
        let gate = out.gate();
        // The supervisor's thread: it hands each line on and waits until it is taken (a sink)
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(0);
        thread::spawn(move || {
            for line in out {
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        let t = Duration::from_secs(2);
        assert_eq!(rx.recv_timeout(t).unwrap(), "one");
        // The reader now holds "two" for the sink. The freeze is asked for, and lands once the
        // sink takes it and the reader comes back for the next line.
        let freezer = thread::spawn(move || (gate.freeze(Duration::from_secs(2)), gate));
        thread::sleep(Duration::from_millis(100));
        assert_eq!(rx.recv_timeout(t).unwrap(), "two");
        let (held, gate) = freezer.join().unwrap();
        assert_eq!(held.unwrap(), b"four-five\nthr", "what the next keeper starts with: a whole line and a half one");
        w.write_all(b"ee\n").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "nothing is delivered while frozen");
        gate.thaw();
        assert_eq!(rx.recv_timeout(t).unwrap(), "four-five");
        assert_eq!(rx.recv_timeout(t).unwrap(), "three");
    }

    #[test]
    fn bouncing_with_no_host_running_does_nothing() {
        assert!(!Supervisor::new().bounce());
    }

    /// Retry can relaunch a supervisor that has given up, and does not launch a second one on
    /// top of a running one (#184).
    #[test]
    fn a_supervisor_that_gave_up_can_be_claimed_again() {
        let sup = Supervisor::new();
        assert!(sup.claim(false), "starts for the first time");
        assert!(!sup.claim(true), "does not launch a second one while the watcher thread is running");

        // The watcher thread emitted Failed and ended.
        sup.set_error("agent-host exited (code Some(1))");
        drop(Running(sup.clone()));

        assert!(sup.claim(true), "launches again once it has ended");
        assert_eq!(sup.last_error(), None, "a fresh attempt must not look like it failed instantly for the old reason");
    }

    #[test]
    fn no_restart_while_the_app_is_quitting() {
        let sup = Supervisor::new();
        sup.shutdown();
        assert!(!sup.claim(true));
    }

    /// Installing Node after the app is open and pressing Retry must trigger a fresh search
    /// (#184).
    #[test]
    fn a_missing_node_is_not_remembered_but_a_found_one_is() {
        let cache = std::sync::OnceLock::new();
        assert_eq!(
            remember_found(&cache, || Err("could not find Node.js".into())),
            Err("could not find Node.js".to_string())
        );
        assert_eq!(
            remember_found(&cache, || Ok("/opt/homebrew/bin/node".into())),
            Ok("/opt/homebrew/bin/node".to_string())
        );
        assert_eq!(
            remember_found(&cache, || panic!("a successful find is not asked for again")),
            Ok("/opt/homebrew/bin/node".to_string())
        );
    }

    // The login-shell probe is unix-only, and its sample answer is a unix path.
    #[cfg(unix)]
    #[test]
    fn picks_the_marked_line_only() {
        // Only the marked line is checked, no matter what the shell configuration prints
        // (banners, warnings).
        let out = "Welcome to zsh!\n__CC_NODE__:/bin/sh\nsome trailing noise\n";
        assert_eq!(parse_probe_output(out), Some("/bin/sh".to_string()));
    }

    #[test]
    fn ignores_a_path_that_is_not_there() {
        // `command -v` can return an empty string (not installed) or a dead symlink.
        assert_eq!(parse_probe_output("__CC_NODE__:\n"), None);
        assert_eq!(parse_probe_output("__CC_NODE__:/nope/node\n"), None);
        assert_eq!(parse_probe_output("node not found\n"), None);
    }

    #[test]
    fn compares_versions_as_numbers_not_text() {
        // A lexical sort would make v9 > v22 and pick the old Node.
        assert!(version_parts("v22.3.1") > version_parts("v9.11.2"));
        assert_eq!(version_parts("v22.3.1"), vec![22, 3, 1]);
        assert_eq!(version_parts("lts/*"), Vec::<u32>::new());
        assert_eq!(version_parts(""), Vec::<u32>::new());
    }

    /// Sets up a script that pretends to be node and prints the given version.
    fn fake_node(version: &str, name: &str) -> String {
        // Windows cannot run a sh script; a batch file is what Rust's Command can start there.
        #[cfg(windows)]
        let (path, body) = (std::env::temp_dir().join(format!("{name}.cmd")), format!("@echo {version}\r\n"));
        #[cfg(not(windows))]
        let (path, body) = (std::env::temp_dir().join(name), format!("#!/bin/sh\necho {version}\n"));
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().to_string()
    }

    #[test]
    fn rejects_a_node_that_is_too_old() {
        // A low version is "needs an upgrade", not "missing" — the person has a different task.
        let path = fake_node("v20.11.1", "cc-test-node-old");
        let err = check_node_version(&path).unwrap_err();
        assert!(err.contains("or newer is required"), "{err}");
        assert!(err.contains("v20.11.1"), "{err}");
    }

    #[test]
    fn accepts_a_node_that_is_new_enough() {
        let path = fake_node("v22.3.1", "cc-test-node-ok");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    #[test]
    fn passes_when_the_version_cannot_be_read() {
        // No basis to block it, so it is not blocked (an unexpected output format).
        let path = fake_node("banana", "cc-test-node-weird");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    /// Checks that this Mac's login shell's own node is actually picked out.
    ///
    /// A unit test alone cannot confirm "asks the shell instead of using a fixed path" — since
    /// that is the entire point of this fix, this touches the real thing once. Passes silently
    /// in an environment with no node (there is no basis to block it there).
    #[cfg(unix)]
    #[test]
    fn finds_the_node_this_shell_knows() {
        let Ok(shell) = std::env::var("SHELL") else { return };
        if !Path::new(&shell).exists() {
            return;
        }
        let Ok(out) = Command::new(&shell).args(["-ilc", "command -v node"]).output() else {
            return;
        };
        let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if expected.is_empty() || !Path::new(&expected).exists() {
            return;
        }
        assert_eq!(probe_login_shell(), Some(expected.clone()));
        assert_eq!(resolve_node(), Ok(expected));
    }

    #[test]
    fn moves_on_when_the_shell_node_is_too_old() {
        // A Mac where nvm defaults to v18 but Homebrew has v22 — stopping here would fail to
        // launch even though a usable Node exists.
        let old = fake_node("v18.20.4", "cc-test-node-shell-old");
        let new = fake_node("v22.9.0", "cc-test-node-brew-new");
        assert_eq!(pick_node(Some(old), vec![new.clone()]), Ok(new));
    }

    #[test]
    fn explains_the_old_version_when_there_is_nothing_newer() {
        // If nothing newer ever turns up, say "old", not "missing" — the task is an upgrade,
        // not an install.
        let old = fake_node("v18.20.4", "cc-test-node-only-old");
        let err = pick_node(Some(old), vec!["/nope/node".into()]).unwrap_err();
        assert!(err.contains("v18.20.4"), "{err}");
        assert!(!err.contains("Could not find"), "{err}");
    }

    #[test]
    fn reports_every_place_it_looked_when_nothing_is_there() {
        // Finding nothing anywhere is the moment the person is most stuck — list every place
        // that was checked.
        let err = pick_node(None, vec!["/nope/a/node".into(), "/nope/b/node".into()]).unwrap_err();
        assert!(err.contains(FIRST_LOOK), "{err}");
        assert!(err.contains("/nope/a/node") && err.contains("/nope/b/node"), "{err}");
    }

    /// Windows (#14): Node discovery used to be the login shell plus unix folders under `$HOME`,
    /// so a packaged Windows build could never find Node. These are the folders the installers
    /// people actually use put it in.
    #[test]
    fn looks_where_windows_installers_put_node() {
        let env = |name: &str| {
            match name {
                "ProgramFiles" | "ProgramW6432" => Some("C:\\Program Files"),
                "LOCALAPPDATA" => Some("C:\\Users\\me\\AppData\\Local"),
                "NVM_SYMLINK" => Some("C:\\nvm4w\\nodejs"),
                "NVM_HOME" => Some("C:\\Users\\me\\AppData\\Local\\nvm"),
                "USERPROFILE" => Some("C:\\Users\\me"),
                _ => None,
            }
            .map(String::from)
        };
        let paths = windows_node_paths(env, |_| vec!["v22.3.1".into(), "v20.1.0".into()]);
        assert_eq!(
            paths,
            vec![
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Users\\me\\AppData\\Local\\Programs\\nodejs\\node.exe",
                "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\node.exe",
                "C:\\nvm4w\\nodejs\\node.exe",
                "C:\\Users\\me\\AppData\\Local\\nvm\\v22.3.1\\node.exe",
                "C:\\Users\\me\\AppData\\Local\\nvm\\v20.1.0\\node.exe",
                "C:\\Users\\me\\scoop\\shims\\node.exe",
                "C:\\Users\\me\\scoop\\apps\\nodejs\\current\\node.exe",
                "C:\\Users\\me\\scoop\\apps\\nodejs-lts\\current\\node.exe",
            ],
            "ProgramFiles and ProgramW6432 name the same folder, so it is listed once"
        );
        assert!(windows_node_paths(|_| None, |_| Vec::new()).is_empty(), "nothing set, nothing guessed");
    }

    /// PATH comes first on Windows, but only its absolute entries: `.` or `bin` on PATH would be
    /// resolved against the working directory, which could be a cloned repository.
    #[test]
    fn a_relative_path_entry_is_never_searched() {
        use std::path::PathBuf;
        let base = std::env::temp_dir();
        let dirs = vec![PathBuf::from("bin"), base.join("a"), base.join("b")];
        let found = first_on_path(dirs, "node.exe", |p| p.starts_with("bin") || p.starts_with(base.join("b")));
        assert_eq!(found, Some(base.join("b").join("node.exe").to_string_lossy().to_string()));
    }

    #[test]
    fn falls_back_to_a_real_path_when_the_shell_says_nothing() {
        let ok = fake_node("v22.0.0", "cc-test-node-fallback");
        assert_eq!(pick_node(None, vec!["/nope/node".into(), ok.clone()]), Ok(ok));
    }

    #[test]
    fn looks_where_version_managers_actually_put_node() {
        // This used to be only the two Homebrew locations and /usr/bin — nvm, mise and volta
        // users got stuck here.
        let paths = node_paths_under("/home/tester");
        for expected in [
            "/opt/homebrew/bin/node",
            "/home/tester/.volta/bin/node",
            "/home/tester/.local/share/mise/shims/node",
            "/home/tester/.asdf/shims/node",
        ] {
            assert!(paths.iter().any(|p| p == expected), "{expected} is not among the candidates: {paths:?}");
        }
    }

    #[test]
    fn says_where_it_looked_when_there_is_no_node() {
        let msg = node_missing_message(&["login shell PATH".into(), "/opt/homebrew/bin/node".into()]);
        assert!(msg.contains("login shell PATH"));
        assert!(msg.contains("/opt/homebrew/bin/node"));
        assert!(msg.contains("22"));
    }
}
