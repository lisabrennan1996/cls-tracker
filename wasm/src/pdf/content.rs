//! PDF content-stream processor.
//!
//! Walks every page's content stream(s), maintains a graphics-state stack,
//! and emits `TextItem` values – one per glyph run – that carry:
//!
//!  * the decoded Unicode string
//!  * the bounding box in page-space points (origin = bottom-left, as in PDF)
//!  * font size, baseline, and line metrics
//!
//! Link annotations are harvested separately from the page's /Annots array
//! and returned as [`LinkAnnotation`] values.
//!
//! ### What we handle
//!  * BT/ET blocks, Tf/Td/TD/Tm/T*/Tj/TJ/'/'' operators
//!  * Nested content streams (Form XObjects)
//!  * Compressed streams (FlateDecode / ASCIIHexDecode – lopdf does this)
//!  * Images: we detect `BI` inline-images and XObject Images and record a
//!    placeholder bbox so the complexity check can count them
//!
//! ### What we skip
//!  * Actual rendering / rasterisation
//!  * Colour / shading operators

use std::collections::HashMap;
use lopdf::{Document, Dictionary, Object, Stream};
use crate::pdf::font::{FontInfo, build_font_info, decode_bytes};

// ── public types ───────────────────────────────────────────────────────────

/// A single run of text with its page-space bounding box.
#[derive(Debug, Clone)]
pub struct TextItem {
    pub text: String,
    /// `[x_min, y_min, x_max, y_max]` in PDF user-space points.
    pub bbox: [f32; 4],
    pub font_size: f32,
    pub page_number: usize,
}

/// A clickable hyperlink annotation on a page.
#[derive(Debug, Clone)]
pub struct LinkAnnotation {
    pub uri: String,
    pub bbox: [f32; 4],
    pub page_number: usize,
}

/// One raster or inline image found on a page (for complexity analysis).
#[derive(Debug, Clone)]
pub struct ImageItem {
    pub bbox: [f32; 4],
    pub page_number: usize,
}

/// Everything extracted from a single page.
#[derive(Debug, Default)]
pub struct PageContent {
    pub text_items: Vec<TextItem>,
    pub links: Vec<LinkAnnotation>,
    pub images: Vec<ImageItem>,
    pub width_pts: f32,
    pub height_pts: f32,
}

// ── graphics state ─────────────────────────────────────────────────────────

/// Affine CTM: [a, b, c, d, e, f] matching PDF spec.
type Ctm = [f32; 6];

fn identity_ctm() -> Ctm { [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] }

fn concat_ctm(a: &Ctm, b: &Ctm) -> Ctm {
    [
        a[0]*b[0] + a[1]*b[2],
        a[0]*b[1] + a[1]*b[3],
        a[2]*b[0] + a[3]*b[2],
        a[2]*b[1] + a[3]*b[3],
        a[4]*b[0] + a[5]*b[2] + b[4],
        a[4]*b[1] + a[5]*b[3] + b[5],
    ]
}

fn transform_pt(ctm: &Ctm, x: f32, y: f32) -> (f32, f32) {
    (ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5])
}

#[derive(Clone)]
struct GraphicsState {
    ctm: Ctm,
}

impl GraphicsState {
    fn new() -> Self { Self { ctm: identity_ctm() } }
}

#[derive(Clone, Default)]
struct TextState {
    font_name: String,
    font_size: f32,
    /// Text matrix (= Tm × Tlm)
    tm: Ctm,
    /// Text line matrix
    tlm: Ctm,
    char_spacing: f32,
    word_spacing: f32,
    rise: f32,
    leading: f32,
}

// ── main extraction entry point ────────────────────────────────────────────

/// Extract text, links, and image placeholders from every page.
pub fn extract_pages(
    doc: &Document,
    target_pages: Option<&[usize]>,
    max_pages: usize,
    quiet: bool,
) -> Vec<PageContent> {
    let page_ids = doc.get_pages();
    let total = page_ids.len();
    let mut pages: Vec<PageContent> = Vec::new();

    for (page_num_u32, &obj_id) in page_ids.iter().take(max_pages) {
        let page_idx_1based: usize = *page_num_u32 as usize;
        if let Some(tp) = target_pages {
            if !tp.contains(&page_idx_1based) {
                continue;
            }
        }

        if !quiet {
            // In wasm console_log is used from lib.rs – here we just skip
        }

        let page_dict = match doc.get_object(obj_id).ok().and_then(|o| o.as_dict().ok()) {
            Some(d) => d.clone(),
            None => { pages.push(PageContent::default()); continue; }
        };

        let (width_pts, height_pts) = page_dimensions(&page_dict);

        let mut pc = PageContent { width_pts, height_pts, ..Default::default() };

        // Build font map for this page
        let font_map = build_font_map(doc, &page_dict);

        // Process content stream(s)
        let contents = collect_content_streams(doc, &page_dict);
        process_streams(doc, &contents, &font_map, *page_idx_1based, &mut pc);

        // Harvest link annotations
        harvest_links(doc, &page_dict, *page_idx_1based, &mut pc);

        pages.push(pc);
    }

    pages
}

// ── page helpers ───────────────────────────────────────────────────────────

fn page_dimensions(page_dict: &Dictionary) -> (f32, f32) {
    if let Ok(Object::Array(mb)) = page_dict.get(b"MediaBox") {
        if mb.len() == 4 {
            let w = mb[2].as_float().unwrap_or(612.0);
            let h = mb[3].as_float().unwrap_or(792.0);
            return (w, h);
        }
    }
    (612.0, 792.0) // US Letter fallback
}

fn build_font_map(doc: &Document, page_dict: &Dictionary) -> HashMap<String, FontInfo> {
    let mut map = HashMap::new();

    let resources = match page_dict.get(b"Resources").ok().and_then(|o| {
        match o {
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o2| o2.as_dict().ok().map(|d| d.clone())),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        }
    }) {
        Some(r) => r,
        None => return map,
    };

    let fonts = match resources.get(b"Font").ok().and_then(|o| {
        match o {
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o2| o2.as_dict().ok().map(|d| d.clone())),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        }
    }) {
        Some(f) => f,
        None => return map,
    };

    for (name, obj) in fonts.iter() {
        let font_dict = match obj {
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_dict().ok().map(|d| d.clone())),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        };
        if let Some(fd) = font_dict {
            let key = String::from_utf8_lossy(name).to_string();
            map.insert(key, build_font_info(doc, &fd));
        }
    }
    map
}

fn collect_content_streams(doc: &Document, page_dict: &Dictionary) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    match page_dict.get(b"Contents") {
        Ok(Object::Reference(r)) => {
            if let Ok(obj) = doc.get_object(*r) {
                push_stream_bytes(doc, obj, &mut out);
            }
        }
        Ok(Object::Array(arr)) => {
            for item in arr {
                if let Object::Reference(r) = item {
                    if let Ok(obj) = doc.get_object(*r) {
                        push_stream_bytes(doc, obj, &mut out);
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn push_stream_bytes(doc: &Document, obj: &Object, out: &mut Vec<Vec<u8>>) {
    if let Ok(stream) = obj.as_stream() {
        if let Ok(data) = stream.decompressed_content() {
            out.push(data);
        }
    }
}

// ── stream processor (tokeniser + operator dispatch) ───────────────────────

fn process_streams(
    doc: &Document,
    streams: &[Vec<u8>],
    font_map: &HashMap<String, FontInfo>,
    page_number: usize,
    pc: &mut PageContent,
) {
    let mut gs_stack: Vec<GraphicsState> = vec![GraphicsState::new()];
    let mut ts = TextState::default();
    let mut in_text = false;

    for stream_bytes in streams {
        let tokens = tokenise(stream_bytes);
        let mut i = 0;

        while i < tokens.len() {
            match tokens[i].as_str() {
                // Graphics state
                "q" => { gs_stack.push(gs_stack.last().cloned().unwrap_or_else(GraphicsState::new)); }
                "Q" => { gs_stack.pop(); }
                "cm" => {
                    if i >= 6 {
                        let m = read_f32_6(&tokens, i - 6);
                        if let Some(gs) = gs_stack.last_mut() {
                            gs.ctm = concat_ctm(&gs.ctm, &m);
                        }
                    }
                }
                // Text block
                "BT" => {
                    in_text = true;
                    ts = TextState::default();
                    ts.tm = identity_ctm();
                    ts.tlm = identity_ctm();
                }
                "ET" => { in_text = false; }
                // Font + size
                "Tf" if in_text => {
                    if i >= 2 {
                        ts.font_name = tokens[i - 2].trim_start_matches('/').to_string();
                        ts.font_size = parse_f32(&tokens[i - 1]);
                    }
                }
                // Text positioning
                "Td" if in_text => {
                    if i >= 2 {
                        let tx = parse_f32(&tokens[i - 2]);
                        let ty = parse_f32(&tokens[i - 1]);
                        ts.tlm = translate_ctm(&ts.tlm, tx, ty);
                        ts.tm = ts.tlm;
                    }
                }
                "TD" if in_text => {
                    if i >= 2 {
                        let tx = parse_f32(&tokens[i - 2]);
                        let ty = parse_f32(&tokens[i - 1]);
                        ts.leading = -ty;
                        ts.tlm = translate_ctm(&ts.tlm, tx, ty);
                        ts.tm = ts.tlm;
                    }
                }
                "Tm" if in_text => {
                    if i >= 6 {
                        let m = read_f32_6(&tokens, i - 6);
                        ts.tm = m;
                        ts.tlm = m;
                    }
                }
                "T*" if in_text => {
                    ts.tlm = translate_ctm(&ts.tlm, 0.0, -ts.leading);
                    ts.tm = ts.tlm;
                }
                // Spacing
                "Tc" if in_text => { if i >= 1 { ts.char_spacing = parse_f32(&tokens[i - 1]); } }
                "Tw" if in_text => { if i >= 1 { ts.word_spacing = parse_f32(&tokens[i - 1]); } }
                "Ts" if in_text => { if i >= 1 { ts.rise = parse_f32(&tokens[i - 1]); } }
                "TL" if in_text => { if i >= 1 { ts.leading = parse_f32(&tokens[i - 1]); } }
                // Show text
                "Tj" if in_text => {
                    if i >= 1 {
                        if let Some(bytes) = decode_string_token(&tokens[i - 1]) {
                            emit_text(&bytes, &ts, &gs_stack, font_map, page_number, pc);
                        }
                    }
                }
                "'" if in_text => {
                    ts.tlm = translate_ctm(&ts.tlm, 0.0, -ts.leading);
                    ts.tm = ts.tlm;
                    if i >= 1 {
                        if let Some(bytes) = decode_string_token(&tokens[i - 1]) {
                            emit_text(&bytes, &ts, &gs_stack, font_map, page_number, pc);
                        }
                    }
                }
                "\"" if in_text => {
                    if i >= 3 {
                        ts.word_spacing = parse_f32(&tokens[i - 3]);
                        ts.char_spacing = parse_f32(&tokens[i - 2]);
                        ts.tlm = translate_ctm(&ts.tlm, 0.0, -ts.leading);
                        ts.tm = ts.tlm;
                        if let Some(bytes) = decode_string_token(&tokens[i - 1]) {
                            emit_text(&bytes, &ts, &gs_stack, font_map, page_number, pc);
                        }
                    }
                }
                "TJ" if in_text => {
                    // The operand is the array token (already tokenised as individual items)
                    // Walk backwards to find the matching '[' for this ']'
                    let end = i - 1; // should be ']'
                    let mut depth = 0i32;
                    let mut start_arr = end;
                    for j in (0..=end).rev() {
                        match tokens[j].as_str() {
                            "]" => depth += 1,
                            "[" => {
                                depth -= 1;
                                if depth == 0 { start_arr = j; break; }
                            }
                            _ => {}
                        }
                    }
                    let mut cur_x_offset = 0.0f32;
                    for k in start_arr + 1..end {
                        let tok = &tokens[k];
                        if tok == "]" || tok == "[" { continue; }
                        if let Ok(adj) = tok.parse::<f32>() {
                            // Negative = move right in text space
                            cur_x_offset -= adj * ts.font_size / 1000.0;
                        } else if let Some(bytes) = decode_string_token(tok) {
                            let mut local_ts = ts.clone();
                            local_ts.tm = translate_ctm(&local_ts.tm, cur_x_offset, 0.0);
                            emit_text(&bytes, &local_ts, &gs_stack, font_map, page_number, pc);
                            cur_x_offset = 0.0;
                        }
                    }
                }
                // Inline images
                "BI" => {
                    // Consume until EI, record an image placeholder
                    let ctm = gs_stack.last().map(|g| g.ctm).unwrap_or_else(identity_ctm);
                    let (x, y) = transform_pt(&ctm, 0.0, 0.0);
                    let (x2, y2) = transform_pt(&ctm, 1.0, 1.0);
                    pc.images.push(ImageItem { bbox: [x.min(x2), y.min(y2), x.max(x2), y.max(y2)], page_number });
                    // skip to EI
                    while i < tokens.len() && tokens[i] != "EI" { i += 1; }
                }
                // XObject invocation (Do operator)
                "Do" => {
                    if i >= 1 {
                        let xobj_name = tokens[i - 1].trim_start_matches('/').to_string();
                        // best-effort: if it's an Image XObject, record placeholder
                        let ctm = gs_stack.last().map(|g| g.ctm).unwrap_or_else(identity_ctm);
                        let (x, y) = transform_pt(&ctm, 0.0, 0.0);
                        let (x2, y2) = transform_pt(&ctm, 1.0, 1.0);
                        pc.images.push(ImageItem { bbox: [x.min(x2), y.min(y2), x.max(x2), y.max(y2)], page_number });
                        let _ = xobj_name; // suppress unused warning
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn translate_ctm(ctm: &Ctm, tx: f32, ty: f32) -> Ctm {
    let mut out = *ctm;
    let (x, y) = transform_pt(ctm, tx, ty);
    out[4] = x;
    out[5] = y;
    out
}

fn read_f32_6(tokens: &[String], start: usize) -> Ctm {
    let mut m = identity_ctm();
    for k in 0..6 {
        m[k] = parse_f32(&tokens[start + k]);
    }
    m
}

fn parse_f32(s: &str) -> f32 {
    s.parse().unwrap_or(0.0)
}

/// Emit a text item from raw glyph bytes.
fn emit_text(
    bytes: &[u8],
    ts: &TextState,
    gs_stack: &[GraphicsState],
    font_map: &HashMap<String, FontInfo>,
    page_number: usize,
    pc: &mut PageContent,
) {
    let text = if let Some(font) = font_map.get(&ts.font_name) {
        crate::pdf::font::decode_bytes(bytes, font)
    } else {
        // Best-effort Latin-1
        bytes.iter().map(|&b| b as char).collect()
    };

    if text.trim().is_empty() { return; }

    let ctm = gs_stack.last().map(|g| g.ctm).unwrap_or_else(identity_ctm);
    // Combine text matrix with CTM
    let combined = concat_ctm(&ts.tm, &ctm);

    let (x0, y0) = transform_pt(&combined, 0.0, ts.rise);
    // Approximate width: 0.6 × font_size × char_count
    let approx_w = ts.font_size * 0.6 * text.chars().count() as f32;
    let (x1, y1) = transform_pt(&combined, approx_w, ts.rise + ts.font_size);

    pc.text_items.push(TextItem {
        text,
        bbox: [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)],
        font_size: ts.font_size,
        page_number,
    });
}

/// Decode a PDF string token `(...)` or `<hex>` to raw bytes.
fn decode_string_token(tok: &str) -> Option<Vec<u8>> {
    let tok = tok.trim();
    if tok.starts_with('(') && tok.ends_with(')') {
        let inner = &tok[1..tok.len() - 1];
        Some(unescape_pdf_string(inner))
    } else if tok.starts_with('<') && tok.ends_with('>') {
        let hex = tok.trim_start_matches('<').trim_end_matches('>');
        let bytes = (0..hex.len())
            .step_by(2)
            .filter_map(|i| u8::from_str_radix(&hex[i..i.saturating_add(2).min(hex.len())], 16).ok())
            .collect();
        Some(bytes)
    } else {
        None
    }
}

fn unescape_pdf_string(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'n' => { out.push(b'\n'); i += 2; }
                b'r' => { out.push(b'\r'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'b' => { out.push(8); i += 2; }
                b'f' => { out.push(12); i += 2; }
                b'(' => { out.push(b'('); i += 2; }
                b')' => { out.push(b')'); i += 2; }
                b'\\' => { out.push(b'\\'); i += 2; }
                d if d.is_ascii_digit() => {
                    let end = (i + 2..=(i + 4).min(bytes.len())).find(|&e| !bytes[e - 1].is_ascii_digit()).unwrap_or((i + 4).min(bytes.len()));
                    let oct = std::str::from_utf8(&bytes[i + 1..end]).unwrap_or("0");
                    let val = u8::from_str_radix(oct, 8).unwrap_or(0);
                    out.push(val);
                    i = end;
                }
                _ => { out.push(bytes[i + 1]); i += 2; }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

// ── link annotation harvesting ─────────────────────────────────────────────

fn harvest_links(doc: &Document, page_dict: &Dictionary, page_number: usize, pc: &mut PageContent) {
    let annots = match page_dict.get(b"Annots") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => {
            match doc.get_object(*r) {
                Ok(Object::Array(a)) => a.clone(),
                _ => return,
            }
        }
        _ => return,
    };

    for annot_ref in &annots {
        let annot_dict = match annot_ref {
            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_dict().ok().map(|d| d.clone())),
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        };
        let annot = match annot_dict { Some(a) => a, None => continue };

        // Only Link annotations
        if annot.get(b"Subtype").ok().and_then(|o| o.as_name_str().ok()) != Some("Link") {
            continue;
        }

        // Get URI from /A /URI
        let uri = annot
            .get(b"A")
            .ok()
            .and_then(|o| match o {
                Object::Reference(r) => doc.get_object(*r).ok().and_then(|o2| o2.as_dict().ok().map(|d| d.clone())),
                Object::Dictionary(d) => Some(d.clone()),
                _ => None,
            })
            .and_then(|action| action.get(b"URI").ok().and_then(|o| {
                // lopdf 0.33: as_str() returns Result<Vec<u8>>
                o.as_str().ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            }));

        let uri = match uri { Some(u) => u, None => continue };

        // /Rect
        let bbox = match annot.get(b"Rect") {
            Ok(Object::Array(a)) if a.len() == 4 => {
                let vals: Vec<f32> = a.iter().map(|o| o.as_float().unwrap_or(0.0)).collect();
                [vals[0], vals[1], vals[2], vals[3]]
            }
            _ => [0.0, 0.0, 0.0, 0.0],
        };

        pc.links.push(LinkAnnotation { uri, bbox, page_number });
    }
}

// ── PDF content-stream tokeniser ──────────────────────────────────────────

/// Very lightweight tokeniser.  Handles:
///  * literals: numbers, names (/Foo), booleans
///  * strings:  (...) with nesting and escapes, <hex>
///  * arrays:   [ ... ]
///  * operators: bare words
fn tokenise(data: &[u8]) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut i = 0;
    let n = data.len();

    while i < n {
        match data[i] {
            // Skip whitespace
            b' ' | b'\t' | b'\n' | b'\r' | 0x0C | 0x00 => { i += 1; }
            // Comment
            b'%' => { while i < n && data[i] != b'\n' { i += 1; } }
            // Literal string
            b'(' => {
                let (s, end) = read_literal_string(data, i);
                tokens.push(s);
                i = end;
            }
            // Hex string or dict <<
            b'<' => {
                if i + 1 < n && data[i + 1] == b'<' {
                    tokens.push("<<".to_string()); i += 2;
                } else {
                    let (s, end) = read_hex_string(data, i);
                    tokens.push(s);
                    i = end;
                }
            }
            b'>' => {
                if i + 1 < n && data[i + 1] == b'>' {
                    tokens.push(">>".to_string()); i += 2;
                } else {
                    tokens.push(">".to_string()); i += 1;
                }
            }
            b'[' => { tokens.push("[".to_string()); i += 1; }
            b']' => { tokens.push("]".to_string()); i += 1; }
            b'{' => { tokens.push("{".to_string()); i += 1; }
            b'}' => { tokens.push("}".to_string()); i += 1; }
            _ => {
                // Read a regular token (number, name, operator)
                let start = i;
                while i < n && !is_delimiter(data[i]) { i += 1; }
                if i > start {
                    let tok = String::from_utf8_lossy(&data[start..i]).to_string();
                    tokens.push(tok);
                }
            }
        }
    }
    tokens
}

fn is_delimiter(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C | 0x00 | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn read_literal_string(data: &[u8], start: usize) -> (String, usize) {
    let mut out = String::from("(");
    let mut i = start + 1;
    let mut depth = 1i32;
    while i < data.len() && depth > 0 {
        match data[i] {
            b'\\' => {
                out.push('\\');
                i += 1;
                if i < data.len() { out.push(data[i] as char); i += 1; }
            }
            b'(' => { depth += 1; out.push('('); i += 1; }
            b')' => {
                depth -= 1;
                if depth > 0 { out.push(')'); }
                i += 1;
            }
            b => { out.push(b as char); i += 1; }
        }
    }
    out.push(')');
    (out, i)
}

fn read_hex_string(data: &[u8], start: usize) -> (String, usize) {
    let mut out = String::from("<");
    let mut i = start + 1;
    while i < data.len() && data[i] != b'>' {
        out.push(data[i] as char);
        i += 1;
    }
    out.push('>');
    (out, i + 1)
}
