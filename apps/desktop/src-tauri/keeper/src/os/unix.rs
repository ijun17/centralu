//! What macOS and Linux share: the system calls the keeper and the host supervisor need that `std`
//! does not offer. A lock the OS releases when its holder dies, a new session, the creation mask and
//! who is on the other end of a socket (here); the host process's group, signals and the login
//! shell probe (below); the children the keeper holds (`children`); descriptor passing for a
//! handoff (`handles`). What differs between the two is in `macos.rs` and `linux.rs`.

pub mod children;
pub mod handles;

use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;

pub use super::this_unix::peer_uid;

/// Every descriptor above stderr this process has open, except those in `keep`: what it inherited,
/// when it is asked before it opens anything of its own. `/dev/fd` lists them on macOS and Linux
/// (there a link to `/proc/self/fd`); the listing's own descriptor is gone once it is read.
pub fn inherited_descriptors(keep: &[i32]) -> Vec<i32> {
    let Ok(dir) = std::fs::read_dir("/dev/fd") else { return Vec::new() };
    let listed: Vec<i32> = dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect();
    listed
        .into_iter()
        // The listing's own descriptor is closed by now and answers EBADF
        .filter(|&fd| fd > 2 && !keep.contains(&fd) && unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1)
        .collect()
}

/// Closes every descriptor `inherited_descriptors` names. Only for the start of a process, before any
/// thread or library holds a descriptor of its own (lesson FI4: an AppImage's keep-alive pipe and
/// mount descriptor, which keep it mounted for as long as anything holds them).
pub fn close_inherited(keep: &[i32]) -> Vec<i32> {
    let fds = inherited_descriptors(keep);
    for &fd in &fds {
        // SAFETY: closing a descriptor nothing in this process owns yet.
        unsafe { libc::close(fd) };
    }
    fds
}

/// Takes an exclusive `flock` without waiting. `Ok(false)` means someone else holds it.
///
/// `flock` and not a pid file: the kernel drops the lock however the holder ends (SIGKILL, a
/// crash, a power cut leaves no process to hold it), so a dead keeper never leaves a lock that
/// has to be judged stale — the same reasoning as the host's SQLite ownership lock (#278).
pub fn try_lock(file: &File) -> io::Result<bool> {
    // SAFETY: a plain syscall on a descriptor this File owns.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let err = io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(err)
    }
}

/// Starts the child in a session of its own (`setsid`), outside the launching app's session and
/// process group. Quitting the app, or a terminal's Ctrl-C reaching the app's group, then sends
/// the keeper nothing.
pub fn new_session(cmd: &mut Command) {
    // SAFETY: setsid is async-signal-safe, which is all pre_exec requires.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Runs `f` with the creation mask set to `mask`, so a socket is born with its final permissions
/// instead of passing through a window where another user could connect before a chmod.
/// Only called while the keeper is still single-threaded.
pub fn with_umask<T>(mask: libc::mode_t, f: impl FnOnce() -> T) -> T {
    // SAFETY: umask cannot fail.
    let old = unsafe { libc::umask(mask) };
    let out = f();
    unsafe { libc::umask(old) };
    out
}

pub fn my_uid() -> u32 {
    // SAFETY: getuid cannot fail.
    unsafe { libc::getuid() as u32 }
}

/// Whether the process on the other end of `stream` runs as this user. Every keeper socket refuses
/// everyone else (lessons LK8). The error describes who it was, for the log.
pub fn peer_is_this_user(stream: &UnixStream) -> Result<(), String> {
    same_user(peer_uid(stream), my_uid())
}

fn same_user(peer: io::Result<u32>, me: u32) -> Result<(), String> {
    match peer {
        Ok(uid) if uid == me => Ok(()),
        other => Err(format!("{other:?}")),
    }
}

// ---- The host process (`host_proc`): how it is started, signalled and stopped.

/// On unix stdin is kept open until the end, so EOF does not race the signal into a second
/// `shutdown()` (`host_proc::stop_pid_gracefully`).
pub const CLOSE_STDIN_TO_STOP: bool = false;

/// Whether a `.bin/` sh script can be started as a program (it can: the kernel reads its `#!`).
pub const RUNS_SH_SCRIPTS: bool = true;

/// A group of its own, led by the host (`host_proc::spawn_host`).
pub fn own_group(cmd: &mut Command) {
    cmd.process_group(0);
}

/// A no-op off Windows.
pub fn hide_console(cmd: &mut Command) {
    let _ = cmd;
}

/// Whether a process exists and is not a zombie waiting for someone else to reap it.
///
/// `kill(pid, 0)` alone succeeds on a zombie. A host handed over by the previous keeper is that
/// keeper's child, not ours: when it died before that keeper reaped it, signal 0 kept saying it
/// ran, so it was never seen as exited (no restart) and `Foreign::wait` sat out its 10 s.
pub fn pid_alive(pid: u32) -> bool {
    let Some(target) = i32::try_from(pid).ok().filter(|&p| p > 0) else { return false };
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(target, 0) };
    let exists = rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    exists && !super::this_unix::is_zombie(pid)
}

/// Whether the group a host led may still be signalled once the host itself has ended.
///
/// The number is safe while it is pinned: by a member still in the group, or by the leader's own
/// zombie. Once every member is gone it may be handed out again, and the new owner of that pid,
/// leading a group of its own, would get our TERM. The original leader has ended, so a live,
/// non-zombie process under that pid is someone else: the group is then left alone. (A group of
/// members only, with no process under the leader's pid, cannot be told from a free number
/// without asking each process, and is still signalled: that is the orphan sweep this is for.)
pub fn group_signal_after_exit_is_safe(pid: u32) -> bool {
    !pid_alive(pid)
}

/// SIGTERM to the single host process only — children (codex, etc.) are cleaned up by the
/// host itself via EOF (#57).
pub fn kill_pid(pid: u32) {
    if let Some(pid) = signal_target(pid) {
        // SAFETY: a plain syscall to one positive pid.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}

/**
 * The pid or process group number a signal may be sent to, or None for the numbers that mean
 * something else to `kill(2)`: 0 (the caller's own group), 1 (as a group, `-1` is every process
 * the user may signal) and anything that does not fit a positive `pid_t` (it would turn negative).
 */
pub fn signal_target(pid: u32) -> Option<i32> {
    i32::try_from(pid).ok().filter(|&p| p > 1)
}

/**
 * SIGTERM to the process group `pid` leads (`spawn_host` made the group number the host's pid),
 * never to the caller's own group.
 *
 * `kill(2)` with the number negated, not `/bin/kill -TERM -<pid>` as before (#350). procps-ng
 * 4.0.4's `kill` (Ubuntu 24.04) reads a `-<pid>` that follows a signal option as more options and
 * signals the group named by **its first digit**: `-12345` became `kill(-1, SIGTERM)`, every
 * process the user may signal, and `-40000` became group 4. macOS's `kill` reads it as a group,
 * which is why only Linux ever saw it (docs/spikes/2026-10-linux-keeper.md).
 */
pub fn kill_group(pid: u32) {
    let Some(pgid) = signal_target(pid) else { return };
    // SAFETY: getpgrp takes no arguments.
    if pgid == unsafe { libc::getpgrp() } {
        return;
    }
    // SAFETY: a plain syscall; a negative pid is the group, and `signal_target` ruled out 0 and 1.
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
}

/// Asks the login shell where node is. It has to be interactive (-i) for .zshrc's nvm/mise
/// initialization to run.
///
/// Only the line carrying the marker is picked out, so it does not matter what else the shell
/// configuration prints.
pub fn probe_login_shell() -> Option<String> {
    use std::io::Read;
    use std::io::BufReader;
    use std::path::Path;
    use std::process::Stdio;
    use std::thread;
    use std::time::Duration;

    let shell = std::env::var("SHELL").ok()?;
    if !Path::new(&shell).exists() {
        return None;
    }

    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "command -p echo \"__CC_NODE__:$(command -v node)\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // So the shell's initialization script does not put up an interactive prompt.
        .env("TERM", "dumb")
        .env("CI", "1");
    // A session of its own, not only a group: its group is still its pid, which `kill_group`
    // below needs, and it has no controlling terminal. An interactive shell in a background group
    // of a terminal's session is stopped (SIGTTOU) when it sets up job control, so an app started
    // from a terminal (the npm launcher runs the AppImage attached to one) waited out the 5 s
    // below and fell back to the fixed paths. Measured in WSL2 Ubuntu 24.04: state `T` in a group
    // of its own, the answer in 0.04 s in a session of its own (docs/spikes/2026-10-linux-keeper.md).
    new_session(&mut cmd);

    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take()?;

    // **Getting stuck here would fail the whole app's launch.** Shell configurations really do
    // sometimes wait forever (waiting on prompt input, for example), so this cuts it off on a
    // timer and kills the whole group.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    super::parse_probe_output(&out)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_lock_on_the_same_file_is_refused_until_the_first_is_dropped() {
        let path = std::env::temp_dir().join(format!("cc-keeper-lock-test-{}", std::process::id()));
        let a = File::create(&path).unwrap();
        let b = File::options().write(true).open(&path).unwrap();
        assert!(try_lock(&a).unwrap(), "the first taker gets it");
        assert!(!try_lock(&b).unwrap(), "a second open file description is refused");
        drop(a);
        assert!(try_lock(&b).unwrap(), "released when the holder goes away");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_peer_of_our_own_socket_is_us() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), my_uid());
        assert_eq!(peer_is_this_user(&a), Ok(()));
    }

    /// LK8: a connection from another uid is refused, and so is one whose uid cannot be read.
    #[test]
    fn another_user_or_an_unknown_one_is_refused() {
        assert_eq!(same_user(Ok(501), 501), Ok(()));
        assert_eq!(same_user(Ok(0), 501), Err("Ok(0)".to_string()));
        assert!(same_user(Err(io::Error::other("no credentials")), 501).is_err());
    }

    /// SU7: a host the keeper did not start is watched by pid, and EPERM from `kill(pid, 0)` means
    /// alive. Pid 1 belongs to root: for anyone else, signal 0 to it is EPERM.
    #[test]
    fn a_process_we_may_not_signal_is_alive() {
        assert!(pid_alive(1), "pid 1 is always there");
        assert!(pid_alive(std::process::id()));
        let mut gone = Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        assert!(!pid_alive(pid), "a reaped child is gone");
    }

    /// A process that ended but is not reaped yet is not alive. `kill(pid, 0)` succeeds on a
    /// zombie, so a handed-over host that died before the keeper that started it reaped it was
    /// never seen as exited (`host_proc::handover::Foreign`). Here the test itself is the parent
    /// that has not reaped.
    #[test]
    fn a_zombie_is_not_alive() {
        let mut child = Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
        let pid = child.id();
        // Ended, not reaped: wait for the zombie without collecting it.
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: info is a valid out-pointer; WNOWAIT leaves the child to be reaped below.
        let rc = unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) };
        assert_eq!(rc, 0, "waitid: {}", io::Error::last_os_error());
        assert!(std::time::Instant::now() < end);
        // SAFETY: signal 0 only checks; the zombie is still there to answer it.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "the zombie is still there");
        let alive = pid_alive(pid);
        child.wait().unwrap();
        assert!(!alive, "a zombie counted as a running process");
    }

    /// ST8: what `new_session` starts leads a session of its own, so quitting the window (its
    /// session, its group, its terminal) sends it nothing. The keeper's start uses it
    /// (`keeper::client::spawn_detached`).
    #[test]
    fn a_new_session_is_led_by_the_child() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 5"]);
        new_session(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        // SAFETY: plain queries about a child we hold.
        let (sid, ours) = unsafe { (libc::getsid(pid), libc::getsid(0)) };
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(sid, pid, "the child leads its own session");
        assert_ne!(sid, ours);
    }
}
