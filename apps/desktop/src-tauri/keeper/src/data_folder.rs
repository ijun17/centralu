//! Where the host keeps its data, as the window, the keeper and the host each work it out.

use std::path::PathBuf;

/**
 * The data folder: `CC_DATA_DIR`, or the folder the host would choose for itself
 * (`~/.centralu`, or `~/.centralu-dev` with `CC_DEV=1`).
 *
 * The app and the keeper each compute this and must agree, and the keeper hands it to the host
 * explicitly (`--db`, `CC_DATA_DIR`), so all three name the same folder.
 */
pub fn data_dir() -> PathBuf {
    data_dir_with(std::env::var("CC_DEV").as_deref() == Ok("1"))
}

/// `data_dir`, with the dev flag given rather than read from the environment.
pub fn data_dir_with(dev: bool) -> PathBuf {
    if let Ok(d) = std::env::var("CC_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = crate::os::home().unwrap_or_default();
    PathBuf::from(home).join(if dev { ".centralu-dev" } else { ".centralu" })
}
