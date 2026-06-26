# CLS Sample Reconciliation Tracker

Zero-install browser app — users click a link, the page loads, everything runs locally in the browser. No server, no uploads, no API keys.

## What it does

1. **Drop a study protocol PDF** → liteparse-wasm (Rust/WebAssembly) extracts spatial text and auto-detects the Schedule of Activities (SOA) including visit columns via bbox column detection
2. **Drop the IQVIA sample management report** (.xlsx / .csv) → reconciles every sample against the SOA
3. **Export** per-tab styled Excel reports with optional comment round-tripping

## Hosting (pick one)

### GitHub Pages (recommended — free, automatic)

```
1. Push this repo to GitHub
2. Settings → Pages → Source: GitHub Actions
3. Every push to main builds and deploys automatically
   Live URL: https://<your-org>.github.io/<repo-name>/
```

### Netlify (one click)

```
1. app.netlify.com → New site → Import from Git → select this repo
2. Build settings are already in netlify.toml — just click Deploy
   Live URL: https://<your-site>.netlify.app/
```

### Cloudflare Pages

```
1. dash.cloudflare.com → Pages → Create application → Connect to Git
2. Build command:      bash build-cf.sh
3. Build output dir:   public
4. Node version env:   NODE_VERSION = 18
   Live URL: https://<your-project>.pages.dev/
```

## Project layout

```
cls-tracker-app/
├── public/
│   └── index.html          ← the app (CI writes pkg/ here during build)
├── wasm/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs          ← wasm_bindgen bindings (LiteParse class)
│   │   ├── complexity.rs   ← isComplex heuristics
│   │   ├── output.rs       ← JSON / text / Markdown serialisers
│   │   └── pdf/
│   │       ├── loader.rs   ← lopdf wrapper
│   │       ├── font.rs     ← ToUnicode CMap decoder
│   │       └── content.rs  ← content-stream processor + bbox extraction
├── .github/workflows/
│   └── deploy.yml          ← GitHub Actions: build wasm → deploy Pages
├── netlify.toml
├── build-cf.sh             ← Cloudflare Pages build script
└── README.md
```

## Local development

```powershell
# install Rust (once)
winget install Rustlang.Rustup
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# build wasm into public/pkg/
cd wasm
wasm-pack build --target web --out-dir ../public/pkg --out-name liteparse_wasm --release
cd ..

# serve locally (module imports need HTTP, not file://)
npx serve public
# open http://localhost:3000
```
