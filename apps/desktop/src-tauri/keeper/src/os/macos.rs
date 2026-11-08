//! What macOS does differently from Linux: the peer of a socket by `getpeereid` and `LOCAL_PEERPID`, a process's
//! executable and start by `proc_pidinfo`, and launchd's stop.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

/// Whether a window that starts its host itself can relaunch into an update just installed (#1895): its bundle is an app the update replaces, and the host it stops for the update is the one the relaunch starts again. Only macOS ships that.
pub const RELAUNCH_WITHOUT_KEEPER: bool = true;

/// The write end of the pipe that takes the news of launchd's SIGTERM out of the handler (-1 until `on_system_stop`)
static STOP_PIPE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

/// Ends the process by the signal's default action, as it would have without a handler
fn die_by_term() {
    // SAFETY: both calls are async-signal-safe
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
        libc::raise(libc::SIGTERM);
    }
}

extern "C" fn on_term(_sig: libc::c_int, info: *mut libc::siginfo_t, _ctx: *mut libc::c_void) {
    // SAFETY: errno is this thread's; a handler leaves it as it found it
    let errno = unsafe { *libc::__error() };
    // SAFETY: the kernel gives a valid siginfo to a SA_SIGINFO handler; read and write are async-signal-safe
    let (from, fd) = unsafe { ((*info).si_pid, STOP_PIPE.load(std::sync::atomic::Ordering::Relaxed)) };
    if super::is_system_stop(from) && fd >= 0 {
        // A thread takes it from here: nothing that locks or allocates runs in a handler
        unsafe { libc::write(fd, b"1".as_ptr().cast(), 1) };
    } else {
        die_by_term()
    }
    // SAFETY: as above
    unsafe { *libc::__error() = errno };
}

/// Runs `told` when launchd stops this process (SIGTERM from pid 1, `is_system_stop`), and then ends the process as the signal
/// would have: the keeper and its host are stopped by the system together, and the host cannot tell that SIGTERM from the keeper's
/// own (#1970). A SIGTERM from any other process ends it at once, as before. Called once, with the keeper still single-threaded
pub fn on_system_stop(told: impl Fn() + Send + 'static) {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fds holds the two descriptors pipe writes
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let (read, write) = (fds[0], fds[1]);
    for fd in [read, write] {
        let _ = super::set_cloexec(fd);
    }
    // SAFETY: fcntl on a descriptor just made; a full pipe must not block the handler
    unsafe { libc::fcntl(write, libc::F_SETFL, libc::fcntl(write, libc::F_GETFL) | libc::O_NONBLOCK) };
    STOP_PIPE.store(write, std::sync::atomic::Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        // SAFETY: byte is valid for one byte
        while unsafe { libc::read(read, byte.as_mut_ptr().cast(), 1) } < 0 {}
        told();
        die_by_term()
    });
    // SAFETY: a zeroed sigaction with a handler and an empty mask is valid
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_term as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

/// The uid of the process on the other end of a unix socket.
/// `LOCAL_PEERPID` (sys/un.h): the pid of the process that connected, recorded at `connect`.
const LOCAL_PEERPID: libc::c_int = 0x002;
/// `SOL_LOCAL` (sys/un.h): the level of the local-socket options.
const SOL_LOCAL: libc::c_int = 0;

/// The pid of the process at the other end of a unix socket (`LOCAL_PEERPID`), as of its `connect`.
pub fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: pid and len are valid out-pointers of the size LOCAL_PEERPID writes.
    let rc = unsafe { libc::getsockopt(stream.as_raw_fd(), SOL_LOCAL, LOCAL_PEERPID, &mut pid as *mut libc::pid_t as *mut libc::c_void, &mut len) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(pid).ok().filter(|&p| p > 0).ok_or_else(|| io::Error::other("the kernel named no peer process"))
}

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

/// Whether `pid` is a zombie: ended, and not yet reaped by its parent (`p_stat` `SZOMB`, read with
/// `proc_pidinfo`). `kill(pid, 0)` cannot tell, it succeeds on a zombie (`super::pid_alive`).
pub fn is_zombie(pid: u32) -> bool {
    let Ok(pid) = libc::c_int::try_from(pid) else { return false };
    // SAFETY: proc_bsdinfo is plain data, for which all zeroes is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // A non-zero `arg` asks for zombies too: with 0 the call fails on one, and a zombie read as
    // "not a zombie" (measured on macOS 27).
    // SAFETY: the buffer is valid for `size` bytes for the duration of the call.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 1, &mut info as *mut _ as *mut libc::c_void, size) };
    n == size && info.pbi_status == libc::SZOMB
}

/// The executable `pid` runs (#1405), by `proc_pidpath`.
pub fn exe_of_pid(pid: u32) -> io::Result<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4 * 1024;
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let pid = libc::c_int::try_from(pid).map_err(|_| io::Error::other("pid out of range"))?;
    // SAFETY: buf is valid for writes of its length, which is what we pass.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(n as usize);
    Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(&buf)))
}

/// When `pid` started, in microseconds since the epoch (`pbi_start_tvsec`, `pbi_start_tvusec`, #2117): with the pid, it names
/// one process, since a pid is used again only by a process that started later.
pub fn process_started(pid: u32) -> io::Result<u64> {
    let pid = libc::c_int::try_from(pid).map_err(|_| io::Error::other("pid out of range"))?;
    // SAFETY: proc_bsdinfo is plain data, for which all zeroes is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is valid for `size` bytes for the duration of the call.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if n != size {
        return Err(io::Error::last_os_error());
    }
    Ok(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// What `codesign --display --verbose=2` says about `exe` (#1405, `window_peer::team_in` reads its
/// team): written to stderr. None when it could not be run.
pub fn code_signature_display(exe: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/codesign").arg("--display").arg("--verbose=2").arg(exe).output().ok()?;
    Some(String::from_utf8_lossy(&out.stderr).into_owned())
}
