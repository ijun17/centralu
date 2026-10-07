//! Collecting descriptors and buffers for a snapshot, and taking them back out on the other side.
//!
//! A snapshot names a descriptor or a blob by its index in the message (`wire.rs`). Packing a
//! descriptor **duplicates** it: the outgoing keeper keeps its own, so if the handoff is rolled
//! back nothing it was using has been closed or moved.

use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd, RawFd};

#[derive(Default)]
pub struct Pack {
    pub fds: Vec<OwnedFd>,
    pub blobs: Vec<Vec<u8>>,
}

impl Pack {
    /// A duplicate of `fd` (close-on-exec), and its index.
    pub fn fd(&mut self, fd: &impl AsFd) -> io::Result<usize> {
        self.fds.push(fd.as_fd().try_clone_to_owned()?);
        Ok(self.fds.len() - 1)
    }

    /// Takes an already owned descriptor (a duplicate made elsewhere).
    pub fn owned(&mut self, fd: OwnedFd) -> usize {
        self.fds.push(fd);
        self.fds.len() - 1
    }

    pub fn blob(&mut self, bytes: Vec<u8>) -> usize {
        self.blobs.push(bytes);
        self.blobs.len() - 1
    }

    /// Appends another pack, returning the offsets its indices move by (descriptors, blobs).
    pub fn absorb(&mut self, other: Pack) -> (usize, usize) {
        let at = (self.fds.len(), self.blobs.len());
        self.fds.extend(other.fds);
        self.blobs.extend(other.blobs);
        at
    }

    pub fn raw_fds(&self) -> Vec<RawFd> {
        self.fds.iter().map(|f| f.as_raw_fd()).collect()
    }
}

/// The receiving side: each index can be taken once.
pub struct Unpack {
    fds: Vec<Option<OwnedFd>>,
    blobs: Vec<Option<Vec<u8>>>,
}

impl Unpack {
    pub fn new(fds: Vec<OwnedFd>, blobs: Vec<Vec<u8>>) -> Unpack {
        Unpack { fds: fds.into_iter().map(Some).collect(), blobs: blobs.into_iter().map(Some).collect() }
    }

    pub fn fd(&mut self, i: usize) -> Result<OwnedFd, String> {
        self.fds.get_mut(i).and_then(Option::take).ok_or_else(|| format!("descriptor {i} is missing or used twice"))
    }

    pub fn blob(&mut self, i: usize) -> Result<Vec<u8>, String> {
        self.blobs.get_mut(i).and_then(Option::take).ok_or_else(|| format!("blob {i} is missing or used twice"))
    }

    /// A view onto a sub-snapshot packed with `Pack::absorb` at these offsets.
    pub fn shifted(&mut self, at: (usize, usize)) -> Shifted<'_> {
        Shifted { inner: self, at }
    }
}

/// Index translation for a part of the snapshot that was packed on its own and then absorbed.
pub struct Shifted<'a> {
    inner: &'a mut Unpack,
    at: (usize, usize),
}

impl Shifted<'_> {
    pub fn fd(&mut self, i: usize) -> Result<OwnedFd, String> {
        self.inner.fd(self.at.0 + i)
    }

    pub fn blob(&mut self, i: usize) -> Result<Vec<u8>, String> {
        self.inner.blob(self.at.1 + i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn packing_duplicates_so_the_original_stays_usable() {
        let (a, _b) = UnixStream::pair().unwrap();
        let mut p = Pack::default();
        let i = p.fd(&a).unwrap();
        assert_ne!(p.fds[i].as_raw_fd(), a.as_raw_fd());
        drop(p);
        assert!(a.peer_addr().is_ok(), "the original is still open after the pack is dropped");
    }

    #[test]
    fn an_absorbed_part_is_found_at_its_shifted_indices() {
        let mut outer = Pack::default();
        outer.blob(b"outer".to_vec());
        let mut part = Pack::default();
        let j = part.blob(b"part".to_vec());
        let at = outer.absorb(part);
        let mut u = Unpack::new(outer.fds, outer.blobs);
        assert_eq!(u.shifted(at).blob(j).unwrap(), b"part");
        assert!(u.blob(1).is_err(), "taken once only");
    }
}
