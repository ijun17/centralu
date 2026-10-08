//! The OS layer: every operating-system branch of the runtime's mechanism, in one place
//! (docs/plans/runtime-unification.md §3.3).
//!
//! The rest of the crate calls `crate::os::…` and never asks which OS this is; `start_plan`'s
//! `Os::current` is the one place that asks it for a *decision*, and this module is where the
//! *mechanism* differs. `platform_checks.rs` fails the build's tests when an OS `cfg` appears
//! anywhere else.
//!
//! - `unix.rs`: what macOS and Linux share (a lock, a session, the creation mask, peer
//!   credentials, the host's process group and signals, the login-shell probe), with
//!   `unix/children.rs` (the children the keeper holds) and `unix/handles.rs` (descriptor passing).
//! - `macos.rs`, `linux.rs`: what differs between the two (`peer_uid`, `ExitBackend`,
//!   `RECV_FLAGS`); `other_unix.rs` keeps a unix that is neither compiling with the old fallbacks.
//! - `windows.rs`: the host process on Windows (stdin EOF, `taskkill`, no console). The keeper's
//!   operations have no Windows half yet (plan step 9): the keeper is unix-only.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as this_unix;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as this_unix;

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
mod other_unix;
#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
use other_unix as this_unix;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;
