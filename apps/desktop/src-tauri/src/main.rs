// Keep the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keeper mode (#280) branches off before the Tauri app is built: no window, no webview, no
    // registration with the window server. It is the same executable so it carries the same
    // signature and bundle identifier as the app.
    let args: Vec<String> = std::env::args().collect();
    if centralu_lib::is_keeper(&args) {
        std::process::exit(centralu_lib::run_keeper(&args));
    }
    centralu_lib::run()
}
