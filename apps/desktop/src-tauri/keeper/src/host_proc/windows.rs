//! The Windows side of `host_proc` (#14): no process groups and no signals, a host asked to stop by
//! closing its stdin and ended with `taskkill /T`, no console windows, and Node looked for on PATH
//! and where Windows installers put it. There is no keeper here (`start_plan`), so nothing of the
//! handoff is either.

use std::io::{BufRead, BufReader};
use std::process::{ChildStdout, Command, Stdio};

use super::Lines;

/// Nothing to pause: a host's stdout is never handed over here.
pub enum Gate {}

impl Clone for Gate {
    fn clone(&self) -> Gate {
        match *self {}
    }
}

/// A host another keeper handed over: none here, there is no keeper.
pub enum Foreign {}

impl Foreign {
    pub(super) fn id(&self) -> u32 {
        match *self {}
    }

    pub(super) fn stdin(&mut self) -> Option<&mut dyn std::io::Write> {
        match *self {}
    }

    pub(super) fn take_stdin(&mut self) -> Option<Box<dyn Send>> {
        match *self {}
    }

    pub(super) fn has_exited(&mut self) -> bool {
        match *self {}
    }

    pub(super) fn kill(&mut self) {
        match *self {}
    }

    pub(super) fn wait(&mut self) -> Option<i32> {
        match *self {}
    }
}

/// Windows has no TERM: closing the host's stdin is the request to stop. The host runs with
/// `--watch-parent`, so EOF runs the same `shutdown()` a TERM does (`stop_pid_gracefully`).
pub(super) const CLOSE_STDIN_TO_STOP: bool = true;

/// `taskkill /T` walks the tree from a pid, and a pid that has ended may already belong to someone
/// else, so only a host still running is ended (`stop_pid_gracefully`).
pub(super) const SIGNAL_GROUP_AFTER_EXIT: bool = false;

/// Windows has no process groups to join; the tree is ended with `taskkill /T` instead
/// (`kill_group`). What it does need is no console: the release app is a GUI-subsystem program, so
/// `node.exe` would otherwise get a console window of its own, visible for as long as the host
/// runs. The host's own children (git, codex, claude) inherit that windowless console rather than
/// each opening one (`hide_console`, which `spawn_host` calls on every OS).
pub(super) fn own_group(_cmd: &mut Command) {}

pub(super) fn host_lines(stdout: ChildStdout) -> (Lines, Option<Gate>) {
    (Box::new(BufReader::new(stdout).lines().map_while(Result::ok)), None)
}

/// `.bin/tsx` is a sh script, and its siblings `tsx.CMD` / `tsx.ps1` cannot be started without a
/// shell either (Rust would hand the sh script to CreateProcessW and fail). So Node runs tsx's own
/// entry directly, the file `.bin/tsx` points at anyway.
pub(super) fn tsx_program(root: &str, args: &mut Vec<String>) -> String {
    args.insert(0, format!("{root}/node_modules/tsx/dist/cli.mjs"));
    super::resolve_node().unwrap_or_else(|_| "node".into())
}

/// Windows: nothing to send. Closing stdin (in `stop_pid_gracefully`) is the request to stop.
pub fn kill_pid(_pid: u32) {}

/// Windows: the host and every process under it, forcibly. `taskkill` is named by its full path
/// under the system folder, so a `taskkill.exe` in the working directory or on PATH is never the
/// one that runs.
pub fn kill_group(pid: u32) {
    let mut cmd = Command::new(windows_system_tool("taskkill.exe"));
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    let _ = cmd.status();
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

pub(super) const INSTALL_NODE_HINT: &str = "`winget install OpenJS.NodeJS.LTS`";
pub(super) const UPGRADE_NODE_HINT: &str = "`winget upgrade OpenJS.NodeJS.LTS`";

/// The first place `pick_node` asks, named in the "looked in" list.
pub(super) const FIRST_LOOK: &str = "PATH";

pub(super) fn probe_first() -> Option<String> {
    let path = std::env::var_os("PATH")?;
    super::node::first_on_path(std::env::split_paths(&path), "node.exe", |p| p.is_file())
}

pub(super) fn fallback_node_paths() -> Vec<String> {
    super::node::windows_node_paths(|name| std::env::var(name).ok().filter(|v| !v.is_empty()), nvm_windows_versions)
}

/// nvm-windows' version folders (`v22.3.1`), newest first, compared as numbers.
fn nvm_windows_versions(home: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = super::node::version_parts(&name);
            (name.starts_with('v') && !parts.is_empty()).then_some((parts, name))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, n)| n).collect()
}
