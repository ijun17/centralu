//! The window's side of the macOS shell (docs/plans/thin-shell.md §6, §6.1, §10.2): install or upgrade
//! `<data>/shell/Centralu.app` from the shell the window carries (`install`), open it through
//! LaunchServices to start the keeper, and read how that went (`start`). When it does not start a
//! keeper the window starts one directly, as before, and says why (`Report`).
//!
//! Used by a macOS release build only (`start_plan::StartMode::ThroughShell`, docs/agent-host.md
//! §4.0). Debug builds, Linux and Windows start the keeper (or the host) as they always did.
//!
//! **A shell the window carries unpinned** (a local `pnpm app` build or a release rehearsal, whose
//! shell was built on the spot rather than taken from `shell.lock`) is neither installed nor opened:
//! the keeper starts directly and the reason goes to `keeper.log` only. Its content is signed with a
//! throwaway key, which the shell refuses anyway, and opening it would cost a launch, could ask for
//! access to the folder the build sits in (a build under `~/Desktop` asks in the shell's name), and
//! would leave unpinned bytes where people's permissions are meant to attach. `CC_SHELL_UNPINNED=1`
//! (read with the other start variables in `start_plan::Env`) opens it anyway, for checking the
//! path by hand against a temporary `CC_DATA_DIR`.

pub mod install;
pub mod start;

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use install::{Carried, Installed, Plan};
use start::{Fallback, Outcome, Request, World};

/// How this window's keeper start went, for the UI (`HostBuild.shell`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// A keeper was started through the shell.
    pub started: bool,
    /// Why not: the shell's refusal reason or the window's own (`start::Fallback`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Shown in the window: a release (pinned shell) shows a fallback, a local build only logs it.
    pub notify: bool,
    /// The installed shell's version, when one was opened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_version: Option<u64>,
}

impl Report {
    fn fallback(f: Fallback, notify: bool, shell_version: Option<u64>) -> Report {
        Report { started: false, reason: Some(f.reason), message: Some(f.message), notify, shell_version }
    }
}

/// What to open, decided before anything is opened.
pub struct Prepared {
    pub request: Request,
    pub notify: bool,
    pub shell_version: u64,
}

/**
 * Reads the carried shell and installs or upgrades `<data>/shell/Centralu.app` from it (`install`).
 * Errs with the reason to start directly, and whether to show it. `resources` is the window's
 * `Contents/Resources`.
 */
pub fn prepare(
    resources: &Path,
    data: &Path,
    bundle_path: Option<String>,
    allow_unpinned: bool,
    log: &dyn Fn(&str),
) -> Result<Prepared, (Fallback, bool)> {
    let carried: Carried = match install::read_carried(resources) {
        Ok(Some(c)) => c,
        Ok(None) => return Err((Fallback::new("not-carried", "this build carries no shell"), false)),
        Err(e) => return Err((Fallback::new("install", format!("the shell this window carries is damaged: {e}")), true)),
    };
    let notify = carried.pinned;
    if !carried.pinned && !allow_unpinned {
        return Err((
            Fallback::new(
                "unpinned",
                format!("this build carries shell {} built locally, not the one shell.lock pins; it is not installed or opened", carried.version),
            ),
            false,
        ));
    }
    let dir = install::shell_dir(data);
    if install::recover(&dir) {
        log("put back the shell an interrupted upgrade had moved aside");
    }
    let before = install::installed(&dir);
    let version = match install::plan(&carried, &before) {
        Plan::Keep => match &before {
            Installed::Shell { version, .. } => *version,
            _ => carried.version,
        },
        Plan::Install => match install::install(&carried, &dir) {
            Ok(_) => {
                log(&format!(
                    "installed shell {}{} in {} ({})",
                    carried.version,
                    if carried.pinned { "" } else { ", unpinned" },
                    dir.display(),
                    match &before {
                        Installed::None => "none was installed".to_string(),
                        Installed::Unreadable => "the installed one could not be read".to_string(),
                        Installed::Shell { version, .. } => format!("replacing shell {version}"),
                    }
                ));
                carried.version
            }
            Err(e) => match &before {
                // The installed shell is still there and still a shell: open it.
                Installed::Shell { version, .. } => {
                    log(&format!("could not install shell {}: {e}; opening the installed shell {version}", carried.version));
                    *version
                }
                _ => return Err((Fallback::new("install", format!("could not install the shell: {e}")), notify)),
            },
        },
    };
    Ok(Prepared {
        request: Request {
            shell_app: dir.join(install::SHELL_APP),
            content: resources.join("content"),
            data_dir: data.to_path_buf(),
            bundle_path,
            nonce: start::nonce(),
        },
        notify,
        shell_version: version,
    })
}

/// The whole start through the shell. `None` when a keeper already answered and nothing was done.
pub fn start_keeper(
    resources: &Path,
    data: &Path,
    bundle_path: Option<String>,
    allow_unpinned: bool,
    world: &dyn World,
) -> Option<Report> {
    let log = |m: &str| log(data, m);
    if world.keeper_alive() {
        return None;
    }
    let p = match prepare(resources, data, bundle_path, allow_unpinned, &log) {
        Ok(p) => p,
        Err((f, notify)) => {
            log(&format!("starting the keeper directly ({}): {}", f.reason, f.message));
            return Some(Report::fallback(f, notify, None));
        }
    };
    log(&format!("opening shell {} at {} through LaunchServices", p.shell_version, p.request.shell_app.display()));
    match start::start(&p.request, world) {
        Outcome::KeeperAnswering => None,
        Outcome::Started { reported } => {
            log(if reported { "the shell started the keeper" } else { "a keeper answers; the shell's report did not arrive" });
            // Whichever start installed it: a shell that has started a keeper is the one to keep.
            if install::finish(&install::shell_dir(data)) {
                log("removed the shell the upgrade had moved aside");
            }
            Some(Report { started: true, reason: None, message: None, notify: p.notify, shell_version: Some(p.shell_version) })
        }
        Outcome::Fallback(f) => {
            log(&format!("starting the keeper directly ({}): {}", f.reason, f.message));
            Some(Report::fallback(f, p.notify, Some(p.shell_version)))
        }
    }
}

/// A `[window]` line in `<data>/keeper.log`, where the shell, the keeper and the host write too.
pub fn log(data: &Path, msg: &str) {
    eprintln!("[window] {msg}");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).mode(0o600).open(data.join("keeper.log")) {
        let _ = writeln!(f, "[window] {msg}");
    }
}

/// The world as it is: the keeper's socket, `/usr/bin/open`, the status file.
pub struct Real {
    pub sock: PathBuf,
    pub status: PathBuf,
}

impl Real {
    pub fn new(data: &Path) -> Real {
        Real { sock: centralu_keeper_core::keeper::socket_path(data), status: data.join("shell-status.json") }
    }
}

/// `open` asks LaunchServices and returns; this bounds a LaunchServices that never answers.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

impl World for Real {
    fn keeper_alive(&self) -> bool {
        centralu_keeper_core::keeper::client::alive(&self.sock)
    }

    fn open_shell(&self, shell_app: &Path, args: &[String]) -> Result<(), String> {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let (program, argv) = start::open_command(shell_app, args);
        let mut child = Command::new(&program)
            .args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
        let deadline = std::time::Instant::now() + OPEN_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    // Our own child, started just above.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{} did not return within {}s", program.display(), OPEN_TIMEOUT.as_secs()));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        if status.success() {
            return Ok(());
        }
        let mut err = String::new();
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_string(&mut err);
        }
        let err = err.trim();
        Err(if err.is_empty() { format!("{} exited with {status}", program.display()) } else { err.chars().take(400).collect() })
    }

    fn read_status(&self) -> Option<Value> {
        serde_json::from_slice(&std::fs::read(&self.status).ok()?).ok()
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
}

#[cfg(test)]
mod tests;
