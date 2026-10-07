//! The few system calls the keeper needs that `std` does not offer: a lock the OS releases when
//! its holder dies, a new session, the creation mask, and who is on the other end of a socket.

use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;

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

/// The uid of the process on the other end of a unix socket.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
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

#[cfg(target_os = "linux")]
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

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "linux")))]
pub fn peer_uid(_stream: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "peer credentials are not implemented here"))
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
    }
}
