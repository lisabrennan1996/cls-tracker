/* ── Pure logic helpers — no DOM, no React ─────────────────────────────── */

export const VISIT_PATTERN = /\b(screen(?:ing)?|baseline|day\s*[-–]?\d+|visit\s*\d+|v\s*\d+|eot|eos|follow[- ]?up|week\s*\d+|cycle\s*\d+|c\d+d\d+)\b/i
export const LAB_PATTERN   = /\b(cbc|complete blood|chem(?:istry|panel)?|metabolic|lft|liver function|hba1c|hemo?glob|haemo?glob|lipid|cholesterol|thyroid|tsh|urinalysis|urine|coagulation|coag|clotting|pk|pharmacokinetic|insulin|c-?peptide|glucose|haematol|hematol|serology|pcr|fibrinogen|d-?dimer|inr|aptt|ptt|creatinine|alt|ast|bun|gfr|egfr|sodium|potassium|chloride|bicarbonate|albumin|total protein|bilirubin|cortisol|igf|acth|prolactin|testosterone|estrogen|osteocalcin|biomarker|cytokine|immunoglobulin|complement|ferritin|iron|transferrin|vitamin|folate|b12|magnesium|phosphorus|uric acid|ldh|amylase|lipase|troponin|bnp|procalcitonin|crp|esr|flow cytometry|elisa|immunoassay|drug level|trough|serum|plasma|pregnancy|hcg|fsh|immunogenicity|anti-?drug|ada\b|biopsy|tissue)\b/i

// ── SOA extraction ─────────────────────────────────────────────────────────

export function parseSOAFromText(text, bboxPages) {
  const tests = [], seen = {}

  function addTest(name, visits) {
    name = (name || '')
      .replace(/[\s:;.,*\-]+$/, '').replace(/^[\s\d.\-#]+/, '')
      .replace(/^#+\s*/, '').trim()
    const key = name.toLowerCase()
    if (!name || name.length < 3 || name.length > 80 || seen[key]) return
    seen[key] = true
    tests.push({ test: name, visits: visits || [], gender: 'all', analytes: [] })
  }

  // Strategy 0 — bbox column detection
  if (bboxPages?.length) {
    const CELL_TOL = 20, Y_BAND = 4
    const MARKER_RE = /^(x|✓|•|∙|·|1|yes)$/i

    for (const pg of bboxPages) {
      if (!pg.items?.length) continue
      const rowMap = {}
      for (const it of pg.items) {
        const midY = Math.round((it.bbox[1] + it.bbox[3]) / 2 / Y_BAND) * Y_BAND;
        (rowMap[midY] ??= []).push(it)
      }
      const rowKeys = Object.keys(rowMap).map(Number).sort((a, b) => b - a)

      let visitHeaderIdx = -1, visitCols = []
      for (let ri = 0; ri < rowKeys.length; ri++) {
        const rowItems = rowMap[rowKeys[ri]].sort((a, b) => a.bbox[0] - b.bbox[0])
        const vi = rowItems.filter(it => VISIT_PATTERN.test(it.text))
        if (vi.length >= 2) {
          visitHeaderIdx = ri
          visitCols = vi.map(it => ({ label: it.text.trim(), cx: (it.bbox[0] + it.bbox[2]) / 2 }))
          break
        }
      }
      if (visitHeaderIdx < 0) continue

      for (let di = visitHeaderIdx + 1; di < rowKeys.length; di++) {
        const dataItems = rowMap[rowKeys[di]].sort((a, b) => a.bbox[0] - b.bbox[0])
        if (!dataItems.length) continue
        const testName = dataItems[0].text.trim()
        if (!testName || testName.length < 3 || !LAB_PATTERN.test(testName)) continue
        const markedVisits = []
        for (let ii = 1; ii < dataItems.length; ii++) {
          const itemCx = (dataItems[ii].bbox[0] + dataItems[ii].bbox[2]) / 2
          const val    = dataItems[ii].text.trim()
          for (const vc of visitCols) {
            if (Math.abs(itemCx - vc.cx) <= CELL_TOL) {
              if (MARKER_RE.test(val)) markedVisits.push(vc.label)
              break
            }
          }
        }
        addTest(testName, markedVisits)
      }
    }
  }

  // Strategy 1 — whitespace-split columns
  if (tests.length < 3) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    let vhIdx = -1, visitHeaders = []
    for (let i = 0; i < lines.length; i++) {
      const toks = lines[i].split(/\s{2,}|\t/).map(t => t.trim()).filter(Boolean)
      if (toks.filter(t => VISIT_PATTERN.test(t)).length >= 2) {
        vhIdx = i; visitHeaders = toks.filter(t => VISIT_PATTERN.test(t)); break
      }
    }
    if (vhIdx > -1) {
      for (let j = vhIdx + 1; j < lines.length; j++) {
        const cols = lines[j].split(/\s{2,}|\t/).filter(Boolean)
        const name = cols[0]?.trim()
        if (!name || name.length < 3 || !LAB_PATTERN.test(name)) continue
        const visits = []
        for (let k = 1; k < cols.length && k <= visitHeaders.length; k++) {
          if (/^(x|✓|•|∙|·|1|yes)$/i.test((cols[k] || '').trim())) visits.push(visitHeaders[k - 1])
        }
        addTest(name, visits)
      }
    }
  }

  // Strategy 2 — keyword scan
  if (tests.length < 3) {
    for (const ln of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      if (!ln || ln.length < 3 || ln.length > 120) continue
      if (/^[\d\s.,:;()\[\]–\-#*]+$/.test(ln)) continue
      if (LAB_PATTERN.test(ln)) addTest(ln.split(/\s{2,}|\t/)[0].trim(), [])
    }
  }

  return tests
}

// ── Helpers ────────────────────────────────────────────────────────────────

export const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
export const isEmpty = v => v == null || String(v).trim() === '' || String(v).trim() === '-' || String(v).trim() === 'N/A'

export function fmtDate(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date && !isNaN(v)) return v.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  if (typeof v === 'string') return v.trim().length > 4 ? v.trim() : v
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000))
    return isNaN(d) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  }
  return String(v)
}

export function daysSince(str) {
  if (!str) return null
  const d = new Date(str)
  return isNaN(d) ? null : Math.round((Date.now() - d) / 86400000)
}

// ── Resolution caches ──────────────────────────────────────────────────────

export function buildResolutionCaches(soaSchedule, allRows) {
  const soaMap = {}
  soaSchedule.forEach(t => { soaMap[normStr(t.test)] = t.test })

  const cachedVisits = [], cachedVisitsNorm = []
  soaSchedule.forEach(t => {
    (t.visits || []).forEach(sv => {
      if (!cachedVisits.includes(sv)) { cachedVisits.push(sv); cachedVisitsNorm.push(normStr(sv)) }
    })
  })

  const resolveTestCache = {}
  allRows.forEach(r => {
    const k = `${r.sampleName}|${r.lifecycle}`
    if (k in resolveTestCache) return
    const sl = normStr(r.sampleName), ll = normStr(r.lifecycle)
    let res = ''
    if (soaMap[sl]) res = soaMap[sl]
    else if (soaMap[ll]) res = soaMap[ll]
    else {
      const hay = `${sl} ${ll}`
      for (const t of soaSchedule) {
        const tl = normStr(t.test)
        if (hay.includes(tl) || (tl.includes(sl) && sl.length > 3)) { res = t.test; break }
      }
    }
    resolveTestCache[k] = res
  })

  return { soaMap, cachedVisits, cachedVisitsNorm, resolveTestCache }
}

export function resolveVisit(v, { cachedVisits, cachedVisitsNorm }) {
  if (!cachedVisits.length) return null
  if ((v || '').toUpperCase().includes('UNSCHEDULED')) return 'Unscheduled'
  const n = normStr(v)
  const i = cachedVisitsNorm.indexOf(n)
  return i >= 0 ? cachedVisits[i] : null
}

export function resolveTest(row, { soaMap, soaSchedule, resolveTestCache }) {
  const k = `${row.sampleName}|${row.lifecycle}`
  if (k in resolveTestCache) return resolveTestCache[k] || null
  const sl = normStr(row.sampleName), ll = normStr(row.lifecycle)
  if (soaMap[sl]) return soaMap[sl]
  if (soaMap[ll]) return soaMap[ll]
  const hay = `${sl} ${ll}`
  for (const t of soaSchedule) {
    const tl = normStr(t.test)
    if (hay.includes(tl) || (tl.includes(sl) && sl.length > 3)) return t.test
  }
  return null
}

// ── buildCounts ────────────────────────────────────────────────────────────

export function buildCounts(filtered, soaSchedule, allRows, caches) {
  const visitCols = []
  soaSchedule.forEach(t => (t.visits || []).forEach(v => { if (!visitCols.includes(v)) visitCols.push(v) }))
  if (allRows.some(r => (r.visit || '').toUpperCase().includes('UNSCHEDULED')) && !visitCols.includes('Unscheduled'))
    visitCols.push('Unscheduled')

  const vn = v => {
    const s = (v || '').toLowerCase()
    if (/screen|baseline/.test(s)) return -1
    if (/eos|eot|end.?of|follow/.test(s)) return 999999
    if (v === 'Unscheduled') return 9999998
    const m = s.match(/(\d+)/); return m ? parseInt(m[1], 10) : 99999
  }
  visitCols.sort((a, b) => vn(a) - vn(b))

  const bucket = {}
  soaSchedule.forEach(t => {
    bucket[t.test] = {}
    visitCols.forEach(v => { bucket[t.test][v] = { expected: 0, received: 0 } })
  })

  const sg = {}
  allRows.forEach(r => {
    if (!r.subjectId || sg[r.subjectId]) return
    const g = (r.gender || '').toLowerCase()
    if (g === 'f' || g === 'female') sg[r.subjectId] = 'female'
    else if (g === 'm' || g === 'male') sg[r.subjectId] = 'male'
  })

  const unmapped = []
  filtered.forEach(r => {
    if (!r.subjectId) return
    const soaVisit = resolveVisit(r.visit, caches)
    if (!soaVisit) { unmapped.push({ row: r, reason: `Visit "${r.visit || '(blank)'}" not in SOA` }); return }
    const testsAtVisit = soaSchedule.filter(t => (t.visits || []).includes(soaVisit))
    if (!testsAtVisit.length && soaVisit !== 'Unscheduled') { unmapped.push({ row: r, reason: `No SOA test scheduled at ${soaVisit}` }); return }
    const resolvedTest = resolveTest(r, { ...caches, soaSchedule })
    let targets = []
    if (resolvedTest && bucket[resolvedTest]?.[soaVisit] !== undefined) targets = [resolvedTest]
    else if (testsAtVisit.length === 1) targets = [testsAtVisit[0].test]
    else { unmapped.push({ row: r, reason: `Sample "${r.sampleName || '?'}" could not be matched at ${soaVisit}` }); return }

    targets.forEach(testName => {
      const t = soaSchedule.find(s => s.test === testName)
      if (!t || !bucket[testName]?.[soaVisit]) return
      const tg = t.gender || 'all'
      if (tg !== 'all') {
        const rawG = (r.gender || '').toLowerCase()
        const subG = rawG === 'female' ? 'female' : rawG === 'male' ? 'male' : sg[r.subjectId]
        if (tg === 'female' && subG !== 'female') return
        if (tg === 'male'   && subG !== 'male')   return
      }
      bucket[testName][soaVisit].expected++
      if (r.received) bucket[testName][soaVisit].received++
    })
  })

  return { bucket, visitCols, unmapped }
}

// ── XLSX lab-file parser ───────────────────────────────────────────────────

export function parseLabFile(raw) {
  if (!raw.length) throw new Error('No data rows found')
  const keys = Object.keys(raw[0])
  const fc = patterns => {
    for (const re of patterns)
      for (const k of keys) if (re.test(k)) return k
    return ''
  }

  const cSubject   = fc([/subject.?id/i, /subj/i, /patient.?id/i])
  const cSite      = fc([/^site$/i, /site.?(id|#|num)/i, /site/i])
  const cInvestig  = fc([/invest/i, /pi\b/i, /principal/i])
  const cVisit     = fc([/visit/i, /time.?point/i, /period/i])
  const cSample    = fc([/sample.?name/i, /test.?name/i, /assay/i, /panel/i, /sample/i])
  const cLifecycle = fc([/lifecycle/i, /life.?cycle/i, /step/i])
  const cStatus    = fc([/sample.?status/i, /status/i])
  const cAccession = fc([/accession/i, /accn/i])
  const cSpecimen  = fc([/specimen/i, /spec.?id/i])
  const cCollDate  = fc([/collect.*date/i, /draw.*date/i, /coll.*dt/i])
  const cRecvDate  = fc([/receiv.*date/i, /receipt.*date/i, /recv.*dt/i])
  const cAwb       = fc([/awb/i, /air.*way|tracking/i, /courier/i])
  const cGender    = fc([/gender/i, /sex/i])
  const cStudy     = fc([/study/i, /protocol/i, /trial/i])
  const cSponsor   = fc([/sponsor/i, /company/i])
  const cContainer = fc([/container/i, /tube/i, /vial/i])
  const cLocation  = fc([/location/i, /lab.*site/i, /central|referral/i])

  const isReceived = row => {
    const st = String(row[cStatus] || '').toLowerCase()
    if (/not.?receiv|missing|pending|expect|cancel|await/i.test(st)) return false
    if (/receiv|arrived|complete|result/i.test(st)) return true
    if (cRecvDate && !isEmpty(row[cRecvDate])) return true
    return false
  }

  return raw.map(row => ({
    sponsor:        String(row[cSponsor]   || ''),
    study:          String(row[cStudy]     || ''),
    investigator:   String(row[cInvestig]  || ''),
    site:           String(row[cSite]      || ''),
    subjectId:      String(row[cSubject]   || '').trim(),
    gender:         String(row[cGender]    || ''),
    visit:          String(row[cVisit]     || '').trim(),
    sampleName:     String(row[cSample]    || '').trim(),
    lifecycle:      String(row[cLifecycle] || row[cSample] || '').trim(),
    container:      String(row[cContainer] || ''),
    accession:      String(row[cAccession] || '').trim(),
    specimenId:     String(row[cSpecimen]  || '').trim(),
    lifecycleStep:  String(row[cLifecycle] || '').trim(),
    collectionDate: fmtDate(row[cCollDate]),
    receivedDate:   fmtDate(row[cRecvDate]),
    sampleStatus:   String(row[cStatus]    || '').trim(),
    sampleLocation: String(row[cLocation]  || '').trim(),
    awb:            String(row[cAwb]       || '').trim(),
    received:       isReceived(row),
  })).filter(r => r.subjectId || r.sampleName)
}

// ── Excel export ───────────────────────────────────────────────────────────

export function styledExport({ headers, rows, sheetName, subTitle, filename, studyId }) {
  const JSZip = window.JSZip // loaded via cdn

  const esc = v => v == null ? '' : String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const strings = [], sMap = {}
  const si = v => {
    const s = String(v ?? '')
    if (!(s in sMap)) { sMap[s] = strings.length; strings.push(s) }
    return sMap[s]
  }
  const col26 = n => {
    let s = ''; n++
    while (n > 0) { s = String.fromCharCode(64 + (n % 26 || 26)) + s; n = Math.floor((n - (n % 26 || 26)) / 26) }
    return s
  }

  const today = new Date()
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const exportedStr = `Exported: ${String(today.getDate()).padStart(2,'0')} ${mo[today.getMonth()]} ${today.getFullYear()}   |   Study: ${studyId || ''}   |   Records: ${rows.length}`

  const titleSi = si(sheetName), subtitleSi = si(subTitle || ''), exportedSi = si(exportedStr)
  const headerIdxs = headers.map(h => si(h.label))
  const rowData = rows.map(row => headers.map(h => {
    const v = row[h.key]; return { si: si(v ?? ''), isNum: typeof v === 'number', v }
  }))

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="9"/><name val="Arial"/><color rgb="FF000000"/></font><font><sz val="13"/><name val="Arial"/><b/><color rgb="FFFFFFFF"/></font><font><sz val="9"/><name val="Arial"/><color rgb="FFFFFFFF"/></font><font><sz val="9"/><name val="Arial"/><b/><color rgb="FFFFFFFF"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF002060"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E75B6"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf></cellXfs></styleSheet>`

  const colsXml = `<cols>${headers.map((h, i) => `<col min="${i+1}" max="${i+1}" width="${(h.width||18)+0.83}" customWidth="1"/>`).join('')}</cols>`

  let sheetRows = `<row r="1" ht="22" customHeight="1"><c r="A1" s="0" t="s"><v>${titleSi}</v></c></row>`
  sheetRows += `<row r="2" ht="15" customHeight="1">${subTitle ? `<c r="A2" s="1" t="s"><v>${subtitleSi}</v></c>` : ''}</row>`
  sheetRows += `<row r="3" ht="13" customHeight="1"><c r="A3" s="1" t="s"><v>${exportedSi}</v></c></row>`
  sheetRows += `<row r="4" ht="5" customHeight="1"></row>`
  sheetRows += `<row r="5" ht="28" customHeight="1">${headerIdxs.map((idx, c) => `<c r="${col26(c)}5" s="2" t="s"><v>${idx}</v></c>`).join('')}</row>`
  rowData.forEach((row, ri) => {
    const r = ri + 6, s = ri % 2 === 0 ? 3 : 4
    sheetRows += `<row r="${r}" ht="18" customHeight="1">${row.map((cell, c) =>
      cell.isNum ? `<c r="${col26(c)}${r}" s="${s}"><v>${esc(cell.v)}</v></c>`
                 : `<c r="${col26(c)}${r}" s="${s}" t="s"><v>${cell.si}</v></c>`
    ).join('')}</row>`
  })

  const lastCol = col26(headers.length - 1)
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${colsXml}<sheetData>${sheetRows}</sheetData><mergeCells><mergeCell ref="A1:${lastCol}1"/><mergeCell ref="A2:${lastCol}2"/><mergeCell ref="A3:${lastCol}3"/><mergeCell ref="A4:${lastCol}4"/></mergeCells><pageSetup orientation="landscape" fitToPage="1" fitToWidth="1" fitToHeight="0"/></worksheet>`
  const ssXml    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`
  const wbXml    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const wbRels   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const topRels  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', topRels)
  zip.file('xl/workbook.xml', wbXml)
  zip.file('xl/_rels/workbook.xml.rels', wbRels)
  zip.file('xl/worksheets/sheet1.xml', sheetXml)
  zip.file('xl/sharedStrings.xml', ssXml)
  zip.file('xl/styles.xml', stylesXml)
  zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    .then(blob => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(a.href)
    })
}
