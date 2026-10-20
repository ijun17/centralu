//! Who is a window (#1405): the one kind of client `keeper.sock` hands the front door's token to.
//!
//! The token lets a client call every method of the host, and the window shows the person its own
//! confirmations first. Any other process of this user (an agent, a script it wrote, a tool) gets
//! the limited credential (`limited.rs`) on `status` and `attach`, and is refused `switch` and
//! `upgrade`, which would start code of its choosing with the token.
//!
//! A peer is a window when the kernel's record of who connected (`peer_pid`, as of its `connect`)
//! names a process whose executable is the app's own: a file named `centralu` (the window's binary
//! in the macOS bundle, the AppImage, the Linux packages and a debug build alike, `exe.rs`). On a
//! keeper signed with a team identifier, the peer's executable must also be signed by that team
//! (`codesign --display`): a copy of another program renamed `centralu` is not. No release is signed
//! with a team today (macOS releases are signed ad hoc, `tauri.conf.json`), so in every build that
//! ships the name decides; the team check is there for the day one is.
//!
//! **Not a wall.** A process of this user can start the app's own executable, which opens a
//! window the person sees, and where the name decides it can also run a program of its own renamed
//! `centralu`. What this closes is the easy path: a script asking the socket for the token.
//!
//! **How it fails.** A peer whose pid or executable the kernel does not name is not a window: the
//! token is not handed out on a guess. Where the keeper has a team and `codesign` cannot be run at
//! all, the name decides, as it does for an unsigned keeper; a peer `codesign` reads as unsigned,
//! ad hoc or another team's is not a window. Every refusal is logged with the executable and why,
//! and a window that was given the limited credential says so in its own log (`sidecar/link.rs`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use std::os::unix::net::UnixStream;

/// The window's executable, by file name (`exe.rs`: the window's binary sits next to the keeper's).
const WINDOW_EXE: &str = "centralu";

/// Whether the process at the other end of `stream` is a Centralu window.
pub fn is_window(stream: &UnixStream) -> bool {
    judge(stream).is_ok()
}

/// The same, with why not: the executable, when the kernel named one, and the reason.
pub fn judge(stream: &UnixStream) -> Result<(), String> {
    if test_any_peer() {
        return Ok(());
    }
    let pid = crate::os::peer_pid(stream).map_err(|e| format!("the kernel named no peer process ({e})"))?;
    let exe = crate::os::exe_of_pid(pid).map_err(|e| format!("the executable of pid {pid} could not be read ({e})"))?;
    judge_exe(&exe, own_team().as_deref(), team_of)
}

/// The rule for one executable: `ours` is this keeper's team (None: it judges no signatures), and
/// the team reader is passed in for the tests.
pub fn judge_exe(exe: &Path, ours: Option<&str>, read_team: impl Fn(&Path) -> Signer) -> Result<(), String> {
    if !named_as_window(exe) {
        return Err(format!("{} is not the window's executable", exe.display()));
    }
    let Some(ours) = ours else { return Ok(()) };
    match read_team(exe) {
        Signer::Team(t) if t == ours => Ok(()),
        Signer::Team(t) => Err(format!("{} is signed by team {t}, not this keeper's {ours}", exe.display())),
        Signer::NoTeam => Err(format!("{} is not signed by this keeper's team {ours}", exe.display())),
        // `codesign` could not be run at all: the name decides, as for an unsigned keeper
        Signer::Unread => Ok(()),
    }
}

/// The executable's file name is the window's. Linux marks an executable replaced since the
/// process started with ` (deleted)`, which is still that window (an update replaced its file).
pub fn named_as_window(exe: &Path) -> bool {
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else { return false };
    name == WINDOW_EXE || name == format!("{WINDOW_EXE} (deleted)")
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
 * A debug keeper started with `CC_KEEPER_TEST_ANY_PEER=1` counts every peer as a window, for the
 * integration scripts (`scripts/keeper-*.mjs`), whose clients are Node processes. A release build
 * ignores it: the check is compiled out with `debug_assertions`.
 */
pub fn test_any_peer() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CC_KEEPER_TEST_ANY_PEER").is_some_and(|v| v == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_the_app_executable_by_name() {
        for p in [
            "/Applications/Centralu.app/Contents/MacOS/centralu",
            "/tmp/.mount_CentraXYZ/usr/bin/centralu",
            "/home/me/cc/target/debug/centralu",
            "/usr/bin/centralu (deleted)",
        ] {
            assert!(named_as_window(&PathBuf::from(p)), "{p}");
        }
        for p in ["/usr/bin/node", "/opt/homebrew/bin/python3", "/Applications/Centralu.app/Contents/MacOS/centralu-keeper", "/tmp/centralu.sh", "/tmp/Centralu"] {
            assert!(!named_as_window(&PathBuf::from(p)), "{p}");
        }
    }

    #[test]
    fn reads_the_team_codesign_displays() {
        let signed = "Executable=/Applications/Centralu.app/Contents/MacOS/centralu\nIdentifier=app.centralu\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2\n";
        assert_eq!(team_in(signed).as_deref(), Some("AB12CD34EF"));
        assert_eq!(team_in("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_in("code object is not signed at all\n"), None);
    }

    #[test]
    fn a_misnamed_peer_is_refused_with_its_path() {
        let why = judge_exe(Path::new("/usr/bin/node"), None, |_| Signer::Unread).unwrap_err();
        assert!(why.contains("/usr/bin/node"), "{why}");
    }

    #[test]
    fn a_keeper_with_a_team_takes_only_its_own_teams_window() {
        let exe = Path::new("/Applications/Centralu.app/Contents/MacOS/centralu");
        assert!(judge_exe(exe, Some("AB12"), |_| Signer::Team("AB12".into())).is_ok());
        assert!(judge_exe(exe, Some("AB12"), |_| Signer::Team("ZZ99".into())).unwrap_err().contains("team ZZ99"));
        assert!(judge_exe(exe, Some("AB12"), |_| Signer::NoTeam).is_err(), "an ad hoc or unsigned copy named centralu");
        // codesign could not run at all: the name decides, as on a keeper with no team
        assert!(judge_exe(exe, Some("AB12"), |_| Signer::Unread).is_ok());
        // A keeper with no team judges no signatures
        assert!(judge_exe(exe, None, |_| Signer::NoTeam).is_ok());
    }

    #[test]
    fn a_process_that_is_not_the_window_is_not_one() {
        // The test binary is the peer of both ends here: it is not named `centralu`
        let (a, _b) = UnixStream::pair().unwrap();
        if !test_any_peer() {
            let why = judge(&a).unwrap_err();
            assert!(why.contains("not the window's executable"), "{why}");
        }
    }
}
