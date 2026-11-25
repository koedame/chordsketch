//! Transparent PNGs must come out of the PDF writer as images a PDF reader
//! can actually paint.
//!
//! Each test builds a small PNG, embeds it, and then reads the produced PDF
//! back the way a viewer does: it follows the page's `/XObject` resource to
//! the image object, applies the stream filters (including the PNG
//! predictor) with an independent PDF parser (`lopdf`), applies `/SMask` or
//! `/Mask`, and composites the result over white. The expected pixels are
//! written out by hand, so a wrong object reference, a wrong predictor
//! setting or an ignored `tRNS` chunk all show up as wrong pixels.

use super::*;
use lopdf::{Dictionary, Document, Object};

type Rgb = [u8; 3];
/// Converts one pixel's color samples to RGB.
type ToRgb = Box<dyn Fn(&[u32]) -> Rgb>;

/// One PNG built by `png_bytes`: raw (unfiltered) rows plus the chunks around them.
struct PngSpec<'a> {
    width: u32,
    height: u32,
    color_type: u8,
    bit_depth: u8,
    /// Unfiltered scanlines, each already packed to whole bytes.
    rows: Vec<Vec<u8>>,
    plte: Option<&'a [u8]>,
    trns: Option<&'a [u8]>,
}

fn chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(payload);
    let mut out = (payload.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out.extend_from_slice(&crc.sum().to_be_bytes());
    out
}

/// Encode `spec` as a PNG, storing every scanline with the Sub filter so the
/// reader has to honour the predictor's pixel size.
fn png_bytes(spec: &PngSpec) -> Vec<u8> {
    let channels = match spec.color_type {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        other => panic!("unsupported color type {other}"),
    };
    let bpp = (channels * spec.bit_depth as usize).div_ceil(8);
    let mut filtered = Vec::new();
    for row in &spec.rows {
        filtered.push(1); // Sub
        for (i, byte) in row.iter().enumerate() {
            let left = if i >= bpp { row[i - bpp] } else { 0 };
            filtered.push(byte.wrapping_sub(left));
        }
    }
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&spec.width.to_be_bytes());
    ihdr.extend_from_slice(&spec.height.to_be_bytes());
    ihdr.extend_from_slice(&[spec.bit_depth, spec.color_type, 0, 0, 0]);

    let mut png = PNG_SIGNATURE.to_vec();
    png.extend(chunk(b"IHDR", &ihdr));
    if let Some(plte) = spec.plte {
        png.extend(chunk(b"PLTE", plte));
    }
    if let Some(trns) = spec.trns {
        png.extend(chunk(b"tRNS", trns));
    }
    png.extend(chunk(b"IDAT", &zlib_compress(&filtered).unwrap()));
    png.extend(chunk(b"IEND", &[]));
    png
}

/// Embed each PNG, draw them on one page, and return the PDF bytes.
fn pdf_with_pngs(pngs: &[Vec<u8>]) -> Vec<u8> {
    let mut doc = PdfDocument::new();
    for (i, png) in pngs.iter().enumerate() {
        let info = parse_png(png).expect("test PNG must parse");
        let idx = doc.embed_png(info);
        doc.draw_image(idx, 56.0, 700.0 - 100.0 * i as f32, 50.0, 50.0);
    }
    doc.build_pdf()
}

/// Undo the PNG predictor (`/Predictor 15`) of an image stream as the PDF
/// specification defines it: `/Columns` pixels of `/Colors` samples of
/// `/BitsPerComponent` bits per row, filtered over `ceil(Colors * bpc / 8)`
/// byte pixels. Only the filters the tests write (None and Sub) are handled.
fn undo_predictor(data: &[u8], params: &Dictionary) -> Vec<u8> {
    let get = |key: &[u8]| params.get(key).unwrap().as_i64().unwrap() as usize;
    assert_eq!(get(b"Predictor"), 15);
    let (columns, colors, bpc) = (get(b"Columns"), get(b"Colors"), get(b"BitsPerComponent"));
    let row_bytes = (columns * colors * bpc).div_ceil(8);
    let bpp = (colors * bpc).div_ceil(8);
    assert_eq!(
        data.len() % (row_bytes + 1),
        0,
        "predictor rows are the wrong size"
    );
    let mut out = Vec::new();
    for row in data.chunks(row_bytes + 1) {
        let start = out.len();
        for (i, &byte) in row[1..].iter().enumerate() {
            let left = match row[0] {
                0 => 0,
                1 if i >= bpp => out[start + i - bpp],
                1 => 0,
                other => panic!("test PNGs only use filters 0 and 1, got {other}"),
            };
            out.push(byte.wrapping_add(left));
        }
    }
    out
}

/// Samples of an image stream as `[row][pixel * components + c]`, unpacked
/// from `bpc`-bit samples to plain integers.
fn samples(dict: &Dictionary, stream: &lopdf::Stream, components: usize) -> Vec<Vec<u32>> {
    let width = dict.get(b"Width").unwrap().as_i64().unwrap() as usize;
    let height = dict.get(b"Height").unwrap().as_i64().unwrap() as usize;
    let bpc = dict.get(b"BitsPerComponent").unwrap().as_i64().unwrap() as usize;
    // Inflate only; the predictor is undone by `undo_predictor`.
    let mut inflated = stream.clone();
    inflated.dict.remove(b"DecodeParms");
    let data = undo_predictor(
        &inflated
            .decompressed_content()
            .expect("stream must inflate"),
        dict.get(b"DecodeParms").unwrap().as_dict().unwrap(),
    );
    let row_bytes = (width * components * bpc).div_ceil(8);
    assert_eq!(
        data.len(),
        row_bytes * height,
        "decoded stream has the wrong size"
    );
    data.chunks(row_bytes)
        .map(|row| {
            (0..width * components)
                .map(|n| match bpc {
                    16 => u32::from(u16::from_be_bytes([row[2 * n], row[2 * n + 1]])),
                    8 => u32::from(row[n]),
                    _ => {
                        let bit = n * bpc;
                        u32::from((row[bit / 8] >> (8 - bpc - bit % 8)) & ((1u16 << bpc) - 1) as u8)
                    }
                })
                .collect()
        })
        .collect()
}

/// Paint the image named `/Im{n}` of page 1 over white, the way a viewer would.
fn paint(pdf: &[u8], n: usize) -> Vec<Vec<Rgb>> {
    let doc = Document::load_mem(pdf).expect("output must be a readable PDF");
    // The writer puts the shared resources on the /Pages node.
    let catalog = doc.catalog().unwrap();
    let pages = doc
        .get_dictionary(catalog.get(b"Pages").unwrap().as_reference().unwrap())
        .unwrap();
    let xobjects = pages
        .get(b"Resources")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"XObject")
        .unwrap()
        .as_dict()
        .unwrap();
    let image_id = xobjects
        .get(format!("Im{n}").as_bytes())
        .unwrap()
        .as_reference()
        .unwrap();
    let image = doc.get_object(image_id).unwrap().as_stream().unwrap();
    let dict = &image.dict;
    assert_eq!(dict.get(b"Subtype").unwrap().as_name().unwrap(), b"Image");

    let max = |bpc: i64| ((1u32 << bpc) - 1) as f32;
    let bpc = dict.get(b"BitsPerComponent").unwrap().as_i64().unwrap();
    // Color: (samples, converter from one pixel's samples to RGB).
    let (components, colors, to_rgb): (usize, Vec<Vec<u32>>, ToRgb) =
        match dict.get(b"ColorSpace").unwrap() {
            Object::Name(name) if name == b"DeviceGray" => (
                1,
                samples(dict, image, 1),
                Box::new(move |s| [(s[0] as f32 / max(bpc) * 255.0).round() as u8; 3]),
            ),
            Object::Name(name) if name == b"DeviceRGB" => (
                3,
                samples(dict, image, 3),
                Box::new(move |s| {
                    let c = |v: u32| (v as f32 / max(bpc) * 255.0).round() as u8;
                    [c(s[0]), c(s[1]), c(s[2])]
                }),
            ),
            Object::Array(parts) => {
                assert_eq!(parts[0].as_name().unwrap(), b"Indexed");
                assert_eq!(parts[1].as_name().unwrap(), b"DeviceRGB");
                let palette = parts[3].as_str().unwrap().to_vec();
                (
                    1,
                    samples(dict, image, 1),
                    Box::new(move |s| {
                        let i = s[0] as usize * 3;
                        [palette[i], palette[i + 1], palette[i + 2]]
                    }),
                )
            }
            other => panic!("unexpected /ColorSpace {other:?}"),
        };

    // Alpha: /SMask (a gray image) or /Mask (a color key) or opaque.
    let alpha: Vec<Vec<f32>> = if let Ok(smask) = dict.get(b"SMask") {
        let smask_id = smask.as_reference().expect("/SMask must be a reference");
        let smask = doc.get_object(smask_id).unwrap().as_stream().unwrap();
        assert_ne!(smask_id, image_id, "/SMask must be a separate object");
        assert_eq!(
            smask.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
            b"DeviceGray"
        );
        let smask_max = max(smask
            .dict
            .get(b"BitsPerComponent")
            .unwrap()
            .as_i64()
            .unwrap());
        samples(&smask.dict, smask, 1)
            .iter()
            .map(|row| row.iter().map(|&a| a as f32 / smask_max).collect())
            .collect()
    } else if let Ok(Object::Array(key)) = dict.get(b"Mask") {
        let key: Vec<u32> = key.iter().map(|v| v.as_i64().unwrap() as u32).collect();
        assert_eq!(
            key.len(),
            components * 2,
            "/Mask needs a min and max per component"
        );
        samples(dict, image, components)
            .iter()
            .map(|row| {
                row.chunks(components)
                    .map(|px| {
                        let hit = px
                            .iter()
                            .enumerate()
                            .all(|(c, &v)| v >= key[2 * c] && v <= key[2 * c + 1]);
                        if hit { 0.0 } else { 1.0 }
                    })
                    .collect()
            })
            .collect()
    } else {
        colors
            .iter()
            .map(|row| vec![1.0; row.len() / components])
            .collect()
    };

    colors
        .iter()
        .zip(&alpha)
        .map(|(row, alpha_row)| {
            row.chunks(components)
                .zip(alpha_row)
                .map(|(px, &a)| {
                    let [r, g, b] = to_rgb(px);
                    let over = |c: u8| (f32::from(c) * a + 255.0 * (1.0 - a)).round() as u8;
                    [over(r), over(g), over(b)]
                })
                .collect()
        })
        .collect()
}

fn assert_pixels(actual: &[Vec<Rgb>], expected: &[&[Rgb]]) {
    assert_eq!(actual.len(), expected.len(), "row count");
    for (y, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(a.len(), e.len(), "row {y} width");
        for (x, (pa, pe)) in a.iter().zip(e.iter()).enumerate() {
            for c in 0..3 {
                assert!(
                    pa[c].abs_diff(pe[c]) <= 1,
                    "pixel ({x},{y}) is {pa:?}, expected {pe:?}"
                );
            }
        }
    }
}

const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
// Pure green at 50% alpha over white.
const HALF_GREEN: Rgb = [127, 255, 127];

#[test]
fn rgba_png_paints_color_through_its_alpha_mask() {
    let png = png_bytes(&PngSpec {
        width: 2,
        height: 2,
        color_type: 6,
        bit_depth: 8,
        rows: vec![
            vec![255, 0, 0, 255, 0, 255, 0, 0],
            vec![0, 255, 0, 128, 0, 0, 255, 255],
        ],
        plte: None,
        trns: None,
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[RED, WHITE], &[HALF_GREEN, BLUE]]);
}

#[test]
fn sixteen_bit_rgba_png_paints_color_through_its_alpha_mask() {
    let png = png_bytes(&PngSpec {
        width: 2,
        height: 1,
        color_type: 6,
        bit_depth: 16,
        rows: vec![vec![
            0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, // opaque red
            0, 0, 0xff, 0xff, 0, 0, 0, 0, // fully transparent green
        ]],
        plte: None,
        trns: None,
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[RED, WHITE]]);
}

#[test]
fn gray_alpha_png_paints_gray_through_its_alpha_mask() {
    let png = png_bytes(&PngSpec {
        width: 3,
        height: 1,
        color_type: 4,
        bit_depth: 8,
        rows: vec![vec![0, 255, 0, 0, 0, 128]],
        plte: None,
        trns: None,
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    // Opaque black, transparent, half-transparent black over white.
    assert_pixels(&pixels, &[&[[0, 0, 0], WHITE, [127, 127, 127]]]);
}

#[test]
fn indexed_png_with_trns_paints_transparent_entries_as_background() {
    // Palette: red, blue, red. tRNS covers only the first two entries, so
    // entry 2 is opaque.
    let png = png_bytes(&PngSpec {
        width: 3,
        height: 1,
        color_type: 3,
        bit_depth: 8,
        rows: vec![vec![0, 1, 2]],
        plte: Some(&[255, 0, 0, 0, 0, 255, 255, 0, 0]),
        trns: Some(&[255, 0]),
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[RED, WHITE, RED]]);
}

#[test]
fn four_bit_indexed_png_with_trns_paints_transparent_entries_as_background() {
    // Two pixels per byte: indices 0 1 | 1 0 | 0 1 (the last byte is padded).
    let png = png_bytes(&PngSpec {
        width: 3,
        height: 2,
        color_type: 3,
        bit_depth: 4,
        rows: vec![vec![0x01, 0x10], vec![0x01, 0x00]],
        plte: Some(&[255, 0, 0, 0, 0, 255]),
        trns: Some(&[255, 0]),
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[RED, WHITE, WHITE], &[RED, WHITE, RED]]);
}

#[test]
fn indexed_png_without_trns_paints_every_entry_opaque() {
    let png = png_bytes(&PngSpec {
        width: 2,
        height: 1,
        color_type: 3,
        bit_depth: 8,
        rows: vec![vec![1, 2]],
        plte: Some(&[255, 0, 0, 0, 0, 255, 0, 255, 0]),
        trns: None,
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[BLUE, [0, 255, 0]]]);
}

#[test]
fn gray_png_with_trns_paints_the_transparent_gray_as_background() {
    let png = png_bytes(&PngSpec {
        width: 3,
        height: 1,
        color_type: 0,
        bit_depth: 8,
        rows: vec![vec![0, 100, 200]],
        plte: None,
        trns: Some(&[0, 100]),
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[[0, 0, 0], WHITE, [200, 200, 200]]]);
}

#[test]
fn rgb_png_with_trns_paints_the_transparent_color_as_background() {
    let png = png_bytes(&PngSpec {
        width: 2,
        height: 1,
        color_type: 2,
        bit_depth: 8,
        rows: vec![vec![255, 0, 0, 0, 0, 255]],
        plte: None,
        trns: Some(&[0, 0, 0, 0, 0, 255]),
    });
    let pixels = paint(&pdf_with_pngs(&[png]), 1);
    assert_pixels(&pixels, &[&[RED, WHITE]]);
}

#[test]
fn images_after_a_transparent_png_still_resolve_to_their_own_object() {
    let rgba = png_bytes(&PngSpec {
        width: 1,
        height: 1,
        color_type: 6,
        bit_depth: 8,
        rows: vec![vec![255, 0, 0, 255]],
        plte: None,
        trns: None,
    });
    let rgb = png_bytes(&PngSpec {
        width: 1,
        height: 1,
        color_type: 2,
        bit_depth: 8,
        rows: vec![vec![0, 0, 255]],
        plte: None,
        trns: None,
    });
    let pdf = pdf_with_pngs(&[rgba, rgb]);
    assert_pixels(&paint(&pdf, 1), &[&[RED]]);
    assert_pixels(&paint(&pdf, 2), &[&[BLUE]]);
}
