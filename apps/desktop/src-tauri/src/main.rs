// Keep the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `centralu --keeper` (#280) branches off before the Tauri app is built: no window, no webview,
    // no registration with the window server. Since #440 the keeper is its own executable,
    // `centralu-keeper`; this branch runs the keeper only for a debug window that asked, and
    // otherwise exits at once (#461, `keeper::exe::run_from_window`). Dropping it would open a
    // window from a background keeper of 0.1.0-beta.11 or earlier handing over this way.
    let args: Vec<String> = std::env::args().collect();
    if centralu_lib::is_keeper(&args) {
        std::process::exit(centralu_lib::run_keeper(&args));
    }
    centralu_lib::run()
}
