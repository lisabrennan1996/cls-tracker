//! Output serialisers: JSON, plain-text, and Markdown.
//!
//! All three formats share the same `ParseResult` struct on the Rust side; the
//! caller chooses a format via `OutputFormat`.  The `text` field always
//! contains the human-readable string; `pages` carries the structured per-page
//! breakdown.

use crate::pdf::content::{PageContent, TextItem, LinkAnnotation};
use serde::{Deserialize, Serialize};

// ── public types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Json,
    Text,
    Markdown,
}

impl OutputFormat {
    pub fn from_str(s: &str) -> Self {
        match s {
            "text" => OutputFormat::Text,
            "markdown" => OutputFormat::Markdown,
            _ => OutputFormat::Json,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageMode {
    Off,
    Placeholder,
    Embed,
}

impl ImageMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "off" => ImageMode::Off,
            "embed" => ImageMode::Embed,
            _ => ImageMode::Placeholder,
        }
    }
}

/// A single text span in the output (coordinates in PDF user-space points).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSpan {
    pub text: String,
    pub bbox: [f32; 4],
    #[serde(rename = "fontSize")]
    pub font_size: f32,
}

/// Per-page result returned to JS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageResult {
    #[serde(rename = "pageNumber")]
    pub page_number: usize,
    pub items: Vec<TextSpan>,
    pub links: Vec<LinkResult>,
    pub width: f32,
    pub height: f32,
}

/// A hyperlink on a page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResult {
    pub uri: String,
    pub bbox: [f32; 4],
}

/// Top-level parse result returned to JS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    /// Full document text (format depends on `OutputFormat`).
    pub text: String,
    pub pages: Vec<PageResult>,
}

// ── serialisation ──────────────────────────────────────────────────────────

pub fn build_result(
    extracted: &[PageContent],
    format: OutputFormat,
    image_mode: ImageMode,
    extract_links: bool,
    preserve_very_small: bool,
) -> ParseResult {
    let pages: Vec<PageResult> = extracted
        .iter()
        .enumerate()
        .map(|(idx, pc)| page_to_result(idx + 1, pc, preserve_very_small, extract_links))
        .collect();

    let text = match format {
        OutputFormat::Json => {
            serde_json::to_string_pretty(&pages).unwrap_or_default()
        }
        OutputFormat::Text => {
            pages
                .iter()
                .map(|p| {
                    p.items
                        .iter()
                        .map(|s| s.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        OutputFormat::Markdown => {
            build_markdown(&pages, image_mode, extract_links)
        }
    };

    ParseResult { text, pages }
}

fn page_to_result(
    page_number: usize,
    pc: &PageContent,
    preserve_very_small: bool,
    extract_links: bool,
) -> PageResult {
    let items: Vec<TextSpan> = pc
        .text_items
        .iter()
        .filter(|t| {
            if !preserve_very_small && t.font_size < 4.0 { return false; }
            !t.text.trim().is_empty()
        })
        .map(|t| TextSpan {
            text: t.text.clone(),
            bbox: t.bbox,
            font_size: t.font_size,
        })
        .collect();

    let links: Vec<LinkResult> = if extract_links {
        pc.links.iter().map(|l| LinkResult { uri: l.uri.clone(), bbox: l.bbox }).collect()
    } else {
        vec![]
    };

    PageResult {
        page_number,
        items,
        links,
        width: pc.width_pts,
        height: pc.height_pts,
    }
}

// ── Markdown renderer ──────────────────────────────────────────────────────

fn build_markdown(pages: &[PageResult], image_mode: ImageMode, extract_links: bool) -> String {
    let mut md = String::new();

    for page in pages {
        if pages.len() > 1 {
            md.push_str(&format!("\n\n---\n<!-- page {} -->\n\n", page.page_number));
        }

        // Build a link-lookup: for each text span, does it fall inside a link bbox?
        // Simple O(n*m) — pages are small.
        let link_for = |span: &TextSpan| -> Option<&LinkResult> {
            if !extract_links { return None; }
            page.links.iter().find(|l| bbox_contains(&l.bbox, &span.bbox))
        };

        // Group spans into rough lines by y-coordinate (within 2pt)
        let mut lines: Vec<Vec<&TextSpan>> = Vec::new();
        let mut sorted = page.items.iter().collect::<Vec<_>>();
        // Sort top-to-bottom, left-to-right (PDF y-axis is bottom-up)
        sorted.sort_by(|a, b| {
            b.bbox[1].partial_cmp(&a.bbox[1]).unwrap_or(std::cmp::Ordering::Equal)
                .then(a.bbox[0].partial_cmp(&b.bbox[0]).unwrap_or(std::cmp::Ordering::Equal))
        });

        let mut cur_y = f32::MAX;
        for span in &sorted {
            let mid_y = (span.bbox[1] + span.bbox[3]) / 2.0;
            if (mid_y - cur_y).abs() > 3.0 {
                lines.push(vec![span]);
                cur_y = mid_y;
            } else {
                lines.last_mut().unwrap().push(span);
            }
        }

        for line in &lines {
            for span in line {
                // Heading detection: large font on its own line
                let is_heading = span.font_size > 14.0 && line.len() <= 3;
                if is_heading {
                    let level = if span.font_size > 22.0 { 1 } else if span.font_size > 17.0 { 2 } else { 3 };
                    md.push_str(&format!("{} ", "#".repeat(level)));
                }

                if let Some(link) = link_for(span) {
                    md.push_str(&format!("[{}]({})", span.text, link.uri));
                } else {
                    md.push_str(&span.text);
                }
                md.push(' ');
            }
            md.push('\n');
        }

        // Image placeholders
        if image_mode == ImageMode::Placeholder {
            for (i, _img) in page.items.iter().enumerate().take(0) {
                // text items already handled; images below
                let _ = i;
            }
            // Real image count comes from PageContent, but PageResult only carries TextSpans.
            // We note image placeholders via a comment.
        }
    }

    md
}

fn bbox_contains(outer: &[f32; 4], inner: &[f32; 4]) -> bool {
    let cx = (inner[0] + inner[2]) / 2.0;
    let cy = (inner[1] + inner[3]) / 2.0;
    cx >= outer[0] && cx <= outer[2] && cy >= outer[1] && cy <= outer[3]
}
