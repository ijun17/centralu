//! Why signed content was refused, shown in a native window (#634, docs/security-boundaries.md
//! "Signed content").
//!
//! When the shell or the keeper refuses a build's content, the person used to see one line in the
//! build bar, drawn by the web UI. That UI is fed by the host, and the host is the very thing whose
//! content failed to verify, so it could hide or rewrite the line. A dialog drawn here, in the window
//! process (the signed app bundle), cannot be suppressed by the host: it needs nothing from the host,
//! only what the shell wrote to `<data>/shell-status.json` and what the keeper reports in its swap
//! view, both read by the window itself.
//!
//! **Show, do not run.** This only tells. Nothing here starts, trusts or unlocks the content it names;
//! what keeps running is what already ran (an update swap) or what the window starts itself
//! (docs/plans/thin-shell.md §6).
//!
//! The wording and the once-only rule are plain functions, so they are tested on every platform; only
//! `show` touches the dialog plugin. The sources of a refusal are macOS (the shell, the keeper), but
//! none of this is `cfg(unix)`: a refusal that cannot arise on another OS is simply never offered.

use std::collections::HashSet;
use std::path::PathBuf;

/// Where the refusal came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The permission shell refused the window's own content at a start.
    Shell,
    /// The running keeper refused the new build's content on an update.
    Keeper,
}

/// What the window knows of one refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub source: Source,
    /// The id of the refusal (`content`, `downgrade`, `shell-too-old`, …), the shell's and the keeper's.
    pub reason: String,
    /// Which check of the verifier refused (`unknown-key`, `bad-signature`, `hash-mismatch`, …), when known.
    pub check: Option<String>,
    /// The listed file it is about, when it is about one.
    pub file: Option<String>,
    /// The exact sentence the shell or the keeper gave.
    pub message: String,
    /// The version that could not be verified.
    pub new_version: Option<String>,
    /// The version that keeps running (an update), when known.
    pub running_version: Option<String>,
}

/// Which reasons are about the content failing verification, and so are shown here. A copy that failed,
/// a folder in use, or a shell that would not open are not: the build bar already says those, and
/// none says the content is not what was signed.
pub fn is_verification(reason: &str) -> bool {
    matches!(reason, "content" | "downgrade" | "shell-too-old")
}

impl Refusal {
    /// The shell's refusal of the window's own content at a start (`shell-status.json`: `reason` and `message`), if
    /// it is a verification failure. `found` is what the window found by reading the content itself
    /// (`keeper::content::diagnose`: the check, the file, and the exact sentence with both hashes), which says
    /// more than the shell's one sentence; the shell's reason and sentence stand when it found nothing.
    pub fn from_shell(reason: &str, message: &str, found: Option<Found>, new_version: &str) -> Option<Refusal> {
        if !is_verification(reason) {
            return None;
        }
        let (check, file, message) = match found {
            Some(f) => (Some(f.check), f.file, f.message),
            // The shell's status of this version carries no check: the reason is the check for the two that are one
            None => (matches!(reason, "downgrade" | "shell-too-old").then(|| reason.to_string()), None, message.to_string()),
        };
        Some(Refusal { source: Source::Shell, reason: reason.to_string(), check, file, message, new_version: Some(new_version.to_string()), running_version: None })
    }

    /// The keeper's refusal of a new build's content, from its swap view (`refused`, `refusedCheck`, `refusedFile`,
    /// `message`, the target's and the running build's versions), if it is a verification failure.
    pub fn from_swap(
        refused: Option<&str>,
        check: Option<&str>,
        file: Option<&str>,
        message: Option<&str>,
        new_version: Option<&str>,
        running_version: Option<&str>,
    ) -> Option<Refusal> {
        let reason = refused.filter(|r| is_verification(r))?;
        Some(Refusal {
            source: Source::Keeper,
            reason: reason.to_string(),
            check: check.map(String::from),
            file: file.map(String::from),
            message: message.unwrap_or("the keeper refused the new build's content").to_string(),
            new_version: new_version.map(String::from),
            running_version: running_version.map(String::from),
        })
    }
}

/// What the window found by reading its own content again (`keeper::content::diagnose`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub check: String,
    pub file: Option<String>,
    pub message: String,
}

/// The words for one check, the first line of the details.
fn headline(r: &Refusal) -> &'static str {
    match r.check.as_deref() {
        Some("unknown-key") => "It is signed with a key this Centralu does not trust.",
        Some("bad-signature") => "Its signature does not match its manifest.",
        Some("hash-mismatch") => "A file is not the one the signed manifest lists: its hash differs.",
        Some("size-mismatch") => "A file is not the size the signed manifest lists.",
        Some("wrong-platform") => "It is built for another platform.",
        Some("shell-too-old") => "It needs a newer agent shell than the installed one.",
        Some("downgrade") => "It is older than a version that has already run here.",
        Some("missing-file" | "bad-file" | "manifest-malformed" | "signature-malformed" | "unsupported-format") => {
            "Its signed manifest or signature file is missing, damaged or of a format this Centralu does not read."
        }
        Some("file-unreadable") => "A file the signed manifest lists is missing or cannot be read.",
        Some("bad-path" | "duplicate-path" | "symlink" | "not-regular-file") => "The signed manifest lists a file in a way Centralu refuses.",
        _ => match r.reason.as_str() {
            "downgrade" => "It is older than a version that has already run here.",
            "shell-too-old" => "It needs a newer agent shell than the installed one.",
            _ => "It is not what the project signed.",
        },
    }
}

/// What the dialog says, and how its two buttons read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialog {
    pub title: String,
    pub text: String,
    /// The button that shows the log.
    pub log_button: String,
    pub close_button: String,
}

pub const TITLE_UPDATE: &str = "Centralu could not verify this update";
pub const TITLE_START: &str = "Centralu could not verify its content";
pub const LOG_BUTTON: &str = "Show log";
pub const CLOSE_BUTTON: &str = "Close";

/// A string from the shell's status or the keeper's view, as shown: control characters (a line break included) become
/// spaces, runs of spaces one, and no more than `SHOWN_MAX` characters. A native dialog is the window's own voice, so
/// what it repeats from another process is kept to plain text of a bounded length.
pub const SHOWN_MAX: usize = 600;

pub fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_control() || c == ' ' {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
        if out.chars().count() >= SHOWN_MAX {
            out.push('…');
            break;
        }
    }
    out
}

/// The dialog for a refusal. The first paragraph says what happened and what keeps running; the second,
/// under "Details", is the exact reason, as the shell or the keeper gave it.
pub fn dialog(r: &Refusal) -> Dialog {
    let (reason_text, check, file) = (plain(&r.message), r.check.as_deref().map(plain), r.file.as_deref().map(plain));
    let new = r.new_version.as_deref().map(|v| format!("Centralu {}", plain(v))).unwrap_or_else(|| "The new build".to_string());
    let (title, what) = match r.source {
        Source::Keeper => (
            TITLE_UPDATE,
            match &r.running_version {
                Some(v) => format!("{new} could not be verified and was not started. Centralu {} is still running.", plain(v)),
                None => format!("{new} could not be verified and was not started. The running build is still running."),
            },
        ),
        Source::Shell => (
            TITLE_START,
            format!(
                "{new} could not be verified by the permission shell, so the shell did not start Centralu. \
                 Centralu was started directly from this app instead, and that start was not verified: \
                 what agents may access follows this window's permissions, not the shell's."
            ),
        ),
    };
    let mut details = vec![headline(r).to_string()];
    if let Some(file) = &file {
        details.push(format!("File: {file}"));
    }
    if let Some(check) = &check {
        details.push(format!("Check: {check}"));
    }
    details.push(reason_text);
    let again = match &r.new_version {
        Some(v) => format!("npm i -g centralu@{v}` and then `centralu install --force"),
        None => "npm i -g centralu` and then `centralu install --force".to_string(),
    };
    let fetch = match r.source {
        // An update's refused build never ran: the running one kept serving (a later "Restart completely" is another start)
        Source::Keeper => format!("To fetch it again, run `{again}` in a terminal. The refused build was not run."),
        Source::Shell => format!("To fetch it again, run `{again}` in a terminal, then open Centralu."),
    };
    Dialog {
        title: title.to_string(),
        text: format!("{what}\n\n{fetch}\n\nDetails\n{}", details.join("\n")),
        log_button: LOG_BUTTON.to_string(),
        close_button: CLOSE_BUTTON.to_string(),
    }
}

/// Which refusals were already shown in this window's life: one dialog per refusal, not one per view
/// the keeper pushes while the swap sits in its failed phase.
#[derive(Debug, Default)]
pub struct Shown {
    keys: HashSet<String>,
    /// When the last dialog was shown, in milliseconds on any clock the caller keeps.
    last_ms: Option<u64>,
}

/// The least time between two dialogs. A process of this user that reaches the keeper's socket can ask for a switch to
/// content it names, and each refusal would be a new dialog: they are shown one at a time, a person-paced rate.
pub const MIN_GAP_MS: u64 = 5_000;

impl Shown {
    /// Whether this refusal is new and may be shown now, and notes it. `started_at` tells one swap attempt from the next
    /// (a second try of the same build that is refused again is shown again; the same view repeated is not). `now_ms`:
    /// a refusal that comes within `MIN_GAP_MS` of the last dialog is not shown and not noted, so a later view shows it.
    pub fn first(&mut self, r: &Refusal, started_at: u64, now_ms: u64) -> bool {
        if self.last_ms.is_some_and(|last| now_ms.saturating_sub(last) < MIN_GAP_MS) {
            return false;
        }
        let key = format!(
            "{:?}|{}|{}|{}|{}",
            r.source,
            r.new_version.as_deref().unwrap_or(""),
            r.check.as_deref().unwrap_or(&r.reason),
            r.file.as_deref().unwrap_or(""),
            started_at
        );
        let new = self.keys.insert(key);
        if new {
            self.last_ms = Some(now_ms);
        }
        new
    }
}

/// Which of the refusals in hand are to be shown now: the shell's of this window's content (the first of its life: key
/// `started_at` 0) and the keeper's of this window's build (with its swap's `started_at`), each once, one at a time
/// (`Shown::first`). What the keeper link calls on every view and after every start; one that had to wait is returned by a
/// later call.
pub fn due(shown: &mut Shown, shell: Option<&Refusal>, keeper: Option<(&Refusal, u64)>, now_ms: u64) -> Vec<Refusal> {
    let mut out = Vec::new();
    if let Some(r) = shell {
        if shown.first(r, 0, now_ms) {
            out.push(r.clone());
        }
    }
    if let Some((r, started_at)) = keeper {
        if shown.first(r, started_at, now_ms) {
            out.push(r.clone());
        }
    }
    out
}

/// Shows the dialog natively, from this process. Returns at once; "Show log" reveals `log` in the file
/// manager. Never blocks the keeper link's thread: the answer arrives on the dialog's own callback.
pub fn show(app: &tauri::AppHandle, d: Dialog, log: PathBuf) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(d.text)
        .title(d.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(d.log_button, d.close_button))
        .show(move |show_log| {
            if show_log {
                if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&log) {
                    eprintln!("[window] could not show {}: {e}", log.display());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keeper(check: Option<&str>, file: Option<&str>) -> Refusal {
        Refusal {
            source: Source::Keeper,
            reason: "content".into(),
            check: check.map(String::from),
            file: file.map(String::from),
            message: "the new build's content at /App.app/Contents/Resources/content is not what the project signed: \"host/main.mjs\" does not match its hash".into(),
            new_version: Some("0.1.0-beta.32".into()),
            running_version: Some("0.1.0-beta.31".into()),
        }
    }

    #[test]
    fn an_update_says_which_version_failed_which_one_still_runs_and_the_exact_reason() {
        let d = dialog(&keeper(Some("hash-mismatch"), Some("host/main.mjs")));
        assert_eq!(d.title, TITLE_UPDATE);
        assert!(d.text.starts_with("Centralu 0.1.0-beta.32 could not be verified and was not started. Centralu 0.1.0-beta.31 is still running."), "{}", d.text);
        let details = d.text.split("\n\nDetails\n").nth(1).expect("a Details part");
        assert_eq!(
            details.lines().collect::<Vec<_>>(),
            [
                "A file is not the one the signed manifest lists: its hash differs.",
                "File: host/main.mjs",
                "Check: hash-mismatch",
                "the new build's content at /App.app/Contents/Resources/content is not what the project signed: \"host/main.mjs\" does not match its hash",
            ]
        );
        assert_eq!((d.log_button.as_str(), d.close_button.as_str()), ("Show log", "Close"));
    }

    #[test]
    fn every_check_has_its_own_words_and_an_unknown_one_still_says_something() {
        let words = |check: Option<&str>, reason: &str| {
            let mut r = keeper(check, None);
            r.reason = reason.into();
            headline(&r)
        };
        let all = [
            words(Some("unknown-key"), "content"),
            words(Some("bad-signature"), "content"),
            words(Some("hash-mismatch"), "content"),
            words(Some("size-mismatch"), "content"),
            words(Some("wrong-platform"), "content"),
            words(Some("shell-too-old"), "shell-too-old"),
            words(Some("downgrade"), "downgrade"),
            words(Some("missing-file"), "content"),
            words(Some("bad-path"), "content"),
        ];
        let distinct: HashSet<_> = all.iter().collect();
        assert_eq!(distinct.len(), all.len(), "{all:?}");
        // The shell's older status says no check: the reason's own words, and the general one for the rest
        assert_eq!(words(None, "downgrade"), "It is older than a version that has already run here.");
        assert_eq!(words(None, "shell-too-old"), "It needs a newer agent shell than the installed one.");
        assert_eq!(words(None, "content"), "It is not what the project signed.");
        assert_eq!(words(Some("a-check-from-a-newer-keeper"), "content"), "It is not what the project signed.");
    }

    #[test]
    fn a_start_through_the_shell_says_centralu_started_without_it() {
        let r = Refusal {
            source: Source::Shell,
            reason: "content".into(),
            check: Some("unknown-key".into()),
            file: None,
            message: "the content at /App.app/Contents/Resources/content is not what the project signed: signed with an unknown key 0011223344556677".into(),
            new_version: Some("0.1.0-beta.32".into()),
            running_version: None,
        };
        let d = dialog(&r);
        assert_eq!(d.title, TITLE_START);
        assert!(
            d.text.contains("could not be verified by the permission shell, so the shell did not start Centralu. Centralu was started directly from this app instead, and that start was not verified"),
            "{}",
            d.text
        );
        assert!(d.text.contains("It is signed with a key this Centralu does not trust.\nCheck: unknown-key\n"), "{}", d.text);
        assert!(!d.text.contains("File:"), "no file when none is named");
        // What is true of a start the window made itself is not "nothing ran"; and the command really fetches it again
        // (`centralu update` says "already up to date" for the version just installed)
        assert!(!d.text.contains("was not run"), "{}", d.text);
        assert!(d.text.contains("run `npm i -g centralu@0.1.0-beta.32` and then `centralu install --force` in a terminal, then open Centralu."), "{}", d.text);
        assert!(!d.text.contains("centralu update"), "{}", d.text);
    }

    #[test]
    fn an_update_that_does_not_know_what_runs_still_reads() {
        let mut r = keeper(None, None);
        r.new_version = None;
        r.running_version = None;
        let d = dialog(&r);
        assert!(d.text.starts_with("The new build could not be verified and was not started. The running build is still running."), "{}", d.text);
        assert!(d.text.contains("run `npm i -g centralu` and then `centralu install --force` in a terminal. The refused build was not run."), "{}", d.text);
    }

    #[test]
    fn what_another_process_wrote_is_shown_as_plain_bounded_text() {
        let mut r = keeper(Some("hash-mismatch\nFile: /etc/passwd"), Some("a\u{7}b\r\nc"));
        r.message = format!("first\nsecond\t  third {}", "x".repeat(5_000));
        r.new_version = Some("0.1\n\nCentralu is fine".into());
        let d = dialog(&r);
        assert!(!d.text.contains('\u{7}') && !d.text.contains('\r') && !d.text.contains('\t'), "{:?}", d.text);
        assert!(d.text.starts_with("Centralu 0.1 Centralu is fine could not be verified"), "the first paragraph is one line: {:?}", d.text);
        assert!(d.text.contains("File: a b c\n") && d.text.contains("Check: hash-mismatch File: /etc/passwd\n"), "{:?}", d.text);
        let details = d.text.split("\n\nDetails\n").nth(1).unwrap();
        assert!(details.lines().last().unwrap().chars().count() <= SHOWN_MAX + 1, "capped: {}", details.len());
        assert_eq!(plain("  a \n\n b  "), "a b");
        assert_eq!(plain(""), "");
    }

    #[test]
    fn a_file_the_manifest_lists_that_cannot_be_read_is_not_called_a_missing_manifest() {
        let mut r = keeper(Some("file-unreadable"), Some("host/main.mjs"));
        assert_eq!(headline(&r), "A file the signed manifest lists is missing or cannot be read.");
        r.check = Some("missing-file".into());
        assert!(headline(&r).starts_with("Its signed manifest or signature file"));
    }

    #[test]
    fn only_verification_failures_are_shown() {
        for yes in ["content", "downgrade", "shell-too-old"] {
            assert!(is_verification(yes), "{yes}");
        }
        for no in ["copy", "in-use", "no-content", "install", "open", "no-report", "keeper-start", "keeper-exited", "keeper-timeout", "unpinned", "not-carried", "usage", ""] {
            assert!(!is_verification(no), "{no}");
        }
    }

    #[test]
    fn the_shells_refusal_is_worded_from_what_the_window_found_when_it_found_something() {
        let sentence = "the content at /App.app/Contents/Resources/content is not what the project signed: \"host/main.mjs\" does not match its hash";
        let found = Found {
            check: "hash-mismatch".into(),
            file: Some("host/main.mjs".into()),
            message: format!("{sentence}: the signed manifest lists aa, the file is bb"),
        };
        let r = Refusal::from_shell("content", sentence, Some(found), "0.1.0-beta.32").unwrap();
        assert_eq!((r.source, r.check.as_deref(), r.file.as_deref()), (Source::Shell, Some("hash-mismatch"), Some("host/main.mjs")));
        assert!(r.message.ends_with("the file is bb"), "{}", r.message);
        assert_eq!(r.new_version.as_deref(), Some("0.1.0-beta.32"));
        // Found nothing: the shell's own sentence stands, with the reason for the two reasons that are checks
        let r = Refusal::from_shell("content", sentence, None, "0.1.0-beta.32").unwrap();
        assert_eq!((r.check, r.file, r.message.as_str()), (None, None, sentence));
        assert_eq!(Refusal::from_shell("downgrade", "x", None, "1").unwrap().check.as_deref(), Some("downgrade"));
        assert_eq!(Refusal::from_shell("shell-too-old", "x", None, "1").unwrap().check.as_deref(), Some("shell-too-old"));
        // A copy that failed, an install, a missing report are not this window's to show
        for reason in ["copy", "install", "open", "no-report", "unpinned", "keeper-timeout"] {
            assert_eq!(Refusal::from_shell(reason, "x", None, "1"), None, "{reason}");
        }
    }

    #[test]
    fn the_keepers_refusal_is_read_from_its_swap_view() {
        let r = Refusal::from_swap(Some("content"), Some("unknown-key"), None, Some("signed with an unknown key"), Some("0.1.0-beta.32"), Some("0.1.0-beta.31")).unwrap();
        assert_eq!((r.source, r.reason.as_str(), r.check.as_deref(), r.running_version.as_deref()), (Source::Keeper, "content", Some("unknown-key"), Some("0.1.0-beta.31")));
        // An older keeper names no check: still shown, with the reason's own words
        let r = Refusal::from_swap(Some("downgrade"), None, None, Some("0.1.0 is older than 0.2.0"), None, None).unwrap();
        assert_eq!(headline(&r), "It is older than a version that has already run here.");
        assert_eq!(Refusal::from_swap(Some("content"), None, None, None, None, None).unwrap().message, "the keeper refused the new build's content");
        // Not a refusal, or not one about verification
        assert_eq!(Refusal::from_swap(None, Some("hash-mismatch"), None, Some("m"), None, None), None);
        for reason in ["copy", "in-use", "no-content"] {
            assert_eq!(Refusal::from_swap(Some(reason), None, None, Some("m"), None, None), None, "{reason}");
        }
    }

    #[test]
    fn a_refusal_is_shown_once_and_a_second_attempt_again() {
        let mut shown = Shown::default();
        let gap = MIN_GAP_MS;
        let r = keeper(Some("hash-mismatch"), Some("host/main.mjs"));
        assert!(shown.first(&r, 100, 0));
        // The keeper pushes the same failed view again, for another reason (a status change)
        assert!(!shown.first(&r, 100, gap));
        assert!(!shown.first(&r.clone(), 100, 10 * gap));
        // The person tries again and it is refused again: that is news
        assert!(shown.first(&r, 200, 10 * gap));
        // Another file, another build, another source
        assert!(shown.first(&keeper(Some("hash-mismatch"), Some("keeper")), 200, 20 * gap));
        let mut newer = r.clone();
        newer.new_version = Some("0.1.0-beta.33".into());
        assert!(shown.first(&newer, 200, 30 * gap));
        let mut shell = r.clone();
        shell.source = Source::Shell;
        assert!(shown.first(&shell, 200, 40 * gap));
    }

    #[test]
    fn the_views_the_link_sees_show_each_refusal_once_and_the_second_of_two_after_the_gap() {
        let shell = Refusal::from_shell("content", "x", None, "0.1.0-beta.32").unwrap();
        let swap = keeper(Some("hash-mismatch"), Some("host/main.mjs"));
        let mut shown = Shown::default();
        // Nothing to say
        assert_eq!(due(&mut shown, None, None, 0), []);
        // A start the shell refused, then the same view again and again
        assert_eq!(due(&mut shown, Some(&shell), None, 1_000), [shell.clone()]);
        assert_eq!(due(&mut shown, Some(&shell), None, 1_000 + 10 * MIN_GAP_MS), []);
        // An update refused: shown, and not again for the views that follow while it stays failed
        assert_eq!(due(&mut shown, Some(&shell), Some((&swap, 500)), 100_000), [swap.clone()]);
        assert_eq!(due(&mut shown, Some(&shell), Some((&swap, 500)), 200_000), []);
        // Both new at once: the shell's now, the keeper's with the next view once the gap has passed
        let mut shown = Shown::default();
        assert_eq!(due(&mut shown, Some(&shell), Some((&swap, 500)), 1_000), [shell.clone()]);
        assert_eq!(due(&mut shown, Some(&shell), Some((&swap, 500)), 1_000 + MIN_GAP_MS), [swap.clone()]);
        assert_eq!(due(&mut shown, Some(&shell), Some((&swap, 500)), 1_000 + 3 * MIN_GAP_MS), []);
    }

    #[test]
    fn dialogs_come_one_at_a_time_and_one_that_had_to_wait_is_shown_later() {
        let mut shown = Shown::default();
        let a = keeper(Some("hash-mismatch"), Some("a"));
        let b = keeper(Some("hash-mismatch"), Some("b"));
        assert!(shown.first(&a, 1, 1_000));
        // Another refusal right after, as a process asking for switch after switch would cause: not shown, not noted
        assert!(!shown.first(&b, 2, 1_001));
        assert!(!shown.first(&b, 3, 1_000 + MIN_GAP_MS - 1));
        // Once the gap has passed, the one that waited is news
        assert!(shown.first(&b, 3, 1_000 + MIN_GAP_MS));
        assert!(!shown.first(&b, 3, 1_000 + 3 * MIN_GAP_MS));
    }
}
