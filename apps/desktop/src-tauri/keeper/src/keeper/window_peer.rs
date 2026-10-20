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
