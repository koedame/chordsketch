# frozen_string_literal: true

require "minitest/autorun"
require "chordsketch"

class TestChordSketch < Minitest::Test
  MINIMAL_INPUT = "{title: Test}\n[C]Hello"
  # Tiny irealb:// fixture from `crates/convert/tests/from_ireal.rs`.
  TINY_IREAL_URL = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33"

  def test_version
    v = Chordsketch.version
    refute_empty v
  end

  def test_render_text
    text = Chordsketch.parse_and_render_text(MINIMAL_INPUT, nil, nil)
    assert_includes text, "Test"
    assert_includes text, "Hello"
  end

  def test_render_html
    html = Chordsketch.parse_and_render_html(MINIMAL_INPUT, nil, nil)
    assert_includes html, "Test"
  end

  def test_render_pdf
    pdf = Chordsketch.parse_and_render_pdf(MINIMAL_INPUT, nil, nil)
    refute_empty pdf
    assert_equal "%PDF", pdf[0..3]
  end

  def test_validate
    errors = Chordsketch.validate(MINIMAL_INPUT)
    assert_kind_of Array, errors
    assert_empty errors
  end

  def test_render_with_preset
    text = Chordsketch.parse_and_render_text(MINIMAL_INPUT, "guitar", nil)
    assert_includes text, "Test"
  end

  def test_render_with_transpose
    text = Chordsketch.parse_and_render_text(MINIMAL_INPUT, nil, 2)
    refute_empty text
  end

  # iReal Pro conversion (#2067 Phase 1).

  def test_convert_chordpro_to_irealb
    result = Chordsketch.convert_chordpro_to_irealb(MINIMAL_INPUT)
    assert result.output.start_with?("irealb://"), "unexpected output: #{result.output}"
    assert_kind_of Array, result.warnings
  end

  def test_convert_irealb_to_chordpro_text
    result = Chordsketch.convert_irealb_to_chordpro_text(TINY_IREAL_URL)
    assert_includes result.output, "|"
    assert_kind_of Array, result.warnings
  end

  # iReal Pro SVG render (#2067 Phase 2a).

  def test_render_ireal_svg
    svg = Chordsketch.render_ireal_svg(TINY_IREAL_URL)
    assert svg.include?("<svg"), "expected SVG document, got: #{svg[0..200]}"
  end

  # iReal Pro AST round-trip (#2067 Phase 2b).

  def test_parse_irealb_emits_ast_json
    json = Chordsketch.parse_irealb(TINY_IREAL_URL)
    assert json.start_with?("{"), "expected JSON object, got: #{json[0..200]}"
    assert_includes json, '"sections"'
    assert_includes json, '"key_signature"'
  end

  def test_serialize_irealb_round_trip
    json1 = Chordsketch.parse_irealb(TINY_IREAL_URL)
    url2 = Chordsketch.serialize_irealb(json1)
    assert url2.start_with?("irealb://"), "unexpected output: #{url2}"
    json2 = Chordsketch.parse_irealb(url2)
    assert_equal json1, json2,
                 "AST JSON must be stable across a parse → serialize → parse round-trip"
  end

  # iReal Pro PNG / PDF render (#2067 Phase 2c).

  def test_render_ireal_png
    png = Chordsketch.render_ireal_png(TINY_IREAL_URL)
    assert_kind_of String, png
    # PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert_equal "\x89PNG\r\n\x1A\n".b, png[0, 8].b,
                 "expected PNG signature, got: #{png[0, 8].bytes}"
  end

  def test_render_ireal_pdf
    pdf = Chordsketch.render_ireal_pdf(TINY_IREAL_URL)
    assert_kind_of String, pdf
    assert_equal "%PDF-".b, pdf[0, 5].b,
                 "expected PDF signature, got: #{pdf[0, 5]}"
  end
end
