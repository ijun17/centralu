// Keep the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `centralu --keeper` (#280) branches off before the Tauri app is built: no window, no webview,
    // no registration with the window server. Since #440 the keeper is its own executable,
    // `centralu-keeper`, and this branch only turns into it (`keeper::exe`), for the keepers and
    // windows of earlier builds that still start the keeper this way.
    let args: Vec<String> = std::env::args().collect();
    if centralu_lib::is_keeper(&args) {
        std::process::exit(centralu_lib::run_keeper(&args));
    }
    centralu_lib::run()
}
