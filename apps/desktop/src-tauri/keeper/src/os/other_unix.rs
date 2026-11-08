//! A unix that is neither macOS nor Linux. Nothing ships for one; the keeper compiles there with
//! the fallbacks it always had: no peer credentials (every connection is refused).

use std::io;
use std::os::unix::net::UnixStream;

/// Whether a window that starts its host itself can relaunch into an update just installed (#1895): its bundle is an app the update replaces, and the host it stops for the update is the one the relaunch starts again. Only macOS ships that.
pub const RELAUNCH_WITHOUT_KEEPER: bool = false;

/// Nothing to hear: the host asks systemd itself where there is one (#1397), and elsewhere nothing says who sent a stop
pub fn on_system_stop(_told: impl Fn() + Send + 'static) {}

/// No portable way to ask: a zombie counts as alive here, as it always did.
pub fn is_zombie(_pid: u32) -> bool {
    false
}

pub fn peer_pid(_stream: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "peer credentials are not implemented here"))
}

pub fn peer_uid(_stream: &UnixStream) -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "peer credentials are not implemented here"))
}

pub fn exe_of_pid(_pid: u32) -> io::Result<std::path::PathBuf> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "a process's executable is not read here"))
}

pub fn process_started(_pid: u32) -> io::Result<u64> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "a process's start is not read here"))
}

/// No code signatures to read here (#1405): a keeper here judges a window by its executable's name.
pub fn code_signature_display(_exe: &std::path::Path) -> Option<String> {
    None
}
