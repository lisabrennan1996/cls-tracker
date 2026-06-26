//! Document-complexity heuristics.
//!
//! `is_complex` does a quick, text-layer-only pass over the extracted page
//! content and returns a verdict per page.  The caller can use this to decide
//! whether OCR or heavier processing is worthwhile before committing to a full
//! parse.
//!
//! ### Signals checked (per page)
//!
//! | Reason         | Description |
//! |----------------|-------------|
//! | `no-text`      | Page has zero text items |
//! | `scanned`      | At least one large raster image covers >30% of page area and the page has very little text |
//! | `sparse-text`  | Character density < 5 chars per 1000 pt² of page area |
//! | `embedded-images` | More than 2 embedded raster images on the page |
//! | `garbled`      | Average word entropy > threshold (non-printable / unparseable chars) |
//! | `vector-text`  | No extractable text but no images either (likely drawn with paths) |

use crate::pdf::content::PageContent;
use serde::{Deserialize, Serialize};

/// Per-page complexity verdict (mirrors the public TS type).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageComplexity {
    pub page_number: usize,
    pub needs_ocr: bool,
    pub reasons: Vec<String>,
}

/// Run the complexity check over the extracted pages.
pub fn check_complexity(pages: &[PageContent]) -> Vec<PageComplexity> {
    pages
        .iter()
        .enumerate()
        .map(|(idx, page)| analyse_page(idx + 1, page))
        .collect()
}

fn analyse_page(page_number: usize, page: &PageContent) -> PageComplexity {
    let mut reasons: Vec<String> = Vec::new();

    let page_area = page.width_pts * page.height_pts;
    let total_chars: usize = page.text_items.iter().map(|t| t.text.chars().count()).sum();

    // ── no-text ──────────────────────────────────────────────────────────
    if total_chars == 0 {
        reasons.push("no-text".to_string());
    }

    // ── scanned / embedded-images ────────────────────────────────────────
    let large_images = page
        .images
        .iter()
        .filter(|img| {
            let w = (img.bbox[2] - img.bbox[0]).abs();
            let h = (img.bbox[3] - img.bbox[1]).abs();
            let img_area = w * h;
            page_area > 0.0 && img_area / page_area > 0.30
        })
        .count();

    if large_images > 0 && total_chars < 50 {
        reasons.push("scanned".to_string());
    }

    if page.images.len() > 2 {
        reasons.push("embedded-images".to_string());
    }

    // ── sparse-text ──────────────────────────────────────────────────────
    if page_area > 0.0 && total_chars > 0 {
        let density = (total_chars as f32) / (page_area / 1000.0);
        if density < 5.0 {
            reasons.push("sparse-text".to_string());
        }
    }

    // ── garbled ──────────────────────────────────────────────────────────
    let garbled_ratio = compute_garbled_ratio(page);
    if garbled_ratio > 0.25 {
        reasons.push("garbled".to_string());
    }

    // ── vector-text ──────────────────────────────────────────────────────
    if total_chars == 0 && page.images.is_empty() {
        reasons.push("vector-text".to_string());
    }

    let needs_ocr = !reasons.is_empty();
    PageComplexity { page_number, needs_ocr, reasons }
}

/// Fraction of text characters that are non-printable replacements (U+FFFD)
/// or single-char strings that are control characters.
fn compute_garbled_ratio(page: &PageContent) -> f32 {
    let mut total = 0usize;
    let mut bad = 0usize;
    for item in &page.text_items {
        for ch in item.text.chars() {
            total += 1;
            if ch == '\u{FFFD}' || (ch.is_control() && ch != '\n' && ch != '\t') {
                bad += 1;
            }
        }
    }
    if total == 0 { 0.0 } else { bad as f32 / total as f32 }
}
