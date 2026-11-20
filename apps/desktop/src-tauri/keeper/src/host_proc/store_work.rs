//! What a starting host does to its store before it can answer (#2334), as it says it in `host.lock`'s `store`
//! (agent-host `store/store-work.ts`). The window reads it while it waits for the host, so a copy of a large store or a
//! long store step shows as that instead of ending in "Could not start the agent host". The npm launcher's reader of the
//! same record is `storeWork` in serve-files.mjs.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// `{ doing, step, bytes, since }`: `doing` is `copy` or `update`; `since` is epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreWork {
    pub doing: String,
    pub step: u64,
    pub bytes: u64,
    pub since: u64,
}

/// The store work `host.lock` in `data` says, while the process it names runs. A host ended in its work leaves the
/// record behind; its pid running again under another process would read as it until the next host takes the folder,
/// which only lengthens a wait the supervisor still ends when that host exits.
pub fn read(data: &Path) -> Option<StoreWork> {
    let text = std::fs::read_to_string(data.join("host.lock")).ok()?;
    let (pid, work) = parse(&text)?;
    crate::os::pid_alive(pid).then_some(work)
}

/// The holder's pid and its store work, when the record has both and the work is one this build knows.
fn parse(text: &str) -> Option<(u32, StoreWork)> {
    #[derive(Deserialize)]
    struct Lock {
        pid: u32,
        store: Option<StoreWork>,
    }
    let lock: Lock = serde_json::from_str(text).ok()?;
    let work = lock.store?;
    (work.doing == "copy" || work.doing == "update").then_some((lock.pid, work))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record the host writes (agent-host `instance-lock.ts` `sayWork`), byte for byte as its test pins it.
    const SAID: &str = r#"{"pid":4242,"started":null,"at":1800000000000,"by":"app","store":{"doing":"copy","step":76,"bytes":19352965120,"since":1800000001000}}"#;

    #[test]
    fn the_work_the_host_says_is_read_with_its_pid() {
        let (pid, work) = parse(SAID).expect("a record with store work");
        assert_eq!(pid, 4242);
        assert_eq!(work, StoreWork { doing: "copy".into(), step: 76, bytes: 19_352_965_120, since: 1_800_000_001_000 });
    }

    #[test]
    fn a_lock_without_work_or_with_work_of_another_kind_says_none() {
        assert_eq!(parse(r#"{"pid":4242,"started":null,"at":1}"#), None);
        assert_eq!(parse(&SAID.replace("\"copy\"", "\"index\"")), None);
        assert_eq!(parse("{\"pid\":42"), None);
    }

    #[test]
    fn a_record_whose_process_is_gone_says_none() {
        let dir = std::env::temp_dir().join(format!("cc-store-work-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A pid no process has: the largest a u32 holds
        std::fs::write(dir.join("host.lock"), SAID.replace("4242", &u32::MAX.to_string())).unwrap();
        assert_eq!(read(&dir), None);
        std::fs::write(dir.join("host.lock"), SAID.replace("4242", &std::process::id().to_string())).unwrap();
        assert_eq!(read(&dir).map(|w| w.step), Some(76));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
