// Experiment shell: stays the parent, spawns the unbundled "keeper" from content/current.
import AppKit
import Foundation
let home = NSHomeDirectory() + "/centralu-shell-exp"
func log(_ s: String) {
  let line = "[shell pid=\(getpid())] \(s)\n"
  if let h = FileHandle(forWritingAtPath: home + "/log.txt") { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
  else { FileManager.default.createFile(atPath: home + "/log.txt", contents: line.data(using: .utf8)) }
}
let mode = ((try? String(contentsOfFile: home + "/mode", encoding: .utf8)) ?? "normal").trimmingCharacters(in: .whitespacesAndNewlines)
class D: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    let exe = home + "/content/current/content"
    var pid: pid_t = 0
    let args = [exe, "keeper", mode]
    var cargs = args.map { strdup($0) } + [nil]
    let rc = posix_spawn(&pid, exe, nil, nil, &cargs, environ)
    log("mode=\(mode) spawned keeper rc=\(rc) pid=\(pid)")
    if mode == "shell-exits" { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { log("exiting early"); exit(0) } ; return }
    DispatchQueue.global().async {
      var st: Int32 = 0; waitpid(pid, &st, 0)
      log("keeper exited; quitting"); DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }
}
let app = NSApplication.shared
let d = D(); app.delegate = d
app.setActivationPolicy(.regular)
app.run()
