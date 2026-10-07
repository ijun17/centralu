//! The keeper executable (#440, thin-shell plan §5).
//!
//! It links `centralu-keeper-core` and nothing else of this package: no Tauri, no webview, no
//! AppKit. Tauri bundles it next to the window's executable, where the window looks for it
//! (`keeper::exe`). Arguments are the keeper's own (`--data-dir`, `--host-source`, `--take-over-fd`,
//! ...); a `--keeper` among them is accepted and ignored, so a command line written for the window's
//! executable starts this one unchanged.

#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::process::exit(centralu_keeper_core::keeper::server::run(&args));
}

/// Windows has no keeper yet (unix sockets, descriptor passing, `flock`); the bundle leaves this
/// executable out there (`required-features`, tauri.windows.conf.json).
#[cfg(not(unix))]
fn main() {
    eprintln!("the keeper needs a unix socket and is not available on this platform");
    std::process::exit(2);
}
