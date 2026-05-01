"""
Smoke test for the chordsketch Python package.

Called from .github/workflows/python.yml by each per-OS test job
(test-ubuntu, test-macos, test-windows) after the wheel has been
installed, so that the test logic lives in a single place.
"""

import chordsketch

v = chordsketch.version()
assert v, "version should not be empty"
print(f"Version: {v}")

text = chordsketch.parse_and_render_text("{title: Test}\n[C]Hello", None, None)
assert "Test" in text and "Hello" in text
print("Text render: OK")

html = chordsketch.parse_and_render_html("{title: Test}\n[C]Hello", None, None)
assert "Test" in html
print("HTML render: OK")

pdf = chordsketch.parse_and_render_pdf("{title: Test}\n[C]Hello", None, None)
assert pdf[:4] == b"%PDF"
print("PDF render: OK")

errors = chordsketch.validate("{title: Valid}\n[C]Hello")
assert isinstance(errors, list)
assert len(errors) == 0
print("Validate (valid): OK")

# #2009: validate() now returns structured ValidationError records with
# line/column/message fields. Exercise the bad-input path so the smoke
# test catches a regression in the UniFFI wire shape, not just the
# function existing.
errors = chordsketch.validate("{title: Test}\n[G")
assert isinstance(errors, list)
assert len(errors) > 0
first = errors[0]
assert first.line >= 1
assert first.column >= 1
assert isinstance(first.message, str) and first.message
print("Validate (broken, structured): OK")

text = chordsketch.parse_and_render_text("{title: Test}\n[C]Hello", "guitar", None)
assert "Test" in text
print("Config preset: OK")

chordsketch.parse_and_render_text("{title: Test}\n[C]Hello", None, 2)
print("Transpose: OK")

# iReal Pro conversion (#2067 Phase 1).
TINY_IREAL_URL = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33"

result = chordsketch.convert_chordpro_to_irealb("{title: Test}\n[C]Hello")
assert result.output.startswith("irealb://"), f"unexpected output: {result.output}"
assert isinstance(result.warnings, list)
print("convert_chordpro_to_irealb: OK")

result = chordsketch.convert_irealb_to_chordpro_text(TINY_IREAL_URL)
assert "|" in result.output, "rendered text missing barlines"
assert isinstance(result.warnings, list)
print("convert_irealb_to_chordpro_text: OK")

# iReal Pro SVG render (#2067 Phase 2a).
svg = chordsketch.render_ireal_svg(TINY_IREAL_URL)
assert "<svg" in svg, f"expected SVG document, got: {svg[:200]}"
print("render_ireal_svg: OK")

# iReal Pro AST round-trip (#2067 Phase 2b).
json_ast = chordsketch.parse_irealb(TINY_IREAL_URL)
assert json_ast.startswith("{"), f"expected JSON object, got: {json_ast[:200]}"
assert '"sections"' in json_ast, "JSON must include the sections array"
assert '"key_signature"' in json_ast, "JSON must include the key_signature field"
print("parse_irealb: OK")

url2 = chordsketch.serialize_irealb(json_ast)
assert url2.startswith("irealb://"), f"unexpected output: {url2}"
json_ast2 = chordsketch.parse_irealb(url2)
assert json_ast == json_ast2, (
    "AST JSON must be stable across a parse → serialize → parse round-trip"
)
print("serialize_irealb (round-trip): OK")

# iReal Pro PNG render (#2067 Phase 2c).
png = chordsketch.render_ireal_png(TINY_IREAL_URL)
assert isinstance(png, bytes), f"expected bytes, got {type(png)}"
assert png[:8] == b"\x89PNG\r\n\x1a\n", f"expected PNG signature, got: {png[:8]!r}"
print("render_ireal_png: OK")

# iReal Pro PDF render (#2067 Phase 2c).
pdf = chordsketch.render_ireal_pdf(TINY_IREAL_URL)
assert isinstance(pdf, bytes), f"expected bytes, got {type(pdf)}"
assert pdf[:5] == b"%PDF-", f"expected PDF signature, got: {pdf[:5]!r}"
print("render_ireal_pdf: OK")

print("All smoke tests passed!")
