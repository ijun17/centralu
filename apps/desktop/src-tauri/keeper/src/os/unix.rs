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

pub use super::this_unix::{peer_pid, peer_uid};

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

/// The soft descriptor limit the keeper asks for: macOS's `OPEN_MAX`, which `setrlimit` there
/// refuses to go past even when the hard limit is unlimited.
pub const DESCRIPTOR_LIMIT: u64 = 10_240;

/**
 * Raises this process's soft descriptor limit to `DESCRIPTOR_LIMIT`, or to the hard limit when that
 * is lower; never lowers it. Returns the limit before and after when it changed.
 *
 * A keeper started from Finder or launchd gets a soft limit of 256, and every relay through the
 * front door holds four descriptors, every attached child stream more: a few dozen clients were
 * enough to run out, and with it every accept and spawn failed (#840 item 3). What the keeper
 * starts gets the limit it had before back (`original_descriptor_limit`): a program that still uses
 * `select` cannot take a descriptor at or past `FD_SETSIZE` (1,024), which a limit of 10,240 would
 * let it be given.
 */
pub fn raise_descriptor_limit() -> Option<(u64, u64)> {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: a valid out-pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return None;
    }
    let before = lim.rlim_cur;
    let want = DESCRIPTOR_LIMIT.min(lim.rlim_max);
    if want <= before {
        return None;
    }
    let raised = libc::rlimit { rlim_cur: want as libc::rlim_t, rlim_max: lim.rlim_max };
    // SAFETY: a valid pointer to an rlimit.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } != 0 {
        return None;
    }
    ORIGINAL_DESCRIPTOR_LIMIT.store(before, std::sync::atomic::Ordering::SeqCst);
    Some((before, want))
}

/// The soft descriptor limit this process had before `raise_descriptor_limit`; 0 while it has not
/// raised it.
static ORIGINAL_DESCRIPTOR_LIMIT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/**
 * Has `cmd` start with the soft descriptor limit this process had before it raised its own: the
 * keeper's children (hosts, agents, terminals and commands) see the limit they would have had
 * without it. Nothing changes when the limit was never raised. The hard limit is left as it is.
 */
pub fn original_descriptor_limit(cmd: &mut Command) {
    let original = ORIGINAL_DESCRIPTOR_LIMIT.load(std::sync::atomic::Ordering::SeqCst);
    if original == 0 {
        return;
    }
    // SAFETY: getrlimit and setrlimit are plain syscalls, async-signal-safe, which is all
    // pre_exec requires; the closure allocates nothing.
    unsafe {
        cmd.pre_exec(move || {
            let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 && lim.rlim_cur > original {
                lim.rlim_cur = original;
                libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
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

/// The process group of `pid`, or None when it cannot be read: the process is gone, or is in
/// another session where the OS does not say (macOS refuses `getpgid` across sessions).
pub fn process_group(pid: u32) -> Option<u32> {
    let target = i32::try_from(pid).ok().filter(|&p| p > 0)?;
    // SAFETY: a plain syscall.
    let pgid = unsafe { libc::getpgid(target) };
    u32::try_from(pgid).ok().filter(|&g| g > 0)
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

/// Whether a process exists and is not a zombie waiting for someone else to reap it: whether it
/// *runs*. Not whether its number is taken, which a zombie still does (`children::number_in_use`,
/// the question before signalling a group by a number that may be reused).
///
/// `kill(pid, 0)` alone succeeds on a zombie. A host handed over by the previous keeper is that
/// keeper's child, not ours: when it died before that keeper reaped it, signal 0 kept saying it
/// ran, so it was never seen as exited (no restart) and `Foreign::wait` sat out its 10 s.
///
/// The state is read before `kill` asks whether the pid exists, never after (#546). The other
/// order took a zombie reaped between the two calls for a running process: `kill` found the
/// zombie, then its state could no longer be read, so it was not a zombie. Once a process has
/// ended, its state reads as a zombie or not at all, and a pid whose state is gone is gone for
/// `kill` too, so the answer cannot turn from "ended" back to "alive".
pub fn pid_alive(pid: u32) -> bool {
    let Some(target) = i32::try_from(pid).ok().filter(|&p| p > 0) else { return false };
    if super::this_unix::is_zombie(pid) {
        return false;
    }
    // SAFETY: signal 0 only checks.
    let rc = unsafe { libc::kill(target, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
    let _ = signal_pid(pid, libc::SIGTERM);
}

/**
 * Sends `signal` to the one process `pid`. Refused (`InvalidInput`) for a number `kill(2)` reads as
 * something other than one process (`signal_target`). The one way the keeper signals a single
 * process: the host, a handed-over host, a child it holds (#840 item 13, which found four signal
 * helpers, each with guards of its own).
 */
pub fn signal_pid(pid: u32, signal: libc::c_int) -> io::Result<()> {
    let Some(target) = signal_target(pid) else { return Err(refused(pid)) };
    // SAFETY: a plain syscall to one positive pid.
    if unsafe { libc::kill(target, signal) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/**
 * Sends `signal` to the process group `pgid`, under `signal_pid`'s rule and never to the caller's own
 * group. The one way the keeper signals a group: a host's, a child's, a terminal session's.
 */
pub fn signal_group(pgid: u32, signal: libc::c_int) -> io::Result<()> {
    let Some(target) = signal_target(pgid) else { return Err(refused(pgid)) };
    // SAFETY: getpgrp takes no arguments.
    if target == unsafe { libc::getpgrp() } {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to signal the keeper's own process group"));
    }
    // SAFETY: a plain syscall; a negative pid is the group, and `signal_target` ruled out 0 and 1.
    if unsafe { libc::kill(-target, signal) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn refused(pid: u32) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("refusing to signal pid {pid}: it names more than one process"))
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
    let _ = signal_group(pid, libc::SIGTERM);
}

/// SIGKILL to the process group `pid` leads, under `kill_group`'s rules: for a host that ignored
/// TERM and its grace (#840 item 1). Only while the host is still held unreaped, so its number is
/// still its group's.
pub fn kill_group_now(pid: u32) {
    let _ = signal_group(pid, libc::SIGKILL);
}

/// `N` bytes from the system's random source (`/dev/urandom`).
pub fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    use std::io::Read;
    let mut bytes = [0u8; N];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Asks the login shell where node is. It has to be interactive (-i) for .zshrc's nvm/mise
/// initialization to run.
///
/// Only the line carrying the marker is picked out, so it does not matter what else the shell
/// configuration prints.
pub fn probe_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    probe_shell(&shell, PROBE_TIMEOUT)
}

/// How long the login shell gets to answer before the fixed paths are used (lessons PA2).
///
/// Longer than the host's 3 s (`PROBE_TIMEOUT_MS` in `agent-host/src/env-path.ts`) on purpose. Both
/// return as soon as the marked line arrives, so the bound only costs time with a shell that never
/// answers. What a miss costs differs: the host falls back to the fixed folders and at worst misses
/// an agent tool, but the keeper without the shell's answer seldom finds an nvm or mise Node in its
/// fixed paths, and then no host starts at all. A slow configuration (a framework plus a version
/// manager, on a cold disk) gets the extra time here, where it matters.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// `probe_login_shell` with the shell and the bound given, so a test can hand it a shell that hangs
/// or stops itself.
pub fn probe_shell(shell: &str, timeout: std::time::Duration) -> Option<String> {
    use std::io::BufReader;
    use std::path::Path;
    use std::process::Stdio;
    use std::thread;

    if !Path::new(shell).exists() {
        return None;
    }

    let mut cmd = Command::new(shell);
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
    let deadline = std::time::Instant::now() + timeout;

    // **Getting stuck here would fail the whole app's launch.** Shell configurations really do
    // sometimes wait forever (waiting on prompt input, for example), so this cuts it off on a
    // timer and kills the whole group.
    //
    // The answer is the marked line, not the end of the output (#840 item 12): something the
    // configuration started in the background (an agent, a version manager's daemon) inherits
    // stdout and keeps it open after the shell has exited, and waiting for the end then sat out the
    // whole bound and fell back to the fixed paths with the answer already read. A reader still
    // blocked on such a pipe ends when that process lets go of it.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        use std::io::BufRead;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut found = None;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => {
                found = super::parse_probe_output(&line);
                if found.is_some() {
                    break;
                }
            }
            // The output ended: the shell said all it will
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                kill_group(pid);
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    // The shell exits right after the line it was asked for; one that does not is ended at the bound
    while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
        thread::sleep(std::time::Duration::from_millis(10));
    }
    if matches!(child.try_wait(), Ok(None)) {
        kill_group(pid);
        let _ = child.kill();
    }
    let _ = child.wait();
    found
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

    /// A shell of the test's own, as the probe would run it. Written by a `sh` child, never by this
    /// process: another test thread that forks while this one holds the file open for writing hands
    /// the descriptor on, and Linux then refuses to run the script (`ETXTBSY`, #503's `fake_node`).
    fn fake_shell(name: &str, body: &str) -> String {
        let dir = std::env::temp_dir().join(format!("cc-keeper-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name).to_string_lossy().to_string();
        let script = format!("#!/bin/sh\n{body}\n");
        let written = Command::new("/bin/sh")
            .args(["-c", "rm -f \"$2\" && printf '%s' \"$1\" > \"$2\" && chmod 755 \"$2\"", "sh", &script, &path])
            .status()
            .unwrap();
        assert!(written.success(), "could not write {path}");
        path
    }

    /// PA1: the node only the login shell knows is found, on any machine, CI included: the shell
    /// here answers whatever PATH the test runs with. What else a shell's configuration prints is
    /// ignored.
    #[test]
    fn the_node_the_login_shell_names_is_found_whatever_else_it_prints() {
        let node = fake_shell("node", "exit 0");
        let shell = fake_shell("knows-node", &format!("echo 'noise from a .zshrc'\necho \"__CC_NODE__:{node}\""));
        assert_eq!(probe_shell(&shell, PROBE_TIMEOUT), Some(node));
    }

    /// #840 item 12: the answer is the marked line, not the end of the output. A process the
    /// configuration left in the background holds stdout open after the shell has exited; waiting
    /// for the end sat out the bound and fell back to the fixed paths with the answer already read.
    #[test]
    fn the_answer_does_not_wait_for_a_background_process_holding_the_output() {
        let node = fake_shell("node-bg", "exit 0");
        let shell = fake_shell("leaves-a-job", &format!("echo \"__CC_NODE__:{node}\"\nsleep 4 &"));
        let began = std::time::Instant::now();
        assert_eq!(probe_shell(&shell, std::time::Duration::from_secs(2)), Some(node));
        assert!(began.elapsed() < std::time::Duration::from_secs(1), "{:?}", began.elapsed());
    }

    /// PA2: a shell that never answers is cut off at the bound, and its group with it.
    #[test]
    fn a_shell_that_never_answers_is_cut_off_at_the_bound() {
        let shell = fake_shell("hangs", "exec sleep 30");
        let began = std::time::Instant::now();
        assert_eq!(probe_shell(&shell, std::time::Duration::from_millis(300)), None);
        assert!(began.elapsed() < std::time::Duration::from_secs(3), "{:?}", began.elapsed());
    }

    /// PA2: an interactive shell sets up job control, and in a background group of a terminal's
    /// session it is stopped by SIGTTOU (measured under the npm launcher, #458). In a session of
    /// its own its group is orphaned and the kernel discards the stop: the shell answers at once.
    /// The shell here stops itself the way job control would.
    #[test]
    fn a_shell_that_job_control_would_stop_still_answers() {
        let node = fake_shell("node-ttou", "exit 0");
        let shell = fake_shell("ttou", &format!("kill -TTOU $$\necho \"__CC_NODE__:{node}\""));
        assert_eq!(probe_shell(&shell, std::time::Duration::from_secs(3)), Some(node));
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

    /// A process that has ended is never alive again, also while it is being reaped (#546). Here
    /// a zombie is reaped while `pid_alive` asks about it, at a different moment each round. When
    /// `kill(pid, 0)` came before the state, a zombie reaped between the two read as running: 1103
    /// of 3000 rounds on macOS, and on Linux the member of a reaped host's group read as gone,
    /// then as running, in `host_proc`'s test.
    #[test]
    fn a_zombie_reaped_while_it_is_checked_is_not_alive() {
        use std::sync::{Arc, Barrier};
        use std::time::{Duration, Instant};
        let rounds = 300;
        let mut alive_after_exit = 0;
        for round in 0..rounds {
            let mut child = Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
            let pid = child.id();
            // SAFETY: info is a valid out-pointer; WNOWAIT leaves the zombie for the reaper below.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) };
            assert_eq!(rc, 0, "waitid: {}", io::Error::last_os_error());
            let start = Arc::new(Barrier::new(2));
            let reaper = {
                let start = start.clone();
                // Spread the reaping over the checks below: 0 to 49 µs after they begin.
                let delay = Duration::from_micros(round % 50);
                std::thread::spawn(move || {
                    start.wait();
                    let from = Instant::now();
                    while from.elapsed() < delay {}
                    child.wait().unwrap();
                })
            };
            start.wait();
            if (0..40).any(|_| pid_alive(pid)) {
                alive_after_exit += 1;
            }
            reaper.join().unwrap();
        }
        assert_eq!(alive_after_exit, 0, "an ended process read as alive in {alive_after_exit} of {rounds} rounds");
    }
}
