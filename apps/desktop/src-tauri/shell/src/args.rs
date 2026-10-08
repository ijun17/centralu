//! The shell's command line. The window passes it through LaunchServices (`open -n -g -a <shell>
//! --args ...`), which starts the shell with `/` as its working folder and launchd's environment, so
//! everything the shell needs is an argument and every path is absolute.

use std::path::{Path, PathBuf};

use crate::{Reason, Refusal};

pub const USAGE: &str = "usage: centralu-shell --content <dir> --data-dir <dir> [--bundle-path <path>] [--nonce <id>] [--rollback]";

/// The longest nonce accepted; the window sends 32 hex characters.
const MAX_NONCE: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    /// The signed content the window carries (`Contents/Resources/content` in its bundle).
    pub content: PathBuf,
    /// The data folder (`~/.centralu`). Never taken from the environment: a shell opened through
    /// LaunchServices has launchd's, not the window's.
    pub data_dir: PathBuf,
    /// The window's bundle, recorded as where the build came from.
    pub bundle_path: Option<String>,
    /// Matches this start's status file to the window that asked for it.
    pub nonce: Option<String>,
    /// The window asked for this version on purpose, even if a newer one has run.
    pub rollback: bool,
}

pub fn parse(argv: &[String]) -> Result<Args, Refusal> {
    let usage = |m: String| Refusal::new(Reason::Usage, m);
    let mut content = None;
    let mut data_dir = None;
    let mut bundle_path = None;
    let mut nonce = None;
    let mut rollback = false;
    let mut it = argv.iter().skip(1);
    while let Some(a) = it.next() {
        // LaunchServices on macOS before 10.9 added a process serial number; ignore one if it comes.
        if a.starts_with("-psn_") {
            continue;
        }
        let mut value = |slot_taken: bool| -> Result<String, Refusal> {
            if slot_taken {
                return Err(usage(format!("{a} is given twice")));
            }
            match it.next() {
                Some(v) if !v.is_empty() && !v.starts_with("--") => Ok(v.clone()),
                _ => Err(usage(format!("{a} needs a value"))),
            }
        };
        match a.as_str() {
            "--content" => content = Some(absolute(a, value(content.is_some())?)?),
            "--data-dir" => data_dir = Some(absolute(a, value(data_dir.is_some())?)?),
            "--bundle-path" => bundle_path = Some(value(bundle_path.is_some())?),
            "--nonce" => {
                let v = value(nonce.is_some())?;
                if v.len() > MAX_NONCE || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    return Err(usage("--nonce is letters, digits and dashes, at most 64".into()));
                }
                nonce = Some(v);
            }
            "--rollback" => {
                if rollback {
                    return Err(usage("--rollback is given twice".into()));
                }
                rollback = true;
            }
            other => return Err(usage(format!("unknown argument {other:?}"))),
        }
    }
    Ok(Args {
        content: content.ok_or_else(|| usage("--content is required".into()))?,
        data_dir: data_dir.ok_or_else(|| usage("--data-dir is required".into()))?,
        bundle_path,
        nonce,
        rollback,
    })
}

fn absolute(flag: &str, v: String) -> Result<PathBuf, Refusal> {
    let p = PathBuf::from(v);
    if !p.is_absolute() {
        return Err(Refusal::new(Reason::Usage, format!("{flag} must be an absolute path, not {}", p.display())));
    }
    // So what a path names can be compared by its components (`run::run`), never by resolving it.
    if p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(Refusal::new(Reason::Usage, format!("{flag} must not contain `..`, as {} does", p.display())));
    }
    Ok(p)
}

fn hint(argv: &[String], flag: &str) -> Option<String> {
    let i = argv.iter().position(|a| a == flag)?;
    argv.get(i + 1).cloned()
}

/// The data folder of a command line that did not parse, so the refusal can still be written where
/// the window looks for it.
pub fn data_dir_hint(argv: &[String]) -> Option<PathBuf> {
    hint(argv, "--data-dir").map(PathBuf::from).filter(|p| p.is_absolute() && Path::new(p).is_dir())
}

/// The nonce of a command line that did not parse, if it is one `parse` would accept.
pub fn nonce_hint(argv: &[String]) -> Option<String> {
    hint(argv, "--nonce").filter(|v| v.len() <= MAX_NONCE && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(v: &[&str]) -> Vec<String> {
        std::iter::once("centralu-shell").chain(v.iter().copied()).map(String::from).collect()
    }

    fn refused(v: &[&str]) -> String {
        match parse(&argv(v)) {
            Err(r) => {
                assert_eq!(r.reason, Reason::Usage);
                r.message
            }
            Ok(a) => panic!("{v:?} parsed: {a:?}"),
        }
    }

    #[test]
    fn reads_what_the_window_passes() {
        let a = parse(&argv(&[
            "--content",
            "/Applications/Centralu.app/Contents/Resources/content",
            "--data-dir",
            "/Users/a b/.centralu",
            "--bundle-path",
            "/Applications/Centralu.app",
            "--nonce",
            "0123abcd-ef",
        ]))
        .unwrap();
        assert_eq!(a.content, PathBuf::from("/Applications/Centralu.app/Contents/Resources/content"));
        assert_eq!(a.data_dir, PathBuf::from("/Users/a b/.centralu"));
        assert_eq!(a.bundle_path.as_deref(), Some("/Applications/Centralu.app"));
        assert_eq!(a.nonce.as_deref(), Some("0123abcd-ef"));
        assert!(!a.rollback);
        let r = parse(&argv(&["--rollback", "--data-dir", "/d", "--content", "/c"])).unwrap();
        assert!(r.rollback, "any order");
        assert_eq!(r.bundle_path, None);
    }

    #[test]
    fn an_old_process_serial_number_is_ignored() {
        assert!(parse(&argv(&["-psn_0_12345", "--content", "/c", "--data-dir", "/d"])).is_ok());
    }

    #[test]
    fn every_malformed_command_line_is_a_usage_refusal() {
        assert!(refused(&[]).contains("--content is required"));
        assert!(refused(&["--content", "/c"]).contains("--data-dir is required"));
        assert!(refused(&["--data-dir", "/d"]).contains("--content is required"));
        assert!(refused(&["--content", "c", "--data-dir", "/d"]).contains("absolute"));
        assert!(refused(&["--content", "/c", "--data-dir", "./d"]).contains("absolute"));
        assert!(refused(&["--content", "/d/content/x/../0.2.0", "--data-dir", "/d"]).contains("`..`"));
        assert!(refused(&["--content", "/c", "--data-dir", "/d/.."]).contains("`..`"));
        assert!(refused(&["--content", "/c", "--content", "/c2", "--data-dir", "/d"]).contains("twice"));
        assert!(refused(&["--content", "/c", "--data-dir", "/d", "--rollback", "--rollback"]).contains("twice"));
        assert!(refused(&["--content"]).contains("needs a value"));
        assert!(refused(&["--content", "--data-dir", "/d"]).contains("needs a value"));
        assert!(refused(&["--content", "", "--data-dir", "/d"]).contains("needs a value"));
        assert!(refused(&["--content", "/c", "--data-dir", "/d", "--keeper"]).contains("unknown argument"));
        assert!(refused(&["--content", "/c", "--data-dir", "/d", "extra"]).contains("unknown argument"));
        assert!(refused(&["--content", "/c", "--data-dir", "/d", "--nonce", "a/b"]).contains("--nonce"));
        let long = "a".repeat(65);
        assert!(refused(&["--content", "/c", "--data-dir", "/d", "--nonce", &long]).contains("--nonce"));
    }

    #[test]
    fn a_refused_command_line_still_names_where_to_report() {
        let d = std::env::temp_dir();
        let v = argv(&["--data-dir", d.to_str().unwrap(), "--nonce", "abc", "--bogus"]);
        assert!(parse(&v).is_err());
        assert_eq!(data_dir_hint(&v), Some(d));
        assert_eq!(nonce_hint(&v).as_deref(), Some("abc"));
        assert_eq!(data_dir_hint(&argv(&["--data-dir", "relative"])), None);
        assert_eq!(data_dir_hint(&argv(&["--data-dir", "/no/such/folder/here"])), None, "never creates a folder to report into");
        assert_eq!(nonce_hint(&argv(&["--nonce", "../x"])), None);
    }
}
