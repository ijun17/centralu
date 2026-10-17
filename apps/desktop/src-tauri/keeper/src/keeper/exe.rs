//! Which executable runs as the keeper (#440), and what the window's executable does when started as
//! one.
//!
//! The keeper is its own executable, `centralu-keeper`, shipped next to the window's
//! (`Contents/MacOS/` in the macOS bundle, `usr/bin/` in the AppImage). It links no Tauri and no
//! webview, so it can be started from verified content outside the bundle (thin-shell plan §5).
//!
//! **`centralu --keeper` refuses** (#461), at once and before anything graphical exists
//! (`run_from_window`). Until 0.1.0-beta.16 it `exec`ed the `centralu-keeper` beside it, for keepers
//! of 0.1.0-beta.11 and earlier, which hand themselves over by starting the new build's *window*
//! executable as `centralu --keeper --take-over-fd 3 ...`, and for windows from before #440, which
//! started their keeper that way. Such a keeper now never hears its successor say `hello` or
//! `ready` (the handoff's commit point), so it rolls back and serves on; the window then offers
//! "Restart completely", which starts a keeper of its own build. Opening a window instead would put
//! a second window on screen from a background keeper, so the refusal is an exit, not a fallthrough.
//!
//! **Debug builds run the keeper in the window's executable** (`IN_PROCESS_ENV`). `tauri dev` and
//! `cargo run` build only the binary they run, so a `centralu-keeper` in `target/debug` is whatever
//! an earlier `cargo build` left there: older code than the window's, with nothing to tell the two
//! apart (the two binaries of one `cargo build` are linked in no fixed order, so their times say
//! nothing either). A debug window that opts into the keeper (`CC_USE_KEEPER=1`) therefore starts
//! its own executable with `--keeper` and this variable. That is the only `--keeper` left.

use std::path::{Path, PathBuf};

/// The keeper executable's file name.
pub const KEEPER_EXE: &str = "centralu-keeper";

/// Set by a debug window on the keeper it starts: run the keeper in the window's executable. Removed
/// again before the keeper starts anything.
pub const IN_PROCESS_ENV: &str = crate::start_plan::KEEPER_IN_PROCESS_ENV;

/// Exit code of `centralu --keeper` refusing to be a keeper (#461). `EX_USAGE`: the command line
/// names a way of starting the keeper this build no longer has.
pub const EXIT_NOT_A_KEEPER: i32 = 64;

/**
 * How a keeper is started: its arguments, the environment it gets on top of the starter's, and
 * where its output goes. The window (`sidecar/link.rs`, the direct start) and the shell (thin-shell plan
 * §3, a keeper from verified content) both start keepers through this, so the two cannot drift
 * apart: what the shell starts is what the window would have started, from another place.
 */
#[derive(Debug, Clone, PartialEq)]
pub struct Start {
    pub data_dir: PathBuf,
    /// The host folder the keeper runs its hosts from (`--host-source`); none runs the source host.
    pub host_source: Option<PathBuf>,
    /// The app bundle the build came from (`--bundle-path`), for the build record.
    pub bundle_path: Option<String>,
    pub app_version: String,
    /// A debug build's keeper: the dev data folder and the source host (`CC_DEV=1`).
    pub dev: bool,
    /// Run the keeper in the window's executable, which a debug window starts as `centralu --keeper`
    /// (`IN_PROCESS_ENV`).
    pub in_process: bool,
}

impl Start {
    /// `--keeper` only for a keeper in the window's executable, the one place it still means
    /// something. `centralu-keeper` ignores it (`server::parse_args`): shell v1, whose bytes are
    /// pinned, still passes it, as every start did until #461.
    pub fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.in_process {
            args.push(super::KEEPER_FLAG.to_string());
        }
        args.push("--data-dir".into());
        args.push(self.data_dir.to_string_lossy().to_string());
        if let Some(dir) = &self.host_source {
            args.push("--host-source".into());
            args.push(dir.to_string_lossy().to_string());
        }
        if let Some(b) = &self.bundle_path {
            args.push("--bundle-path".into());
            args.push(b.clone());
        }
        args.push("--app-version".into());
        args.push(self.app_version.clone());
        args
    }

    /// Added to the environment the keeper inherits; nothing is removed from it.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = if self.dev { vec![("CC_DEV".into(), "1".into())] } else { Vec::new() };
        if self.in_process {
            env.push((IN_PROCESS_ENV.into(), "1".into()));
        }
        env
    }

    /// `keeper.log` in the data folder: the keeper's stdout and stderr, and the host's stderr.
    pub fn log_path(&self) -> PathBuf {
        super::log_path(&self.data_dir)
    }

    /// Starts `exe` as the keeper, detached into a session of its own (`client::spawn_detached`).
    pub fn spawn(&self, exe: &Path) -> std::io::Result<std::process::Child> {
        super::client::spawn_detached(exe, &self.args(), &self.env(), &self.log_path())
    }
}

/// The keeper executable shipped next to the window's executable `window_exe`.
pub fn beside(window_exe: &Path) -> PathBuf {
    window_exe.with_file_name(KEEPER_EXE)
}

/// Whether `exe` is a keeper executable by its name. A keeper hands itself over only to one
/// (`handoff::give`): a window from before #440 names its own executable instead, which no longer
/// answers `--keeper` and must never be started without it.
pub fn is_keeper_exe(exe: &Path) -> bool {
    exe.file_name().is_some_and(|n| n == KEEPER_EXE)
}

/// Whether `centralu --keeper` may run the keeper in this process: only a debug build, and only when
/// the debug window that started it asked (`IN_PROCESS_ENV`).
pub fn runs_in_process(asked: bool, build: crate::start_plan::Build) -> bool {
    asked && build == crate::start_plan::Build::Debug
}

/**
 * `centralu --keeper ...`: runs the keeper in this process for a debug window that asked, and
 * otherwise exits at once with `EXIT_NOT_A_KEEPER` (module docs). Returns the exit code.
 */
pub fn run_from_window(args: &[String]) -> i32 {
    let asked = std::env::var_os(IN_PROCESS_ENV).is_some();
    // Not passed on to the host and its children, nor to the next keeper of a handoff.
    std::env::remove_var(IN_PROCESS_ENV);
    if runs_in_process(asked, crate::start_plan::Build::current()) {
        return super::server::run(args);
    }
    eprintln!(
        "[keeper] `centralu --keeper` no longer starts a keeper (#461): the keeper is the {KEEPER_EXE} \
         executable beside this one. A keeper of 0.1.0-beta.11 or earlier asked for this; it rolls back, and \
         \"Restart completely\" in the window starts a keeper of the new build."
    );
    EXIT_NOT_A_KEEPER
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::start_plan::Build;
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// The command line every keeper start uses, written in one place for the window and the shell.
    /// `server::parse_args` reads it back.
    #[test]
    fn a_keeper_start_writes_the_command_line_the_keeper_reads() {
        let start = Start {
            data_dir: PathBuf::from("/d ata"),
            host_source: Some(PathBuf::from("/c/0.1.0/host")),
            bundle_path: Some("/Applications/Centralu.app".into()),
            app_version: "0.1.0".into(),
            dev: false,
            in_process: false,
        };
        assert_eq!(
            start.args(),
            ["--data-dir", "/d ata", "--host-source", "/c/0.1.0/host", "--bundle-path", "/Applications/Centralu.app", "--app-version", "0.1.0"],
            "no --keeper for centralu-keeper (#461)"
        );
        assert!(start.env().is_empty(), "a release start adds nothing to the environment");
        assert_eq!(start.log_path(), PathBuf::from("/d ata/keeper.log"));
        let mut argv = vec!["centralu-keeper".to_string()];
        argv.extend(start.args());
        let o = super::super::server::parse_args(&argv);
        assert_eq!(o.data_dir.as_deref(), Some(Path::new("/d ata")));
        assert_eq!(o.bundle_path.as_deref(), Some("/Applications/Centralu.app"));
        assert_eq!(o.app_version.as_deref(), Some("0.1.0"));

        // A debug window's keeper in its own executable: the one start that still needs `--keeper`
        let dev = Start { host_source: None, bundle_path: None, dev: true, in_process: true, ..start };
        assert_eq!(dev.args(), ["--keeper", "--data-dir", "/d ata", "--app-version", "0.1.0"]);
        assert_eq!(dev.env(), [("CC_DEV".to_string(), "1".to_string()), (IN_PROCESS_ENV.to_string(), "1".to_string())]);
    }

    /// Shell v1's pinned bytes still pass `--keeper` first; the keeper reads the rest as before.
    #[test]
    fn a_keeper_still_reads_a_command_line_that_starts_with_keeper() {
        let argv: Vec<String> =
            ["centralu-keeper", "--keeper", "--data-dir", "/d", "--app-version", "0.1.0"].iter().map(|s| s.to_string()).collect();
        let o = super::super::server::parse_args(&argv);
        assert_eq!(o.data_dir.as_deref(), Some(Path::new("/d")));
        assert_eq!(o.app_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn the_keeper_is_looked_for_next_to_the_window() {
        assert_eq!(
            beside(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu")),
            PathBuf::from("/Applications/Centralu.app/Contents/MacOS/centralu-keeper")
        );
        assert_eq!(beside(Path::new("/tmp/.mount_x/usr/bin/centralu")), PathBuf::from("/tmp/.mount_x/usr/bin/centralu-keeper"));
    }

    #[test]
    fn only_centralu_keeper_is_a_keeper_executable() {
        assert!(is_keeper_exe(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu-keeper")));
        assert!(is_keeper_exe(Path::new("/d/content/0.1.0/centralu-keeper")));
        assert!(!is_keeper_exe(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu")), "a window from before #440 names this");
        assert!(!is_keeper_exe(Path::new("/tmp/centralu-keeper-old")));
        assert!(!is_keeper_exe(Path::new("/")));
    }

    /// `tauri dev` relinks only the window; a keeper from an earlier `cargo build` is older code. A
    /// release never runs one in the window's executable, whatever the environment says.
    #[test]
    fn only_a_debug_window_that_asked_runs_the_keeper_in_its_own_executable() {
        assert!(runs_in_process(true, Build::Debug));
        assert!(!runs_in_process(false, Build::Debug), "a debug `centralu --keeper` nobody asked for refuses too");
        assert!(!runs_in_process(true, Build::Release));
        assert!(!runs_in_process(false, Build::Release));
    }

    /// The child half of `an_old_keeper_handing_over_to_the_window_executable_gets_no_hello`: run in a
    /// process of its own (the test binary started again), it is `centralu --keeper` as a keeper of
    /// 0.1.0-beta.11 or earlier starts it.
    #[test]
    fn refusing_child() {
        if std::env::var_os("CC_TEST_REFUSING_CHILD").is_none() {
            return;
        }
        let args: Vec<String> =
            ["centralu", "--keeper", "--take-over-fd", "3", "--data-dir", "/nonexistent/cc-461"].iter().map(|s| s.to_string()).collect();
        std::process::exit(run_from_window(&args));
    }

    /**
     * #461: what a keeper of 0.1.0-beta.11 or earlier meets when it hands itself over to this build's
     * window executable (`centralu --keeper --take-over-fd 3 ...`, the handoff channel at descriptor
     * 3). It must see the channel close with nothing said, so it never reaches `ready`, its commit
     * point, and rolls back; and the process must end at once rather than go on to open a window.
     */
    #[test]
    fn an_old_keeper_handing_over_to_the_window_executable_gets_no_hello() {
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let fd = theirs.as_raw_fd();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "keeper::exe::tests::refusing_child", "--test-threads", "1", "--nocapture"])
            .env("CC_TEST_REFUSING_CHILD", "1")
            .env_remove(IN_PROCESS_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: dup2 and fcntl are async-signal-safe (the same as handoff::spawn_successor).
        unsafe {
            cmd.pre_exec(move || {
                if fd == 3 {
                    libc::fcntl(3, libc::F_SETFD, 0);
                } else if libc::dup2(fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let started = Instant::now();
        let mut child = cmd.spawn().unwrap();
        drop(theirs);
        ours.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut got = Vec::new();
        let read = ours.read_to_end(&mut got);
        let status = child.wait().unwrap();
        assert!(read.is_ok(), "the channel closed rather than timing out: {read:?}");
        assert!(got.is_empty(), "nothing was said on the channel, so no hello and no ready: {got:?}");
        assert_eq!(status.code(), Some(EXIT_NOT_A_KEEPER), "it refused: {status}");
        assert!(started.elapsed() < Duration::from_secs(20), "at once: {:?}", started.elapsed());
    }
}
