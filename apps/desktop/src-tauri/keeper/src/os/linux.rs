//! What Linux does differently from macOS: the peer of a socket by `SO_PEERCRED`, a process's exit by
//! a `pidfd`, and descriptors received with
//! `MSG_CMSG_CLOEXEC`.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

use super::process::{set_cloexec, Watch};

/// Whether a window that starts its host itself can relaunch into an update just installed (#1895): its bundle is an app the update replaces, and the host it stops for the update is the one the relaunch starts again. Only macOS ships that.
pub const RELAUNCH_WITHOUT_KEEPER: bool = false;

/// Nothing to hear: the host asks systemd itself where there is one (#1397), and elsewhere nothing says who sent a stop
pub fn on_system_stop(_told: impl Fn() + Send + 'static) {}

/// Received descriptors are close-on-exec from the moment they exist.
pub const RECV_FLAGS: libc::c_int = libc::MSG_CMSG_CLOEXEC;

/// The uid of the process on the other end of a unix socket.
/// The pid of the process at the other end of a unix socket (`SO_PEERCRED`), as of its `connect`.
pub fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: cred and len are valid out-pointers of the size SO_PEERCRED writes.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(cred.pid).ok().filter(|&p| p > 0).ok_or_else(|| io::Error::other("the kernel named no peer process"))
}

pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: cred and len are valid out-pointers of the size SO_PEERCRED writes.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if rc == 0 {
        Ok(cred.uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// A `pidfd`, readable once the process exits (`ProcessWatch`).
pub struct ExitBackend {
    pidfd: Option<OwnedFd>,
}

impl ExitBackend {
    pub fn new() -> io::Result<Self> {
        Ok(ExitBackend { pidfd: None })
    }

    pub fn watch(&mut self, pid: i32) -> Watch {
        // SAFETY: pidfd_open(pid, 0) takes no pointers.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
        if fd < 0 {
            // Gone (ESRCH), or a kernel without pidfd_open (before 5.3) and anything else: polled
            return Watch::after_error(io::Error::last_os_error());
        }
        let _ = set_cloexec(fd);
        // SAFETY: the syscall just returned it.
        self.pidfd = Some(unsafe { OwnedFd::from_raw_fd(fd) });
        Watch::Registered
    }

    /// Whether the watched process's pidfd reports it gone (readable), without waiting.
    pub fn ended(&mut self, _pid: i32) -> bool {
        let Some(fd) = &self.pidfd else { return true };
        let mut p = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd, no wait.
        unsafe { libc::poll(&mut p, 1, 0) == 1 }
    }
}

/// Whether `pid` is a zombie: ended, and not yet gone (`/proc/<pid>/stat`'s state `Z`, or `X`).
/// `kill(pid, 0)` cannot tell, it succeeds on a zombie (`super::pid_alive`).
///
/// `X` (dead) is the moment between a parent's `wait` taking the zombie and the kernel removing
/// it: `kill(pid, 0)` still finds it then (#546). Counting only `Z`, a process being reaped read
/// as running in about 1 of 300 rounds of `a_zombie_reaped_while_it_is_checked_is_not_alive` on a
/// CI runner. (`x` is how kernels before 4.14 print it.)
pub fn is_zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .is_ok_and(|stat| matches!(proc_state(&stat), Some('Z' | 'X' | 'x')))
}

/// The state letter of a `/proc/<pid>/stat` line: the first field after the command name, which is
/// in parentheses and may itself hold spaces and parentheses.
fn proc_state(stat: &str) -> Option<char> {
    stat.rsplit_once(')')?.1.trim_start().chars().next()
}

/// The executable `pid` runs (#1405): `/proc/<pid>/exe`, which names the file the process was
/// started from, as the kernel recorded it.
pub fn exe_of_pid(pid: u32) -> io::Result<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
}

/// When `pid` started, in clock ticks since boot (`starttime`, field 22 of `/proc/<pid>/stat`, #2117): with the pid, it names
/// one process, since a pid is used again only by a process that started later.
pub fn process_started(pid: u32) -> io::Result<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    // The fields after the command name, which is in parentheses and may hold either: the state is field 3, the start 22
    let after = stat.rsplit_once(')').map(|(_, rest)| rest).ok_or_else(|| io::Error::other("no command name in stat"))?;
    after.split_whitespace().nth(19).and_then(|s| s.parse().ok()).ok_or_else(|| io::Error::other("no start time in stat"))
}

/// No code signatures to read here (#1405): a keeper here judges a window by its executable's name.
pub fn code_signature_display(_exe: &std::path::Path) -> Option<String> {
    None
}
