/** Merge candidates without treating a model observation as user approval. */
export const PROFILE_FIELDS = ['document_type','title','language','book_type','note_numbering','note_location','layout','start_page','end_page','note_start_page','note_end_page','cover_page','bibliography']
export function normalizeProfileAnalysis(report) {
  const fields={...report?.fields}
  if(!['endnote_only','mixed'].includes(fields.book_type?.value)||!fields.note_start_page||!fields.note_end_page||fields.note_start_page.value>fields.note_end_page.value){
    delete fields.note_start_page;delete fields.note_end_page
  }
  if(fields.book_type?.value==='no_notes'&&fields.note_location?.value==='none'&&['high','medium'].includes(fields.book_type?.confidence)&&['high','medium'].includes(fields.note_location?.confidence)){
    if(!fields.note_numbering||!['per_page','per_chapter','continuous'].includes(fields.note_numbering.value)){
      fields.note_numbering={value:'per_chapter',confidence:fields.book_type.confidence,pages:fields.book_type.pages??[1],reason:'无注释文献默认按章编号占位',source:fields.book_type.source??'model'}
    }
  }
  return {...report,fields}
}
export function mergeProfileAnalysis(task, report, {preserveSaved=false}={}) {
  if(report?.schemaVersion!==1||report.fingerprint!==task.inspection?.fingerprint)throw new Error('结构分析与当前源文件不一致')
  report=normalizeProfileAnalysis(report)
  const old=task.profile??{},profile={document_type:task.kind,title:task.name,transcription_method:'vision',...old}
  if(!preserveSaved&&!old.confirmed){
    // Discard earlier unapproved machine guesses when a later observation is uncertain.
    delete profile.regions
    for(const key of PROFILE_FIELDS)if(!['document_type','title'].includes(key))delete profile[key]
    for(const key of PROFILE_FIELDS){
      const field=report.fields?.[key]
      if(field&&['high','medium'].includes(field.confidence)&&(field.value!==undefined&&(field.value!==null||key==='cover_page')))profile[key]=field.value
    }
  }
  if(profile.book_type==='no_notes'&&profile.note_location==='none'&&!['per_page','per_chapter','continuous'].includes(profile.note_numbering)){
    profile.note_numbering='per_chapter'
  }
  profile.confirmed=preserveSaved&&old.source_fingerprint===report.fingerprint?old.confirmed===true:false
  profile.source_fingerprint=report.fingerprint
  return profile
}

/** A successful model response can still lack fields needed by the pipeline. */
export function profileReadiness(task) {
  const p=task.profile??{},missing=[]
  const labels={language:'原文语言',book_type:'注释体例',note_numbering:'注释编号方式',note_location:'注释位置',layout:'页面布局',regions:'逐页区域与阅读顺序'}
  if(!/^[a-z]{2,3}$/.test(p.language??''))missing.push('language')
  if(task.input?.type==='pdf'){
    const values={book_type:['footnote_only','endnote_only','mixed','no_notes'],note_numbering:['per_page','per_chapter','continuous'],note_location:['per_page_bottom','chapter_end_notes','book_end_notes','none','mixed'],layout:['single','spread','columns']}
    for(const [key,allowed] of Object.entries(values)){
      if(key==='note_numbering'&&p.book_type==='no_notes'&&p.note_location==='none'&&(p.note_numbering==='none'||p.note_numbering===null||p.note_numbering===undefined||p.note_numbering===''))continue
      if(!allowed.includes(p[key]))missing.push(key)
    }
    if(['spread','columns'].includes(p.layout)&&(!Array.isArray(p.regions)||!p.regions.length))missing.push('regions')
  }
  return {ready:missing.length===0,missing,message:missing.length?'文档体例尚未确认：'+missing.map(key=>labels[key]).join('、')+'。已保留分析结果；补充证据并核验这些字段后才能继续。':null}
}
