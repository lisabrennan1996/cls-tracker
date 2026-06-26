import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { getLiteparseReady, liteparseDocument, checkComplexity } from './liteparse'
import {
  parseSOAFromText, parseLabFile, buildResolutionCaches,
  resolveVisit, resolveTest, buildCounts,
  fmtDate, daysSince, normStr, styledExport,
} from './logic'

// ── Wasm init ─────────────────────────────────────────────────────────────
// Start loading immediately on module evaluation
const wasmReady = getLiteparseReady()

// ── Helpers ───────────────────────────────────────────────────────────────
function fileStamp(studyId, allRows) {
  const study = (studyId || (allRows[0]?.study) || 'Study').replace(/[^a-zA-Z0-9]/g, '')
  const d = new Date()
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${study}_${String(d.getDate()).padStart(2,'0')}${mo[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`
}

const TABS = [
  { id: 'recon',           label: 'Sample Reconciliation' },
  { id: 'visitrecon',      label: 'Visit Reconciliation' },
  { id: 'tests',           label: 'SOA test list' },
  { id: 'missing',         label: 'Missing samples',   red: true },
  { id: 'samplelocations', label: 'Sample Location Reconciliation' },
  { id: 'sites',           label: 'By site' },
  { id: 'raw',             label: 'Raw data' },
  { id: 'cancellations',   label: 'Cancellations',      red: true, hiddenUntilLoaded: true },
]

// ── UploadZone ────────────────────────────────────────────────────────────
function UploadZone({ id, icon, label, hint, state, onFile, accept }) {
  const inputRef = useRef()
  const cls = `upload-zone ${state}`
  const onDrop = e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f) }
  return (
    <div className={cls} onClick={() => inputRef.current.click()}
      onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <i className={`ti ${icon}`} />
      <p>{state === 'loading' ? <><span className="spinner"/>Reading…</> : label}</p>
      <p className="hint">{hint}</p>
      <input ref={inputRef} type="file" accept={accept} style={{display:'none'}}
        onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = '' }} />
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const [wasmOk,       setWasmOk]       = useState(null)   // null=loading, true, false
  const [soaSchedule,  setSoaSchedule]  = useState([])
  const [allRows,      setAllRows]      = useState([])
  const [cancellations,setCancellations]= useState([])
  const [studyId,      setStudyId]      = useState('')
  const [tabComments,  setTabComments]  = useState({recon:{},visitrecon:{},tests:{},missing:{},sites:{},raw:{},cancellations:{},samplelocations:{}})
  const [activeTab,    setActiveTab]    = useState('recon')
  const [optOpen,      setOptOpen]      = useState(false)
  const [soaManualInput, setSoaManualInput] = useState('')
  const [showCommentZone, setShowCommentZone] = useState(false)
  const [commentZoneLoaded, setCommentZoneLoaded] = useState(false)

  // upload zone states
  const [protocolState, setProtocolState] = useState({ state: '', label: 'Drop study protocol PDF here', hint: 'Tests are detected automatically — no upload, no API key' })
  const [labState,      setLabState]      = useState({ state: '', label: 'Drop sample management report here', hint: 'Accepts .xlsx / .xlsm / .csv — auto-detects IQVIA format' })
  const [specState,     setSpecState]     = useState({ state: '', label: 'Drop lab spec document here' })
  const [edcState,      setEdcState]      = useState({ state: '', label: 'Drop EDC report here' })
  const [cancelFileState, setCancelFileState] = useState({ state: '', label: 'Drop cancellations report here' })

  // filters
  const [search,        setSearch]        = useState('')
  const [filterSubject, setFilterSubject] = useState('')
  const [filterVisit,   setFilterVisit]   = useState('')
  const [filterStatus,  setFilterStatus]  = useState('')
  const [filterTest,    setFilterTest]    = useState('')
  const [filterLocation,setFilterLocation]= useState('')
  const [showUnmapped,  setShowUnmapped]  = useState(false)

  // wasm init
  useEffect(() => {
    wasmReady.then(ok => setWasmOk(ok))
  }, [])

  // ── caches (rebuilt whenever soaSchedule or allRows changes) ──────────
  const caches = useMemo(
    () => buildResolutionCaches(soaSchedule, allRows),
    [soaSchedule, allRows]
  )

  // ── filtered rows ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return allRows.filter(r => {
      if (filterSubject && r.subjectId !== filterSubject) return false
      if (filterVisit   && r.visit     !== filterVisit)   return false
      if (filterStatus === 'Missing'  && r.received)  return false
      if (filterStatus === 'Received' && !r.received) return false
      if (filterTest    && r.sampleName !== filterTest)   return false
      if (q && ![r.subjectId,r.site,r.visit,r.sampleName,r.accession,r.specimenId,r.investigator].join(' ').toLowerCase().includes(q)) return false
      return true
    })
  }, [allRows, search, filterSubject, filterVisit, filterStatus, filterTest])

  // ── SOA protocol handler ──────────────────────────────────────────────
  const handleProtocol = useCallback(async file => {
    setProtocolState({ state: 'loading', label: file.name, hint: 'Extracting spatial text with liteparse-wasm…' })
    try {
      const buf = await file.arrayBuffer()
      const complexity = await checkComplexity(buf)
      if (complexity?.length) {
        const needsOcr = complexity.filter(p => p.needsOcr)
        if (needsOcr.length) {
          const reasons = [...new Set(needsOcr.flatMap(p => p.reasons))]
          setProtocolState(s => ({ ...s, hint: `ℹ ${needsOcr.length}/${complexity.length} page(s) may need OCR (${reasons.join(', ')}) — quality may vary.` }))
        }
      }
      const result = await liteparseDocument(buf)
      const text = result.text || ''
      const bboxPages = result.pages || []
      if (!text.replace(/\s/g, '').length) throw new Error('No selectable text — PDF may be fully scanned.')
      const tests = parseSOAFromText(text, bboxPages)
      if (!tests.length) {
        setSoaSchedule([])
        setProtocolState({ state: 'error', label: `⚠ ${file.name}`, hint: 'No lab tests auto-detected. Add them manually below.' })
        return
      }
      setSoaSchedule(tests)
      setProtocolState({ state: 'loaded', label: `✓ ${file.name}`, hint: `${tests.length} tests detected (liteparse-wasm, bbox-markdown) — review/edit below` })
    } catch (err) {
      setProtocolState({ state: 'error', label: `⚠ ${file.name}`, hint: `Could not read PDF — ${err.message || err}` })
    }
  }, [])

  // ── Lab file handler ──────────────────────────────────────────────────
  const handleLabFile = useCallback(file => {
    if (!soaSchedule.length) {
      setLabState({ state: 'error', label: `⚠ ${file.name}`, hint: 'Please load the study protocol first' })
      return
    }
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true })
        const ws  = wb.Sheets[wb.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
        const rows = parseLabFile(raw)
        setAllRows(rows)
        if (!studyId && rows[0]?.study) setStudyId(String(rows[0].study).trim())
        const rec  = rows.filter(r => r.received).length
        const subs = new Set(rows.map(r => r.subjectId)).size
        const sits = new Set(rows.map(r => r.site)).size
        setLabState({ state: 'loaded', label: `✓ ${file.name}`, hint: `${rows.length} rows · ${rec} received · ${rows.length - rec} missing · ${subs} subjects · ${sits} sites` })
      } catch (err) {
        setLabState({ state: 'error', label: `⚠ ${file.name}`, hint: `Error reading file: ${err.message}` })
      }
    }
    reader.readAsArrayBuffer(file)
  }, [soaSchedule, studyId])

  // ── Cancellations handler ─────────────────────────────────────────────
  const handleCancelFile = useCallback(file => {
    const reader = new FileReader()
    reader.onload = e => {
      const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      setCancellations(rows)
      setCancelFileState({ state: 'loaded', label: `✓ ${file.name}`, hint: `${rows.length} cancellations loaded` })
    }
    reader.readAsArrayBuffer(file)
  }, [])

  // ── Comment import ────────────────────────────────────────────────────
  const handleCommentFile = useCallback(file => {
    const reader = new FileReader()
    reader.onload = e => {
      const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      let loaded = 0
      const newComments = { ...tabComments, [activeTab]: {} }
      rows.forEach(row => {
        const comment = row['Comments'] || row['comments'] || ''
        if (!comment) return
        const key = makeCommentKey(activeTab, row)
        if (key) { newComments[activeTab][key] = comment; loaded++ }
      })
      setTabComments(newComments)
      setCommentZoneLoaded(true)
    }
    reader.readAsArrayBuffer(file)
  }, [activeTab, tabComments])

  const getComment = (tab, key) => tabComments[tab]?.[key] || ''

  // ── Stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const exp = filtered.length
    const rec = filtered.filter(r => r.received).length
    return {
      expected: exp, received: rec, missing: exp - rec,
      rate: exp ? `${Math.round(rec / exp * 100)}%` : '—',
      tests:    soaSchedule.length,
      visits:   new Set(allRows.map(r => r.visit)).size,
      sites:    new Set(allRows.map(r => r.site)).size,
      subjects: new Set(allRows.map(r => r.subjectId)).size,
      studies:  [...new Set(allRows.map(r => r.study))].filter(Boolean).join(' / '),
      date:     allRows.length ? new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—',
    }
  }, [filtered, soaSchedule, allRows])

  // ── buildCounts (memoised) ────────────────────────────────────────────
  const counts = useMemo(
    () => soaSchedule.length ? buildCounts(filtered, soaSchedule, allRows, caches) : null,
    [filtered, soaSchedule, allRows, caches]
  )

  // ── Dropdown options ──────────────────────────────────────────────────
  const subjectOpts = useMemo(() => [...new Set(allRows.map(r => r.subjectId))].filter(Boolean).sort(), [allRows])
  const visitOpts   = useMemo(() => [...new Set(allRows.map(r => r.visit))].filter(Boolean), [allRows])
  const testOpts    = useMemo(() => soaSchedule.map(t => t.test), [soaSchedule])

  // ── Tab badge counts ──────────────────────────────────────────────────
  const badges = useMemo(() => ({
    recon:           (filterTest ? soaSchedule.filter(t => t.test === filterTest) : soaSchedule).length,
    visitrecon:      counts?.visitCols?.length ?? 0,
    tests:           soaSchedule.length,
    missing:         filtered.filter(r => !r.received).length,
    samplelocations: filtered.filter(r => r.received).length,
    sites:           [...new Set(filtered.map(r => r.site))].filter(Boolean).length,
    raw:             filtered.length,
    cancellations:   cancellations.length,
  }), [filtered, soaSchedule, counts, cancellations, filterTest])

  // ── Excel export ──────────────────────────────────────────────────────
  const dlExcel = useCallback(mode => {
    if (!allRows.length) { alert('Load data first.'); return }
    const stamp = fileStamp(studyId, allRows)
    const vn = v => { const m = (v||'').match(/(\d+)/); return m ? parseInt(m[1],10) : 99999 }
    const gc = (tab, key) => getComment(tab, key)

    const rtRow = r => resolveTest(r, { ...caches, soaSchedule })

    if (mode === 'recon' && counts) {
      const vc = counts.visitCols
      const rows = soaSchedule.map(t => {
        const row = { 'Test / Assay': t.test }
        vc.forEach(v => {
          if (!(t.visits||[]).includes(v)) { row[v] = 'N/A'; return }
          const b = counts.bucket[t.test]?.[v] || { expected:0, received:0 }
          row[v] = b.expected === 0 ? 'Expected' : `${b.received}/${b.expected}`
        })
        row['Comments'] = gc('recon', t.test)
        return row
      })
      styledExport({ filename: `CLS_Sample_Reconciliation_${stamp}.xlsx`, sheetName: 'Sample Reconciliation', subTitle: 'Sample receipt reconciliation by test and visit', studyId,
        headers: [{ label:'Test / Assay', key:'Test / Assay', width:30 }, ...vc.map(v=>({label:v,key:v,width:14})), { label:'Comments',key:'Comments',width:30 }], rows })
    } else if (mode === 'missing') {
      const rows = filtered.filter(r=>!r.received).map(r=>({ 'Subject ID':r.subjectId,'Site':r.site,'Investigator':r.investigator,'Visit':r.visit,'SOA Test':rtRow(r)||'','Sample Name':r.sampleName,'Accession':r.accession,'Collection Date':r.collectionDate,'Status':r.sampleStatus,'Days Since Collection':daysSince(r.collectionDate)||'', Comments:gc('missing',`${r.subjectId}|${r.visit}|${r.sampleName}`) }))
      styledExport({ filename:`CLS_Missing_Samples_${stamp}.xlsx`, sheetName:'Missing Samples', subTitle:'Samples not yet received', studyId, headers:[{label:'Subject ID',key:'Subject ID',width:14},{label:'Site',key:'Site',width:10},{label:'Investigator',key:'Investigator',width:18},{label:'Visit',key:'Visit',width:12},{label:'SOA Test',key:'SOA Test',width:26},{label:'Sample Name',key:'Sample Name',width:26},{label:'Accession',key:'Accession',width:18},{label:'Collection Date',key:'Collection Date',width:18},{label:'Status',key:'Status',width:14},{label:'Days Since Collection',key:'Days Since Collection',width:22},{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'raw') {
      const rows = filtered.map(r=>({ 'Subject ID':r.subjectId,'Site':r.site,'Investigator':r.investigator,'Visit':r.visit,'SOA Test':rtRow(r)||'','Sample Name':r.sampleName,'Specimen ID':r.specimenId,'Accession':r.accession,'Collection Date':r.collectionDate,'Received Date':r.receivedDate,'Status':r.received?'Received':'Missing','Sample Status':r.sampleStatus,'Lifecycle Step':r.lifecycleStep,'AWB':r.awb, Comments:gc('raw',`${r.subjectId}|${r.visit}|${r.sampleName}`) }))
      styledExport({ filename:`CLS_Raw_Data_${stamp}.xlsx`, sheetName:'Raw Data', subTitle:'Full sample management report export', studyId, headers:[{label:'Subject ID',key:'Subject ID',width:14},{label:'Site',key:'Site',width:10},{label:'Investigator',key:'Investigator',width:18},{label:'Visit',key:'Visit',width:12},{label:'SOA Test',key:'SOA Test',width:26},{label:'Sample Name',key:'Sample Name',width:26},{label:'Specimen ID',key:'Specimen ID',width:16},{label:'Accession',key:'Accession',width:18},{label:'Collection Date',key:'Collection Date',width:18},{label:'Received Date',key:'Received Date',width:18},{label:'Status',key:'Status',width:14},{label:'Sample Status',key:'Sample Status',width:16},{label:'Lifecycle Step',key:'Lifecycle Step',width:22},{label:'AWB',key:'AWB',width:18},{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'sites') {
      const sitesArr = [...new Set(filtered.map(r=>r.site))].filter(Boolean)
      const rows = sitesArr.map(site => { const sr=filtered.filter(r=>r.site===site); const rec=sr.filter(r=>r.received).length; return {'Site':site,'Investigator':sr[0]?.investigator||'','Expected Samples':sr.length,'Received':rec,'Missing':sr.length-rec,'Receipt Rate %':sr.length?`${Math.round(rec/sr.length*100)}%`:'0%', Comments:gc('sites',site)} })
      styledExport({ filename:`CLS_Site_Report_${stamp}.xlsx`, sheetName:'By Site', subTitle:'Sample receipt rates by investigator site', studyId, headers:[{label:'Site',key:'Site',width:10},{label:'Investigator',key:'Investigator',width:20},{label:'Expected Samples',key:'Expected Samples',width:18},{label:'Received',key:'Received',width:14},{label:'Missing',key:'Missing',width:14},{label:'Receipt Rate %',key:'Receipt Rate %',width:16},{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'tests') {
      const rows = soaSchedule.map(t => { const rel=allRows.filter(r=>rtRow(r)===t.test); const rec=rel.filter(r=>r.received).length; return {'Test / Assay':t.test,'Visits Scheduled':(t.visits||[]).join(', '),'Total Samples':rel.length,'Received':rec,'Missing':rel.length-rec, Comments:gc('tests',t.test)} })
      styledExport({ filename:`CLS_SOA_Test_List_${stamp}.xlsx`, sheetName:'SOA Test List', subTitle:'Schedule of Activities — lab test panels', studyId, headers:[{label:'Test / Assay',key:'Test / Assay',width:32},{label:'Visits Scheduled',key:'Visits Scheduled',width:40},{label:'Total Samples',key:'Total Samples',width:16},{label:'Received',key:'Received',width:14},{label:'Missing',key:'Missing',width:14},{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'samplelocations') {
      const normLoc = loc => { const l=(loc||'').toLowerCase().trim(); if(!l) return 'Unknown'; if(l.includes('central')) return 'Central Lab'; if(l.includes('referral')) return 'Referral Lab'; return 'On-site / Other' }
      const rows = filtered.filter(r=>r.received).map(r=>({'Subject ID':r.subjectId,'Site':r.site,'Visit':r.visit,'Test / Assay':rtRow(r)||r.sampleName,'Accession':r.accession,'Received Date':r.receivedDate,'AWB':r.awb||'','Current Location':normLoc(r.sampleLocation), Comments:gc('samplelocations',`${r.subjectId}|${r.visit}|${r.accession}`)}))
      styledExport({ filename:`CLS_Sample_Location_${stamp}.xlsx`, sheetName:'Sample Location', subTitle:'Current location of received samples', studyId, headers:[{label:'Subject ID',key:'Subject ID',width:14},{label:'Site',key:'Site',width:10},{label:'Visit',key:'Visit',width:12},{label:'Test / Assay',key:'Test / Assay',width:28},{label:'Accession',key:'Accession',width:18},{label:'Received Date',key:'Received Date',width:16},{label:'AWB',key:'AWB',width:20},{label:'Current Location',key:'Current Location',width:18},{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'cancellations' && cancellations.length) {
      const keys = Object.keys(cancellations[0])
      const rows = cancellations.map(r => { const row={}; keys.forEach(k=>{row[k]=r[k]||''}); row['Comments']=gc('cancellations',`${r['Subject ID']||''}|${r['Visit']||''}|${r['Test / Assay']||''}`); return row })
      styledExport({ filename:`CLS_Cancellations_${stamp}.xlsx`, sheetName:'Cancellations', subTitle:'Cancelled tests', studyId, headers:[...keys.map(k=>({label:k,key:k,width:20})),{label:'Comments',key:'Comments',width:30}], rows })
    } else if (mode === 'visitrecon' && counts) {
      const vc = counts.visitCols
      const subs = [...new Set(allRows.map(r=>r.subjectId))].filter(Boolean)
      const sv = {}; allRows.forEach(r=>{if(r.subjectId&&r.visit){if(!sv[r.subjectId])sv[r.subjectId]={};sv[r.subjectId][r.visit]=true}})
      const rows = vc.map(v => { const att=subs.filter(s=>sv[s]?.[v]).length; const pend=att===0; return {'Visit':v,'Expected Subjects':subs.length,'Attended':pend?'Pending':att,'Missing / Pending':pend?0:subs.length-att,'Completion %':pend?'Pending':`${Math.round(att/subs.length*100)}%`, Comments:gc('visitrecon',v)} })
      styledExport({ filename:`CLS_Visit_Reconciliation_${stamp}.xlsx`, sheetName:'Visit Reconciliation', subTitle:'Visit attendance reconciliation', studyId, headers:[{label:'Visit',key:'Visit',width:16},{label:'Expected Subjects',key:'Expected Subjects',width:20},{label:'Attended',key:'Attended',width:14},{label:'Missing / Pending',key:'Missing / Pending',width:20},{label:'Completion %',key:'Completion %',width:16},{label:'Comments',key:'Comments',width:30}], rows })
    }
  }, [allRows, filtered, soaSchedule, counts, caches, studyId, tabComments, cancellations])

  // ── Render ────────────────────────────────────────────────────────────
  if (wasmOk === null) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:16,fontFamily:'Inter,system-ui,sans-serif'}}>
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="17" stroke="#dee2e6" strokeWidth="4"/>
        <path d="M20 3 A17 17 0 0 1 37 20" stroke="#1971c2" strokeWidth="4" strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.8s" repeatCount="indefinite"/>
        </path>
      </svg>
      <div style={{fontSize:14,color:'#495057',fontWeight:500}}>Loading PDF engine…</div>
    </div>
  )

  if (wasmOk === false) return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:16,fontFamily:'Inter,system-ui,sans-serif',padding:'0 24px',textAlign:'center'}}>
      <i className="ti ti-alert-triangle" style={{fontSize:40,color:'#c92a2a'}}/>
      <div style={{fontSize:14,color:'#c92a2a',fontWeight:500}}>PDF engine failed to load.</div>
      <div style={{fontSize:12,color:'#868e96',maxWidth:400}}>Ensure <code>pkg/liteparse_wasm.js</code> and <code>pkg/liteparse_wasm_bg.wasm</code> are deployed alongside this app.</div>
    </div>
  )

  const rtRow = r => resolveTest(r, { ...caches, soaSchedule })

  return (
    <div className="page">

      {/* ── Header ── */}
      <div className="header">
        <div className="header-left">
          <h1><i className="ti ti-flask" style={{verticalAlign:'-3px',marginRight:6}}/> CLS Sample Reconciliation Tracker</h1>
          <p>Drop a study protocol PDF to auto-extract the SOA · Load IQVIA report to reconcile samples by visit</p>
          <div className="header-badges">
            <span className="lab-badge lb-iqvia"><i className="ti ti-building-hospital" style={{fontSize:12}}/> IQVIA</span>
            <span className="lab-badge lb-ppd"><i className="ti ti-building-hospital" style={{fontSize:12}}/> PPD</span>
            <span className="lab-badge lb-labcorp"><i className="ti ti-building-hospital" style={{fontSize:12}}/> Labcorp</span>
          </div>
        </div>
      </div>

      {/* ── Upload grid ── */}
      <div className="upload-grid">
        <div>
          <div className="section-label">Step 1 — Drop protocol PDF (auto-extracts SOA)</div>
          <UploadZone id="protocol" icon="ti-file-text" accept=".pdf"
            state={protocolState.state} label={protocolState.label} hint={protocolState.hint}
            onFile={handleProtocol} />
        </div>
        <div>
          <div className="section-label">Step 2 — Sample management report</div>
          <UploadZone id="lab" icon="ti-table" accept=".xlsx,.xlsm,.csv"
            state={labState.state} label={labState.label} hint={labState.hint}
            onFile={handleLabFile} />
        </div>
      </div>

      {/* ── Optional reports ── */}
      <div className="optional-toggle-bar">
        <button className={`optional-toggle-btn ${optOpen ? 'open' : ''}`} onClick={() => setOptOpen(v => !v)}>
          <i className="ti ti-chevron-down"/> <span>{optOpen ? 'Hide additional reports' : 'Additional optional reports'}</span>
        </button>
      </div>
      <div className={`optional-reports ${optOpen ? 'visible' : ''}`}>
        {[
          { id:'spec',   icon:'ti-clipboard-list', label: specState.label,       hint:'Improves test-to-panel mapping',         accept:'.pdf,.xlsx,.docx', onFile: f => setSpecState({ state:'loaded', label:`✓ ${f.name}` }) },
          { id:'edc',    icon:'ti-database',        label: edcState.label,        hint:'Cross-references subject visit data',    accept:'.xlsx,.csv,.xls',  onFile: f => setEdcState({ state:'loaded', label:`✓ ${f.name}` }) },
          { id:'cancel', icon:'ti-x',               label: cancelFileState.label, hint:'Excludes cancelled visits from missing', accept:'.xlsx,.csv,.xls',  onFile: handleCancelFile },
        ].map(z => (
          <div key={z.id}>
            <div className="section-label" style={{textAlign:'center'}}>{z.id === 'spec' ? 'Lab Specification' : z.id === 'edc' ? 'EDC Report' : 'Cancellations'}</div>
            <UploadZone id={z.id} icon={z.icon} accept={z.accept} state={z.id==='cancel'?cancelFileState.state:''} label={z.label} hint={z.hint} onFile={z.onFile} />
          </div>
        ))}
      </div>

      {/* ── SOA editor ── */}
      {soaSchedule.length > 0 && (
        <div className="soa-result">
          <h4>Tests detected from the protocol — review and edit before they drive the tracker</h4>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr>
              <th style={{textAlign:'left',padding:'5px 8px',color:'var(--text3)',fontWeight:600,fontSize:10,textTransform:'uppercase',borderBottom:'1px solid var(--border2)',background:'var(--surface2)'}}>Test</th>
              <th style={{textAlign:'left',padding:'5px 8px',color:'var(--text3)',fontWeight:600,fontSize:10,textTransform:'uppercase',borderBottom:'1px solid var(--border2)',background:'var(--surface2)'}}>Visits from SOA</th>
              <th style={{padding:'5px 8px',borderBottom:'1px solid var(--border2)',background:'var(--surface2)'}}/>
            </tr></thead>
            <tbody>
              {soaSchedule.map((item, i) => (
                <tr key={i} style={{borderBottom:'0.5px solid var(--border)'}}>
                  <td style={{padding:'6px 8px',fontWeight:500,whiteSpace:'nowrap',verticalAlign:'top'}}>{item.test}</td>
                  <td style={{padding:'6px 8px'}}>{(item.visits||[]).map(v => <span key={v} className="visit-chip">{v}</span>)}</td>
                  <td style={{padding:'6px 8px'}}>
                    <button onClick={() => setSoaSchedule(s => s.filter((_,j)=>j!==i))}
                      style={{background:'none',border:'none',cursor:'pointer',color:'var(--text3)',fontSize:15}}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="soa-add">
            <input type="text" value={soaManualInput} onChange={e => setSoaManualInput(e.target.value)}
              placeholder="Add a test manually…"
              onKeyDown={e => { if (e.key === 'Enter' && soaManualInput.trim()) {
                setSoaSchedule(s => [...s, { test: soaManualInput.trim(), visits:[], gender:'all', analytes:[] }])
                setSoaManualInput('')
              }}} />
            <button className="btn" onClick={() => { if (!soaManualInput.trim()) return; setSoaSchedule(s => [...s, { test: soaManualInput.trim(), visits:[], gender:'all', analytes:[] }]); setSoaManualInput('') }}>
              <i className="ti ti-plus"/> Add
            </button>
          </div>
        </div>
      )}

      {/* ── Info strip ── */}
      <div className="info-strip">
        {[
          ['ti-test-pipe', 'Tests in SOA', stats.tests || '—'],
          ['ti-calendar-event', 'Visits', stats.visits || '—'],
          ['ti-building', 'Sites', stats.sites || '—'],
          ['ti-user', 'Subjects', stats.subjects || '—'],
          ['ti-flask', 'Study', stats.studies || '—'],
          ['ti-calendar', 'Last updated', stats.date],
        ].map(([icon, label, val]) => (
          <div key={label} className="info-chip"><i className={`ti ${icon}`}/>{label}: <strong>{val}</strong></div>
        ))}
      </div>

      {/* ── Metrics ── */}
      <div className="metrics">
        <div className="metric"><div className="metric-label">Total sample rows</div><div className="metric-value">{stats.expected || '—'}</div></div>
        <div className="metric"><div className="metric-label">Received</div><div className="metric-value green">{stats.received || '—'}</div></div>
        <div className="metric"><div className="metric-label">Missing</div><div className="metric-value red">{stats.expected ? stats.missing : '—'}</div></div>
        <div className="metric"><div className="metric-label">Receipt rate</div><div className="metric-value amber">{stats.rate}</div></div>
      </div>

      {/* ── Tabs ── */}
      <div className="tabs">
        {TABS.filter(t => !t.hiddenUntilLoaded || cancellations.length > 0).map(t => (
          <button key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label} <span className={`tab-badge ${t.red ? 'red' : ''}`}>{badges[t.id] || 0}</span>
          </button>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="search-bar">
        <div className="search-wrap"><i className="ti ti-search"/><input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search test, site, visit, subject ID, accession…"/></div>
        <Select value={filterSubject} onChange={setFilterSubject} label="All subjects" opts={subjectOpts}/>
        <Select value={filterVisit}   onChange={setFilterVisit}   label="All visits"   opts={visitOpts}/>
        <select value={filterStatus}  onChange={e=>setFilterStatus(e.target.value)}>
          <option value="">All statuses</option><option>Missing</option><option>Received</option>
        </select>
        <Select value={filterTest}    onChange={setFilterTest}    label="All tests"    opts={testOpts}/>
        {activeTab === 'samplelocations' && (
          <select value={filterLocation} onChange={e=>setFilterLocation(e.target.value)}>
            <option value="">All locations</option>
            <option>Central Lab</option><option>Referral Lab</option><option>On-site / Other</option><option>Unknown</option>
          </select>
        )}
      </div>

      {/* ── Export bar ── */}
      <div className="export-bar">
        <div className={`comment-import-wrap ${showCommentZone ? 'visible' : ''}`}>
          <label className={`comment-import-zone ${commentZoneLoaded ? 'loaded' : ''}`}>
            <i className="ti ti-upload"/> {commentZoneLoaded ? 'Comments loaded' : 'Drop updated export to load comments'}
            <input type="file" accept=".xlsx" style={{display:'none'}} onChange={e => { if (e.target.files[0]) handleCommentFile(e.target.files[0]); e.target.value='' }}/>
          </label>
        </div>
        <button className="btn btn-primary" onClick={() => dlExcel(activeTab)}>
          <i className="ti ti-download"/> Export {activeTab}
        </button>
        <button className={`comment-toggle ${showCommentZone ? 'active' : ''}`} onClick={() => { setShowCommentZone(v=>!v); setCommentZoneLoaded(false) }}>
          <i className="ti ti-message-plus"/> Import comments
        </button>
      </div>

      {/* ── Tab content ── */}
      {activeTab === 'recon'           && <ReconTab counts={counts} soaSchedule={soaSchedule} filterTest={filterTest} unmapped={counts?.unmapped||[]} showUnmapped={showUnmapped} setShowUnmapped={setShowUnmapped}/>}
      {activeTab === 'visitrecon'      && <VisitReconTab soaSchedule={soaSchedule} allRows={allRows} filterSubject={filterSubject} filterVisit={filterVisit} filterStatus={filterStatus} search={search}/>}
      {activeTab === 'tests'           && <TestsTab soaSchedule={soaSchedule} filtered={filtered} rtRow={rtRow}/>}
      {activeTab === 'missing'         && <MissingTab filtered={filtered} rtRow={rtRow}/>}
      {activeTab === 'samplelocations' && <SampleLocationsTab filtered={filtered} filterLocation={filterLocation} rtRow={rtRow} getComment={(k)=>getComment('samplelocations',k)}/>}
      {activeTab === 'sites'           && <SitesTab filtered={filtered}/>}
      {activeTab === 'raw'             && <RawTab filtered={filtered} rtRow={rtRow}/>}
      {activeTab === 'cancellations'   && <CancellationsTab cancellations={cancellations} getComment={(k)=>getComment('cancellations',k)}/>}

      <div className="footer">CLS Sample Reconciliation Tracker · Eli Lilly &amp; Company · All processing is local — no study data leaves your machine</div>
    </div>
  )
}

// ── Small shared components ───────────────────────────────────────────────

function Select({ value, onChange, label, opts }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{label}</option>
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  )
}

function Empty({ icon, text }) {
  return <div className="empty"><i className={`ti ${icon}`}/>{text}</div>
}

// ── Recon tab ─────────────────────────────────────────────────────────────
function ReconTab({ counts, soaSchedule, filterTest, unmapped, showUnmapped, setShowUnmapped }) {
  if (!soaSchedule.length) return (
    <div className="matrix-wrap"><div className="matrix-scroll">
      <table className="matrix-table"><thead><tr><th className="th-corner">Test / assay (from SOA)</th></tr></thead>
        <tbody><tr><td><Empty icon="ti-file-text" text="Drop a study protocol PDF to auto-extract SOA tests, then load the IQVIA report"/></td></tr></tbody>
      </table>
    </div></div>
  )
  const { bucket, visitCols } = counts || { bucket:{}, visitCols:[] }
  const visibleTests = filterTest ? soaSchedule.filter(t => t.test === filterTest) : soaSchedule
  return <>
    {unmapped.length > 0 && (
      <div className="unmapped-banner">
        <i className="ti ti-alert-triangle" style={{verticalAlign:-2}}/> <strong>{unmapped.length}</strong> sample row{unmapped.length!==1?'s':''} could not be mapped to the SOA.{' '}
        <a href="#" onClick={e=>{e.preventDefault();setShowUnmapped(v=>!v)}} style={{color:'var(--amber)',textDecoration:'underline'}}>Show details</a>
        {showUnmapped && <div style={{marginTop:8,maxHeight:160,overflowY:'auto'}}>
          {unmapped.slice(0,200).map((u,i) => <div key={i} style={{padding:'2px 0',borderTop:'1px solid var(--amber-border)'}}><span className="mono">{u.row.subjectId||'?'}</span> · {u.row.site||'?'} · {u.reason}</div>)}
          {unmapped.length>200 && <div style={{paddingTop:4}}>…and {unmapped.length-200} more</div>}
        </div>}
      </div>
    )}
    <div className="matrix-wrap"><div className="matrix-scroll">
      <table className="matrix-table">
        <thead><tr>
          <th className="th-corner">Test / assay (from SOA)</th>
          {visitCols.map(v => <th key={v} className="th-visit">{v}</th>)}
        </tr></thead>
        <tbody>
          {visibleTests.map(t => (
            <tr key={t.test}>
              <td className="td-test"><div className="td-test-inner"><div className="td-test-name">{t.test}</div></div></td>
              {visitCols.map(v => {
                const isExp = (t.visits||[]).includes(v)
                if (!isExp && v !== 'Unscheduled') return <td key={v} className="td-visit"><span className="badge b-na">N/A</span></td>
                const b = bucket[t.test]?.[v] || { expected:0, received:0 }
                if (b.expected === 0) return <td key={v} className="td-visit"><span className="badge b-expected">Expected</span></td>
                const cls = b.received === b.expected ? 'b-received' : b.received === 0 ? 'b-missing' : 'b-partial'
                return <td key={v} className="td-visit"><span className={`badge ${cls}`}>{b.received}/{b.expected}</span></td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div></div>
  </>
}

// ── Visit recon tab ────────────────────────────────────────────────────────
function VisitReconTab({ soaSchedule, allRows, filterSubject, filterVisit, filterStatus, search }) {
  if (!soaSchedule.length || !allRows.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-cloud-upload" text="Load files to see visit reconciliation"/></td></tr></tbody></table></div>

  const visitCols = []
  soaSchedule.forEach(t => (t.visits||[]).forEach(v => { if (!visitCols.includes(v)) visitCols.push(v) }))
  const vn = v => { const s=(v||'').toLowerCase(); if(/screen|baseline/.test(s))return -1; if(/eos|eot|end.?of|follow/.test(s))return 999999; const m=s.match(/(\d+)/); return m?parseInt(m[1],10):99999 }
  visitCols.sort((a,b)=>vn(a)-vn(b))

  let subjects = [...new Set(allRows.map(r=>r.subjectId))].filter(Boolean).sort()
  if (filterSubject) subjects = subjects.filter(s=>s===filterSubject)
  const sv = {}; allRows.forEach(r=>{if(r.subjectId&&r.visit&&(!filterSubject||r.subjectId===filterSubject)){(sv[r.subjectId]??={})[r.visit]=true}})
  const total = subjects.length
  const q = search.toLowerCase()

  const visibleVisits = filterVisit ? visitCols.filter(v=>v===filterVisit) : visitCols

  return <div className="tbl-wrap"><table className="matrix-table">
    <thead><tr>
      <th className="th-corner">Visit</th>
      <th className="th-visit">Expected subjects</th>
      <th className="th-visit">Attended</th>
      <th className="th-visit">Missing / Pending</th>
      <th className="th-visit">Completion</th>
    </tr></thead>
    <tbody>
      {visibleVisits.map(v => {
        const attended = subjects.filter(s=>sv[s]?.[v]).length
        const pending  = attended === 0
        if (filterStatus === 'Missing'  && !pending && total-attended===0) return null
        if (filterStatus === 'Received' && pending) return null
        if (q && !v.toLowerCase().includes(q)) return null
        if (pending) return (
          <tr key={v}>
            <td className="td-test"><div className="td-test-name">{v}</div></td>
            <td className="td-visit" style={{textAlign:'center'}}>{total}</td>
            <td className="td-visit" style={{textAlign:'center'}}><span className="badge b-expected">Expected</span></td>
            <td className="td-visit" style={{textAlign:'center'}}><span className="badge b-na">0</span></td>
            <td className="td-visit"><span className="badge b-expected">Pending</span></td>
          </tr>
        )
        const missing = total - attended
        const rate    = Math.round(attended / total * 100)
        const bg = rate>=90?'var(--green)':rate>=70?'var(--amber)':'var(--red)'
        return (
          <tr key={v}>
            <td className="td-test"><div className="td-test-name">{v}</div></td>
            <td className="td-visit" style={{textAlign:'center'}}>{total}</td>
            <td className="td-visit" style={{textAlign:'center'}}><span className={`badge ${attended===total?'b-received':'b-partial'}`}>{attended}</span></td>
            <td className="td-visit" style={{textAlign:'center'}}><span className={`badge ${missing>0?'b-missing':'b-received'}`}>{missing}</span></td>
            <td className="td-visit" style={{minWidth:160}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <div className="progress-bar" style={{flex:1}}><div className="progress-fill" style={{width:`${rate}%`,background:bg}}/></div>
                <span style={{fontWeight:600,fontSize:12,minWidth:36}}>{rate}%</span>
              </div>
            </td>
          </tr>
        )
      })}
    </tbody>
  </table></div>
}

// ── Tests tab ──────────────────────────────────────────────────────────────
function TestsTab({ soaSchedule, filtered, rtRow }) {
  if (!soaSchedule.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-file-text" text="Drop a protocol PDF to populate the SOA test list"/></td></tr></tbody></table></div>
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr><th>#</th><th>Test / assay</th><th>Visits with samples</th><th>Total</th><th>Received</th><th>Missing</th></tr></thead>
    <tbody>{soaSchedule.map((t,i) => {
      const rel=filtered.filter(r=>rtRow(r)===t.test); const rec=rel.filter(r=>r.received).length
      return <tr key={t.test}><td style={{color:'#868e96'}}>{i+1}</td><td style={{fontWeight:600}}>{t.test}</td><td>{(t.visits||[]).map(v=><span key={v} className="visit-chip">{v}</span>)}</td><td>{rel.length}</td><td style={{color:'var(--green)'}}>{rec}</td><td style={{color:'var(--red)'}}>{rel.length-rec}</td></tr>
    })}</tbody>
  </table></div>
}

// ── Missing tab ────────────────────────────────────────────────────────────
function MissingTab({ filtered, rtRow }) {
  const missing = filtered.filter(r=>!r.received)
  if (!missing.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon={filtered.length?'ti-circle-check':'ti-cloud-upload'} text={filtered.length?'No missing samples':'Load files to see missing samples'}/></td></tr></tbody></table></div>
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr><th>Subject ID</th><th>Site #</th><th>Visit</th><th>SOA test</th><th>Sample name</th><th>Accession #</th><th>Collection date</th><th>Sample status</th><th>Days since collection</th></tr></thead>
    <tbody>{missing.map((r,i) => {
      const days=daysSince(r.collectionDate); const sev=days===null?'b-na':days>14?'b-missing':days>7?'b-partial':'b-expected'
      return <tr key={i}><td className="mono">{r.subjectId}</td><td>{r.site}</td><td><span className="visit-chip">{r.visit||'—'}</span></td><td style={{fontWeight:600}}>{rtRow(r)||r.sampleName||'—'}</td><td style={{color:'#495057'}}>{r.sampleName}</td><td className="mono">{r.accession||'—'}</td><td style={{color:'#868e96'}}>{r.collectionDate||'—'}</td><td><span className="badge b-missing">{r.sampleStatus||'Not received'}</span></td><td><span className={`badge ${sev}`}>{days!==null?`${days}d`:'—'}</span></td></tr>
    })}</tbody>
  </table></div>
}

// ── Sites tab ─────────────────────────────────────────────────────────────
function SitesTab({ filtered }) {
  const sites = [...new Set(filtered.map(r=>r.site))].filter(Boolean)
  if (!sites.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-cloud-upload" text="Load the IQVIA report to see site breakdown"/></td></tr></tbody></table></div>
  const data = sites.map(site=>{const rows=filtered.filter(r=>r.site===site);const rec=rows.filter(r=>r.received).length;return{site,investigator:rows[0]?.investigator||'',exp:rows.length,rec,miss:rows.length-rec,rate:rows.length?Math.round(rec/rows.length*100):0}}).sort((a,b)=>a.rate-b.rate)
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr><th>Site #</th><th>Investigator</th><th>Expected</th><th>Received</th><th>Missing</th><th>Receipt rate</th><th>Progress</th></tr></thead>
    <tbody>{data.map(d=>{const bg=d.rate>=90?'var(--green)':d.rate>=70?'var(--amber)':'var(--red)';return<tr key={d.site}><td style={{fontWeight:600}}>{d.site}</td><td style={{color:'#495057'}}>{d.investigator}</td><td>{d.exp}</td><td style={{color:'var(--green)'}}>{d.rec}</td><td style={{color:'var(--red)'}}>{d.miss}</td><td style={{fontWeight:600}}>{d.rate}%</td><td style={{minWidth:80}}><div className="progress-bar"><div className="progress-fill" style={{width:`${d.rate}%`,background:bg}}/></div></td></tr>})}</tbody>
  </table></div>
}

// ── Raw tab ───────────────────────────────────────────────────────────────
function RawTab({ filtered, rtRow }) {
  if (!filtered.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-cloud-upload" text="Load the IQVIA report to see raw data"/></td></tr></tbody></table></div>
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr><th>Subject ID</th><th>Site #</th><th>Investigator</th><th>Visit</th><th>Sample name</th><th>Specimen ID</th><th>Accession #</th><th>Collection date</th><th>Received date</th><th>Sample status</th><th>Lifecycle step</th><th>AWB</th></tr></thead>
    <tbody>{filtered.map((r,i)=>{const sc=r.received?'b-received':'b-missing';return<tr key={i}><td className="mono">{r.subjectId}</td><td>{r.site}</td><td style={{color:'#495057',fontSize:11}}>{r.investigator}</td><td><span className="visit-chip">{r.visit||'—'}</span></td><td style={{fontWeight:500}}>{r.sampleName}</td><td className="mono">{r.specimenId||'—'}</td><td className="mono">{r.accession||'—'}</td><td style={{color:'#868e96'}}>{r.collectionDate||'—'}</td><td style={{color:'#868e96'}}>{r.receivedDate||'—'}</td><td><span className={`badge ${sc}`}>{r.sampleStatus||'—'}</span></td><td style={{fontSize:11,color:'#495057'}}>{r.lifecycleStep||'—'}</td><td className="mono" style={{fontSize:10}}>{r.awb||'—'}</td></tr>})}</tbody>
  </table></div>
}

// ── Sample locations tab ──────────────────────────────────────────────────
function SampleLocationsTab({ filtered, filterLocation, rtRow, getComment }) {
  const normLoc = loc => { const l=(loc||'').toLowerCase().trim(); if(!l)return'Unknown'; if(l.includes('central'))return'Central Lab'; if(l.includes('referral'))return'Referral Lab'; return'On-site / Other' }
  const locBadge = loc => loc==='Central Lab'?'b-received':loc==='Referral Lab'?'b-partial':loc==='On-site / Other'?'b-expected':'b-na'
  let rows = filtered.filter(r=>r.received)
  if (filterLocation) rows = rows.filter(r=>normLoc(r.sampleLocation)===filterLocation)
  if (!rows.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-map-pin" text="No received samples match current filters"/></td></tr></tbody></table></div>
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr><th>Subject ID</th><th>Site</th><th>Visit</th><th>Test / Assay</th><th>Accession</th><th>Received Date</th><th>AWB</th><th>Current Location</th><th>Comments</th></tr></thead>
    <tbody>{rows.map((r,i)=>{const loc=normLoc(r.sampleLocation);return<tr key={i}><td className="mono">{r.subjectId}</td><td>{r.site}</td><td><span className="visit-chip">{r.visit||'—'}</span></td><td style={{fontWeight:500}}>{rtRow(r)||r.sampleName||'—'}</td><td className="mono">{r.accession||'—'}</td><td style={{color:'#868e96'}}>{r.receivedDate||'—'}</td><td className="mono" style={{fontSize:11}}>{r.awb||'—'}</td><td><span className={`badge ${locBadge(loc)}`}>{loc}</span></td><td style={{color:'#868e96',fontSize:11}}>{getComment(`${r.subjectId}|${r.visit}|${r.accession}`)}</td></tr>})}</tbody>
  </table></div>
}

// ── Cancellations tab ─────────────────────────────────────────────────────
function CancellationsTab({ cancellations, getComment }) {
  if (!cancellations.length) return <div className="tbl-wrap"><table className="data-table"><tbody><tr><td><Empty icon="ti-x" text="No cancellations loaded"/></td></tr></tbody></table></div>
  const keys = Object.keys(cancellations[0])
  const fc = re => keys.find(k=>re.test(k))||''
  const sCol=fc(/subject|subj/i),siCol=fc(/^site$/i),vCol=fc(/visit/i),tCol=fc(/test|assay|panel/i),dCol=fc(/date|cancel/i),rCol=fc(/reason|comment|note/i),stCol=fc(/status/i)
  const cols = [sCol,siCol,vCol,tCol,dCol,rCol,stCol].filter(Boolean)
  return <div className="tbl-wrap"><table className="data-table">
    <thead><tr>{cols.map(c=><th key={c}>{c}</th>)}<th>Comments</th></tr></thead>
    <tbody>{cancellations.map((r,i)=>(
      <tr key={i}>
        {cols.map(c=><td key={c}>{c===vCol?<span className="visit-chip">{r[c]||'—'}</span>:c===stCol?<span className="badge b-missing">{r[c]||'—'}</span>:(r[c]||'—')}</td>)}
        <td style={{color:'#868e96',fontSize:11}}>{getComment(`${r[sCol]||''}|${r[vCol]||''}|${r[tCol]||''}`)}</td>
      </tr>
    ))}</tbody>
  </table></div>
}

// ── Comment key helper ────────────────────────────────────────────────────
function makeCommentKey(mode, row) {
  switch (mode) {
    case 'recon':           return row['Test / Assay']||''
    case 'visitrecon':      return row['Visit']||''
    case 'tests':           return row['Test / Assay']||''
    case 'missing':         return `${row['Subject ID']||''}|${row['Visit']||''}|${row['Sample Name']||''}`
    case 'sites':           return row['Site']||''
    case 'raw':             return `${row['Subject ID']||''}|${row['Visit']||''}|${row['Sample Name']||''}`
    case 'cancellations':   return `${row['Subject ID']||''}|${row['Visit']||''}|${row['Test / Assay']||''}`
    case 'samplelocations': return `${row['Subject ID']||''}|${row['Visit']||''}|${row['Accession']||''}`
    default: return null
  }
}
