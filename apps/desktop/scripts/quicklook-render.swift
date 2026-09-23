// Shows a file in a Quick Look preview view — the same view Finder's
// Space panel uses — and screenshots the window.
//
// Usage: swift quicklook-render.swift <file> <output.png> [seconds]
//
// Used by quicklook-smoke.sh instead of `qlmanage -p`, which aborts
// with an ExtensionFoundation "key cannot be nil" exception for every
// app-extension preview on current macOS, whatever the extension.

import AppKit
import Quartz

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: quicklook-render.swift <file> <output.png> [seconds]\n".utf8))
    exit(2)
}
let file = URL(fileURLWithPath: arguments[1])
let output = arguments[2]
let seconds = arguments.count > 3 ? Double(arguments[3]) ?? 15 : 15

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let window = NSWindow(
    contentRect: NSRect(x: 80, y: 80, width: 800, height: 900),
    styleMask: [.titled],
    backing: .buffered,
    defer: false)
guard let content = window.contentView, let preview = QLPreviewView(frame: content.bounds, style: .normal) else {
    FileHandle.standardError.write(Data("could not create a QLPreviewView\n".utf8))
    exit(1)
}
preview.autoresizingMask = [.width, .height]
content.addSubview(preview)
preview.previewItem = file as NSURL
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), output]
    do {
        try capture.run()
        capture.waitUntilExit()
        exit(capture.terminationStatus)
    } catch {
        FileHandle.standardError.write(Data("screencapture failed: \(error)\n".utf8))
        exit(1)
    }
}
app.run()
