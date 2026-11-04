//! The system ending (a shutdown, restart or sign-out), told to the host (#1397, #1970).
//!
//! The host cannot hear it itself where it matters: on Windows only a process with a window gets `WM_QUERYENDSESSION` (Node ignores
//! `CTRL_SHUTDOWN_EVENT` outside services), and on macOS launchd's SIGTERM looks like the keeper's own. So the window, which hears
//! both, says it:
//!
//!   - Windows: the main window is subclassed, and the end-session question and its call-off become the host's
//!     `{"op":"system-ending"}` line (`end_session_message`). The host is the window's child (its stdin) or, with `serve --window`,
//!     the launcher's, which passes the line on to the host over its socket (`host.systemEnding`, serve-window.mjs);
//!   - macOS: `NSWorkspaceWillPowerOffNotification` (shutdown, restart and log out). The window writes the line itself in direct
//!     mode and asks the keeper to under one (`system_ending`); the keeper hears launchd's SIGTERM on its own
//!     (`os::on_system_stop`).
//!
//! The window's OS integration, not the runtime (`platform_checks.rs`).

#[cfg(unix)]
use super::Choice;
use super::Supervisor;
use centralu_keeper_core::host_proc::{SYSTEM_ENDING_CANCELLED_LINE, SYSTEM_ENDING_LINE, SYSTEM_ENDING_LOGOFF_LINE};
use tauri::AppHandle;

impl Supervisor {
    /// Tells the host the system is ending, or (`cancelled`) that it is not after all: its stdin in direct mode, through the keeper
    /// under one. Best effort: the system does not wait for it, and a host that is not up has nothing to be told
    pub fn system_ending(&self, what: EndSession) {
        #[cfg(unix)]
        if self.choice() == Choice::Keeper {
            if let Err(e) = self.link().and_then(|l| l.system_ending(what == EndSession::Cancelled)) {
                eprintln!("[system-ending] the keeper did not tell the host: {e}");
            }
            return;
        }
        if let Err(e) = self.direct.send_line(line_of(what)) {
            eprintln!("[system-ending] the host was not told: {e}");
        }
    }
}

/// The control line the host takes for a notice
fn line_of(what: EndSession) -> &'static str {
    match what {
        EndSession::Cancelled => SYSTEM_ENDING_CANCELLED_LINE,
        EndSession::Ending { logoff: true } => SYSTEM_ENDING_LOGOFF_LINE,
        EndSession::Ending { logoff: false } => SYSTEM_ENDING_LINE,
    }
}

/// What a window message says about the system ending
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EndSession {
    /// The system asks (or has decided) to end; `logoff`: only the user's session does (a sign-out)
    Ending { logoff: bool },
    /// What was asked was called off: another program refused it
    Cancelled,
}

const WM_QUERYENDSESSION: u32 = 0x0011;
const WM_ENDSESSION: u32 = 0x0016;
/// How long the confirmed end waits for the notice to be written before it lets the system go on
#[cfg_attr(not(windows), allow(dead_code))]
const CONFIRMED_END_WAIT: std::time::Duration = std::time::Duration::from_millis(500);
/// `lParam` of both: the Restart Manager closes this program to replace a file it holds, which is no end of the system
const ENDSESSION_CLOSEAPP: u32 = 0x1;
/// `lParam` of both: a sign-out, not a shutdown or a restart
const ENDSESSION_LOGOFF: u32 = 0x8000_0000;

/// Reads a window message: `WM_QUERYENDSESSION` is the question (the end may still be refused by another program), and
/// `WM_ENDSESSION` its outcome, with `wParam` FALSE when it was called off. A Restart Manager's request to close is neither
#[cfg_attr(not(windows), allow(dead_code))] // read by the Windows window procedure; tested everywhere
pub(crate) fn end_session_message(msg: u32, wparam: usize, lparam: isize) -> Option<EndSession> {
    // The flags are the low 32 bits; the upper half is whatever the platform extended them with
    let flags = lparam as u32;
    if !matches!(msg, WM_QUERYENDSESSION | WM_ENDSESSION) || flags & ENDSESSION_CLOSEAPP != 0 {
        return None;
    }
    // The question and a confirmed end both say it (the host keeps the first); only a refusal takes it back
    Some(if msg == WM_ENDSESSION && wparam == 0 { EndSession::Cancelled } else { EndSession::Ending { logoff: flags & ENDSESSION_LOGOFF != 0 } })
}

/// Tells the host on a thread of its own, in the order it was told: a write to a host that stopped reading, or a keeper that is slow to
/// answer, must not hold the window's thread (the Windows message loop, the main thread on macOS). `flush` is for the one moment the
/// process may go right after (Windows' confirmed end), when what was queued has to be written first
pub(crate) struct Notifier {
    tx: std::sync::mpsc::Sender<EndSession>,
    queued: std::sync::atomic::AtomicU64,
    handled: std::sync::Arc<(std::sync::Mutex<u64>, std::sync::Condvar)>,
}

impl Notifier {
    pub(crate) fn new(mut handle: impl FnMut(EndSession) + Send + 'static) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<EndSession>();
        let handled = std::sync::Arc::new((std::sync::Mutex::new(0u64), std::sync::Condvar::new()));
        let seen = handled.clone();
        std::thread::spawn(move || {
            for what in rx {
                handle(what);
                if let Ok(mut n) = seen.0.lock() {
                    *n += 1;
                    seen.1.notify_all();
                }
            }
        });
        Self { tx, queued: std::sync::atomic::AtomicU64::new(0), handled }
    }

    pub(crate) fn send(&self, what: EndSession) {
        self.queued.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = self.tx.send(what);
    }

    /// Waits up to `limit` for everything sent so far to have been handled; whether it was
    #[cfg_attr(not(windows), allow(dead_code))] // the Windows window procedure's; tested everywhere
    pub(crate) fn flush(&self, limit: std::time::Duration) -> bool {
        let want = self.queued.load(std::sync::atomic::Ordering::SeqCst);
        let Ok(n) = self.handled.0.lock() else { return false };
        self.handled.1.wait_timeout_while(n, limit, |n| *n < want).map(|(_, r)| !r.timed_out()).unwrap_or(false)
    }
}

fn notifier(app: AppHandle) -> Notifier {
    use tauri::Manager;
    Notifier::new(move |what| {
        if let Some(sup) = app.try_state::<Supervisor>() {
            sup.system_ending(what);
        }
    })
}

/// Starts listening for the system ending, once the main window exists. Where the OS offers no notice there is nothing to listen to
pub(crate) fn install(app: &AppHandle) {
    #[cfg(windows)]
    use tauri::Manager;
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(hwnd) = w.hwnd() {
            subclass(hwnd.0 as windows_sys::Win32::Foundation::HWND, notifier(app.clone()));
        }
    }
    #[cfg(target_os = "macos")]
    observe_power_off(notifier(app.clone()));
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
}

/// Puts the end-session messages of `hwnd` through `subclass_proc`, for the life of the process (the leaked sender to the notifier is its data)
#[cfg(windows)]
fn subclass(hwnd: windows_sys::Win32::Foundation::HWND, tell: Notifier) {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    let data = Box::into_raw(Box::new(tell)) as usize;
    // SAFETY: called on the thread that made the window (the setup closure); `data` lives for the rest of the process
    let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, data) };
    if ok == 0 {
        eprintln!("[system-ending] could not hear the end-session messages: SetWindowSubclass failed");
    }
}

#[cfg(windows)]
const SUBCLASS_ID: usize = 0x4343_5345; // "CCSE"

#[cfg(windows)]
unsafe extern "system" fn subclass_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    if let Some(what) = end_session_message(msg, wparam, lparam) {
        // SAFETY: `data` is the leaked sender `subclass` passed
        let tell = unsafe { &*(data as *const Notifier) };
        tell.send(what);
        // The confirmed end: the process may be ended right after this returns, so what is queued is written first, within a bound
        if msg == WM_ENDSESSION && what != EndSession::Cancelled {
            tell.flush(CONFIRMED_END_WAIT);
        }
    }
    // The answer is the program's own, as it was: the window never refuses the end
    // SAFETY: the next procedure of the chain, with the message as it came
    unsafe { windows_sys::Win32::UI::Shell::DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// `NSWorkspaceWillPowerOffNotification` is posted for a shutdown, a restart and a log out alike, before any program is asked to quit.
/// There is no notice for it being called off: the host calls an end it outlives off by itself
#[cfg(target_os = "macos")]
fn observe_power_off(tell: Notifier) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceWillPowerOffNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    // The block runs on the main thread and only hands the notice over
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| tell.send(EndSession::Ending { logoff: false }));
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: the name is a constant of AppKit, no object or queue is named (the block runs on the posting thread), and the block
    // owns what it captures and is `Send` (an `AppHandle`)
    let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillPowerOffNotification), None, None, &block) };
    // Observing for the life of the process: the center holds the block, and nothing removes the observer
    std::mem::forget(observer);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ways Windows says a user session ends (`lParam`): a shutdown carries none of them, a sign-out `ENDSESSION_LOGOFF`
    const LOGOFF: isize = 0x8000_0000u32 as i32 as isize; // sign-extended, as a 64-bit message may carry it
    const LOGOFF_ZERO_EXTENDED: isize = 0x8000_0000;
    const CRITICAL: isize = 0x4000_0000;

    #[test]
    fn the_question_is_the_end_announced() {
        for lparam in [0, CRITICAL] {
            assert_eq!(end_session_message(WM_QUERYENDSESSION, 0, lparam), Some(EndSession::Ending { logoff: false }), "{lparam:#x}");
        }
        for lparam in [LOGOFF, LOGOFF_ZERO_EXTENDED, LOGOFF | CRITICAL] {
            assert_eq!(end_session_message(WM_QUERYENDSESSION, 0, lparam), Some(EndSession::Ending { logoff: true }), "{lparam:#x}");
        }
    }

    #[test]
    fn an_end_session_with_false_is_the_end_called_off_and_with_true_the_end() {
        assert_eq!(end_session_message(WM_ENDSESSION, 0, 0), Some(EndSession::Cancelled));
        assert_eq!(end_session_message(WM_ENDSESSION, 0, LOGOFF), Some(EndSession::Cancelled));
        assert_eq!(end_session_message(WM_ENDSESSION, 1, 0), Some(EndSession::Ending { logoff: false }));
        assert_eq!(end_session_message(WM_ENDSESSION, 1, LOGOFF), Some(EndSession::Ending { logoff: true }));
    }

    /// An installer's Restart Manager closes programs the same way, and the system is not ending then
    #[test]
    fn a_restart_managers_request_to_close_is_no_end() {
        for (msg, wparam) in [(WM_QUERYENDSESSION, 0), (WM_ENDSESSION, 0), (WM_ENDSESSION, 1)] {
            assert_eq!(end_session_message(msg, wparam, ENDSESSION_CLOSEAPP as isize), None, "{msg:#x} {wparam}");
        }
    }

    #[test]
    fn other_messages_say_nothing() {
        // WM_CLOSE, WM_QUIT, WM_PAINT, WM_NULL
        for msg in [0x0010, 0x0012, 0x000F, 0x0000] {
            assert_eq!(end_session_message(msg, 1, 0), None, "{msg:#x}");
        }
    }

    #[test]
    fn each_notice_is_the_line_the_host_takes() {
        use centralu_keeper_core::host_proc::*;
        assert_eq!(line_of(EndSession::Ending { logoff: false }), SYSTEM_ENDING_LINE);
        assert_eq!(line_of(EndSession::Ending { logoff: true }), SYSTEM_ENDING_LOGOFF_LINE);
        assert_eq!(line_of(EndSession::Cancelled), SYSTEM_ENDING_CANCELLED_LINE);
    }

    /// M1: the confirmed end waits for what was queued, within a bound, and says whether it was written
    #[test]
    fn a_flush_waits_for_the_notices_sent_and_gives_up_on_a_stuck_one() {
        use std::sync::{mpsc, Arc, Mutex};
        use std::time::Duration;
        let written = Arc::new(Mutex::new(Vec::new()));
        let w = written.clone();
        let n = Notifier::new(move |what| {
            std::thread::sleep(Duration::from_millis(50));
            w.lock().unwrap().push(what);
        });
        assert!(n.flush(Duration::from_millis(10)), "nothing queued is written already");
        n.send(EndSession::Ending { logoff: false });
        n.send(EndSession::Cancelled);
        assert!(n.flush(Duration::from_secs(10)));
        assert_eq!(*written.lock().unwrap(), vec![EndSession::Ending { logoff: false }, EndSession::Cancelled]);

        let (release, held) = mpsc::channel::<()>();
        let stuck = Notifier::new(move |_| {
            let _ = held.recv();
        });
        stuck.send(EndSession::Ending { logoff: false });
        assert!(!stuck.flush(Duration::from_millis(50)), "a host that stops reading does not hold the system");
        drop(release);
    }
}
