/* ── liteparse wasm bridge ─────────────────────────────────────────────────
   Vite-plugin-wasm makes the .wasm import work natively as an ES module.
   We import and initialise once, then export the ready LiteParse class.     */

let _LiteParse = null
let _initPromise = null

export function getLiteparseReady() {
  if (_initPromise) return _initPromise
  _initPromise = import('../wasm/pkg/liteparse_wasm.js')
    .then(async ({ default: init, LiteParse }) => {
      await init()
      _LiteParse = LiteParse
      return true
    })
    .catch(e => {
      console.error('[liteparse-wasm] init failed:', e)
      return false
    })
  return _initPromise
}

export async function liteparseDocument(arrayBuffer) {
  const ok = await getLiteparseReady()
  if (!ok || !_LiteParse) throw new Error('liteparse-wasm not available')
  const parser = new _LiteParse({
    outputFormat:          'markdown',
    ocrEnabled:            false,
    extractLinks:          true,
    imageMode:             'placeholder',
    preserveVerySmallText: false,
    quiet:                 true,
  })
  return parser.parse(new Uint8Array(arrayBuffer))
  // → { text: string, pages: Array<{pageNumber,width,height,items,links}> }
}

export async function checkComplexity(arrayBuffer) {
  const ok = await getLiteparseReady()
  if (!ok || !_LiteParse) return null
  try {
    const parser = new _LiteParse({ ocrEnabled: false, quiet: true })
    return await parser.isComplex(new Uint8Array(arrayBuffer))
  } catch (e) {
    console.warn('[liteparse] isComplex failed:', e)
    return null
  }
}
