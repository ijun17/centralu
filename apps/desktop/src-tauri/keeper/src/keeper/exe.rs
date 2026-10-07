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
