//! Control Center 데스크톱 셸.
//!
//! 여기서 하는 일은 셋뿐이다: 사이드카 감독, OS 통합(알림·뱃지·단축키·IDE 열기), 창 관리.
//! 대화·상태·화면은 전부 웹뷰 쪽에 있다 (docs/architecture.md §4).

mod sidecar;

use sidecar::{HostInfo, Supervisor};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[tauri::command]
fn host_info(sup: State<'_, Supervisor>) -> Option<HostInfo> {
    sup.info()
}

#[tauri::command]
fn host_error(sup: State<'_, Supervisor>) -> Option<String> {
    sup.last_error()
}

/// 독 아이콘 뱃지 (FR-12 ④단계 표시 계층).
/// 0이면 지운다 — 처리할 게 없는데 숫자가 남아 있으면 신호가 아니라 소음이다.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    let Some(window) = app.get_webview_window("main") else { return };
    let label = if count == 0 { None } else { Some(count.to_string()) };
    if let Err(e) = window.set_badge_label(label) {
        eprintln!("[badge] {e}");
    }
}

/// 편집기에서 파일을 연다 (FR-4의 왕복 비용 절감).
#[tauri::command]
fn open_in_ide(path: String, line: Option<u32>) -> Result<(), String> {
    let target = match line {
        Some(l) => format!("{path}:{l}"),
        None => path.clone(),
    };
    // code -g path:line 을 먼저 시도하고, 없으면 OS 기본 앱으로 연다
    let code = std::process::Command::new("code").arg("-g").arg(&target).spawn();
    if code.is_ok() {
        return Ok(());
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("파일을 열지 못했습니다: {e}"))
}

/// 창을 앞으로 가져온다 (알림 클릭·전역 단축키에서 사용).
#[tauri::command]
fn focus_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor = Supervisor::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(supervisor.clone())
        .invoke_handler(tauri::generate_handler![
            host_info,
            host_error,
            set_badge,
            open_in_ide,
            focus_window
        ])
        .setup({
            let sup = supervisor.clone();
            move |app| {
                sup.start(app.handle().clone());
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 생성하지 못했습니다")
        .run(move |app, event| {
            // 앱이 닫힐 때 사이드카를 확실히 죽인다 (좀비 프로세스 금지)
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                supervisor.shutdown();
                let _ = app.emit("host-status", "shutdown");
            }
        });
}
