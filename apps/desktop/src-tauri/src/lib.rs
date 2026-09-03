//! Centralu 데스크톱 셸.
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
    if let Err(e) = write_badge(&window, count) {
        eprintln!("[badge] {e}");
    }
}

#[cfg(target_os = "macos")]
fn write_badge(window: &tauri::WebviewWindow, count: u32) -> tauri::Result<()> {
    // The dock badge is a text bubble on macOS, so we hand it the number as a label.
    window.set_badge_label(if count == 0 { None } else { Some(count.to_string()) })
}

#[cfg(not(target_os = "macos"))]
fn write_badge(window: &tauri::WebviewWindow, count: u32) -> tauri::Result<()> {
    // `set_badge_label` is `#[cfg(target_os = "macos")]` inside tauri itself, so the
    // macOS branch above is not merely wrong off macOS — it does not compile there.
    // `set_badge_count` is the portable call.
    //
    // Be honest about what it buys us on Linux: it goes out over the Unity launcher
    // D-Bus API, which only some desktops listen to (GNOME with dash-to-dock, KDE).
    // Everywhere else it lands nowhere and there is nothing this process can do about
    // it. That is why Linux must not depend on the badge to reach a person — the
    // desktop notification in `notify()` and the urgency hint in `alert()` do that.
    window.set_badge_count(if count == 0 { None } else { Some(i64::from(count)) })
}

/// The "open this with whatever the desktop uses" command.
///
/// This used to be hardcoded to `open`. Off macOS that is not a missing command but a
/// *different* one: util-linux ships `/usr/bin/open` as an alias of `openvt`, which
/// switches virtual consoles. So the fallback did not fail loudly, it did something
/// unrelated. `xdg-open` is the freedesktop equivalent of macOS `open`.
#[cfg(target_os = "macos")]
const GENERIC_OPENER: &str = "open";
#[cfg(not(target_os = "macos"))]
const GENERIC_OPENER: &str = "xdg-open";

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
    std::process::Command::new(GENERIC_OPENER)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("파일을 열지 못했습니다: {e}"))
}

/// 파일 관리자에서 그 파일을 보여준다 (#19의 "Open in Finder").
///
/// `open`·`xdg-open`을 쓰지 않는다 — 그건 **파일을 여는** 명령이라, 스크립트를 골랐을 때
/// 그것을 실행해 버릴 수 있다. 플러그인의 `reveal_item_in_dir`은 macOS에서 NSWorkspace,
/// 리눅스에서 org.freedesktop.FileManager1(없으면 상위 폴더 열기)로 내려가는,
/// "여는 게 아니라 가리키는" 쪽의 API다.
///
/// 여기서 플러그인의 **JS 커맨드가 아니라 러스트 함수**를 부르기 때문에
/// `opener:allow-reveal-item-in-dir` 권한은 필요 없다. 웹뷰가 부르는 것은 이 앱의
/// 커맨드이고, 앱 자신의 커맨드는 capability 목록을 타지 않는다.
///
/// 오류는 **이유만** 돌려준다. 무엇을 하려다 실패했는지는 화면 쪽이 이미 알고 있어서
/// ("Could not show a.ts: …") 여기서 한 번 더 붙이면 같은 말이 두 번 나온다.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// 휴지통으로 보낸다 (#18) — 지우는 게 아니다.
///
/// 확인 대화상자 대신 휴지통을 고른 이유가 이것이다: 되돌릴 수 있는 시점이 **누른 뒤**로
/// 옮겨간다. 대화상자는 누르기 전까지만 되돌릴 수 있다.
///
/// macOS 백엔드를 `NsFileManager`로 바꾼다. 크레이트 기본값은 Finder에게 AppleScript로
/// 시키는 방식인데, 그러면 자동화 권한(TCC)을 물어보고 거절당하면 아무 일도 일어나지
/// 않는다 — 이 앱은 서명 인증서가 없어서 그 프롬프트가 특히 나쁘게 끝난다.
/// 대가는 Finder 컨텍스트 메뉴의 "제자리에 돌려놓기"가 일부 macOS에서 안 뜨는 것인데
/// (macOS 쪽 결함), 파일은 그대로 휴지통에 있고 끌어내면 되므로 되돌릴 수 있다는 약속은
/// 지켜진다. 권한 프롬프트에 막혀 **삭제 자체가 조용히 실패하는 것**이 더 나쁘다.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    send_to_trash(&path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn send_to_trash(path: &str) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

/// 리눅스·윈도우는 기본 백엔드가 곧 OS의 휴지통이다.
/// 리눅스 쪽은 freedesktop 휴지통 규격 1.0 구현이라 GNOME·KDE·XFCE에서 같은 자리로 간다 —
/// 다른 마운트 지점의 파일은 규격대로 그 볼륨의 `.Trash-$uid`로 가고, 그럴 수 없는
/// 파일 시스템(FAT 등)에서는 실패가 그대로 올라온다. 조용히 지우는 것보다 낫다.
#[cfg(not(target_os = "macos"))]
fn send_to_trash(path: &str) -> Result<(), trash::Error> {
    trash::delete(path)
}

/// 이 데스크톱이 파일 관리자를 뭐라고 부르는가.
///
/// 자판 표기(`shortcut_keys`)와 같은 거래다: UI는 어느 OS인지 물을 수 없으므로
/// **이름**을 물어 그대로 찍는다. 리눅스에는 하나의 답이 없어서(Nautilus·Dolphin·Thunar)
/// 짐작 대신 일반 명사를 준다.
#[tauri::command]
fn file_manager_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Finder"
    }
    #[cfg(target_os = "windows")]
    {
        "File Explorer"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "file manager"
    }
}

/// How much room the OS window controls take on the left edge of our own top bar, in px.
///
/// macOS keeps the traffic lights *inside* our overlay title bar, so the bar has to
/// leave a hole for them or the first thing we draw sits under the buttons. Other
/// desktops draw their decorations in a separate strip above our bar, so the bar owns
/// the full width and the same padding would just be dead space.
///
/// The UI is not allowed to ask which OS it is on (docs/platform-abstraction.md): it
/// asks how much room to leave and we answer. That keeps the one number that has to
/// agree with `traffic_lights::INSET_X` on this side of the boundary.
#[tauri::command]
fn window_controls_inset() -> u32 {
    #[cfg(target_os = "macos")]
    {
        // INSET_X (19) + the three 12px buttons and the gaps macOS puts between them,
        // plus breathing room before our first item.
        86
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// What this machine's keyboard prints on the two modifier keys the UI shows.
///
/// `join` is what goes between keys when a combination is written as one string. macOS
/// writes `⌘⇧A` with nothing in between, which reads because the parts are symbols; carry
/// that rule over to keyboards where the parts are words and you get `CtrlShiftA`.
#[derive(serde::Serialize)]
struct ShortcutKeys {
    // `mod` is a Rust keyword, so the field is named for what it is and renamed on the wire.
    #[serde(rename = "mod")]
    modifier: &'static str,
    alt: &'static str,
    join: &'static str,
}

/// The labels for shortcut hints, since the UI is not allowed to ask which OS it is on.
///
/// The bindings themselves need no help — every handler already takes `metaKey ||
/// ctrlKey`, so the shortcuts have always worked here and on Linux alike. It was only the
/// hints that were wrong, and they were wrong everywhere at once because `⌘` was written
/// out at each of them. A key that is not on the keyboard is a worse hint than none.
#[tauri::command]
fn shortcut_keys() -> ShortcutKeys {
    #[cfg(target_os = "macos")]
    {
        ShortcutKeys { modifier: "⌘", alt: "⌥", join: "" }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ShortcutKeys { modifier: "Ctrl", alt: "Alt", join: "+" }
    }
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
///
/// On Linux the ranking is the other way round. The banner path there is real — the
/// notification plugin talks org.freedesktop.Notifications over D-Bus — while the badge
/// only reaches Unity-style launchers. So Linux leans on the banner, and this function
/// adds the two things a banner does not do: a sound, and an urgency hint on the window
/// so the taskbar entry keeps asking after the banner has faded.
#[tauri::command]
fn alert(app: AppHandle, kind: String, sound: bool) {
    if sound {
        play_sound(&kind);
    }
    let Some(window) = app.get_webview_window("main") else { return };
    // 승인·오류는 사람이 와야 풀린다 → 올 때까지 튄다.
    // 완료는 알려만 주면 되므로 한 번만 튄다 — 끝난 일로 계속 부르면 그건 재촉이다.
    let attention = if kind == "done" || kind == "all_done" {
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
///
/// The argument is the alert *kind*, not a sound name. It used to be a macOS sound name
/// picked by the caller, which meant the caller had to know what macOS calls its sounds
/// — and there was no honest way for another OS to answer that question.
#[cfg(target_os = "macos")]
fn play_sound(kind: &str) {
    // 소리를 구분하는 것은 취향이 아니라 기능이다 — 옆방에서도 무슨 일인지 알 수 있다.
    let name = match kind {
        "error" => "Basso",    // macOS가 예부터 "잘못됐다"에 쓰는 소리
        "done" => "Tink",      // 하나 끝났다 — 가볍게
        "all_done" => "Glass", // 다 끝났다
        _ => "Submarine",      // 기다리는 중 (승인)
    };
    let path = format!("/System/Library/Sounds/{name}.aiff");
    if let Err(e) = spawn_and_reap("/usr/bin/afplay", &[&path]) {
        eprintln!("[alert] 소리를 내지 못했습니다 ({path}): {e}");
    }
}

/// Same four meanings, spoken in freedesktop terms.
///
/// The names are XDG sound-theme event ids, not file paths, because the file layout is
/// not portable across distributions but the event ids are (the sound theme spec is what
/// every desktop implements). `canberra-gtk-play` resolves the id through the user's
/// chosen theme and honours their event-sound setting; if it is not installed we fall
/// back to playing the freedesktop theme file directly through PulseAudio/PipeWire.
///
/// If neither exists we say so once. A silent failure here is exactly the bug this whole
/// alert path was written to avoid: the person who walked away never learns that the
/// thing meant to call them back was never able to make a sound.
///
/// Known gap, stated rather than hidden: we only notice whether the player *started*,
/// not whether it found the sound. If canberra is installed but the sound theme is not,
/// it exits non-zero after we have already stopped looking, and the alert is silent.
/// Waiting for the exit status would mean blocking the alert path on a subprocess,
/// which is a worse trade for something that fires on every turn.
#[cfg(target_os = "linux")]
fn play_sound(kind: &str) {
    let event = match kind {
        "error" => "dialog-error",
        "done" => "complete",
        "all_done" => "complete",
        _ => "message", // waiting on a human (approval)
    };
    if spawn_and_reap("canberra-gtk-play", &["-i", event]).is_ok() {
        return;
    }
    let file = format!("/usr/share/sounds/freedesktop/stereo/{event}.oga");
    if std::path::Path::new(&file).exists() && spawn_and_reap("paplay", &[&file]).is_ok() {
        return;
    }
    warn_once(
        "[alert] no way to play a sound: install libcanberra-gtk3 (canberra-gtk-play) \
         or pulseaudio-utils (paplay). Notifications still go out; only the sound is missing.",
    );
}

/// Deliberately silent, and deliberately not a compile error.
///
/// Windows is not supported yet (issue #14 covers Linux only). Leaving `play_sound`
/// undefined for it would break the build before anyone got as far as finding out what
/// else is missing, so this arm exists to keep the failure where it belongs.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn play_sound(_kind: &str) {}

/// Spawns a fire-and-forget child and reaps it. `Err` means it could not start at all.
///
/// The reaping matters: without it every alert leaves a zombie behind, and alerts fire
/// for the whole life of the app. The error is handed back rather than logged here
/// because the caller knows what it was trying to play, and "could not play a sound"
/// without the reason is the kind of log line nobody can act on.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawn_and_reap(program: &str, args: &[&str]) -> std::io::Result<()> {
    let mut child = std::process::Command::new(program).args(args).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Says a thing once. Repeating it on every alert would itself become the noise.
#[cfg(target_os = "linux")]
fn warn_once(message: &str) {
    static SAID: std::sync::Once = std::sync::Once::new();
    SAID.call_once(|| eprintln!("{message}"));
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

/**
 * 사람이 모달에서 종료를 확인했다 (도그푸딩 2026-09-04: ⌘Q/⌘W 즉시 종료 방지).
 *
 * 플래그를 먼저 세우고 exit를 부른다 — 이 exit이 다시 ExitRequested를 낳는데,
 * 그때는 관문(아래 run 콜백)이 열려 있어야 한다. 관문이 코드(Some/None)만 보면
 * 우리가 낸 exit과 시스템 terminate를 못 가르는 플랫폼이 생길 수 있어 플래그가 정본이다.
 */
#[tauri::command]
fn quit_app(app: AppHandle, approved: State<QuitApproved>) {
    approved.0.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/** 종료 확인 플래그 — 모달의 "Quit"만이 이것을 세운다 */
struct QuitApproved(std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(target_os = "macos")]
mod traffic_lights;

pub fn run() {
    let supervisor = Supervisor::new();
    let quit_approved = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(supervisor.clone())
        .manage(QuitApproved(quit_approved.clone()))
        .invoke_handler(tauri::generate_handler![
            host_info,
            host_error,
            set_badge,
            alert,
            open_in_ide,
            reveal_path,
            trash_path,
            file_manager_name,
            focus_window,
            window_controls_inset,
            shortcut_keys,
            quit_app
        ])
        /*
         * ⌘W·빨간 단추 = 창 닫기. 창 하나짜리 앱이라 닫기는 곧 종료다 — 즉시 닫는
         * 대신 웹뷰에 묻는다 (도그푸딩: 작업 중 ⌘W 오타 한 번이 세션 전부를 내렸다).
         */
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
        })
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
            /*
             * ⌘Q(시스템 terminate)의 관문 (도그푸딩 2026-09-04). 사람이 모달에서
             * 확인하기 전에는 종료를 막고 웹뷰에 묻는다 — quit_app만이 플래그를
             * 세우므로, 그 뒤에 다시 도착하는 ExitRequested는 그대로 지나간다.
             *
             * `code`는 문서화된 구분선이다: None = 사용자 상호작용(⌘Q·독 Quit·로그아웃),
             * Some = 프로그램적 종료(AppHandle::exit/restart — 업데이터의 재시작이
             * 이 길로 온다). Some까지 막으면 앱이 자기 재시작을 자기가 막는다.
             */
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() && !quit_approved.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("quit-requested", ());
                    return;
                }
            }
            // 앱이 닫힐 때 사이드카를 확실히 죽인다 (좀비 프로세스 금지)
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                supervisor.shutdown();
                let _ = app.emit("host-status", "shutdown");
            }
        });
}
