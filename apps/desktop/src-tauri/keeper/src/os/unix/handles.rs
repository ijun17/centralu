//! Passing descriptors over a unix socket (`SCM_RIGHTS`): how a keeper hands every handle it holds
//! to the next one (lessons HD2, HD4). The message framing around it is `keeper::handoff::wire`.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

fn cmsg_space(n: usize) -> usize {
    // SAFETY: a pure size computation.
    unsafe { libc::CMSG_SPACE((n * std::mem::size_of::<RawFd>()) as libc::c_uint) as usize }
}

/// One batch of descriptors over a unix socket (`SCM_RIGHTS`), with a one-byte payload. When the
/// channel has no room for the control data, waits for the receiver up to `room_limit`, pausing at
/// most `max_pause` between tries (lessons HD2).
pub fn send_fds(s: &UnixStream, fds: &[RawFd], room_limit: Duration, max_pause: Duration) -> io::Result<()> {
    let mut byte = [b'F'];
    let mut iov = libc::iovec { iov_base: byte.as_mut_ptr() as *mut libc::c_void, iov_len: 1 };
    // u64-backed so the control buffer is aligned for cmsghdr.
    let mut control = vec![0u64; cmsg_space(fds.len()).div_ceil(8)];
    // SAFETY: zeroed is a valid msghdr; every pointer set below outlives the sendmsg call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = cmsg_space(fds.len()) as _;
    // SAFETY: the control buffer holds one cmsghdr with room for fds.len() descriptors.
    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN((fds.len() * std::mem::size_of::<RawFd>()) as libc::c_uint) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(cmsg) as *mut RawFd, fds.len());
    }
    // The payload is one byte, so a sendmsg that fails sent nothing, descriptors included: a retry
    // can neither send the `F` byte twice nor split a batch.
    let deadline = Instant::now() + room_limit;
    let mut pause = Duration::from_millis(1);
    loop {
        // SAFETY: msg is fully initialised above, and sendmsg does not modify it.
        let n = unsafe { libc::sendmsg(s.as_raw_fd(), &msg, 0) };
        if n == 1 {
            return Ok(());
        }
        if n >= 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "sendmsg sent nothing"));
        }
        let e = io::Error::last_os_error();
        match e.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::EMSGSIZE | libc::ENOBUFS | libc::EAGAIN) => {
                if Instant::now() >= deadline {
                    let secs = room_limit.as_secs();
                    return Err(io::Error::new(e.kind(), format!("no room for descriptors on the channel in {secs} s: {e}")));
                }
                wait_for_room(s, pause);
                pause = (pause * 2).min(max_pause);
            }
            _ => return Err(e),
        }
    }
}

/// Waits up to `pause` for the channel to report room, then `pause` more. `POLLOUT` only means
/// there is some room, not room for a batch's control data, so the sleep keeps a retry from
/// spinning while the receiver drains.
fn wait_for_room(s: &UnixStream, pause: Duration) {
    let mut p = libc::pollfd { fd: s.as_raw_fd(), events: libc::POLLOUT, revents: 0 };
    // SAFETY: one pollfd on a descriptor we hold. An error or a timeout just means retry.
    unsafe { libc::poll(&mut p, 1, pause.as_millis() as libc::c_int) };
    std::thread::sleep(pause);
}

/// Receives one batch of at most `max` descriptors. Each arrives close-on-exec, so nothing this
/// process starts later inherits it, and a batch the kernel truncated is an error (lessons HD4).
pub fn recv_fds(s: &UnixStream, max: usize) -> io::Result<Vec<OwnedFd>> {
    let mut byte = [0u8; 1];
    let mut iov = libc::iovec { iov_base: byte.as_mut_ptr() as *mut libc::c_void, iov_len: 1 };
    let space = cmsg_space(max);
    let mut control = vec![0u64; space.div_ceil(8)];
    // SAFETY: as in send_fds.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = space as _;
    let flags = crate::os::this_unix::RECV_FLAGS;
    let n = loop {
        // SAFETY: msg points at live buffers of the sizes given.
        let n = unsafe { libc::recvmsg(s.as_raw_fd(), &mut msg, flags) };
        if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        break n;
    };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the channel closed before the descriptors"));
    }
    let mut out = Vec::new();
    // SAFETY: walking the control buffer the kernel just filled, within msg_controllen.
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsg) as *const RawFd;
                let header = libc::CMSG_LEN(0) as usize;
                let count = ((*cmsg).cmsg_len as usize - header) / std::mem::size_of::<RawFd>();
                for i in 0..count {
                    let fd = std::ptr::read_unaligned(data.add(i));
                    out.push(OwnedFd::from_raw_fd(fd));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    for fd in &out {
        // Not inherited by anything this keeper starts later (only Linux has MSG_CMSG_CLOEXEC).
        // SAFETY: fcntl on a descriptor we own.
        unsafe {
            let fl = libc::fcntl(fd.as_raw_fd(), libc::F_GETFD);
            libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, fl | libc::FD_CLOEXEC);
        }
    }
    if msg.msg_flags & libc::MSG_CTRUNC != 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "descriptors were truncated in transit"));
    }
    Ok(out)
}
