//! What Linux does differently from macOS: the peer of a socket by `SO_PEERCRED`, a child's exit by
//! a `pidfd` (and a zombie's status from `/proc`), and descriptors received with
//! `MSG_CMSG_CLOEXEC`.

use std::collections::HashMap;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

use super::children::{parse_proc_exit, set_cloexec, ExitStatus, Seen, Watch};

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

/// A `pidfd` per child, readable once it exits (`ExitWatch`).
pub struct ExitBackend {
    pidfds: HashMap<i32, OwnedFd>,
}

impl ExitBackend {
    pub fn new() -> io::Result<Self> {
        Ok(ExitBackend { pidfds: HashMap::new() })
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
        self.pidfds.insert(pid, unsafe { OwnedFd::from_raw_fd(fd) });
        Watch::Registered
    }

    pub fn fds(&self) -> Vec<RawFd> {
        self.pidfds.values().map(|f| f.as_raw_fd()).collect()
    }

    /// Every watched child: a pidfd says that something happened, not what, so each is checked.
    pub fn seen(&mut self) -> Vec<Seen> {
        self.pidfds.keys().map(|&pid| Seen { pid, exited: None }).collect()
    }

    /// Whether the child's pidfd reports it gone (readable), without waiting.
    pub fn gone(&self, pid: i32) -> bool {
        let Some(fd) = self.pidfds.get(&pid) else { return true };
        let mut p = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd, no wait.
        unsafe { libc::poll(&mut p, 1, 0) == 1 }
    }

    pub fn forget(&mut self, pid: i32) {
        self.pidfds.remove(&pid);
    }

    /// A zombie's exit status from `/proc/<pid>/stat`, while the zombie is still there.
    pub fn zombie_status(pid: i32) -> Option<ExitStatus> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        parse_proc_exit(&stat)
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

/// Every process id the system has now, whoever owns it (the numeric names in `/proc`). Used to
/// find the members of a session (`children::signal_session`), which no call lists directly.
pub fn all_pids() -> Vec<i32> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok()).filter(|&p| p > 0).collect()
}

/// The state letter of a `/proc/<pid>/stat` line: the first field after the command name, which is
/// in parentheses and may itself hold spaces and parentheses.
fn proc_state(stat: &str) -> Option<char> {
    stat.rsplit_once(')')?.1.trim_start().chars().next()
}
