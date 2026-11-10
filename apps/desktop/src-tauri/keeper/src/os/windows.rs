//! The host process on Windows (#14): no process groups and no signals, a host asked to stop by
//! closing its stdin and ended with `taskkill /T`, no console windows. There is no keeper here yet
//! (`start_plan`; docs/plans/runtime-unification.md step 9), so none of the keeper's operations.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Windows never had a keeper to leave behind (`unix.rs`, #1895 step 4 PR 7).
pub fn stop_earlier_keeper(_dev: bool) -> Option<String> {
    None
}

/// The `centralu` launcher `centralu serve` keeps in this window's data folder (#1223): the managed one an install
/// over ssh made (`<data>/remote/bin/centralu.cmd`), else the one an npm install keeps (`<data>/bin/centralu.cmd`).
/// Its presence says a linked hub's `serve` may hold this folder, so the window attaches to that host
/// (`start_plan::Host::Serve`) rather than starting one the lock would refuse. The folder is the host's own default:
/// `CC_DATA_DIR`, or `.centralu` in the user's profile.
pub fn serve_launcher() -> Option<PathBuf> {
    let data = match std::env::var("CC_DATA_DIR") {
        Ok(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => PathBuf::from(std::env::var_os("USERPROFILE")?).join(".centralu"),
    };
    [data.join("remote").join("bin").join("centralu.cmd"), data.join("bin").join("centralu.cmd")].into_iter().find(|p| p.is_file())
}

/// Whether a window that starts its host itself can relaunch into an update just installed (#1895): its bundle is an app the update replaces, and the host it stops for the update is the one the relaunch starts again. Only macOS ships that.
pub const RELAUNCH_WITHOUT_KEEPER: bool = false;

/// How long a host gets after the polite request (`host_proc::STOP_GRACE`): its whole shutdown bound and a margin, as the host waits for the stops of its
/// terminals' trees and one ended before they are done leaves a grandchild whose parent it already ended (#2142).
pub const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(crate::host_proc::HOST_SHUTDOWN_BOUND.as_secs() + 2);

/// Windows has no TERM: closing the host's stdin is the request to stop. The host runs with
/// `--watch-parent`, so EOF runs the same `shutdown()` a TERM does (`stop_pid_gracefully`).
pub const CLOSE_STDIN_TO_STOP: bool = true;

/// `taskkill /T` walks the tree from a pid, and a pid that has ended may already belong to someone
/// else, so only a host still running is ended (`stop_pid_gracefully`).
pub fn group_signal_after_exit_is_safe(_pid: u32) -> bool {
    false
}

/// Windows has no process groups to join; the tree is ended with `taskkill /T` instead
/// (`kill_group`). What it does need is no console: the release app is a GUI-subsystem program, so
/// `node.exe` would otherwise get a console window of its own, visible for as long as the host
/// runs. The host's own children (git, codex, claude) inherit that windowless console rather than
/// each opening one (`hide_console`, which `spawn_host` calls on every OS).
pub fn own_group(_cmd: &mut Command) {}

/// No descriptor limit to give back: Windows has none of its own (`raise_descriptor_limit` is unix).
pub fn original_descriptor_limit(_cmd: &mut Command) {}

/// `.bin/tsx` is a sh script, and its siblings `tsx.CMD` / `tsx.ps1` cannot be started without a
/// shell either (Rust would hand the sh script to CreateProcessW and fail). So Node runs tsx's own
/// entry directly, the file `.bin/tsx` points at anyway (`host_proc::source_launch`).
pub const RUNS_SH_SCRIPTS: bool = false;

/// No login shell to ask: Node is looked for on PATH (`host_proc::node`).
pub fn probe_login_shell() -> Option<String> {
    None
}

/// Windows: nothing to send. Closing stdin (in `stop_pid_gracefully`) is the request to stop.
pub fn kill_pid(_pid: u32) {}

/// Windows: the host and every process under it, forcibly. `taskkill` is named by its full path
/// under the system folder, so a `taskkill.exe` in the working directory or on PATH is never the
/// one that runs.
pub fn kill_group(pid: u32) {
    let _ = taskkill_tree(pid).status();
}

/// Windows: `kill_group` is already forcible.
pub fn kill_group_now(pid: u32) {
    kill_group(pid);
}

fn taskkill_tree(pid: u32) -> Command {
    let mut cmd = Command::new(windows_system_tool("taskkill.exe"));
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd
}

/// `%SystemRoot%\System32\<name>`.
fn windows_system_tool(name: &str) -> std::path::PathBuf {
    system_tool_under(std::env::var_os("SystemRoot").as_deref(), name)
}

/// `windows_system_tool` for a given `SystemRoot`. One that is not a whole path from a drive's root (an empty one, a
/// relative one, `C:x`, a share) is not used: `System32\taskkill.exe` would be relative to the working directory, where
/// a planted program runs (#428; the host's `systemTool` has the same rule).
fn system_tool_under(root: Option<&std::ffi::OsStr>, name: &str) -> std::path::PathBuf {
    let drive_absolute = |r: &std::ffi::OsStr| {
        let b = r.to_string_lossy().into_owned().into_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    };
    let root = match root {
        Some(r) if drive_absolute(r) => r,
        _ => std::ffi::OsStr::new("C:\\Windows"),
    };
    std::path::PathBuf::from(root).join("System32").join(name)
}

/// Starts a console program with no console window (`CREATE_NO_WINDOW`).
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PA11: Windows looks a bare name up in the working directory first, so a host's tree is
    /// ended by `%SystemRoot%\System32\taskkill.exe`, never by whatever `taskkill.exe` is nearer.
    #[test]
    fn the_tree_is_ended_by_the_system32_taskkill() {
        let cmd = taskkill_tree(4242);
        let program = std::path::Path::new(cmd.get_program());
        assert!(program.is_absolute(), "{}", program.display());
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        assert_eq!(program, std::path::Path::new(&root).join("System32").join("taskkill.exe"));
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, ["/PID", "4242", "/T", "/F"]);
    }

    /// #428: a `SystemRoot` that is empty, relative or drive-relative would put the tool under the working directory.
    #[test]
    fn a_system_root_that_is_not_a_whole_path_is_not_used() {
        use std::ffi::OsStr;
        let default = std::path::Path::new("C:\\Windows\\System32\\taskkill.exe");
        for bad in ["", "Windows", "C:Windows", "\\\\server\\share", "\\Windows"] {
            assert_eq!(system_tool_under(Some(OsStr::new(bad)), "taskkill.exe"), default, "{bad:?}");
        }
        assert_eq!(system_tool_under(None, "taskkill.exe"), default);
        assert_eq!(system_tool_under(Some(OsStr::new("D:\\WinNT")), "taskkill.exe"), std::path::Path::new("D:\\WinNT\\System32\\taskkill.exe"));
    }
}
