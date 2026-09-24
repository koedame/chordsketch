//! Byte-level reader for the Guitar Pro 5 binary format.
//!
//! Every multi-byte integer in a GP5 file is little-endian. Strings come in
//! three framings, all of which this reader exposes:
//!
//! - **byte-size string** (`read_byte_size_string`): one length byte, then a
//!   fixed-size field of which only the first `length` bytes are text.
//! - **int-size string** (`read_int_size_string`): an `i32` length, then that
//!   many bytes.
//! - **int-byte-size string** (`read_int_byte_size_string`): an `i32` field
//!   size, then a byte-size string whose field is `size - 1` bytes long.
//!
//! Every read is bounds-checked and returns [`GpError::Truncated`] instead of
//! panicking, so a truncated or corrupted file can never read past the end of
//! the input.

use crate::error::GpError;

/// Cursor over a GP5 byte buffer.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    /// Starts reading at the first byte of `bytes`.
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    /// Byte offset of the next read, for error messages.
    pub(crate) fn position(&self) -> usize {
        self.pos
    }

    /// Bytes left after the cursor.
    pub(crate) fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    /// Consumes `count` bytes and returns them.
    fn take(&mut self, count: usize) -> Result<&'a [u8], GpError> {
        if count > self.remaining() {
            return Err(GpError::Truncated { offset: self.pos });
        }
        let slice = &self.bytes[self.pos..self.pos + count];
        self.pos += count;
        Ok(slice)
    }

    /// Skips `count` bytes the importer does not need.
    pub(crate) fn skip(&mut self, count: usize) -> Result<(), GpError> {
        self.take(count).map(|_| ())
    }

    pub(crate) fn read_u8(&mut self) -> Result<u8, GpError> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn read_i8(&mut self) -> Result<i8, GpError> {
        Ok(i8::from_le_bytes([self.read_u8()?]))
    }

    pub(crate) fn read_bool(&mut self) -> Result<bool, GpError> {
        Ok(self.read_u8()? != 0)
    }

    pub(crate) fn read_i16(&mut self) -> Result<i16, GpError> {
        let b = self.take(2)?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }

    pub(crate) fn read_i32(&mut self) -> Result<i32, GpError> {
        let b = self.take(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// Reads an `i32` that counts following items, each at least
    /// `min_item_bytes` long, and rejects counts the rest of the input
    /// cannot hold. This bounds every allocation and loop by the input size.
    pub(crate) fn read_count(
        &mut self,
        what: &str,
        min_item_bytes: usize,
    ) -> Result<usize, GpError> {
        let offset = self.pos;
        let value = self.read_i32()?;
        let count = usize::try_from(value).map_err(|_| GpError::InvalidData {
            offset,
            message: format!("negative {what} ({value})"),
        })?;
        if count.saturating_mul(min_item_bytes.max(1)) > self.remaining() {
            return Err(GpError::InvalidData {
                offset,
                message: format!(
                    "{what} {count} does not fit in the {} bytes left",
                    self.remaining()
                ),
            });
        }
        Ok(count)
    }

    /// One length byte, then a `field_size`-byte field holding the text.
    pub(crate) fn read_byte_size_string(&mut self, field_size: usize) -> Result<String, GpError> {
        let offset = self.pos;
        let length = usize::from(self.read_u8()?);
        let field = self.take(field_size)?;
        if length > field_size {
            return Err(GpError::InvalidData {
                offset,
                message: format!("string length {length} exceeds its {field_size}-byte field"),
            });
        }
        Ok(decode(&field[..length]))
    }

    /// An `i32` length, then that many bytes of text.
    pub(crate) fn read_int_size_string(&mut self) -> Result<String, GpError> {
        let length = self.read_count("string length", 1)?;
        Ok(decode(self.take(length)?))
    }

    /// An `i32` field size, then a byte-size string in a `size - 1` field.
    pub(crate) fn read_int_byte_size_string(&mut self) -> Result<String, GpError> {
        let offset = self.pos;
        let size = self.read_count("string field size", 1)?;
        if size == 0 {
            return Err(GpError::InvalidData {
                offset,
                message: "string field size 0 leaves no room for the length byte".to_string(),
            });
        }
        self.read_byte_size_string(size - 1)
    }
}

/// Decodes a GP string.
///
/// Guitar Pro writes strings in the 8-bit code page of the machine that saved
/// the file; files from Western systems use Windows-1252. Text that is valid
/// UTF-8 (written by newer tools) is taken as-is; anything else is decoded as
/// Windows-1252, which maps every byte to a character, so decoding never
/// fails.
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

/// Maps one Windows-1252 byte to its character.
///
/// 0x80–0x9F are the code page's printable additions (curly quotes, dashes,
/// the euro sign); the five bytes the code page leaves undefined map to the
/// C1 control of the same value, as the WHATWG encoding standard does.
/// Every other byte is the Latin-1 character of the same value.
fn windows_1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{2C6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}',
        '\u{8F}', '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}',
        '\u{2014}', '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}', '\u{17E}',
        '\u{178}',
    ];
    match byte {
        0x80..=0x9F => HIGH[usize::from(byte - 0x80)],
        _ => char::from(byte),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_reading_integers_they_are_little_endian() {
        let mut r = Reader::new(&[0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xFF]);
        assert_eq!(r.read_i16().unwrap(), 0x1234);
        assert_eq!(r.read_i32().unwrap(), 0x1234_5678);
        assert_eq!(r.read_i8().unwrap(), -1);
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn when_the_input_ends_mid_value_the_error_names_the_offset() {
        let mut r = Reader::new(&[1, 2, 3]);
        r.skip(1).unwrap();
        assert_eq!(r.read_i32(), Err(GpError::Truncated { offset: 1 }));
    }

    #[test]
    fn when_a_byte_size_string_is_shorter_than_its_field_the_padding_is_dropped() {
        let mut r = Reader::new(&[2, b'E', b'm', 0, 0, 0xAA]);
        assert_eq!(r.read_byte_size_string(4).unwrap(), "Em");
        assert_eq!(r.read_u8().unwrap(), 0xAA);
    }

    #[test]
    fn when_a_string_length_exceeds_its_field_it_is_rejected() {
        let mut r = Reader::new(&[9, b'a', b'b']);
        assert!(matches!(
            r.read_byte_size_string(2),
            Err(GpError::InvalidData { offset: 0, .. })
        ));
    }

    #[test]
    fn when_an_int_byte_size_string_is_read_the_field_is_size_minus_one() {
        // size 4 → length byte + 3-byte field.
        let mut r = Reader::new(&[4, 0, 0, 0, 2, b'h', b'i', 0, 7]);
        assert_eq!(r.read_int_byte_size_string().unwrap(), "hi");
        assert_eq!(r.read_u8().unwrap(), 7);
    }

    #[test]
    fn when_a_count_cannot_fit_in_the_rest_of_the_input_it_is_rejected() {
        let mut r = Reader::new(&[0xFF, 0xFF, 0xFF, 0x7F, 0]);
        assert!(matches!(
            r.read_count("measure count", 1),
            Err(GpError::InvalidData { .. })
        ));
        let mut r = Reader::new(&[0xFF, 0xFF, 0xFF, 0xFF]);
        assert!(matches!(
            r.read_count("track count", 1),
            Err(GpError::InvalidData { .. })
        ));
    }

    #[test]
    fn when_text_is_not_utf8_it_is_decoded_as_windows_1252() {
        // "Café" in Windows-1252 and a curly apostrophe (0x92).
        assert_eq!(decode(&[b'C', b'a', b'f', 0xE9]), "Café");
        assert_eq!(decode(&[b'I', 0x92, b'm']), "I\u{2019}m");
    }

    #[test]
    fn when_text_is_valid_utf8_it_is_kept_as_is() {
        assert_eq!(decode("きらきら星".as_bytes()), "きらきら星");
    }
}
