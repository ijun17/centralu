import AppKit
let home = NSHomeDirectory() + "/centralu-shell-exp"
func log(_ s: String) { let h = FileHandle(forWritingAtPath: home + "/log.txt")!; h.seekToEndOfFile(); h.write("[inner-shell pid=\(getpid()) ppid=\(getppid())] \(s)\n".data(using: .utf8)!); h.closeFile() }
typealias RespFn = @convention(c) (pid_t) -> pid_t
let resp = unsafeBitCast(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")!, to: RespFn.self)
class D: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    // .../Outer.app/Contents/Helpers/Inner.app/Contents/MacOS/x -> .../Outer.app/Contents/Resources/content
    let outer = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent().deletingLastPathComponent()
    let exe = outer.appendingPathComponent("Resources/content").path
    let mode = ((try? String(contentsOfFile: home + "/mode", encoding: .utf8)) ?? "normal").trimmingCharacters(in: .whitespacesAndNewlines)
    var pid: pid_t = 0; var a = [strdup(exe), strdup("keeper"), strdup(mode), nil]
    log("responsible=\(resp(getpid())) spawned keeper \(exe) rc=\(posix_spawn(&pid, exe, nil, nil, &a, environ)) pid=\(pid)")
    DispatchQueue.global().async { var st: Int32 = 0; waitpid(pid, &st, 0); log("keeper exited; quitting"); DispatchQueue.main.async { NSApp.terminate(nil) } }
  }
}
let app = NSApplication.shared; let d = D(); app.delegate = d; app.setActivationPolicy(.accessory); app.run()
