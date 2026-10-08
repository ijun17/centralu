//! What macOS does differently from Linux: the peer of a socket by `getpeereid`, a child's exit by
//! kqueue, and descriptors received without `MSG_CMSG_CLOEXEC` (each is set close-on-exec after).

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

use super::children::{set_cloexec, ExitStatus, Seen, Watch};

/// No flag makes `recvmsg` set close-on-exec here; `handles::recv_fds` sets it on each descriptor.
pub const RECV_FLAGS: libc::c_int = 0;

/// The uid of the process on the other end of a unix socket.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both out-pointers are valid for the duration of the call.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if rc == 0 {
        Ok(uid as u32)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// kqueue `EVFILT_PROC` with `NOTE_EXIT | NOTE_EXITSTATUS`: one queue for every child, the exit
/// status delivered with the event even to a process that is not the parent (`ExitWatch`).
pub struct ExitBackend {
    kq: OwnedFd,
}

impl ExitBackend {
    pub fn new() -> io::Result<Self> {
        // SAFETY: kqueue takes no arguments.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        set_cloexec(fd)?;
        // SAFETY: kqueue just returned it.
        Ok(ExitBackend { kq: unsafe { OwnedFd::from_raw_fd(fd) } })
    }

    pub fn watch(&mut self, pid: i32) -> Watch {
        let ev = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT | libc::NOTE_EXITSTATUS,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: one valid changelist entry, no event list.
        let rc = unsafe { libc::kevent(self.kq.as_raw_fd(), &ev, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
        if rc == 0 {
            Watch::Registered
        } else {
            // ESRCH: it is already gone.
            Watch::Gone
        }
    }

    pub fn fds(&self) -> Vec<RawFd> {
        vec![self.kq.as_raw_fd()]
    }

    /// Every exit event queued since the last call, with the status the event carries.
    pub fn seen(&mut self) -> Vec<Seen> {
        let mut out = Vec::new();
        loop {
            // SAFETY: kevent is plain data; zeroed is a valid value for it.
            let mut evs: [libc::kevent; 32] = unsafe { std::mem::zeroed() };
            let zero = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            // SAFETY: an event list of 32 valid entries, a zero timeout.
            let n = unsafe { libc::kevent(self.kq.as_raw_fd(), std::ptr::null(), 0, evs.as_mut_ptr(), 32, &zero) };
            if n <= 0 {
                break;
            }
            for ev in &evs[..n as usize] {
                if ev.filter != libc::EVFILT_PROC || ev.fflags & libc::NOTE_EXIT == 0 {
                    continue;
                }
                out.push(Seen { pid: ev.ident as i32, exited: Some(ExitStatus::from_wait_status(ev.data as i32)) });
            }
        }
        out
    }

    /// Every event carries its exit, so nothing is ever asked.
    pub fn gone(&self, _pid: i32) -> bool {
        true
    }

    /// The registration was one-shot: nothing to drop.
    pub fn forget(&mut self, _pid: i32) {}

    /// Not needed: the event carried the status.
    pub fn zombie_status(_pid: i32) -> Option<ExitStatus> {
        None
    }
}
