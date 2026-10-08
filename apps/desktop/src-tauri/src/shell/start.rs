//! Starting the keeper through the installed shell (docs/plans/thin-shell.md §6), and the decision of
//! when to fall back to starting it directly.
//!
//! The shell is opened **through LaunchServices**, never as this window's child: the measurement
//! (docs/spikes/2026-10-thin-shell-tcc.md) found that only then is the shell its own responsible
//! process, so that macOS judges the keeper and everything under it as the shell. The window runs
//! `/usr/bin/open -n -g -a <shell> --args ...` (`open_command`), which is how the spike launched it:
//! `open` asks LaunchServices to launch the app and returns; launchd starts the shell, not `open` and
//! not this window. `-n` starts a new instance even if one is still running, `-g` leaves the window in
//! front (the shell is `LSUIElement`, has no window and never activates either). The arguments after
//! `--args` reach the shell's `argv` unchanged; its environment is launchd's, which is why every path
//! is an argument. The shell's exit code and stderr reach no one, so it reports in
//! `<data>/shell-status.json`, matched to this start by a fresh nonce.
//!
//! Everything the start needs from the world goes through `World`, so the tests below exercise the
//! decision without LaunchServices, a keeper or a clock.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// How long the window waits for the shell's report. The shell itself waits up to 25 s for the
/// keeper to answer (`READY_TIMEOUT` in the shell crate), after verifying and copying the content.
pub const REPORT_TIMEOUT: Duration = Duration::from_secs(45);
/// After a keeper answers, how long the window still waits for the shell's report before it takes
/// the answering keeper as the outcome.
pub const REPORT_GRACE: Duration = Duration::from_secs(3);
pub const POLL: Duration = Duration::from_millis(100);

/// One start through the shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// `<data>/shell/Centralu.app`.
    pub shell_app: PathBuf,
    /// The signed content the window carries (`Contents/Resources/content`).
    pub content: PathBuf,
    pub data_dir: PathBuf,
    /// The window's bundle, recorded by the keeper as where its build came from.
    pub bundle_path: Option<String>,
    pub nonce: String,
}

/// The shell's command line (`args.rs` in the shell crate reads it).
pub fn shell_args(r: &Request) -> Vec<String> {
    let mut a = vec![
        "--content".to_string(),
        r.content.to_string_lossy().to_string(),
        "--data-dir".into(),
        r.data_dir.to_string_lossy().to_string(),
    ];
    if let Some(b) = &r.bundle_path {
        a.push("--bundle-path".into());
        a.push(b.clone());
    }
    a.push("--nonce".into());
    a.push(r.nonce.clone());
    a
}

/// The program and arguments that open the shell through LaunchServices (module docs).
pub fn open_command(shell_app: &Path, args: &[String]) -> (PathBuf, Vec<String>) {
    let mut v = vec!["-n".to_string(), "-g".into(), "-a".into(), shell_app.to_string_lossy().to_string(), "--args".into()];
    v.extend(args.iter().cloned());
    (PathBuf::from("/usr/bin/open"), v)
}

/// What the start sees of the world.
pub trait World {
    /// Whether a keeper answers on `<data>/keeper.sock`.
    fn keeper_alive(&self) -> bool;
    /// Asks LaunchServices to open the shell with these arguments.
    fn open_shell(&self, shell_app: &Path, args: &[String]) -> Result<(), String>;
    /// `<data>/shell-status.json`, if there is one that parses.
    fn read_status(&self) -> Option<Value>;
    fn sleep(&self, d: Duration);
}

/// Why the keeper was started directly instead. The shell's own reasons (`Reason::id` in the shell
/// crate) are passed through as they are; the window adds its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fallback {
    pub reason: String,
    pub message: String,
}

impl Fallback {
    pub fn new(reason: &str, message: impl Into<String>) -> Fallback {
        Fallback { reason: reason.into(), message: message.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A keeper already answered: nothing was opened.
    KeeperAnswering,
    /// The shell reported a keeper started (or found one answering), or a keeper answered and the
    /// shell's report did not come within `REPORT_GRACE`.
    Started { reported: bool },
    /// Start the keeper directly, for this reason.
    Fallback(Fallback),
}

/// Opens the shell and waits for its report (module docs).
pub fn start(r: &Request, w: &dyn World) -> Outcome {
    if w.keeper_alive() {
        return Outcome::KeeperAnswering;
    }
    if let Err(e) = w.open_shell(&r.shell_app, &shell_args(r)) {
        return Outcome::Fallback(Fallback::new("open", format!("macOS did not open the shell at {}: {e}", r.shell_app.display())));
    }
    let polls = |d: Duration| (d.as_millis() / POLL.as_millis()).max(1) as u32;
    let mut alive_for = None::<u32>;
    for _ in 0..polls(REPORT_TIMEOUT) {
        if let Some(status) = w.read_status().filter(|s| s.get("nonce").and_then(Value::as_str) == Some(r.nonce.as_str())) {
            return from_status(&status);
        }
        if alive_for.is_none() && w.keeper_alive() {
            alive_for = Some(0);
        }
        if let Some(n) = alive_for.as_mut() {
            if *n >= polls(REPORT_GRACE) {
                return Outcome::Started { reported: false };
            }
            *n += 1;
        }
        w.sleep(POLL);
    }
    if alive_for.is_some() || w.keeper_alive() {
        return Outcome::Started { reported: false };
    }
    Outcome::Fallback(Fallback::new(
        "no-report",
        format!("the shell did not report within {}s and no keeper answers", REPORT_TIMEOUT.as_secs()),
    ))
}

fn from_status(s: &Value) -> Outcome {
    let text = |k: &str| s.get(k).and_then(Value::as_str);
    match text("result") {
        Some("started") => Outcome::Started { reported: true },
        Some("refused") => Outcome::Fallback(Fallback::new(
            text("reason").filter(|r| !r.is_empty() && r.len() <= 32).unwrap_or("refused"),
            text("message").unwrap_or("the shell refused to start the keeper"),
        )),
        _ => Outcome::Fallback(Fallback::new("status", "the shell's report is not one this window can read")),
    }
}

/// 32 hex characters from the system's random source; the shell accepts letters, digits and dashes.
pub fn nonce() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        // Only matches the report to this start; uniqueness is what matters, not secrecy.
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        b = (t ^ ((std::process::id() as u128) << 64)).to_le_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests;
