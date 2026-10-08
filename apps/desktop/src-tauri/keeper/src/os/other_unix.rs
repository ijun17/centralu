//! A unix that is neither macOS nor Linux. Nothing ships for one; the keeper compiles there with
//! the fallbacks it always had: no peer credentials (every connection is refused) and exits found
//! by polling `waitpid`.

use std::io;
use std::os::fd::RawFd;
use std::os::unix::net::UnixStream;

use super::children::{ExitStatus, Seen, Watch};

pub const RECV_FLAGS: libc::c_int = 0;

pub fn peer_uid(_stream: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "peer credentials are not implemented here"))
}

pub struct ExitBackend;

impl ExitBackend {
    pub fn new() -> io::Result<Self> {
        Ok(ExitBackend)
    }

    pub fn watch(&mut self, _pid: i32) -> Watch {
        Watch::Poll
    }

    pub fn fds(&self) -> Vec<RawFd> {
        Vec::new()
    }

    pub fn seen(&mut self) -> Vec<Seen> {
        Vec::new()
    }

    pub fn gone(&self, _pid: i32) -> bool {
        true
    }

    pub fn forget(&mut self, _pid: i32) {}

    pub fn zombie_status(_pid: i32) -> Option<ExitStatus> {
        None
    }
}
