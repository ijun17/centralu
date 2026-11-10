//! Whether the window may use the data folder's `centralu serve` host, and the way back to its own (#1223 review).
//!
//! On Windows, with serve installed in the data folder, the window runs `centralu serve --window` instead of a host
//! of its own (`start_plan::Host::Serve`). That serve is whatever version a linked hub installed. A serve from before
//! `--window` refuses the option, and a host on another protocol refuses the window's hello, so the window would be
//! left with no host where it used to start its own. So:
//!
//!   - before choosing it, the window asks the serve (`serve --connection`, `ask_connection`): only one whose line
//!     lists `window` in `takes` and speaks the window's protocol is used (`choose`);
//!   - a `serve --window` that ends before its ready line hands the next attempt to the bundled host
//!     (`ServeFallback`). If a host holds the data folder all the same, the bundled host's start is refused by the
//!     folder's lock, with the message that names who holds it, as before.
//!
//! No `cfg` here: the launcher is a `.cmd` only on Windows, where `os::serve_launcher` finds it, but asking it is the
//! same everywhere.

use crate::host_proc::{HostStatus, StatusSink};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What `serve --connection` answered, as far as choosing it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeLine {
    /// The running host's protocol when one runs, the installed package's otherwise.
    pub protocol_version: u32,
    /// `takes` lists `window`: this serve has `--window`.
    pub takes_window: bool,
}

/// The connection line among whatever the launcher printed: the last line that is a `v: 1` object with a protocol.
pub fn parse_connection_line(stdout: &str) -> Option<ServeLine> {
    stdout.lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l.trim()).ok()?;
        if v.get("v").and_then(|v| v.as_u64()) != Some(1) {
            return None;
        }
        let protocol_version = v.get("protocolVersion").and_then(|p| p.as_u64())? as u32;
        let takes_window = v
            .get("takes")
            .and_then(|t| t.as_array())
            .is_some_and(|t| t.iter().any(|x| x.as_str() == Some("window")));
        Some(ServeLine { protocol_version, takes_window })
    })
}

/// Whether the window uses the serve host, and why not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServeChoice {
    Use,
    /// It did not answer with a connection line (it failed, or took too long).
    NoAnswer,
    /// A serve from before `--window`.
    NoWindow,
    /// It speaks another protocol than the window; its host would refuse the window's hello.
    ProtocolDiffers { serve: u32, window: u32 },
    /// The window's own protocol could not be read (`bundle_protocol`).
    WindowUnknown,
}

impl ServeChoice {
    pub fn text(&self) -> String {
        match self {
            ServeChoice::Use => "the window uses the data folder's centralu serve host".into(),
            ServeChoice::NoAnswer => "centralu serve in the data folder gave no connection line; the window runs its own host".into(),
            ServeChoice::NoWindow => "the data folder's centralu serve predates --window; the window runs its own host".into(),
            ServeChoice::ProtocolDiffers { serve, window } => {
                format!("the data folder's centralu serve speaks protocol {serve} and this window {window}; the window runs its own host")
            }
            ServeChoice::WindowUnknown => "this window's protocol could not be read; it runs its own host".into(),
        }
    }
}

pub fn choose(line: Option<&ServeLine>, window_protocol: Option<u32>) -> ServeChoice {
    let Some(line) = line else { return ServeChoice::NoAnswer };
    if !line.takes_window {
        return ServeChoice::NoWindow;
    }
    let Some(window) = window_protocol else { return ServeChoice::WindowUnknown };
    if line.protocol_version != window {
        return ServeChoice::ProtocolDiffers { serve: line.protocol_version, window };
    }
    ServeChoice::Use
}

/// The protocol the window's bundled host speaks: `protocolVersion` in its `bundle-info.json`.
pub fn bundle_protocol(host_dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(host_dir.join("bundle-info.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("protocolVersion").and_then(|p| p.as_u64()).map(|p| p as u32)
}

/// How long the window waits for `serve --connection`: it probes the recorded port (2 s at most) after Node starts.
pub const ASK_TIMEOUT: Duration = Duration::from_secs(15);

/// What `<launcher> serve --connection` printed, or None when it could not run or did not end within `timeout` (then
/// its tree is ended).
pub fn ask_connection(launcher: &Path, timeout: Duration) -> Option<String> {
    run_launcher(launcher, "--connection", &[], timeout).ok()
}

/// How long "Quit completely" waits for `serve --stop`, which ends within 45 s whatever it meets (`runStop`'s
/// `STOP_BUDGET_MS`): a start in progress is waited for while it leaves the stop its share, then the host is asked and
/// waited for, and ended after a grace. A start still going at the end is ended, or answered as still starting.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// How long "Quit completely" waits for the host this window is starting (`serve --detach` waits for its host up to 30 s)
pub const START_WAIT: Duration = Duration::from_secs(45);

/// What `serve --stop` said of the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopAnswer {
    /// It was running and is gone.
    Stopped,
    /// None was running when it looked: nothing to stop, unless one is starting.
    NotRunning,
}

/// "Quit completely" on the serve host: `<launcher> serve --stop`, the stop a person types and a hub's update uses (the
/// host's own `host.stop`, waited for). `CENTRALU_STOP_BY=quit` has it leave the mark of a quit ("by quitting Centralu
/// there" to a linked hub) rather than of a typed `--stop`; a launcher from before that writes the typed one. `Err`
/// carries the words for the dialog.
pub fn stop_serve(launcher: &Path, timeout: Duration) -> Result<StopAnswer, String> {
    let out = run_launcher(launcher, "--stop", &[("CENTRALU_STOP_BY", "quit")], timeout).map_err(|e| format!("centralu serve --stop {e}"))?;
    parse_stop_line(&out)
}

/// `{ v: 1, stop: { ok, wasRunning, heldByOther?, message? } }`, the last such line of what `serve --stop` printed. `ok: false`
/// is a host that is still there (busy), and `heldByOther` a folder held by another Centralu host that serve left alone:
/// both are `Err` with the words they came with, since nothing was stopped.
pub fn parse_stop_line(stdout: &str) -> Result<StopAnswer, String> {
    let stop = stdout
        .lines()
        .rev()
        .find_map(|l| {
            let v: serde_json::Value = serde_json::from_str(l.trim()).ok()?;
            if v.get("v").and_then(|v| v.as_u64()) != Some(1) {
                return None;
            }
            v.get("stop").cloned()
        })
        .ok_or("centralu serve --stop gave no answer")?;
    let held_by_other = stop.get("heldByOther").and_then(|h| h.as_bool()) == Some(true);
    if stop.get("ok").and_then(|o| o.as_bool()) == Some(true) && !held_by_other {
        let was_running = stop.get("wasRunning").and_then(|w| w.as_bool()) == Some(true);
        return Ok(if was_running { StopAnswer::Stopped } else { StopAnswer::NotRunning });
    }
    Err(stop.get("message").and_then(|m| m.as_str()).unwrap_or("centralu serve --stop did not stop the host").to_string())
}

/// What `<launcher> serve <flag>` printed, with `env` added to the launcher's. `Err` says how it failed, to follow
/// "centralu serve <flag> ": it could not be started, did not end within `timeout` (then its tree is ended), or its
/// answer could not be read.
fn run_launcher(launcher: &Path, flag: &str, env: &[(&str, &str)], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(launcher);
    cmd.args(["serve", flag]).envs(env.iter().copied()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::os::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not be started: {e}"))?;
    let end = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                crate::os::kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err("gave no answer in time".into());
            }
        }
    }
    let mut out = String::new();
    child.stdout.take().ok_or("gave no answer")?.read_to_string(&mut out).map_err(|e| format!("answer could not be read: {e}"))?;
    Ok(out)
}

/// Which host the next attempt runs, once the plan chose the serve host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Serve,
    Bundle,
}

/// The way back to the window's own host: a `serve --window` attempt that ends before its ready line makes every later
/// attempt in this window's life the bundled host. One that reached its ready line and ended later (its host stopped)
/// is tried again: the next one finds the new host or starts one.
#[derive(Debug, Default)]
pub struct ServeFallback {
    fell_back: AtomicBool,
    trying_serve: AtomicBool,
    ready: AtomicBool,
}

impl ServeFallback {
    /// Called by the launcher for each attempt.
    pub fn next(&self) -> Pick {
        if self.trying_serve.load(Ordering::SeqCst) && !self.ready.load(Ordering::SeqCst) {
            self.fell_back.store(true, Ordering::SeqCst);
        }
        self.ready.store(false, Ordering::SeqCst);
        let pick = if self.fell_back.load(Ordering::SeqCst) { Pick::Bundle } else { Pick::Serve };
        self.trying_serve.store(pick == Pick::Serve, Ordering::SeqCst);
        pick
    }

    /// The attempt running now said it is ready.
    pub fn ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn fell_back(&self) -> bool {
        self.fell_back.load(Ordering::SeqCst)
    }

    /// A `serve --window` attempt has begun and not said it is ready: it may be starting the folder's host now.
    pub fn starting(&self) -> bool {
        self.trying_serve.load(Ordering::SeqCst) && !self.ready.load(Ordering::SeqCst)
    }
}

/// The serve host a window runs on: the data folder's `centralu` launcher, and the fallback that says whether the window
/// still uses it. What "Quit completely" stops, since closing the window leaves that host running for a linked hub (#1466).
#[derive(Debug, Clone)]
pub struct ServeHost {
    launcher: std::path::PathBuf,
    fallback: Arc<ServeFallback>,
}

impl ServeHost {
    pub fn new(launcher: std::path::PathBuf, fallback: Arc<ServeFallback>) -> Self {
        Self { launcher, fallback }
    }

    /// The window runs on this host, not on the bundled one it fell back to.
    pub fn active(&self) -> bool {
        !self.fallback.fell_back()
    }

    /// Stops the serve host with `serve --stop`, waited for. The bundled host a fallen-back window runs is its own child:
    /// quitting already stops it.
    ///
    /// While an attempt of this window is starting the host (`starting`), a stop would find none running and the host would
    /// come up behind it, so it waits for the attempt to be ready (bounded by `START_WAIT`) and stops then. A "not running"
    /// answer given while one began in the meantime is asked again.
    pub fn stop(&self) -> Result<(), String> {
        self.stop_with(|| stop_serve(&self.launcher, STOP_TIMEOUT), START_WAIT)
    }

    fn stop_with(&self, ask: impl Fn() -> Result<StopAnswer, String>, start_wait: Duration) -> Result<(), String> {
        let end = Instant::now() + start_wait;
        loop {
            while self.fallback.starting() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(50));
            }
            if !self.active() {
                return Ok(());
            }
            match ask()? {
                StopAnswer::Stopped => return Ok(()),
                StopAnswer::NotRunning if !self.fallback.starting() => return Ok(()),
                StopAnswer::NotRunning if Instant::now() >= end => return Err("the host is still starting; try again in a moment".into()),
                StopAnswer::NotRunning => {}
            }
        }
    }
}

/// The serve host the window runs on, if it does: what the shell's supervisor asks to stop and to report its mode
/// (`Supervisor::stop_agents`, `build`), kept here so what they do is tested without a window.
#[derive(Debug, Clone, Default)]
pub struct ServeSlot(Arc<std::sync::Mutex<Option<ServeHost>>>);

impl ServeSlot {
    /// What the window's start plan chose: the serve host, or none.
    pub fn remember(&self, host: Option<ServeHost>) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = host;
        }
    }

    fn current(&self) -> Option<ServeHost> {
        self.0.lock().ok()?.clone().filter(ServeHost::active)
    }

    /// The window runs on the serve host now (not on the bundled one it fell back to).
    pub fn serving(&self) -> bool {
        self.current().is_some()
    }

    /// "Quit completely": stops the serve host; nothing to do where the window runs a host of its own.
    pub fn stop(&self) -> Result<(), String> {
        self.current().map_or(Ok(()), |host| host.stop())
    }
}

/// A sink that tells `ServeFallback` when an attempt is ready, and passes everything on.
pub struct FallbackSink<S: StatusSink> {
    pub inner: S,
    pub fallback: Arc<ServeFallback>,
}

impl<S: StatusSink> StatusSink for FallbackSink<S> {
    fn status(&self, status: &HostStatus) {
        if matches!(status, HostStatus::Ready(_)) {
            self.fallback.ready();
        }
        self.inner.status(status);
    }

    fn json_line(&self, line: &serde_json::Value) -> bool {
        self.inner.json_line(line)
    }
}

#[cfg(test)]
mod tests;
