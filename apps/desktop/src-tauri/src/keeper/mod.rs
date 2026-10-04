//! The keeper (#280, option C step 1).
//!
//! The keeper is **this same executable started as `centralu --keeper`**, not a separate binary
//! (owner decision, 2026-10-04): one thing to sign and ship, and the same signature and bundle
//! identifier as the app, so macOS should attribute privacy permissions to Centralu rather than
//! to a new program (#220). `main()` branches into it before the Tauri app is built, so keeper
//! mode never creates a window, loads the webview or registers with the window server.
//!
//! What it does in step 1, and nothing more:
//!   - holds the host: launches it, restarts it by the same rules the app used, stops it;
//!   - runs every host from a per-build copy under the data folder (`source.rs`);
//!   - answers a user-only control socket (`server.rs`) through which the app attaches, learns
//!     the host's port, token and build, and asks to stop or switch builds;
//!   - applies background mode: with it off (the default) the keeper and host stop when the last
//!     window detaches, as quitting the app always did; with it on they keep running.
//!
//! It holds no agents, terminals or commands yet (step 2), and swaps nothing without a restart
//! (step 3).

pub mod client;
pub mod server;
pub mod source;
pub mod sys;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::host_proc::HostStatus;
use source::BuildSource;

/// The control socket's protocol version. An app refuses a keeper that speaks another one
/// rather than guessing at its answers.
pub const KEEPER_PROTOCOL: u32 = 1;

/// The flag `main()` looks for.
pub const KEEPER_FLAG: &str = "--keeper";

/// Exit code of a keeper that found another one already holding the data folder.
pub const EXIT_ALREADY_RUNNING: i32 = 3;

/// How long a window may stay away before an unwatched keeper in background mode ends itself.
pub const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);

/// How long a freshly started keeper waits for its first window. The app that launched it attaches
/// within a second; a keeper nobody attaches to within this is the leftover of an app that died
/// between launching it and attaching.
pub const STARTUP_GRACE: Duration = Duration::from_secs(60);

pub fn is_keeper_invocation(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == KEEPER_FLAG)
}

/**
 * The data folder: `CC_DATA_DIR`, or the folder the host would choose for itself
 * (`~/.centralu`, or `~/.centralu-dev` with `CC_DEV=1`).
 *
 * The app and the keeper each compute this and must agree, and the keeper hands it to the host
 * explicitly (`--db`, `CC_DATA_DIR`), so all three name the same folder.
 */
pub fn data_dir() -> PathBuf {
    data_dir_with(std::env::var("CC_DEV").as_deref() == Ok("1"))
}

/// `data_dir`, with the dev flag given rather than read from the environment.
pub fn data_dir_with(dev: bool) -> PathBuf {
    if let Ok(d) = std::env::var("CC_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(if dev { ".centralu-dev" } else { ".centralu" })
}

/// Moves the pre-rename data folder to its new name before anything creates the new one.
///
/// The host does the same move (`data-dir.ts`), but it leaves both alone when the new folder
/// already exists. If the keeper created `~/.centralu` for its socket first, the host would find
/// it there and never move the real data — the exact trap `data-dir.ts` records for an empty
/// `orchestrator/` folder. So the keeper moves it first, by the same rule.
pub fn migrate_legacy(home: &Path, dev: bool) -> Option<(PathBuf, PathBuf)> {
    let from = home.join(if dev { ".control-center-dev" } else { ".control-center" }); // legacy-name
    let to = home.join(if dev { ".centralu-dev" } else { ".centralu" });
    if !from.exists() || to.exists() {
        return None;
    }
    std::fs::rename(&from, &to).ok().map(|_| (from, to))
}

pub fn socket_path(data: &Path) -> PathBuf {
    data.join("keeper.sock")
}

/// What the keeper says about itself and its host: the answer to `status` and `attach`, and the
/// body of every pushed event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperView {
    pub keeper: KeeperInfo,
    pub status: HostStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_pid: Option<u32>,
    /// The build the current host runs (or is starting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<BuildSource>,
    pub background: bool,
    /// Windows attached right now.
    pub attached: usize,
    /// The host's last activity report: a session working or waiting, a terminal, a command run.
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperInfo {
    pub pid: u32,
    pub protocol: u32,
    pub version: String,
    /// Seconds since the epoch.
    pub started_at: u64,
    pub data_dir: String,
}

/// Everything the idle rule looks at, so the rule can be tested without a clock.
#[derive(Debug, Clone, Copy)]
pub struct IdleInput {
    pub background: bool,
    pub attached: usize,
    pub ever_attached: bool,
    pub busy: bool,
    pub stopping: bool,
    pub since_start: Duration,
    pub since_detach: Duration,
    pub since_busy: Duration,
}

/**
 * Whether a keeper with no window should end itself now, and why.
 *
 * - A window attached: never.
 * - No window has attached since start: after `STARTUP_GRACE`, whatever the mode. The app that
 *   launched it died before attaching, and nobody else knows it is there.
 * - Background mode off: at once. Detaching already stops it; this catches a detach that raced
 *   the mode being turned off.
 * - Background mode on: once nothing has happened for `idle` — no window, and the host has
 *   reported no working or waiting session, no terminal and no command run for that long. A turn
 *   that is still running, or an approval waiting for someone, keeps it alive however long that
 *   takes. That is the point of background mode.
 */
pub fn idle_decision(i: IdleInput, idle: Duration) -> Option<&'static str> {
    if i.stopping || i.attached > 0 {
        return None;
    }
    if !i.ever_attached {
        return (i.since_start >= STARTUP_GRACE).then_some("no window attached since the keeper started");
    }
    if !i.background {
        return Some("the last window closed and background mode is off");
    }
    if i.busy {
        return None;
    }
    let quiet = i.since_detach.min(i.since_busy);
    (quiet >= idle).then_some("no window and no activity for the idle limit")
}

/// The idle limit: `CC_KEEPER_IDLE_SECS` (for tests), else 30 minutes.
pub fn idle_limit() -> Duration {
    std::env::var("CC_KEEPER_IDLE_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_IDLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet(minutes: u64) -> IdleInput {
        IdleInput {
            background: true,
            attached: 0,
            ever_attached: true,
            busy: false,
            stopping: false,
            since_start: Duration::from_secs(3600 * 5),
            since_detach: Duration::from_secs(minutes * 60),
            since_busy: Duration::from_secs(minutes * 60),
        }
    }

    #[test]
    fn only_the_keeper_flag_selects_keeper_mode() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_keeper_invocation(&args(&["centralu", "--keeper", "--host-source", "/x"])));
        assert!(!is_keeper_invocation(&args(&["centralu"])));
        assert!(!is_keeper_invocation(&args(&["--keeper"])), "argv[0] is the program, not a flag");
    }

    #[test]
    fn an_attached_window_keeps_it_alive_in_any_mode() {
        let mut i = quiet(600);
        i.attached = 1;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
        i.background = false;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
    }

    #[test]
    fn with_background_off_the_last_window_leaving_stops_it() {
        let mut i = quiet(0);
        i.background = false;
        assert!(idle_decision(i, DEFAULT_IDLE).is_some());
    }

    #[test]
    fn with_background_on_it_waits_out_the_idle_limit() {
        assert_eq!(idle_decision(quiet(29), DEFAULT_IDLE), None);
        assert!(idle_decision(quiet(30), DEFAULT_IDLE).is_some());
    }

    /// A turn running or an approval waiting is exactly what background mode exists for.
    #[test]
    fn a_busy_host_is_never_idle() {
        let mut i = quiet(600);
        i.busy = true;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
    }

    #[test]
    fn the_clock_starts_from_the_later_of_detach_and_last_activity() {
        let mut i = quiet(600);
        i.since_busy = Duration::from_secs(60);
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None, "activity a minute ago resets the clock");
    }

    #[test]
    fn a_keeper_nobody_attached_to_ends_after_the_grace() {
        let mut i = quiet(0);
        i.ever_attached = false;
        i.since_start = STARTUP_GRACE - Duration::from_secs(1);
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
        i.since_start = STARTUP_GRACE;
        assert!(idle_decision(i, DEFAULT_IDLE).is_some());
    }

    #[test]
    fn a_stopping_keeper_is_not_stopped_twice() {
        let mut i = quiet(600);
        i.stopping = true;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
    }

    #[test]
    fn the_legacy_folder_is_moved_before_the_new_one_exists() {
        let home = std::env::temp_dir().join(format!("cc-keeper-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".control-center")).unwrap(); // legacy-name
        std::fs::write(home.join(".control-center/store.db"), "x").unwrap(); // legacy-name
        assert!(migrate_legacy(&home, false).is_some());
        assert!(home.join(".centralu/store.db").is_file());
        assert!(migrate_legacy(&home, false).is_none(), "nothing left to move");
        let _ = std::fs::remove_dir_all(&home);
    }
}
