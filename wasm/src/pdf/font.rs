//! Font-encoding decoder.
//!
//! Turns raw byte/glyph sequences from a PDF content stream into Unicode
//! strings. Supports:
//!
//! * ToUnicode CMaps (most modern PDFs)
//! * Standard Type-1 / WinAnsi / MacRoman encodings (fallback)
//! * Identity-H/V CID fonts (best-effort: treat code-point as Unicode scalar)
//!
//! This is intentionally "good enough for text extraction" rather than a
//! standards-complete CMap implementation.

use std::collections::HashMap;
use lopdf::{Dictionary, Document, Object};

/// Maps a (multi-byte) character code to a Unicode string.
pub type CharMap = HashMap<u32, String>;

/// Font descriptor cached per resource name.
#[derive(Clone)]
pub struct FontInfo {
    pub char_map: Option<CharMap>,
    pub is_multibyte: bool,
    pub base_encoding: BaseEncoding,
}

#[derive(Clone, Debug)]
pub enum BaseEncoding {
    WinAnsi,
    MacRoman,
    Standard,
    Identity,
    Unknown,
}

/// Build a [`FontInfo`] from the font dictionary inside a PDF resource dict.
pub fn build_font_info(doc: &Document, font_dict: &Dictionary) -> FontInfo {
    let is_multibyte = is_cid_font(font_dict);
    let char_map = extract_to_unicode(doc, font_dict);
    let base_encoding = detect_base_encoding(font_dict);

    FontInfo { char_map, is_multibyte, base_encoding }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn is_cid_font(d: &Dictionary) -> bool {
    matches!(
        d.get(b"Subtype").ok().and_then(|o| o.as_name_str().ok()),
        Some("Type0")
    )
}

fn detect_base_encoding(d: &Dictionary) -> BaseEncoding {
    match d
        .get(b"Encoding")
        .ok()
        .and_then(|o| o.as_name_str().ok())
    {
        Some("WinAnsiEncoding") => BaseEncoding::WinAnsi,
        Some("MacRomanEncoding") => BaseEncoding::MacRoman,
        Some("StandardEncoding") => BaseEncoding::Standard,
        Some("Identity-H") | Some("Identity-V") => BaseEncoding::Identity,
        _ => BaseEncoding::Unknown,
    }
}

/// Parse the ToUnicode CMap stream (if present) into a code → String map.
fn extract_to_unicode(doc: &Document, font_dict: &Dictionary) -> Option<CharMap> {
    let obj_ref = match font_dict.get(b"ToUnicode").ok()? {
        Object::Reference(r) => *r,
        _ => return None,
    };

    let stream = doc.get_object(obj_ref).ok()?.as_stream().ok()?;
    let data = stream.decompressed_content().ok()?;
    let text = std::str::from_utf8(&data).ok()?;

    Some(parse_cmap(text))
}

/// Minimal CMap parser that handles `beginbfchar` and `beginbfrange` sections.
fn parse_cmap(cmap: &str) -> CharMap {
    let mut map = CharMap::new();
    let mut in_char = false;
    let mut in_range = false;
    let mut tokens: Vec<&str> = Vec::new();

    for raw_line in cmap.lines() {
        let line = raw_line.trim();
        match line {
            "beginbfchar" => { in_char = true; tokens.clear(); }
            "endbfchar" => { flush_bfchar(&tokens, &mut map); in_char = false; tokens.clear(); }
            "beginbfrange" => { in_range = true; tokens.clear(); }
            "endbfrange" => { flush_bfrange(&tokens, &mut map); in_range = false; tokens.clear(); }
            l if in_char || in_range => {
                for t in l.split_whitespace() {
                    tokens.push(t);
                }
            }
            _ => {}
        }
    }
    map
}

fn hex_to_u32(s: &str) -> Option<u32> {
    let inner = s.trim_start_matches('<').trim_end_matches('>');
    u32::from_str_radix(inner, 16).ok()
}

fn hex_to_string(s: &str) -> Option<String> {
    let inner = s.trim_start_matches('<').trim_end_matches('>');
    // May be 4 hex digits per Unicode scalar (UTF-16BE pairs)
    let bytes: Vec<u8> = (0..inner.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&inner[i..i + 2], 16).ok())
        .collect();

    // Try UTF-16BE first (2 bytes per code unit)
    if bytes.len() % 2 == 0 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        if let Ok(s) = String::from_utf16(&u16s) {
            return Some(s);
        }
    }
    // Fallback: Latin-1
    Some(bytes.iter().map(|b| *b as char).collect())
}

fn flush_bfchar(tokens: &[&str], map: &mut CharMap) {
    // pairs: <src> <dst>
    let mut i = 0;
    while i + 1 < tokens.len() {
        if let (Some(src), Some(dst)) = (hex_to_u32(tokens[i]), hex_to_string(tokens[i + 1])) {
            map.insert(src, dst);
        }
        i += 2;
    }
}

fn flush_bfrange(tokens: &[&str], map: &mut CharMap) {
    // triples: <lo> <hi> <dst_start_or_array>
    let mut i = 0;
    while i + 2 < tokens.len() {
        let lo = match hex_to_u32(tokens[i]) { Some(v) => v, None => { i += 3; continue; } };
        let hi = match hex_to_u32(tokens[i + 1]) { Some(v) => v, None => { i += 3; continue; } };
        let dst_tok = tokens[i + 2];

        if dst_tok.starts_with('[') {
            // array form – collect until ']'
            // (Simplified: skip range arrays – uncommon in practice)
        } else if let Some(start_str) = hex_to_string(dst_tok) {
            // Scalar offset form
            let start_cp: u32 = start_str.chars().next().map(|c| c as u32).unwrap_or(0);
            for code in lo..=hi {
                if let Some(c) = char::from_u32(start_cp + (code - lo)) {
                    map.insert(code, c.to_string());
                }
            }
        }
        i += 3;
    }
}

// ── public decoding API ────────────────────────────────────────────────────

/// Decode a raw byte sequence from a content stream using the given FontInfo.
pub fn decode_bytes(bytes: &[u8], font: &FontInfo) -> String {
    if font.is_multibyte {
        decode_multibyte(bytes, font)
    } else {
        decode_singlebyte(bytes, font)
    }
}

fn decode_singlebyte(bytes: &[u8], font: &FontInfo) -> String {
    bytes
        .iter()
        .map(|&b| {
            let code = b as u32;
            if let Some(ref cm) = font.char_map {
                if let Some(s) = cm.get(&code) {
                    return s.clone();
                }
            }
            fallback_latin(b, &font.base_encoding)
        })
        .collect()
}

fn decode_multibyte(bytes: &[u8], font: &FontInfo) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        // Try 2-byte codes first
        let code2 = if i + 1 < bytes.len() {
            Some(((bytes[i] as u32) << 8) | bytes[i + 1] as u32)
        } else {
            None
        };

        let mut matched = false;
        if let Some(code) = code2 {
            if let Some(ref cm) = font.char_map {
                if let Some(s) = cm.get(&code) {
                    out.push_str(s);
                    i += 2;
                    matched = true;
                }
            }
            if !matched {
                // Identity-H: treat as Unicode code point
                if let Some(c) = char::from_u32(code) {
                    out.push(c);
                }
                i += 2;
                matched = true;
            }
        }
        if !matched { i += 1; }
    }
    out
}

fn fallback_latin(b: u8, enc: &BaseEncoding) -> String {
    // For now treat all single-byte as Latin-1 (good enough for English)
    let c = match enc {
        BaseEncoding::WinAnsi | BaseEncoding::Unknown => {
            // Windows-1252 printable range
            if b >= 0x20 { b as char } else { '\u{FFFD}' }
        }
        _ => b as char,
    };
    c.to_string()
}
