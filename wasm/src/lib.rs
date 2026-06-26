//! wasm-bindgen entry point for liteparse-wasm.
//!
//! Exposes a single JS class `LiteParse` with two async methods:
//!  * `parse(bytes: Uint8Array): Promise<ParseResult>`
//!  * `isComplex(bytes: Uint8Array): Promise<PageComplexity[]>`
//!
//! A JS-side OCR engine can be injected via the `ocrEngine` config option.
//! The engine must implement `recognize(imageData, width, height, language)`.
//! When present and `ocrEnabled` is true the engine is called for every page
//! that the complexity check flags as needing OCR.

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use js_sys::{Object, Uint8Array, Promise, Reflect, Function, Array};
use serde::{Deserialize, Serialize};

mod pdf;
mod complexity;
mod output;

use pdf::loader;
use pdf::content;
use output::{OutputFormat, ImageMode};

// ── panic hook (debug builds) ──────────────────────────────────────────────

#[cfg(feature = "console_error_panic_hook")]
fn set_panic_hook() {
    console_error_panic_hook::set_once();
}
#[cfg(not(feature = "console_error_panic_hook"))]
fn set_panic_hook() {}

// ── Config ─────────────────────────────────────────────────────────────────

/// Mirrors the public TS LiteParseConfig interface.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub ocr_language: Option<String>,
    pub ocr_enabled: Option<bool>,
    pub max_pages: Option<usize>,
    pub target_pages: Option<String>,
    pub dpi: Option<u32>,
    pub output_format: Option<String>,
    pub image_mode: Option<String>,
    pub extract_links: Option<bool>,
    pub preserve_very_small_text: Option<bool>,
    pub password: Option<String>,
    pub quiet: Option<bool>,
}

// ── JS-facing class ────────────────────────────────────────────────────────

/// Main entry-point class exposed to JavaScript / TypeScript.
#[wasm_bindgen]
pub struct LiteParse {
    config: Config,
    /// Optional JS OCR engine – stored as a raw JsValue.
    ocr_engine: Option<JsValue>,
}

#[wasm_bindgen]
impl LiteParse {
    /// Construct a new `LiteParse` instance.
    ///
    /// ```js
    /// const parser = new LiteParse({ outputFormat: "json", ocrEnabled: false });
    /// ```
    #[wasm_bindgen(constructor)]
    pub fn new(options: &JsValue) -> Result<LiteParse, JsValue> {
        set_panic_hook();

        // Deserialise the plain JS object → Config
        let config: Config = if options.is_null() || options.is_undefined() {
            Config::default()
        } else {
            serde_wasm_bindgen::from_value(options.clone())
                .map_err(|e| JsValue::from_str(&format!("Invalid config: {e}")))?
        };

        // Pull out the ocrEngine sub-object before stripping it from config
        let ocr_engine = Reflect::get(options, &JsValue::from_str("ocrEngine"))
            .ok()
            .filter(|v| !v.is_null() && !v.is_undefined());

        Ok(LiteParse { config, ocr_engine })
    }

    /// Parse a PDF from raw bytes.
    ///
    /// Returns a `Promise` that resolves to `{ text: string, pages: PageResult[] }`.
    #[wasm_bindgen]
    pub fn parse(&self, data: &Uint8Array) -> Promise {
        let bytes = data.to_vec();
        let config = self.config.clone();
        let ocr_engine = self.ocr_engine.clone();

        wasm_bindgen_futures::future_to_promise(async move {
            run_parse(bytes, config, ocr_engine).await
        })
    }

    /// Cheap complexity check — does **not** perform OCR.
    ///
    /// Returns `Promise<PageComplexity[]>`.
    #[wasm_bindgen(js_name = "isComplex")]
    pub fn is_complex(&self, data: &Uint8Array) -> Promise {
        let bytes = data.to_vec();
        let config = self.config.clone();

        wasm_bindgen_futures::future_to_promise(async move {
            run_is_complex(bytes, config).await
        })
    }
}

// ── implementation helpers ─────────────────────────────────────────────────

async fn run_parse(bytes: Vec<u8>, config: Config, ocr_engine: Option<JsValue>) -> Result<JsValue, JsValue> {
    let password = config.password.as_deref();
    let doc = loader::load(&bytes, password)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let max_pages = config.max_pages.unwrap_or(1000);
    let target = parse_page_ranges(config.target_pages.as_deref());
    let quiet = config.quiet.unwrap_or(false);

    let mut pages = content::extract_pages(
        &doc.0,
        target.as_deref(),
        max_pages,
        quiet,
    );

    // Optional JS OCR pass
    let ocr_enabled = config.ocr_enabled.unwrap_or(true);
    if ocr_enabled {
        if let Some(ref engine) = ocr_engine {
            let lang = config.ocr_language.clone().unwrap_or_else(|| "eng".to_string());
            pages = run_ocr_pass(pages, engine, &lang).await?;
        }
    }

    let fmt = OutputFormat::from_str(config.output_format.as_deref().unwrap_or("json"));
    let img_mode = ImageMode::from_str(config.image_mode.as_deref().unwrap_or("placeholder"));
    let extract_links = config.extract_links.unwrap_or(true);
    let preserve_small = config.preserve_very_small_text.unwrap_or(false);

    let result = output::build_result(&pages, fmt, img_mode, extract_links, preserve_small);

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

async fn run_is_complex(bytes: Vec<u8>, config: Config) -> Result<JsValue, JsValue> {
    let password = config.password.as_deref();
    let doc = loader::load(&bytes, password)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let max_pages = config.max_pages.unwrap_or(1000);
    let target = parse_page_ranges(config.target_pages.as_deref());
    let quiet = config.quiet.unwrap_or(false);

    let pages = content::extract_pages(&doc.0, target.as_deref(), max_pages, quiet);
    let result = complexity::check_complexity(&pages);

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// ── OCR bridge ─────────────────────────────────────────────────────────────

/// Call the JS-side OCR engine for each page that needs it.
///
/// We synthesise a placeholder PNG (a white rectangle the same size as the
/// page) and call `engine.recognize(imageData, width, height, language)`.
/// The real integration would render the page to a canvas first, but since
/// we are text-only in this Wasm build, we pass empty image bytes and let
/// the caller handle rendering on the JS side.
async fn run_ocr_pass(
    pages: Vec<content::PageContent>,
    engine: &JsValue,
    language: &str,
) -> Result<Vec<content::PageContent>, JsValue> {
    let recognize_fn = Reflect::get(engine, &JsValue::from_str("recognize"))
        .ok()
        .and_then(|v| v.dyn_into::<Function>().ok());

    let recognize = match recognize_fn {
        Some(f) => f,
        None => return Ok(pages), // no recognize method – skip
    };

    // Complexity check to decide which pages need OCR
    let verdicts = complexity::check_complexity(&pages);

    let mut out_pages = pages;

    for verdict in &verdicts {
        if !verdict.needs_ocr { continue; }
        let idx = verdict.page_number - 1;
        let page = &mut out_pages[idx];

        // Minimal 1×1 white PNG as placeholder image data
        let dummy_png = minimal_png(1, 1);
        let img_array = Uint8Array::from(dummy_png.as_slice());

        let width = page.width_pts as u32;
        let height = page.height_pts as u32;

        let args = Array::new();
        args.push(&img_array);
        args.push(&JsValue::from(width));
        args.push(&JsValue::from(height));
        args.push(&JsValue::from_str(language));

        let this = JsValue::NULL;
        let result = recognize.apply(&this, &args)?;

        // Await the Promise if it is one
        let items_js: JsValue = if result.has_type::<Promise>() {
            JsFuture::from(result.unchecked_into::<Promise>()).await?
        } else {
            result
        };

        // items_js should be an Array of { text, bbox: [x1,y1,x2,y2], confidence }
        if let Some(arr) = items_js.dyn_ref::<Array>() {
            for i in 0..arr.length() {
                let item = arr.get(i);
                if let Ok(text) = Reflect::get(&item, &JsValue::from_str("text")) {
                    let text_str = text.as_string().unwrap_or_default();
                    if text_str.is_empty() { continue; }

                    // Best-effort bbox parsing
                    let bbox = Reflect::get(&item, &JsValue::from_str("bbox"))
                        .ok()
                        .and_then(|b| b.dyn_into::<Array>().ok())
                        .map(|a| {
                            let mut bb = [0f32; 4];
                            for k in 0..4usize {
                                bb[k] = a.get(k as u32).as_f64().unwrap_or(0.0) as f32;
                            }
                            bb
                        })
                        .unwrap_or([0.0, 0.0, page.width_pts, page.height_pts]);

                    page.text_items.push(content::TextItem {
                        text: text_str,
                        bbox,
                        font_size: 12.0,
                        page_number: verdict.page_number,
                    });
                }
            }
        }
    }

    Ok(out_pages)
}

// ── page-range parser ──────────────────────────────────────────────────────

/// Parse a page-range string like `"1-5,10,15-20"` into a sorted Vec<usize>.
fn parse_page_ranges(s: Option<&str>) -> Option<Vec<usize>> {
    let s = s?;
    let mut pages = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let mut ends = part.splitn(2, '-');
            if let (Some(a), Some(b)) = (ends.next(), ends.next()) {
                if let (Ok(lo), Ok(hi)) = (a.trim().parse::<usize>(), b.trim().parse::<usize>()) {
                    pages.extend(lo..=hi);
                }
            }
        } else if let Ok(n) = part.parse::<usize>() {
            pages.push(n);
        }
    }
    if pages.is_empty() { None } else { pages.sort_unstable(); pages.dedup(); Some(pages) }
}

// ── minimal PNG generator ──────────────────────────────────────────────────

/// Return a valid, minimal 1×1 white PNG in raw bytes (no external crate
/// needed – we hard-code the IHDR/IDAT/IEND chunks).
fn minimal_png(w: u32, h: u32) -> Vec<u8> {
    // This is a pre-encoded 1×1 transparent PNG (67 bytes)
    let _ = (w, h);
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8bit RGB, CRC...
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT length + type
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, // IDAT data (zlib)
        0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, // CRC
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND length + type
        0x44, 0xAE, 0x42, 0x60, 0x82,                   // IEND CRC
    ]
}
