import XCTest
import ChordSketch

final class ChordSketchTests: XCTestCase {
    let minimalInput = "{title: Test}\n[C]Hello"
    // Tiny irealb:// fixture from `crates/convert/tests/from_ireal.rs`.
    let tinyIrealUrl = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33"

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

    // iReal Pro conversion (#2067 Phase 1).

    func testConvertChordproToIrealb() throws {
        let result = try ChordSketch.convertChordproToIrealb(input: minimalInput)
        XCTAssertTrue(result.output.hasPrefix("irealb://"), "unexpected output: \(result.output)")
    }

    func testConvertIrealbToChordproText() throws {
        let result = try ChordSketch.convertIrealbToChordproText(input: tinyIrealUrl)
        XCTAssertTrue(result.output.contains("|"), "expected barlines in output: \(result.output)")
    }
}
