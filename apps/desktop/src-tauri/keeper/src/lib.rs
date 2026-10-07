//! The keeper and the host supervisor, with no Tauri and no webview (#440, thin-shell plan §5).
//!
//! Two programs use this crate:
//!   - the keeper executable, `centralu-keeper` (`src/bin/centralu-keeper.rs` in the app package),
//!     which runs `keeper::server::run` and nothing else;
//!   - the window (`centralu`), which talks to a keeper through `keeper::client`, and in direct
//!     mode (debug builds, Windows) supervises the host itself with `host_proc`.
//!
//! It is a crate of its own so that the keeper's link cannot reach Tauri, WebKit or AppKit by
//! accident: its dependencies are `serde`, `serde_json` and `libc`, and anything else has to be
//! added here, in plain sight. A later step starts the keeper from verified content outside the
//! window's bundle, where it must not need the window's frameworks.

pub mod host_proc;
#[cfg(unix)]
pub mod keeper;
