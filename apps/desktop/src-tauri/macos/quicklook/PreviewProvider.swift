// Quick Look preview extension for ChordPro files.
//
// A data-based preview (QLIsDataBasedPreview in Info.plist): the
// extension returns an HTML document and Quick Look displays it, so
// there is no view code here. Rendering happens in Rust, through the
// C ABI declared in ChordSketchQuickLook.h, so Finder shows the same
// markup as the desktop app, `chordsketch --format html`, and the
// Windows preview pane.

import Foundation
import QuickLookUI
import UniformTypeIdentifiers

@objc(ChordSketchPreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let html = try renderHTML(of: request.fileURL)
        // The size is Quick Look's starting window size; the document
        // reflows to whatever the user resizes it to.
        return QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 800, height: 1000)) { reply in
            reply.stringEncoding = .utf8
            return html
        }
    }

    private func renderHTML(of url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let source = try handle.read(upToCount: chordsketch_quicklook_read_limit()) ?? Data()

        var htmlLength = 0
        let html = source.withUnsafeBytes { buffer in
            chordsketch_quicklook_render(
                buffer.bindMemory(to: UInt8.self).baseAddress, buffer.count, &htmlLength)
        }
        defer { chordsketch_quicklook_free(html, htmlLength) }
        return Data(bytes: html, count: htmlLength)
    }
}
