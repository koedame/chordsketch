import XCTest
import ChordSketch

final class ChordSketchTests: XCTestCase {
    let minimalInput = "{title: Test}\n[C]Hello"

    func testVersion() throws {
        let v = ChordSketch.version()
        XCTAssertFalse(v.isEmpty)
    }

    func testRenderText() throws {
        let text = try ChordSketch.parseAndRenderText(input: minimalInput, configJson: nil, transpose: nil)
        XCTAssert(text.contains("Test"))
        XCTAssert(text.contains("Hello"))
    }

    func testRenderHtml() throws {
        let html = try ChordSketch.parseAndRenderHtml(input: minimalInput, configJson: nil, transpose: nil)
        XCTAssert(html.contains("Test"))
    }

    func testRenderPdf() throws {
        let pdf = try ChordSketch.parseAndRenderPdf(input: minimalInput, configJson: nil, transpose: nil)
        XCTAssertFalse(pdf.isEmpty)
        // PDF files start with %PDF
        XCTAssertEqual(String(bytes: Array(pdf.prefix(4)), encoding: .ascii), "%PDF")
    }

    func testValidate() throws {
        let errors = ChordSketch.validate(input: minimalInput)
        XCTAssert(errors.isEmpty)
    }

    func testRenderWithPreset() throws {
        let text = try ChordSketch.parseAndRenderText(input: minimalInput, configJson: "guitar", transpose: nil)
        XCTAssert(text.contains("Test"))
    }

    func testRenderWithTranspose() throws {
        let text = try ChordSketch.parseAndRenderText(input: minimalInput, configJson: nil, transpose: 2)
        XCTAssertFalse(text.isEmpty)
    }
}
