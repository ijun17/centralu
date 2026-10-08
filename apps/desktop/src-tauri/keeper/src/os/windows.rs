//! The host process on Windows (#14): no process groups and no signals, a host asked to stop by
//! closing its stdin and ended with `taskkill /T`, no console windows. There is no keeper here yet
//! (`start_plan`; docs/plans/runtime-unification.md step 9), so none of the keeper's operations.

use std::process::{Command, Stdio};

/// Windows has no TERM: closing the host's stdin is the request to stop. The host runs with
/// `--watch-parent`, so EOF runs the same `shutdown()` a TERM does (`stop_pid_gracefully`).
pub const CLOSE_STDIN_TO_STOP: bool = true;

/// `taskkill /T` walks the tree from a pid, and a pid that has ended may already belong to someone
/// else, so only a host still running is ended (`stop_pid_gracefully`).
pub const SIGNAL_GROUP_AFTER_EXIT: bool = false;

/// Windows has no process groups to join; the tree is ended with `taskkill /T` instead
/// (`kill_group`). What it does need is no console: the release app is a GUI-subsystem program, so
/// `node.exe` would otherwise get a console window of its own, visible for as long as the host
/// runs. The host's own children (git, codex, claude) inherit that windowless console rather than
/// each opening one (`hide_console`, which `spawn_host` calls on every OS).
pub fn own_group(_cmd: &mut Command) {}

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

fn taskkill_tree(pid: u32) -> Command {
    let mut cmd = Command::new(windows_system_tool("taskkill.exe"));
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd
}

/// `%SystemRoot%\System32\<name>`.
fn windows_system_tool(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
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
}
