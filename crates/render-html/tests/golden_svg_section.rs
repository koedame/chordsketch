/// Golden test for SVG section rendering in the HTML renderer.
///
/// Verifies that `{start_of_svg}`/`{end_of_svg}` sections produce the
/// expected HTML output, including safe SVG passthrough and dangerous
/// content stripping (e.g., `<script>` tags are removed).
#[test]
fn svg_section_html_golden() {
    let input = std::fs::read_to_string("tests/fixtures/svg-section/input.cho")
        .expect("read input.cho")
        .replace("\r\n", "\n");
    let expected = std::fs::read_to_string("tests/fixtures/svg-section/expected.html")
        .expect("read expected.html")
        .replace("\r\n", "\n");

    let actual = chordpro_render_html::render(&input);

    assert_eq!(
        actual, expected,
        "HTML output for SVG section does not match golden snapshot.\n\
         If the change is intentional, update tests/fixtures/svg-section/expected.html"
    );
}
