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
//! keeper signed with a team identifier (a macOS release), the peer's executable must also be
//! signed by the same team (`codesign`): a copy of another program renamed `centralu` is not.
//!
//! **Not a wall.** A process of this user can start the app's own executable, which opens a
//! window the person sees; on an unsigned keeper (a debug build, Linux) it can also rename a
//! program of its own. What this closes is the easy path: a script asking the socket for the token.
//!
//! A window never fails this check by an error of the keeper's: an executable it cannot name, or a
//! signature it cannot read, counts against the peer only where the keeper is itself signed and
//! the peer's team is read and differs. Elsewhere the name decides.

use std::path::Path;
use std::sync::OnceLock;

use std::os::unix::net::UnixStream;

/// The window's executable, by file name (`exe.rs`: the window's binary sits next to the keeper's).
const WINDOW_EXE: &str = "centralu";

/// Whether the process at the other end of `stream` is a Centralu window.
pub fn is_window(stream: &UnixStream) -> bool {
    if test_any_peer() {
        return true;
    }
    let Ok(pid) = crate::os::peer_pid(stream) else { return false };
    let Ok(exe) = crate::os::exe_of_pid(pid) else { return false };
    named_as_window(&exe) && same_signer(&exe)
}

/// The executable's file name is the window's. Linux marks an executable replaced since the
/// process started with ` (deleted)`, which is still that window (an update replaced its file).
pub fn named_as_window(exe: &Path) -> bool {
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else { return false };
    name == WINDOW_EXE || name == format!("{WINDOW_EXE} (deleted)")
}

/// On a keeper signed by a team, the peer's executable is signed by the same team. A keeper with
/// no team (unsigned, ad hoc, Linux) does not judge signatures, and neither does one that cannot
/// read its own.
fn same_signer(exe: &Path) -> bool {
    let Some(ours) = own_team() else { return true };
    team_of(exe).as_deref() == Some(ours.as_str())
}

/// This keeper's own team identifier, read once.
fn own_team() -> Option<String> {
    static OWN: OnceLock<Option<String>> = OnceLock::new();
    OWN.get_or_init(|| std::env::current_exe().ok().and_then(|exe| team_of(&exe))).clone()
}

/// The team identifier `exe` is signed with, or None (unsigned, ad hoc, or no signatures here).
fn team_of(exe: &Path) -> Option<String> {
    team_in(&crate::os::code_signature_display(exe)?)
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
fn test_any_peer() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CC_KEEPER_TEST_ANY_PEER").is_some_and(|v| v == "1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
    fn a_process_that_is_not_the_window_is_not_one() {
        // The test binary is the peer of both ends here: it is not named `centralu`
        let (a, _b) = UnixStream::pair().unwrap();
        if !test_any_peer() {
            assert!(!is_window(&a));
        }
    }
}
