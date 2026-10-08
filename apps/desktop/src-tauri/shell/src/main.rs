//! `centralu-shell`, the executable of `Centralu.app` in `<data>/shell/` (docs/plans/thin-shell.md
//! §3). Everything is in the library, so it can be tested without starting this binary.

#[cfg(unix)]
fn main() {
    let argv: Vec<String> = std::env::args().collect();
    std::process::exit(centralu_shell::main_with(&argv));
}

/// The shell exists for macOS's permissions; Windows has no keeper to start (thin-shell.md §8).
#[cfg(not(unix))]
fn main() {
    eprintln!("centralu-shell runs on macOS only");
    std::process::exit(2);
}
