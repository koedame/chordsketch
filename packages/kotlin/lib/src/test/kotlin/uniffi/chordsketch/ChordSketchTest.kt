package uniffi.chordsketch

import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.test.assertFalse
import kotlin.test.assertEquals

class ChordSketchTest {
    private val minimalInput = "{title: Test}\n[C]Hello"

    // Tiny irealb:// fixture from `crates/convert/tests/from_ireal.rs`.
    private val tinyIrealUrl =
        "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33"

    @Test
    fun testVersion() {
        val v = version()
        assertTrue(v.isNotEmpty())
    }

    @Test
    fun testRenderText() {
        val text = parseAndRenderText(minimalInput, null, null)
        assertTrue(text.contains("Test"))
        assertTrue(text.contains("Hello"))
    }

    @Test
    fun testRenderHtml() {
        val html = parseAndRenderHtml(minimalInput, null, null)
        assertTrue(html.contains("Test"))
    }

    @Test
    fun testRenderPdf() {
        val pdf = parseAndRenderPdf(minimalInput, null, null)
        assertTrue(pdf.isNotEmpty())
        // PDF files start with %PDF
        assertEquals("%PDF", String(pdf.sliceArray(0..3)))
    }

    @Test
    fun testValidate() {
        val errors = validate(minimalInput)
        assertTrue(errors.isEmpty())
    }

    @Test
    fun testRenderWithPreset() {
        val text = parseAndRenderText(minimalInput, "guitar", null)
        assertTrue(text.contains("Test"))
    }

    @Test
    fun testRenderWithTranspose() {
        val text = parseAndRenderText(minimalInput, null, 2)
        assertTrue(text.isNotEmpty())
    }

    // iReal Pro conversion (#2067 Phase 1).

    @Test
    fun testConvertChordproToIrealb() {
        val result = convertChordproToIrealb(minimalInput)
        assertTrue(
            result.output.startsWith("irealb://"),
            "unexpected output: ${result.output}",
        )
    }

    @Test
    fun testConvertIrealbToChordproText() {
        val result = convertIrealbToChordproText(tinyIrealUrl)
        assertTrue(result.output.contains("|"), "expected barlines in output: ${result.output}")
    }

    // iReal Pro SVG render (#2067 Phase 2a).

    @Test
    fun testRenderIrealSvg() {
        val svg = renderIrealSvg(tinyIrealUrl)
        assertTrue(
            svg.contains("<svg"),
            "expected SVG document, got: ${svg.take(200)}",
        )
    }

    // iReal Pro PNG / PDF render (#2067 Phase 2c).

    @Test
    fun testRenderIrealPng() {
        val png = renderIrealPng(tinyIrealUrl)
        assertTrue(png.size >= 8, "expected at least 8 bytes, got ${png.size}")
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        assertEquals(
            signature.toList(),
            png.sliceArray(0..7).toList(),
            "expected PNG signature, got: ${png.sliceArray(0..7).toList()}",
        )
    }

    @Test
    fun testRenderIrealPdf() {
        val pdf = renderIrealPdf(tinyIrealUrl)
        assertTrue(pdf.size >= 5, "expected at least 5 bytes, got ${pdf.size}")
        assertEquals("%PDF-", String(pdf.sliceArray(0..4)))
    }
}
