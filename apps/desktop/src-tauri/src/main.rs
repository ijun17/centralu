// Windows 릴리스에서 콘솔 창이 뜨지 않게 한다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    control_center_lib::run()
}
