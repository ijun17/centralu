//! Which executable runs as the keeper, and how the window's executable turns into it (#440).
//!
//! The keeper is its own executable, `centralu-keeper`, shipped next to the window's
//! (`Contents/MacOS/` in the macOS bundle, `usr/bin/` in the AppImage). It links no Tauri and no
//! webview, so a later step can start it from verified content outside the bundle (thin-shell
//! plan §5).
//!
//! **The window's executable still answers `--keeper`.** Keepers already installed (0.1.0-beta.11
//! and earlier) hand themselves over by starting the new build's *window* executable as
//! `centralu --keeper --take-over-fd 3 ...` (the path the window gave them), and an older window
//! starts its keeper the same way. So `centralu --keeper` replaces itself with the keeper next to
//! it through `exec`: same pid (the outgoing keeper is waiting on that child), same arguments,
//! same environment, and every descriptor that is not close-on-exec, which is how the handoff
//! channel at descriptor 3 and the `keeper.log` at stdout and stderr reach the real keeper.
//!
//! When there is no keeper next to it (a bundle someone assembled by hand), the window's
//! executable runs the keeper itself, as every build before this one did. Nothing a person sees
//! changes either way.
//!
//! **Debug builds run the keeper in the window's executable** (`IN_PROCESS_ENV`). `tauri dev` and
//! `cargo run` build only the binary they run, so a `centralu-keeper` in `target/debug` is whatever
//! an earlier `cargo build` left there: older code than the window's, with nothing to tell the two
//! apart (the two binaries of one `cargo build` are linked in no fixed order, so their times say
//! nothing either). A debug window that opts into the keeper (`CC_USE_KEEPER=1`) therefore starts
//! its own executable with `--keeper` and this variable, as it did before #440.

use std::path::{Path, PathBuf};

/// The keeper executable's file name.
pub const KEEPER_EXE: &str = "centralu-keeper";

/// Set by a debug window on the keeper it starts: run the keeper in the window's executable, do not
/// `exec` the `centralu-keeper` next to it. Removed again before the keeper starts anything.
pub const IN_PROCESS_ENV: &str = "CC_KEEPER_IN_PROCESS";

/**
 * How a keeper is started: its arguments, the environment it gets on top of the starter's, and
 * where its output goes. The window (`sidecar.rs`, the direct start) and the shell (thin-shell plan
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
    /// Run the keeper in the window's executable rather than `exec` the one beside it (`IN_PROCESS_ENV`).
    pub in_process: bool,
}

impl Start {
    /// `--keeper` comes first so the same command line works for `centralu-keeper` (which ignores it)
    /// and for the window's executable (which turns into the keeper on seeing it).
    pub fn args(&self) -> Vec<String> {
        let mut args = vec![super::KEEPER_FLAG.to_string(), "--data-dir".into(), self.data_dir.to_string_lossy().to_string()];
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
        self.data_dir.join("keeper.log")
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

/// What to start as the keeper, given the window's own executable: the keeper next to it when
/// there is one, else the window's executable itself (`--keeper` then runs the keeper in it).
pub fn to_start(window_exe: &Path) -> PathBuf {
    let keeper = beside(window_exe);
    if keeper.is_file() {
        keeper
    } else {
        window_exe.to_path_buf()
    }
}

/// What `centralu --keeper` should `exec`, if anything: the keeper next to it, unless asked to run
/// in-process or there is none (or this already is it).
pub fn exec_target(window_exe: &Path, in_process: bool) -> Option<PathBuf> {
    if in_process {
        return None;
    }
    Some(to_start(window_exe)).filter(|k| k != window_exe)
}

/// The descriptor a handoff passes (`--take-over-fd N`), if the arguments name one.
fn take_over_fd(args: &[String]) -> Option<i32> {
    let i = args.iter().position(|a| a == "--take-over-fd")?;
    args.get(i + 1)?.parse().ok()
}

/**
 * Replaces this process with `keeper`, passing `args` after the program name unchanged. Returns
 * only when the `exec` failed.
 *
 * The handoff channel must survive the `exec`. The outgoing keeper already cleared its
 * close-on-exec flag when it put it at descriptor 3 (`handoff::spawn_successor`); it is cleared
 * again here so that nothing the window's executable loaded before `main` can have set it.
 */
pub fn exec(keeper: &Path, args: &[String]) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    if let Some(fd) = take_over_fd(args) {
        // SAFETY: fcntl on a descriptor number only changes its flags; a number that is not open
        // fails with EBADF, and the incoming keeper then reports the missing channel itself.
        unsafe {
            let fl = libc::fcntl(fd, libc::F_GETFD);
            if fl != -1 {
                libc::fcntl(fd, libc::F_SETFD, fl & !libc::FD_CLOEXEC);
            }
        }
    }
    std::process::Command::new(keeper).args(args.iter().skip(1)).exec()
}

/**
 * `centralu --keeper ...`: becomes the keeper next to this executable, or, with none there, runs
 * the keeper in this process. Returns the exit code of an in-process keeper.
 */
pub fn run_from_window(args: &[String]) -> i32 {
    let in_process = std::env::var_os(IN_PROCESS_ENV).is_some();
    // Not passed on to the host and its children, nor to the next keeper of a handoff.
    std::env::remove_var(IN_PROCESS_ENV);
    if let Ok(me) = std::env::current_exe() {
        if let Some(keeper) = exec_target(&me, in_process) {
            let err = exec(&keeper, args);
            eprintln!("[keeper] could not start {} ({err}); running the keeper in {}", keeper.display(), me.display());
        }
    }
    super::server::run(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cc-keeper-exe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The command line every keeper start has used since #280, now written in one place for the
    /// window and the shell. `server::parse_args` reads it back.
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
            ["--keeper", "--data-dir", "/d ata", "--host-source", "/c/0.1.0/host", "--bundle-path", "/Applications/Centralu.app", "--app-version", "0.1.0"]
        );
        assert!(start.env().is_empty(), "a release start adds nothing to the environment");
        assert_eq!(start.log_path(), PathBuf::from("/d ata/keeper.log"));
        let mut argv = vec!["centralu-keeper".to_string()];
        argv.extend(start.args());
        let o = super::super::server::parse_args(&argv);
        assert_eq!(o.data_dir.as_deref(), Some(Path::new("/d ata")));
        assert_eq!(o.bundle_path.as_deref(), Some("/Applications/Centralu.app"));
        assert_eq!(o.app_version.as_deref(), Some("0.1.0"));

        let dev = Start { host_source: None, bundle_path: None, dev: true, in_process: true, ..start };
        assert_eq!(dev.args(), ["--keeper", "--data-dir", "/d ata", "--app-version", "0.1.0"]);
        assert_eq!(dev.env(), [("CC_DEV".to_string(), "1".to_string()), (IN_PROCESS_ENV.to_string(), "1".to_string())]);
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
    fn the_keeper_next_to_the_window_is_started_when_it_is_there() {
        let d = temp("present");
        let window = d.join("centralu");
        std::fs::write(&window, "w").unwrap();
        assert_eq!(to_start(&window), window, "no keeper beside it: the window's own executable");
        assert_eq!(exec_target(&window, false), None, "and `--keeper` runs the keeper in it");
        std::fs::write(d.join(KEEPER_EXE), "k").unwrap();
        assert_eq!(to_start(&window), d.join(KEEPER_EXE));
        assert_eq!(exec_target(&window, false), Some(d.join(KEEPER_EXE)));
        assert_eq!(exec_target(&d.join(KEEPER_EXE), false), None, "the keeper never execs itself");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `tauri dev` relinks only the window; a keeper from an earlier `cargo build` is older code.
    #[test]
    fn a_debug_window_keeps_the_keeper_in_its_own_executable() {
        let d = temp("inproc");
        let window = d.join("centralu");
        std::fs::write(&window, "w").unwrap();
        std::fs::write(d.join(KEEPER_EXE), "k").unwrap();
        assert_eq!(exec_target(&window, true), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_handoff_descriptor_is_read_from_the_arguments() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(take_over_fd(&args(&["centralu", "--keeper", "--take-over-fd", "3", "--data-dir", "/d"])), Some(3));
        assert_eq!(take_over_fd(&args(&["centralu", "--keeper", "--data-dir", "/d"])), None);
    }

    /// The child half of `exec_keeps_the_arguments_and_the_handoff_descriptor`: run in a process of
    /// its own (the test binary started again), it execs into the stand-in keeper the parent names.
    #[test]
    fn exec_child() {
        let Ok(target) = std::env::var("CC_TEST_EXEC_TARGET") else { return };
        // As if something loaded before `main` had marked the channel close-on-exec.
        unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) };
        let args: Vec<String> = ["centralu", "--keeper", "--take-over-fd", "3", "--data-dir", "/some dir"].iter().map(|s| s.to_string()).collect();
        let err = exec(Path::new(&target), &args);
        panic!("exec failed: {err}");
    }

    /**
     * What an installed beta.11 keeper relies on: it starts the new build's window executable as
     * `centralu --keeper --take-over-fd 3 ...` with the handoff channel at descriptor 3, and that
     * process has to become the keeper with the same arguments and the channel still open.
     */
    #[test]
    fn exec_keeps_the_arguments_and_the_handoff_descriptor() {
        let d = temp("exec");
        let keeper = d.join(KEEPER_EXE);
        // A stand-in keeper: writes its arguments down the channel at descriptor 3.
        std::fs::write(&keeper, "#!/bin/sh\nprintf '%s|' \"$@\" >&3\n").unwrap();
        std::fs::set_permissions(&keeper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (mut ours, theirs) = UnixStream::pair().unwrap();
        let fd = theirs.as_raw_fd();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "keeper::exe::tests::exec_child", "--test-threads", "1", "--nocapture"])
            .env("CC_TEST_EXEC_TARGET", &keeper)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
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
        let mut child = cmd.spawn().unwrap();
        drop(theirs);
        ours.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut got = String::new();
        let _ = ours.read_to_string(&mut got);
        let status = child.wait().unwrap();
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(got, "--keeper|--take-over-fd|3|--data-dir|/some dir|", "the keeper got the channel and every argument");
        assert!(status.success(), "the stand-in keeper exited cleanly: {status}");
    }
}
