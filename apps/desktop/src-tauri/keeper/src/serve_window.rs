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
    let mut cmd = Command::new(launcher);
    cmd.args(["serve", "--connection"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::os::hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let end = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                crate::os::kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
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
