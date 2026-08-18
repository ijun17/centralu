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

/// 자리를 비운 사람을 부르는 두 가지 — 소리와 독 아이콘.
///
/// **배너 대신이 아니라 배너를 대체한다.** macOS에서 `tauri-plugin-notification`은
/// `NSUserNotification`을 타는데 2018년(10.14)에 deprecated된 API라 지금 OS에서는
/// 아무것도 뜨지 않는다. 더 나쁜 것은 그 플러그인이 권한 상태를 **상수로** 돌려주고
/// (`Ok(PermissionState::Granted)`) 전달 실패를 `let _ =`로 버린다는 점이다 — 그래서
/// 앱은 한 통도 못 나갔다는 사실조차 알 수 없었다. 실측으로 확인한 내용이다.
///
/// 소리와 독은 알림 권한도 코드 서명도 타지 않는다. 이 맥에는 서명 인증서가 0개이므로
/// (`security find-identity` → 0 valid identities) 지금 사람에게 닿는 길은 여기뿐이다.
#[tauri::command]
fn alert(app: AppHandle, kind: String, sound: bool) {
    if sound {
        // 소리를 구분하는 것은 취향이 아니라 기능이다 — 옆방에서도 무슨 일인지 알 수 있다.
        play_sound(match kind.as_str() {
            "error" => "Basso",     // macOS가 예부터 "잘못됐다"에 쓰는 소리
            "all_done" => "Glass",  // 끝났다
            _ => "Submarine",       // 기다리는 중 (승인)
        });
    }
    let Some(window) = app.get_webview_window("main") else { return };
    // 승인·오류는 사람이 와야 풀린다 → 올 때까지 튄다.
    // "전부 완료"는 알려만 주면 되므로 한 번만 튄다.
    let attention = if kind == "all_done" {
        tauri::UserAttentionType::Informational
    } else {
        tauri::UserAttentionType::Critical
    };
    if let Err(e) = window.request_user_attention(Some(attention)) {
        eprintln!("[alert] 독 아이콘: {e}");
    }
}

/// `/System/Library/Sounds`의 소리 하나를 재생한다.
///
/// `NSSound`가 더 가벼워 보이지만 재생이 비동기라 객체를 살려 둬야 하고, 그러려면
/// 스레드를 넘나드는 보관소가 필요하다 (`Retained<NSSound>`는 Send가 아니다).
/// 짧은 소리 하나에 그 무게를 들이는 대신 `afplay`에 맡긴다 — 알림은 드물게 울린다.
#[cfg(target_os = "macos")]
fn play_sound(name: &str) {
    let path = format!("/System/Library/Sounds/{name}.aiff");
    match std::process::Command::new("/usr/bin/afplay").arg(&path).spawn() {
        // 거두지 않으면 좀비가 쌓인다 — 소리 하나가 끝날 때까지만 기다린다
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => eprintln!("[alert] 소리를 내지 못했습니다 ({path}): {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn play_sound(_name: &str) {}

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
#[cfg(target_os = "macos")]
mod traffic_lights;

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
            alert,
            open_in_ide,
            focus_window
        ])
        .setup({
            let sup = supervisor.clone();
            move |app| {
                sup.start(app.handle().clone());
                #[cfg(target_os = "macos")]
                traffic_lights::install(app.handle());
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
