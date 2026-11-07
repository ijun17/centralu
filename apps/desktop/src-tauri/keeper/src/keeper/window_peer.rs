//! Who is a window (#1405): the one kind of client `keeper.sock` hands the front door's token to.
//!
//! The token lets a client call every method of the host, and the window shows the person its own
//! confirmations first. Any other process of this user (an agent, a script it wrote, a tool) gets
//! the limited credential (`limited.rs`) on `status` and `attach`, and is refused `switch` and
//! `upgrade`, which would start code of its choosing with the token.
//!
//! A peer is a window when the kernel's record of who connected (`peer_pid`, as of its `connect`)
//! names a process whose executable is, by exact path, one of the window executables this keeper
//! accepts (`accepted_windows`): the `centralu` beside the keeper's own executable (the macOS
//! bundle's `Contents/MacOS/`, a debug build's `target/debug/`, a keeper run in the window's own
//! executable), unless the keeper runs from `<data>/content/`, a folder of this user's where a file
//! dropped beside it proves nothing; and the window of each build the keeper names (`--bundle-path`, and the bundle of
//! each `switch` a window made): `<bundle>/Contents/MacOS/centralu` for a macOS bundle, the
//! executable itself elsewhere. A file named `centralu` anywhere else is not a window: a copy of
//! another program renamed so is refused. On a keeper signed with a team identifier, the peer's
//! executable must also be signed by that team (`codesign --display`), and one whose signature could
//! not be read is not a window. No release is signed with a team today (macOS releases are signed
//! ad hoc, `tauri.conf.json`), so in every build that ships the path decides.
//!
//! **Not a wall.** A process of this user can start the app's own executable, which opens a
//! window the person sees, or replace the file at an accepted path (the app bundle is the user's to
//! change); a peer can also connect and then `exec` the window's executable, keeping its pid. And
//! `codesign --display` reads the file now at that path, not the code running in the peer: until the
//! check uses the peer's audit token (`SecCodeCopyGuestWithAttributes`, #1439), a team-signed keeper is
//! only as strong as the path. What this closes is the easy path: a script asking the socket for
//! the token, or running a copy of `node` named `centralu`.
//!
//! **Linux.** A window there runs from its AppImage's mount, whose path changes at every launch,
//! while the keeper runs from `<data>/content/<version>/` (`carried.rs`): only the window that
//! started the keeper or switched it (its `--bundle-path`) is accepted, and a later launch gets the
//! limited credential until a window of its own starts a keeper. The Linux keeper runs only with
//! `CC_USE_KEEPER=1` (`start_plan.rs`), so this is a limit to settle before it runs by default.
//!
//! **How it fails.** A peer whose pid or executable the kernel does not name is not a window: the
//! token is not handed out on a guess. Every refusal is logged with the executable and why, and a
//! window that was given the limited credential says so in its own log (`sidecar/link.rs`).
//!
//! **A window whose executable an update replaced** (#2117, #2119). Installing an update swaps the app bundle under a
//! running window (`swap.mjs` `swapInto`: the new one copied beside, the old one renamed aside and deleted). macOS then
//! names no path for the window's pid (`proc_pidpath` fails with ENOENT, every time), and Linux names the aside path with
//! ` (deleted)`. A file replaced in place instead keeps its path on macOS, which then names the new file, and reads as
//! the window for any process started from that file (seen on a Mac running this crate's tests). So a path read after
//! an install proves nothing either way. A stop for an update, which comes from exactly such a window, reads none: it is
//! a window's only when the peer is one of the windows attached now (`Attached`: its pid and when that process
//! started, so a pid used again is not it). Every window sends it while attached (`sidecar/link.rs`). An attach the
//! path rule refuses is still a window's when the peer is a process this keeper took by its path before
//! (`judge_attaching`), so a window that attaches again after an install keeps its token and its stop. Any other pid
//! is refused whatever its path reads, so a replaced file widens nothing an unknown process gets. `status`,
//! `system_ending`, `switch` and `upgrade` keep the path rule: the last two start code of the caller's naming with the
//! token, which a window about to relaunch has no need of. A keeper started after the install (a restart, a crash)
//! knows no window from before it: there the refusal says to quit and reopen Centralu.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use std::os::unix::net::UnixStream;

/// The window's executable, by file name (`exe.rs`: the window's binary sits next to the keeper's).
const WINDOW_EXE: &str = "centralu";

/// What Linux appends to `/proc/<pid>/exe` when the file was replaced since the process started.
const DELETED: &str = " (deleted)";

/**
 * The window executables a keeper accepts, by exact path: the `centralu` beside `beside` (the
 * keeper's own executable; None when it runs from content, `content::Origin`), and the window of each bundle in `bundles` (`window_exe_of`). Each is
 * resolved when it exists, so a symlinked folder still compares equal to what the kernel names.
 * A debug keeper also takes `CC_KEEPER_TEST_WINDOW_EXE` (`test_window_exe`).
 */
pub fn accepted_windows(beside: Option<&Path>, bundles: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        let p = std::fs::canonicalize(&p).unwrap_or(p);
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(dir) = beside.and_then(Path::parent) {
        add(dir.join(WINDOW_EXE));
    }
    for b in bundles {
        if let Some(p) = window_exe_of(b) {
            add(p);
        }
    }
    if let Some(p) = test_window_exe() {
        add(p);
    }
    out
}

/// The window's executable of a build's bundle (`BuildSource::bundle_path`, `client::bundle_of`): inside a macOS
/// `.app`, or the executable itself where there is no bundle. None for a relative path or another file.
pub fn window_exe_of(bundle: &str) -> Option<PathBuf> {
    let p = Path::new(bundle);
    if !p.is_absolute() {
        return None;
    }
    if p.extension().is_some_and(|e| e == "app") {
        return Some(p.join("Contents").join("MacOS").join(WINDOW_EXE));
    }
    (p.file_name().and_then(|n| n.to_str()) == Some(WINDOW_EXE)).then(|| p.to_path_buf())
}

/// Whether the process at the other end of `stream` is a Centralu window, by the executables accepted.
pub fn is_window(stream: &UnixStream, accepted: &[PathBuf]) -> bool {
    judge(stream, accepted).is_ok()
}

/// The same, with why not: the executable, when the kernel named one, and the reason.
pub fn judge(stream: &UnixStream, accepted: &[PathBuf]) -> Result<(), String> {
    let pid = crate::os::peer_pid(stream).map_err(|e| format!("the kernel named no peer process ({e})"))?;
    let exe = crate::os::exe_of_pid(pid).map_err(|e| format!("the executable of pid {pid} could not be read ({e})"))?;
    judge_exe(&exe, accepted, own_team().as_deref(), team_of)
}

/// A window as it was judged when it attached (#2117): its pid and when that process started (`os::process_started`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attached {
    pub pid: u32,
    pub started: u64,
}

/// The `Attached` of the peer of `stream`, read as it attaches; None when the kernel names no pid or start for it.
pub fn attached(stream: &UnixStream) -> Option<Attached> {
    let pid = crate::os::peer_pid(stream).ok()?;
    let started = crate::os::process_started(pid).ok()?;
    Some(Attached { pid, started })
}

/// How an attaching peer was taken for a window (`judge_attaching`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taken {
    /// Its executable is a window's (`judge`)
    ByPath,
    /// A process this keeper took by its path before, whose path no longer reads as the window's (an update replaced it)
    Known,
}

/// Whether an attaching peer is a window (#2119): by its path (`by_path`, `judge`), or, when the path rule refuses it,
/// by being a process this keeper took by its path before (`known`, by pid and start; `peer` is the attaching one). A
/// peer taken by its path joins `known`, for the keeper's life: after an install its path reads as no window's, and the
/// window it is may attach again (a write it missed closed its attach).
pub fn judge_attaching(by_path: Result<(), String>, peer: Option<Attached>, known: &mut Vec<Attached>) -> Result<Taken, String> {
    match (by_path, peer) {
        (Ok(()), Some(p)) => {
            if !known.contains(&p) {
                known.push(p);
            }
            Ok(Taken::ByPath)
        }
        (Ok(()), None) => Ok(Taken::ByPath),
        (Err(_), Some(p)) if known.contains(&p) => Ok(Taken::Known),
        (Err(why), _) => Err(why),
    }
}

/// Who may stop the keeper for an update (#2117): one of the windows attached now (`windows`), by pid and start. No path is
/// read: after an install macOS names none, or the old one, for the window and for any other process started from that file.
pub fn judge_for_update(stream: &UnixStream, windows: &[Attached]) -> Result<(), String> {
    let pid = crate::os::peer_pid(stream).map_err(|e| format!("the kernel named no peer process ({e})"))?;
    judge_pid_for_update(pid, windows, crate::os::process_started).map_err(|why| match crate::os::exe_of_pid(pid) {
        Ok(exe) => format!("{why} (it runs {})", exe.display()),
        Err(e) => format!("{why} (its executable could not be read: {e})"),
    })
}

/// The rule of `judge_for_update` for one pid, with the reader of its start passed in for the tests.
pub fn judge_pid_for_update(pid: u32, windows: &[Attached], started_of: impl Fn(u32) -> std::io::Result<u64>) -> Result<(), String> {
    match started_of(pid) {
        Ok(started) if windows.contains(&Attached { pid, started }) => Ok(()),
        _ => Err(format!("pid {pid} is no Centralu window attached to this keeper")),
    }
}

/// The rule for one executable: `accepted` are the window executables, `ours` is this keeper's team
/// (None: it judges no signatures), and the team reader is passed in for the tests.
pub fn judge_exe(exe: &Path, accepted: &[PathBuf], ours: Option<&str>, read_team: impl Fn(&Path) -> Signer) -> Result<(), String> {
    if !is_accepted(exe, accepted) {
        let names: Vec<String> = accepted.iter().map(|p| p.display().to_string()).collect();
        return Err(format!("{} is not the window's executable (accepted: {})", exe.display(), names.join(", ")));
    }
    let Some(ours) = ours else { return Ok(()) };
    match read_team(exe) {
        Signer::Team(t) if t == ours => Ok(()),
        Signer::Team(t) => Err(format!("{} is signed by team {t}, not this keeper's {ours}", exe.display())),
        Signer::NoTeam => Err(format!("{} is not signed by this keeper's team {ours}", exe.display())),
        // A keeper that judges signatures does not take an unread one on its path alone
        Signer::Unread => Err(format!("the signature of {} could not be read", exe.display())),
    }
}

/// `exe` is one of `accepted`, exactly. Linux names an executable replaced since the process started
/// with ` (deleted)` after its path, which is still that window when the path without it is accepted
/// (an update replaced its file).
pub fn is_accepted(exe: &Path, accepted: &[PathBuf]) -> bool {
    let raw = exe.to_string_lossy();
    let path = PathBuf::from(raw.strip_suffix(DELETED).unwrap_or(&raw));
    let resolved = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    accepted.iter().any(|a| *a == path || *a == resolved)
}

/// What `codesign` says signed an executable.
#[derive(Debug, Clone, PartialEq)]
pub enum Signer {
    /// Signed by this team
    Team(String),
    /// Unsigned, signed ad hoc, or no team
    NoTeam,
    /// `codesign` could not be run, or there are no signatures to read here
    Unread,
}

/// This keeper's own team identifier, read once. None: it judges no signatures.
fn own_team() -> Option<String> {
    static OWN: OnceLock<Option<String>> = OnceLock::new();
    OWN.get_or_init(|| {
        let exe: PathBuf = std::env::current_exe().ok()?;
        match team_of(&exe) {
            Signer::Team(t) => Some(t),
            _ => None,
        }
    })
    .clone()
}

/// What signed `exe`, as `codesign --display` says it (the OS layer runs it, macOS only).
fn team_of(exe: &Path) -> Signer {
    match crate::os::code_signature_display(exe) {
        None => Signer::Unread,
        Some(display) => match team_in(&display) {
            Some(t) => Signer::Team(t),
            None => Signer::NoTeam,
        },
    }
}

/// The `TeamIdentifier=` line of `codesign --display --verbose=2`; "not set" is no team.
pub fn team_in(display: &str) -> Option<String> {
    let team = display.lines().find_map(|l| l.strip_prefix("TeamIdentifier="))?.trim();
    (!team.is_empty() && team != "not set").then(|| team.to_string())
}

/**
 * A debug keeper started with `CC_KEEPER_TEST_WINDOW_EXE=<absolute path>` also accepts that
 * executable as a window, for the integration scripts (`scripts/keeper-*.mjs`), which pass the
 * `node` that runs them. A release build ignores it: the check is compiled out with
 * `debug_assertions`.
 */
pub fn test_window_exe() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let p = PathBuf::from(std::env::var_os("CC_KEEPER_TEST_WINDOW_EXE")?);
    p.is_absolute().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #2117: a stop for an update is the attached window's, known by pid and start, whatever its executable reads now. A pid
    /// that never attached is not, nor the same pid in a process that started later, nor one whose start cannot be read
    #[test]
    fn a_stop_for_an_update_takes_the_attached_window_whose_executable_was_replaced() {
        let attached = [Attached { pid: 40, started: 1_000 }];
        let started = |pid: u32| -> std::io::Result<u64> { Ok(if pid == 40 { 1_000 } else { 2_000 }) };
        assert_eq!(judge_pid_for_update(40, &attached, started), Ok(()));
        let unknown = judge_pid_for_update(41, &attached, started).unwrap_err();
        assert!(unknown.contains("no Centralu window attached"), "{unknown}");
        let reused = |_: u32| -> std::io::Result<u64> { Ok(1_001) };
        assert!(judge_pid_for_update(40, &attached, reused).is_err(), "a pid used again by a later process");
        let no_start = |_: u32| -> std::io::Result<u64> { Err(std::io::Error::from(std::io::ErrorKind::NotFound)) };
        assert!(judge_pid_for_update(40, &attached, no_start).is_err(), "a start that cannot be read");
        assert!(judge_pid_for_update(40, &[], started).is_err(), "no window attached");
    }

    /// #2119: a window taken by its path is taken again when it attaches with a path that no longer reads as the window's.
    /// A process never taken by its path is not, nor a pid used again by a later process
    #[test]
    fn an_attach_takes_again_a_window_taken_by_its_path_before() {
        let window = Attached { pid: 40, started: 1_000 };
        let refused = || Err::<(), String>("the executable of pid 40 could not be read (ENOENT)".into());
        let mut known = Vec::new();
        assert!(judge_attaching(refused(), Some(window), &mut known).is_err(), "never taken by its path");
        assert_eq!(judge_attaching(Ok(()), Some(window), &mut known), Ok(Taken::ByPath));
        assert_eq!(judge_attaching(Ok(()), Some(window), &mut known), Ok(Taken::ByPath));
        assert_eq!(known, vec![window], "kept once");
        assert_eq!(judge_attaching(refused(), Some(window), &mut known), Ok(Taken::Known));
        assert!(judge_attaching(refused(), Some(Attached { pid: 41, started: 1_000 }), &mut known).is_err(), "another pid");
        assert!(judge_attaching(refused(), Some(Attached { pid: 40, started: 1_001 }), &mut known).is_err(), "the pid used again");
        assert!(judge_attaching(refused(), None, &mut known).is_err(), "no pid or start");
    }

    fn paths(ps: &[&str]) -> Vec<PathBuf> {
        ps.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn the_window_is_an_accepted_executable_by_exact_path() {
        let accepted = paths(&["/Applications/Centralu.app/Contents/MacOS/centralu", "/usr/bin/centralu"]);
        for p in ["/Applications/Centralu.app/Contents/MacOS/centralu", "/usr/bin/centralu", "/usr/bin/centralu (deleted)"] {
            assert!(is_accepted(Path::new(p), &accepted), "{p}");
        }
        // A file named centralu anywhere else, `node` renamed so among them, is not a window
        for p in [
            "/tmp/x/centralu",
            "/home/me/bin/centralu",
            "/home/me/bin/centralu (deleted)",
            "/usr/bin/node",
            "/Applications/Centralu.app/Contents/MacOS/centralu-keeper",
            "/Applications/Other.app/Contents/MacOS/centralu",
        ] {
            assert!(!is_accepted(Path::new(p), &accepted), "{p}");
        }
    }

    #[test]
    fn accepts_the_window_beside_the_keeper_and_the_window_of_each_named_bundle() {
        let accepted = accepted_windows(
            Some(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu-keeper")),
            &["/Applications/Centralu.app".into(), "/tmp/.mount_CentraAb12/usr/bin/centralu".into(), "relative/centralu".into(), "/usr/bin/node".into()],
        );
        let mut expected = paths(&["/Applications/Centralu.app/Contents/MacOS/centralu", "/tmp/.mount_CentraAb12/usr/bin/centralu"]);
        expected.extend(test_window_exe());
        assert_eq!(accepted, expected);
        // A keeper run from content takes nothing beside it: only the bundles it names
        assert_eq!(accepted_windows(None, &[]), test_window_exe().into_iter().collect::<Vec<_>>());
    }

    #[test]
    fn reads_the_team_codesign_displays() {
        let signed = "Executable=/Applications/Centralu.app/Contents/MacOS/centralu\nIdentifier=app.centralu\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2\n";
        assert_eq!(team_in(signed).as_deref(), Some("AB12CD34EF"));
        assert_eq!(team_in("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_in("code object is not signed at all\n"), None);
    }

    #[test]
    fn a_peer_that_is_not_accepted_is_refused_with_its_path() {
        let accepted = paths(&["/usr/bin/centralu"]);
        let why = judge_exe(Path::new("/tmp/x/centralu"), &accepted, None, |_| Signer::Unread).unwrap_err();
        assert!(why.contains("/tmp/x/centralu") && why.contains("/usr/bin/centralu"), "{why}");
    }

    #[test]
    fn a_keeper_with_a_team_takes_only_its_own_teams_window() {
        let exe = Path::new("/Applications/Centralu.app/Contents/MacOS/centralu");
        let accepted = vec![exe.to_path_buf()];
        assert!(judge_exe(exe, &accepted, Some("AB12"), |_| Signer::Team("AB12".into())).is_ok());
        assert!(judge_exe(exe, &accepted, Some("AB12"), |_| Signer::Team("ZZ99".into())).unwrap_err().contains("team ZZ99"));
        assert!(judge_exe(exe, &accepted, Some("AB12"), |_| Signer::NoTeam).is_err(), "an ad hoc or unsigned copy");
        // A signature it could not read is not taken on the path alone
        assert!(judge_exe(exe, &accepted, Some("AB12"), |_| Signer::Unread).unwrap_err().contains("could not be read"));
        // A keeper with no team judges no signatures
        assert!(judge_exe(exe, &accepted, None, |_| Signer::NoTeam).is_ok());
    }

    /// `cargo test --release`: the integration scripts' variable names nothing in a release build.
    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_keeper_ignores_the_test_window() {
        std::env::set_var("CC_KEEPER_TEST_WINDOW_EXE", "/usr/bin/node");
        assert_eq!(test_window_exe(), None);
        assert!(accepted_windows(None, &[]).is_empty());
    }

    #[test]
    fn a_process_that_is_not_the_window_is_not_one() {
        // The test binary is the peer of both ends here, and no path accepted is its executable
        let (a, _b) = UnixStream::pair().unwrap();
        let why = judge(&a, &paths(&["/usr/bin/centralu"])).unwrap_err();
        assert!(why.contains("not the window's executable"), "{why}");
        // Its own executable, accepted, is a window
        let own = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        assert!(judge(&a, &[own]).is_ok());
    }
}
