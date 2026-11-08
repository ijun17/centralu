//! The keeper (#280, option C step 1).
//!
//! The keeper is **its own executable, `centralu-keeper`** (#440), shipped next to the window's
//! executable and linking no Tauri and no webview. Until 0.1.0-beta.11 it was the window's
//! executable started as `centralu --keeper`; that still works and turns into `centralu-keeper`
//! (`exe.rs`), because keepers already installed hand over that way. Who it is for macOS privacy
//! permissions did not change: macOS judges a process by the app that started its tree (the
//! responsible process, measured for #440 in docs/spikes/2026-10-thin-shell-tcc.md), and the window starts
//! the keeper either way.
//!
//! What it does:
//!   - holds the host: launches it, restarts it by the same rules the app used, stops it;
//!   - runs every host from a per-build copy under the data folder (`source.rs`);
//!   - answers a user-only control socket (`server/`) through which the app attaches, learns
//!     the host's port, token and build, and asks to stop or switch builds;
//!   - applies background mode: with it off (the default) the keeper and host stop when the last
//!     window detaches, as quitting the app always did; with it on they keep running.
//!
//! It no longer holds the host's agents, terminals and commands (step 2's children service, gone in
//! #1895 step 4): the host spawns its own, and an update stops them and continues their turns.
//!
//! Step 3 adds two things:
//!   - **the front door** (`front_door.rs`): one loopback port and one token for the keeper's whole
//!     life, relayed byte for byte to whichever host is current, so clients and Codex bridges never
//!     learn a host's own port;
//!   - **the blue-green swap** (`swap.rs`): `switch` starts the next build in standby next to the
//!     running host, drains the running one, and hands the front door over, instead of stopping
//!     the host and cutting every turn.
//!
//! Step 4 (`handoff/`) replaces the keeper itself: the new build's keeper is started from the new
//! bundle's keeper executable, the running one freezes and passes it every descriptor it owns (the
//! sockets, the host's pipes, every relayed connection) with its
//! state, and exits once the new one has rebuilt everything. Nothing is restarted and no address
//! changes.
//!
//! A keeper the macOS shell started runs from verified content, `<data>/content/<version>/`
//! (`content.rs`, thin-shell plan §10 step 5). Its handoffs never start a window's bundle: it
//! verifies and copies the new build's signed content first and hands over to the keeper in that
//! copy, and its hosts run from the copy as well.

mod accept;
pub mod appimage;
pub mod carried;
pub mod client;
pub mod content;
pub mod exe;
pub mod front_door;
pub mod handoff;
pub mod keys;
pub mod limited;
pub mod window_peer;
pub mod server;
pub mod source;
pub mod swap;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::host_proc::HostStatus;
use source::BuildSource;
use swap::SwapView;

/// The control socket's protocol version. An app refuses a keeper that speaks another one
/// rather than guessing at its answers.
pub const KEEPER_PROTOCOL: u32 = 1;

/// The version of a keeper that runs no built host (started by hand, or a debug window's): what the
/// version carriers hold in git (#1501, `scripts/app-version.mjs`).
pub const DEV_VERSION: &str = "0.0.0-dev";

/// The flag the window's `main()` looks for before anything graphical exists. Only a debug window
/// passes it, to run the keeper in its own executable; anything else that passes it to the window's
/// executable is refused there (`exe::run_from_window`, #461). `centralu-keeper` ignores it.
pub const KEEPER_FLAG: &str = "--keeper";

/// Exit code of a keeper that found another one already holding the data folder.
pub const EXIT_ALREADY_RUNNING: i32 = 3;

/// How long a window may stay away before an unwatched keeper in background mode ends itself.
pub const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);

/// How long a freshly started keeper waits for its first window. The app that launched it attaches
/// within a second; a keeper nobody attaches to within this is the leftover of an app that died
/// between launching it and attaching.
pub const STARTUP_GRACE: Duration = Duration::from_secs(60);

/// How long a keeper that closed a window itself (it stopped taking its status, #840 item 5)
/// waits for that window to attach again before the idle rule applies as usual. A window that was
/// only stalled (suspended, in a debugger, its reader blocked) attaches again once it runs.
pub const REATTACH_GRACE: Duration = Duration::from_secs(300);

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

/// Runs `migrate_legacy` when `data` is the default folder (no `CC_DATA_DIR`), before anything
/// creates it. Both the app (which creates the folder for `keeper.log` before launching the
/// keeper) and the keeper call this. Returns what was moved, for the log.
pub fn prepare_default_dir(data: &Path, dev: bool) -> Option<(PathBuf, PathBuf)> {
    if std::env::var("CC_DATA_DIR").map(|d| !d.trim().is_empty()).unwrap_or(false) {
        return None;
    }
    let home = PathBuf::from(std::env::var("HOME").ok()?);
    if data != home.join(if dev { ".centralu-dev" } else { ".centralu" }) {
        return None;
    }
    migrate_legacy(&home, dev)
}

pub fn socket_path(data: &Path) -> PathBuf {
    data.join("keeper.sock")
}

/// `<data>/keeper.log`: the keeper's stdout and stderr, the host's stderr, and the lines the shell
/// and the window add to them.
pub fn log_path(data: &Path) -> PathBuf {
    data.join("keeper.log")
}

/// Appends `[tag] msg` to `keeper.log`, for whoever is not the keeper's own stderr (the shell, the window).
pub fn log_line(data: &Path, tag: &str, msg: &str) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(log_path(data)) {
        let _ = writeln!(f, "[{tag}] {msg}");
    }
}

/// For the window, which links this crate and not the verifier: the one way to write hex and a
/// file's hash.
pub use content_verify::{hex, sha256_file};

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
    /// The current or last blue-green swap (#280 step 3), with its phase, so the app can show it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap: Option<SwapView>,
    /// Whether the current host hands its agents over in a swap (step 2) or stops them. Unknown
    /// until the host says, and for a host from before step 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keeps_agents: Option<bool>,
    /**
     * Which credential `status.token` is (#1405): `full`, the front door's token, for a window;
     * `limited`, the limited credential (`limited.rs`), for any other process. Absent from a keeper
     * from before #1405, which hands everyone the token.
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rights: Option<String>,
    /// `stop` with `forUpdate` stops the host for an update and ends the keeper (#1895 step 3): what "Apply now" and a restart
    /// into another window's build ask of it. A keeper without it gets a plain stop from a window of #1895 step 4 PR 3.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stops_for_update: bool,
}

/// Seconds since the epoch, as every record the keeper keeps writes its times.
pub(super) fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
    /// The build this keeper's own executable is from: the build the app that launched it (or the
    /// handoff that started it) named with `--host-source` (#280 step 4). Absent from keepers that
    /// predate step 4, which cannot hand themselves over.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildSource>,
}

impl KeeperInfo {
    /// This process, started now, serving `data`, from the build `build`. A fresh keeper and one
    /// that took over from another describe themselves the same way. The version is the build's, as
    /// the app passed it (`--app-version`); a keeper running the source host has none (`DEV_VERSION`).
    pub(super) fn of_this_process(data: &Path, build: BuildSource) -> KeeperInfo {
        KeeperInfo {
            pid: std::process::id(),
            protocol: KEEPER_PROTOCOL,
            version: build.version.clone().unwrap_or_else(|| DEV_VERSION.to_string()),
            started_at: now_secs(),
            data_dir: data.to_string_lossy().to_string(),
            build: Some(build),
        }
    }
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
    /// A window the keeper closed itself (it stopped taking its status) may still attach again (`REATTACH_GRACE`): no
    /// window for a moment is not "the last window left".
    pub window_expected: bool,
}

/**
 * Whether a keeper with no window should end itself now, and why.
 *
 * - A window attached: never.
 * - A window expected back (`window_expected`): not yet, whatever the mode. Once its grace runs out,
 *   the rules below apply. (An announced relaunch, #352, held a keeper the same way until #1895 step 4
 *   PR 3: an update now stops the keeper.)
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
    if i.stopping || i.attached > 0 || i.window_expected {
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

/**
 * Whether a window detaching should stop the keeper at once: the last one gone, background mode
 * off, and no window expected back. With one expected the idle rule decides instead, once its
 * grace runs out.
 */
pub fn stop_on_detach(attached: usize, background: bool, window_expected: bool) -> bool {
    attached == 0 && !background && !window_expected
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
            window_expected: false,
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

    /// A window the keeper closed itself may attach again: with background mode off, its going must not stop the keeper
    #[test]
    fn a_window_expected_back_holds_a_keeper_with_background_off() {
        let mut i = quiet(0);
        i.background = false;
        i.window_expected = true;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
        assert!(!stop_on_detach(0, false, true), "the detach itself does not stop it either");
        assert!(stop_on_detach(0, false, false));
        assert!(!stop_on_detach(1, false, false), "a window still attached keeps it");
        assert!(!stop_on_detach(0, true, false), "background mode keeps it");
    }

    #[test]
    fn a_stopping_keeper_is_not_stopped_twice() {
        let mut i = quiet(600);
        i.stopping = true;
        assert_eq!(idle_decision(i, DEFAULT_IDLE), None);
    }

    /// A test's or a person's own CC_DATA_DIR is never treated as the default folder.
    #[test]
    fn only_the_default_folder_takes_part_in_the_legacy_move() {
        assert_eq!(prepare_default_dir(Path::new("/tmp/cc-not-the-default"), false), None);
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
