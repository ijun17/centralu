//! Helpers the tests of this crate, the app and the shell share (`test-support` feature outside this
//! crate's own tests).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A new, empty folder `/tmp/cc-<tag>-<pid>-<n>`. `/tmp` and not `std::env::temp_dir()`: a unix
/// socket path must fit in 104 bytes, and macOS's temp folder is half of that already. It is not
/// removed; `TempDir` is.
pub fn temp_path(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = PathBuf::from(format!("/tmp/cc-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// `temp_path`, removed when dropped.
pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn temp_dir(tag: &str) -> TempDir {
    TempDir(temp_path(tag))
}
