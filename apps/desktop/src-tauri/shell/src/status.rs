//! `<data>/shell-status.json`: how a start ended, for the window that asked for it.
//!
//! A shell opened through LaunchServices is not the window's child, so its exit code and stderr go
//! nowhere the window can read. The window passes a nonce and reads this file until it carries that
//! nonce (or a keeper answers). Shape, `format` 1:
//!
//! ```json
//! { "format": 1, "shellVersion": 1, "testBuild": false, "nonce": "…", "pid": 123, "at": 1791390905,
//!   "result": "started", "appVersion": "0.1.0-beta.12", "contentDir": "…/content/0.1.0-beta.12",
//!   "keeperPid": 456, "alreadyRunning": false }
//! { "format": 1, …, "result": "refused", "reason": "downgrade", "exitCode": 12, "message": "…" }
//! ```
//!
//! Written to a temporary file and renamed, so a reader sees the old status or the new one.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::run::Started;
use crate::{keys, Refusal, SHELL_VERSION};

pub const STATUS_FILE: &str = "shell-status.json";

pub fn path(data: &Path) -> PathBuf {
    data.join(STATUS_FILE)
}

pub fn body(nonce: Option<&str>, outcome: &Result<Started, Refusal>) -> Value {
    let mut v = json!({
        "format": 1,
        "shellVersion": SHELL_VERSION,
        "testBuild": keys::TEST_BUILD,
        "nonce": nonce,
        "pid": std::process::id(),
        "at": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    match outcome {
        Ok(s) => {
            v["result"] = json!("started");
            v["appVersion"] = json!(s.app_version);
            v["contentDir"] = json!(s.content_dir);
            v["keeperPid"] = json!(s.keeper_pid);
            v["alreadyRunning"] = json!(s.already_running);
        }
        Err(r) => {
            v["result"] = json!("refused");
            v["reason"] = json!(r.reason.id());
            v["exitCode"] = json!(r.reason.exit_code());
            v["message"] = json!(r.message);
        }
    }
    v
}

/// Best effort: a status that cannot be written leaves the window to its timeout, and the line in
/// keeper.log still says what happened.
pub fn write(data: &Path, nonce: Option<&str>, outcome: &Result<Started, Refusal>) {
    let mut bytes = serde_json::to_vec_pretty(&body(nonce, outcome)).unwrap_or_default();
    bytes.push(b'\n');
    let target = path(data);
    let tmp = data.join(format!(".{STATUS_FILE}.{}", std::process::id()));
    let written = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
        .and_then(|()| fs::rename(&tmp, &target));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Reason;

    #[test]
    fn a_refusal_carries_its_reason_code_and_sentence() {
        let v = body(Some("n1"), &Err(Refusal::new(Reason::Downgrade, "0.1.0 is older than 0.2.0")));
        assert_eq!(v["result"], "refused");
        assert_eq!(v["reason"], "downgrade");
        assert_eq!(v["exitCode"], 12);
        assert_eq!(v["message"], "0.1.0 is older than 0.2.0");
        assert_eq!(v["nonce"], "n1");
        assert_eq!(v["shellVersion"], SHELL_VERSION);
    }

    #[test]
    fn a_start_names_the_version_the_copy_and_the_keeper() {
        let s = Started {
            app_version: Some("0.2.0".into()),
            content_dir: Some(PathBuf::from("/d/content/0.2.0")),
            keeper_pid: Some(42),
            already_running: false,
        };
        let v = body(None, &Ok(s));
        assert_eq!(v["result"], "started");
        assert_eq!(v["contentDir"], "/d/content/0.2.0");
        assert_eq!(v["keeperPid"], 42);
        assert_eq!(v["nonce"], Value::Null);
    }

    #[test]
    fn the_file_is_replaced_whole_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("cc-shell-status-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        write(&d, Some("a"), &Err(Refusal::new(Reason::Content, "x")));
        write(&d, Some("b"), &Err(Refusal::new(Reason::Copy, "y")));
        let v: Value = serde_json::from_slice(&fs::read(path(&d)).unwrap()).unwrap();
        assert_eq!(v["nonce"], "b");
        assert_eq!(fs::metadata(path(&d)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "no temporary file left");
        let _ = fs::remove_dir_all(&d);
    }
}
