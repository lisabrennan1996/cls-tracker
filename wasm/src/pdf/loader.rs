//! PDF byte-level loader: validates header, resolves cross-reference table /
//! cross-reference stream, decrypts when a password is supplied, and hands
//! the raw `lopdf::Document` to the rest of the pipeline.

use lopdf::{Document, Error as LopdfError};

/// Thin newtype so the rest of the crate never touches lopdf directly.
pub struct PdfDocument(pub Document);

#[derive(Debug)]
pub enum LoadError {
    InvalidPdf(String),
    WrongPassword,
    IoError(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::InvalidPdf(s) => write!(f, "Invalid PDF: {s}"),
            LoadError::WrongPassword => write!(f, "Incorrect password"),
            LoadError::IoError(s) => write!(f, "IO error: {s}"),
        }
    }
}

impl From<LopdfError> for LoadError {
    fn from(e: LopdfError) -> Self {
        LoadError::InvalidPdf(e.to_string())
    }
}

/// Load a PDF from raw bytes, optionally decrypting it.
pub fn load(bytes: &[u8], password: Option<&str>) -> Result<PdfDocument, LoadError> {
    let mut doc = Document::load_mem(bytes)?;

    if doc.is_encrypted() {
        let pw = password.unwrap_or("");
        doc.decrypt(pw)
            .map_err(|_| LoadError::WrongPassword)?;
    } else if password.is_some() {
        // non-encrypted doc with a password supplied – just ignore the password
    }

    Ok(PdfDocument(doc))
}
