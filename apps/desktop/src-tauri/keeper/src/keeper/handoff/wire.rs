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
//!
//! A batch's `sendmsg` can fail for want of room rather than block. On macOS a `sendmsg` carrying
//! ancillary data on a stream socket returns `EMSGSIZE` at once when the send buffer
//! (`net.local.stream.sendspace`, 8 KiB) has less free space than the byte plus its control data,
//! which happens whenever the bytes before it nearly fill the buffer and the receiver has not
//! drained it yet; Linux blocks instead. So `EMSGSIZE`, `ENOBUFS` and `EAGAIN` on a batch mean
//! "wait for the receiver and try again", up to `FDS_ROOM_LIMIT`. A plain `write` never fails this
//! way, so the header and blobs need nothing of the kind. The failure depends on the exact number
//! of bytes before each batch, which is why the tests sweep sizes around the buffer's.

use std::io::{self, Read, Write};
use std::os::fd::{OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::{json, Value};

use crate::os::handles as os;

/// The longest header accepted. A snapshot's header is a few kilobytes per child.
pub const MAX_HEADER: u32 = 16 * 1024 * 1024;
/// The longest blob accepted: an agent's stdout buffer is capped at 64 MiB (`LINES_CAP`), plus
/// its partial line.
pub const MAX_BLOB: u64 = 128 * 1024 * 1024;
const MAX_BLOBS: usize = 64 * 1024;
const MAX_FDS: usize = 16 * 1024;
const FDS_PER_BATCH: usize = 64;
/// How long one descriptor batch may wait for room on the channel. The receiver is the incoming
/// keeper reading the state in a loop, so room appears within microseconds while it is alive, and
/// a receiver that died closes the channel, which fails the send at once (`EPIPE`). This bound only
/// ends the wait for a receiver that is alive but stuck: everything is frozen meanwhile, so rolling
/// back beats waiting forever. Generous so a loaded machine never rolls back a healthy handoff; the
/// same as the wait for `ready` (`READY_LIMIT`).
const FDS_ROOM_LIMIT: Duration = Duration::from_secs(30);
const MAX_ROOM_PAUSE: Duration = Duration::from_millis(20);

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
        os::send_fds(s, batch, FDS_ROOM_LIMIT, MAX_ROOM_PAUSE)?;
    }
    s.flush()
}

/// A message with a header only.
pub fn send_op(s: &mut UnixStream, header: &Value) -> io::Result<()> {
    send(s, header, &[], &[])
}

/// Receives one message, waiting at most `timeout` for each read.
pub fn recv(s: &mut UnixStream, timeout: Duration) -> io::Result<Message> {
    if let Err(e) = s.set_read_timeout(Some(timeout)) {
        // macOS refuses socket options (`EINVAL`) once the peer has closed, but what it sent
        // before closing is still there to read, and with the peer gone no read can block. The
        // outgoing keeper sends `commit` and exits at once, so this is the normal last message.
        if e.raw_os_error() != Some(libc::EINVAL) {
            return Err(e);
        }
    }
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
        let got = os::recv_fds(s, want)?;
        if got.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a descriptor batch arrived empty"));
        }
        fds.extend(got);
    }
    Ok(Message { header: v.get("h").cloned().unwrap_or(Value::Null), blobs, fds })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;

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

    fn sockopt(s: &UnixStream, name: libc::c_int) -> usize {
        let mut v: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: an int-sized option read into an int.
        let r = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, name, &mut v as *mut _ as *mut libc::c_void, &mut len) };
        assert_eq!(r, 0, "getsockopt: {}", io::Error::last_os_error());
        v as usize
    }

    /// Bytes waiting to be read on `s`.
    fn unread(s: &UnixStream) -> usize {
        let mut n: libc::c_int = 0;
        // SAFETY: FIONREAD writes one int.
        let r = unsafe { libc::ioctl(s.as_raw_fd(), libc::FIONREAD, &mut n) };
        assert_eq!(r, 0, "FIONREAD: {}", io::Error::last_os_error());
        n as usize
    }

    /// A channel whose send buffer is the size the bug lives at. macOS's default is 8 KiB
    /// (`net.local.stream.sendspace`) and is left alone; Linux's is hundreds of KiB, which would
    /// only make a sweep slow, so it is shrunk there (Linux doubles what it is asked for).
    fn channel() -> (UnixStream, UnixStream, usize) {
        let (a, b) = UnixStream::pair().unwrap();
        if sockopt(&a, libc::SO_SNDBUF) > 64 * 1024 {
            let v: libc::c_int = 8 * 1024;
            let len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            let p = &v as *const libc::c_int as *const libc::c_void;
            // SAFETY: int-sized options written from an int.
            unsafe {
                libc::setsockopt(a.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, p, len);
                libc::setsockopt(b.as_raw_fd(), libc::SOL_SOCKET, libc::SO_RCVBUF, p, len);
            }
        }
        let sndbuf = sockopt(&a, libc::SO_SNDBUF);
        (a, b, sndbuf)
    }

    /// A header and one blob that take exactly `prefix` bytes on the stream, or a bare header
    /// when `prefix` is shorter than that can be.
    fn filler(prefix: usize, fds: usize) -> (Value, Vec<Vec<u8>>) {
        let header = json!({ "op": "state" });
        let framed = |blobs: usize| 4 + serde_json::to_vec(&json!({ "h": header, "blobs": blobs, "fds": fds })).unwrap().len();
        let with_blob = framed(1) + 8;
        if prefix < with_blob {
            return (header, vec![]);
        }
        (header, vec![vec![b'x'; prefix - with_blob]])
    }

    /// Sends a message of `prefix` bytes before `n` descriptors over `channel()`, to a reader that
    /// starts only once the prefix has arrived (or `gate` has passed, when it cannot all fit) and
    /// the sender has then had `head_start` to try its first batch: the moment the buffer is
    /// fullest. A slow sender can only make this miss the bug, never fail a correct send.
    fn send_to_late_reader(prefix: usize, n: usize, gate: Duration, head_start: Duration) -> (io::Result<()>, io::Result<Message>) {
        let (mut a, mut b, _) = channel();
        let (keep, passed) = UnixStream::pair().unwrap();
        let raw = vec![passed.as_raw_fd(); n];
        let (header, blobs) = filler(prefix, n);
        let reader = std::thread::spawn(move || {
            let since = std::time::Instant::now();
            while unread(&b) < prefix && since.elapsed() < gate {
                std::thread::sleep(Duration::from_micros(200));
            }
            std::thread::sleep(head_start);
            recv(&mut b, Duration::from_secs(10))
        });
        let sent = send(&mut a, &header, &blobs, &raw);
        // A failed send closes the channel, so the reader fails rather than waits.
        drop(a);
        let got = reader.join().unwrap();
        drop((keep, passed));
        (sent, got)
    }

    fn assert_round_trip(prefix: usize, n: usize, sent: io::Result<()>, got: io::Result<Message>) {
        if let Err(e) = sent {
            panic!("{prefix} bytes before {n} descriptors: the send failed: {e}");
        }
        let m = got.unwrap_or_else(|e| panic!("{prefix} bytes before {n} descriptors: the receive failed: {e}"));
        assert_eq!(m.op(), "state");
        assert_eq!(m.fds.len(), n, "{prefix} bytes before the descriptors");
        for fd in &m.fds {
            // SAFETY: fstat into a zeroed struct, on a descriptor the message owns.
            let open = unsafe {
                let mut st: libc::stat = std::mem::zeroed();
                libc::fstat(fd.as_raw_fd(), &mut st) == 0
            };
            assert!(open, "{prefix} bytes before the descriptors: an arrived descriptor is not open");
        }
    }

    /// The owner's failed switch (2026-10-05): the header and blobs nearly filled the channel's
    /// buffer before the receiver drained it, and macOS answered the descriptor batch with
    /// `EMSGSIZE` ("Message too long") instead of blocking. The batch must wait for room.
    #[test]
    fn descriptors_wait_for_room_after_bytes_that_nearly_fill_the_buffer() {
        let (_, _, sndbuf) = channel();
        let prefix = sndbuf - 100;
        let (sent, got) = send_to_late_reader(prefix, FDS_PER_BATCH, Duration::from_secs(5), Duration::from_millis(50));
        assert_round_trip(prefix, FDS_PER_BATCH, sent, got);
    }

    /// The same at every size around the buffer's, so a boundary nobody has measured yet is
    /// caught without knowing its byte count: every 256 bytes up to three buffers, and each of the
    /// last few hundred bytes of the first. 150 descriptors are three batches, so the later
    /// batches meet a buffer the earlier ones filled.
    #[test]
    fn descriptors_arrive_whatever_the_bytes_before_them() {
        let (_, _, sndbuf) = channel();
        let mut sizes: Vec<usize> = (0..=3 * sndbuf).step_by(256).collect();
        sizes.extend((0..=320).step_by(8).map(|k| sndbuf - k));
        sizes.sort_unstable();
        sizes.dedup();
        for prefix in sizes {
            let (sent, got) = send_to_late_reader(prefix, 150, Duration::from_millis(10), Duration::from_millis(2));
            assert_round_trip(prefix, 150, sent, got);
        }
    }

    #[test]
    fn a_closed_channel_is_an_error_not_a_hang() {
        let (a, mut b) = UnixStream::pair().unwrap();
        drop(a);
        assert!(recv(&mut b, Duration::from_secs(2)).is_err());
    }

    /// The outgoing keeper sends `commit` and exits at once. The incoming keeper must still read
    /// it: macOS refuses the read timeout on a socket whose peer has closed (`EINVAL`), and a
    /// `commit` lost that way would make it take over without the exit statuses it carries.
    #[test]
    fn a_message_sent_just_before_the_peer_closed_is_still_read() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let (keep, passed) = UnixStream::pair().unwrap();
        send(&mut a, &json!({ "op": "commit" }), &[b"x".to_vec()], &[passed.as_raw_fd()]).unwrap();
        drop(a);
        let m = recv(&mut b, Duration::from_secs(2)).unwrap();
        assert_eq!(m.op(), "commit");
        assert_eq!(m.fds.len(), 1);
        drop((keep, passed));
    }
}
