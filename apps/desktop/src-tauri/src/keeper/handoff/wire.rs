//! The handoff channel's framing: a JSON header, raw byte blobs, and descriptors passed with
//! `SCM_RIGHTS`.
//!
//! One message is, in order on the stream:
//!
//! ```text
//! u32 BE  length of the header
//! bytes   {"h": <header>, "blobs": n, "fds": m}
//! n x     u64 BE length, then the bytes        (buffers: a child's unsent output, a pty's ring)
//! ceil(m/64) x  one byte `F` carrying up to 64 descriptors as SCM_RIGHTS ancillary data
//! ```
//!
//! Blobs are raw rather than inside the JSON because an agent's unsent stdout can be 64 MiB
//! (`children/buffer.rs`); base64 in a JSON string would double it and parse it twice. The
//! descriptors go last, each batch on a byte of its own, and the receiver reads everything before
//! them with exact-length reads: a plain `read` that swallowed the `F` byte would silently discard
//! the descriptors riding on it. The kernel caps descriptors per message (`SCM_MAX_FD`, 253 on
//! Linux), hence the batches.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::{json, Value};

/// The longest header accepted. A snapshot's header is a few kilobytes per child.
pub const MAX_HEADER: u32 = 16 * 1024 * 1024;
/// The longest blob accepted: an agent's stdout buffer is capped at 64 MiB (`LINES_CAP`), plus
/// its partial line.
pub const MAX_BLOB: u64 = 128 * 1024 * 1024;
const MAX_BLOBS: usize = 64 * 1024;
const MAX_FDS: usize = 16 * 1024;
const FDS_PER_BATCH: usize = 64;

pub struct Message {
    pub header: Value,
    pub blobs: Vec<Vec<u8>>,
    pub fds: Vec<OwnedFd>,
}

impl Message {
    pub fn op(&self) -> &str {
        self.header.get("op").and_then(Value::as_str).unwrap_or("")
    }
}

/// Sends one message. The descriptors stay open on our side: `SCM_RIGHTS` gives the receiver its
/// own copies.
pub fn send(s: &mut UnixStream, header: &Value, blobs: &[Vec<u8>], fds: &[RawFd]) -> io::Result<()> {
    let body = serde_json::to_vec(&json!({ "h": header, "blobs": blobs.len(), "fds": fds.len() }))?;
    if body.len() as u64 > MAX_HEADER as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "handoff header too large"));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    s.write_all(&out)?;
    for b in blobs {
        s.write_all(&(b.len() as u64).to_be_bytes())?;
        s.write_all(b)?;
    }
    for batch in fds.chunks(FDS_PER_BATCH) {
        send_fds(s, batch)?;
    }
    s.flush()
}

/// A message with a header only.
pub fn send_op(s: &mut UnixStream, header: &Value) -> io::Result<()> {
    send(s, header, &[], &[])
}

/// Receives one message, waiting at most `timeout` for each read.
pub fn recv(s: &mut UnixStream, timeout: Duration) -> io::Result<Message> {
    s.set_read_timeout(Some(timeout))?;
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len);
    if len > MAX_HEADER {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "handoff header too large"));
    }
    let mut body = vec![0u8; len as usize];
    s.read_exact(&mut body)?;
    let v: Value = serde_json::from_slice(&body)?;
    let blob_count = v.get("blobs").and_then(Value::as_u64).unwrap_or(0) as usize;
    let fd_count = v.get("fds").and_then(Value::as_u64).unwrap_or(0) as usize;
    if blob_count > MAX_BLOBS || fd_count > MAX_FDS {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too many blobs or descriptors"));
    }
    let mut blobs = Vec::with_capacity(blob_count);
    for _ in 0..blob_count {
        let mut n = [0u8; 8];
        s.read_exact(&mut n)?;
        let n = u64::from_be_bytes(n);
        if n > MAX_BLOB {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "handoff blob too large"));
        }
        let mut b = vec![0u8; n as usize];
        s.read_exact(&mut b)?;
        blobs.push(b);
    }
    let mut fds = Vec::with_capacity(fd_count);
    while fds.len() < fd_count {
        let want = (fd_count - fds.len()).min(FDS_PER_BATCH);
        let got = recv_fds(s, want)?;
        if got.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a descriptor batch arrived empty"));
        }
        fds.extend(got);
    }
    Ok(Message { header: v.get("h").cloned().unwrap_or(Value::Null), blobs, fds })
}

fn cmsg_space(n: usize) -> usize {
    // SAFETY: a pure size computation.
    unsafe { libc::CMSG_SPACE((n * std::mem::size_of::<RawFd>()) as libc::c_uint) as usize }
}

fn send_fds(s: &UnixStream, fds: &[RawFd]) -> io::Result<()> {
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
    loop {
        // SAFETY: msg is fully initialised above.
        let n = unsafe { libc::sendmsg(s.as_raw_fd(), &msg, 0) };
        if n == 1 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if n < 0 && e.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(if n < 0 { e } else { io::Error::new(io::ErrorKind::WriteZero, "sendmsg sent nothing") });
    }
}

fn recv_fds(s: &UnixStream, max: usize) -> io::Result<Vec<OwnedFd>> {
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
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
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
        // Not inherited by anything this keeper starts later (macOS has no MSG_CMSG_CLOEXEC).
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// A descriptor that arrives is a working copy of the one sent: bytes written into a pipe on
    /// one side come out of the copy on the other.
    #[test]
    fn a_message_carries_its_header_blobs_and_working_descriptors() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let mut pipes = Vec::new();
        for _ in 0..70 {
            // More than one batch of descriptors.
            let (r, w) = UnixStream::pair().unwrap();
            pipes.push((r, w));
        }
        let raw: Vec<RawFd> = pipes.iter().map(|(r, _)| r.as_raw_fd()).collect();
        let big = vec![7u8; 3 * 1024 * 1024];
        let sender = std::thread::spawn(move || {
            send(&mut a, &json!({ "op": "state", "n": 70 }), &[b"partial".to_vec(), big], &raw).unwrap();
            (a, pipes)
        });
        let m = recv(&mut b, Duration::from_secs(10)).unwrap();
        let (_a, pipes) = sender.join().unwrap();
        assert_eq!(m.op(), "state");
        assert_eq!(m.blobs[0], b"partial");
        assert_eq!(m.blobs[1].len(), 3 * 1024 * 1024);
        assert_eq!(m.fds.len(), 70);
        let (_, w) = &pipes[69];
        (&*w).write_all(b"hi").unwrap();
        let mut got = [0u8; 2];
        let mut copy = UnixStream::from(m.fds.into_iter().nth(69).unwrap());
        copy.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"hi");
    }

    #[test]
    fn a_closed_channel_is_an_error_not_a_hang() {
        let (a, mut b) = UnixStream::pair().unwrap();
        drop(a);
        assert!(recv(&mut b, Duration::from_secs(2)).is_err());
    }
}
