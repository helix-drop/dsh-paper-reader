import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PipelineIndex, fileStamp } from './storage.js'
import { enrichReading, replaceBlock } from './reader.js'
import { importLegacyBooks } from './legacy.js'
import { importLegacyPapers } from './papers.js'
import { readPipelineConfiguration } from './configuration.js'
import { hash, markdownBlocks, checkMarkdownPair } from './markdown.js'
import { BookmarkStore, exportBookmarks } from './bookmarks.js'
import {cliStatus,LINGUAGACHA_CLI,translationPrompt} from './cli.js'
import { buildPublication, commitPublication } from './publication.js'
const VISION = '.kimi-code/skills/fnm-ai-convert/scripts'
const TEXT = '.kimi-code/skills/fnm-textlayer-convert/scripts'
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
const documentIdFor=t=>t.documentId&&t.documentId!=='document:undefined'?t.documentId:'document:'+(t.input?.fingerprint??t.inspection?.fingerprint??t.id)
const exists = async p => !!(await fs.stat(p).catch(()=>null))
async function atomic(file, value) { await fs.mkdir(path.dirname(file),{recursive:true}); const tmp=`${file}.${randomUUID()}.tmp`; try { await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); await fs.rename(tmp,file) } finally { await fs.unlink(tmp).catch(()=>{}) } }
async function json(file, fallback) { try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('任务记录格式异常')} }
async function walk(dir, extension, maxDepth=5) { const out=[]; if(maxDepth<0)return out; for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])) { if(e.name.startsWith('.')||e.isSymbolicLink())continue;const f=path.join(dir,e.name); if(e.isDirectory())out.push(...await walk(f,extension,maxDepth-1));else if(extension.test(e.name))out.push(f) } return out }
export const STAGES = [
  {id:'inspect',name:'输入检查',entry:'census_borndigital / document_pipeline',scope:'all'},
  {id:'normalize',name:'范围与布局',entry:'document_pipeline normalize',scope:'pdf'},
  {id:'images',name:'页面图',entry:'extract_page_images',scope:'pdf'},
  {id:'paddle',name:'PaddleOCR',entry:'paddle_ocr（仅核对与失败兜底）',scope:'ocr'},
  {id:'mineru',name:'MinerU',entry:'mineru_ocr（仅核对与失败兜底）',scope:'ocr'},
  {id:'prepare',name:'结构准备',entry:'tl_convert prepare / 单篇结构自动生成 / 观察 worker',scope:'pdf'},
  {id:'transcribe',name:'转写',entry:'tl_convert extract / marker_prescan + bounded_chapter（视觉优先）',scope:'pdf'},
  {id:'verify',name:'原文校验',entry:'gate_check 3c / verify_page_json / verify_textlayer_structure',scope:'pdf'},
  {id:'assemble',name:'文档装配',entry:'assemble_chapter / assemble_book / verify_output / audit_book',scope:'pdf'},
  {id:'glossary',name:'术语整理',entry:'curate_glossary',scope:'all'},
  {id:'lgProject',name:'翻译准备',entry:'LinguaGacha 官方 CLI / Markdown V2',scope:'all'},
  {id:'translate',name:'段落翻译',entry:'LinguaGacha batch-translation',scope:'all'},
  {id:'translationCheck',name:'译文校验',entry:'段落块对应 / 注释 / 附件',scope:'all'},
  {id:'review',name:'语义审校',entry:'book-translation-review',scope:'all'},
  {id:'publish',name:'发布',entry:'阅读成品与附件清单',scope:'all'},
]
export class TaskManager {
  constructor(root, readingRoot, options={}) { this.root=root; this.readingRoot=readingRoot; this.base=path.join(root,'.pipeline/tasks'); this.active=new Map(); this.locks=new Map(); this.publishRoot=options.publishRoot??'/Users/hao/Documents/obsidian/obsidian/MD书籍'; this.python=options.python??'/opt/homebrew/bin/python3'; this.bookmarkStore=new BookmarkStore(path.join(root,'.pipeline/bookmarks-v1.json')); this.cliExecutable=options.cliExecutable??LINGUAGACHA_CLI;this.cliStatus=options.cliStatus??(()=>cliStatus(this.root));this.fetch=options.fetch??fetch; this.index=new PipelineIndex(root); this.indexReady=null }
  dir(id) { if(!validId(id))throw new Error('任务编号无效');return path.join(this.base,id) }
  async locked(id, fn) {const before=this.locks.get(id)??Promise.resolve();const next=before.catch(()=>{}).then(fn);this.locks.set(id,next);try{return await next}finally{if(this.locks.get(id)===next)this.locks.delete(id)}}
  async get(id) { const task=await json(path.join(this.dir(id),'task.json'));if(!task)throw new Error('任务不存在');if(task.state==='running'&&!this.active.has(id)){task.state='interrupted';task.stages[task.stage]={...task.stages[task.stage],state:'interrupted'};task.message='宿主重启后任务已中断，先检查产物再续跑';await this.save(task)}return task }
  async refreshLibraryProof(t){
    if(t.legacy)return
    if(!t.publication?.published||!t.translationReport?.passed){delete t.libraryProof;return}
    try {const source=await this.original(t),sourceStamp=await fileStamp(source),targetStamp=await fileStamp(t.translationPath);if(t.libraryProof?.sourceStamp===sourceStamp&&t.libraryProof?.targetStamp===targetStamp)return
      const src=await fs.readFile(source,'utf8'),dst=await fs.readFile(t.translationPath,'utf8');if(hash(src)!==t.translationReport.sourceFingerprint||hash(dst)!==t.translationReport.targetFingerprint){delete t.libraryProof;return}
      t.libraryProof={kind:'pipeline',source,target:t.translationPath,sourceStamp,targetStamp}
    }catch{delete t.libraryProof}
  }
  async save(t) {t.schemaVersion=2;t.documentId=documentIdFor(t);t.updatedAt=new Date().toISOString();await this.refreshLibraryProof(t);const file=path.join(this.dir(t.id),'task.json');await atomic(file,t);await this.index.put(t,await fileStamp(file));return t}
  async ensureIndex(){if(!this.indexReady)this.indexReady=(async()=>{const stamps=await this.index.stamps();for(const id of (await fs.readdir(this.base).catch(()=>[])).filter(validId)){const file=path.join(this.dir(id),'task.json'),stamp=await fileStamp(file);if(stamps.get(id)===stamp)continue;const t=await this.get(id);let currentStamp=stamp;if(!t.documentId||t.documentId==='document:undefined'||t.schemaVersion!==2){const backup=path.join(this.root,'.pipeline/backups/storage-v2',id+'.task.json');await fs.mkdir(path.dirname(backup),{recursive:true});if(!await exists(backup)){await fs.copyFile(file,backup);await fs.chmod(backup,0o600)}t.input.fingerprint??=t.inspection?.fingerprint;t.documentId=documentIdFor(t);t.schemaVersion=2;await atomic(file,t);currentStamp=await fileStamp(file)}await this.refreshLibraryProof(t);await this.index.put(t,currentStamp)}})();return this.indexReady}
  async list(){await this.ensureIndex();return this.index.all()}
  async listPage(query={}){await this.ensureIndex();return this.index.page(query)}
  async importLegacy(){return this.locked('legacy-import',()=>importLegacyBooks(this))}
  async importPapers(){return this.locked('paper-import',()=>importLegacyPapers(this))}
  async adoptLegacy(id){return this.locked(id,async()=>{const old=await this.get(id),file=old.legacy?.artifacts?.original;if(!file)throw new Error('尚无完整装配原文，不能另建任务重置转写预算');const text=await fs.readFile(file,'utf8'),fingerprint=hash(text);const existing=(await this.list()).find(t=>t.sourceHistory?.taskId===id&&t.input.fingerprint===fingerprint);if(existing)return existing;const now=new Date().toISOString(),t={id:randomUUID(),documentId:old.documentId,documentTitle:old.name,name:old.name+' · 接续',kind:old.kind,input:{id:hash(file),name:path.basename(file),type:'markdown',fingerprint},path:file,worker:{provider:'not_required',model:'现成 Markdown，不需转写',timeout:600},state:'idle',stage:'inspect',createdAt:now,stages:{inspect:{state:'done',at:now}},inspection:{fingerprint,verdict:'MARKDOWN',blocks:markdownBlocks(text).length,pages:0},profile:{document_type:old.kind,language:old.profile?.language??'',confirmed:false,source_fingerprint:fingerprint},sourceHistory:{taskId:id,directory:old.legacy.directory,audit:old.legacy.artifacts.audit,budgets:old.legacy.artifacts.budgetFiles,transcriptionRepeated:false,originalQualityVerified:false},bookmarks:[],log:[{stage:'legacyAdoption',command:'已有 Markdown 接续',exitCode:0,endedAt:now}],lgUrl:'',message:'原项目成果、日志和转写预算保留；接续只处理现有 Markdown。'};return this.save(t)})}
  async catalog() {
    const files=[...await walk(path.join(this.root,'Book'),/\.pdf$|\.md$|\.markdown$/i,4),...await walk(path.join(this.readingRoot,'src'),/\.pdf$/i,1),...await walk(path.join(this.base,'uploads'),/\.md$|\.markdown$|\.pdf$/i,1)]
    const sources=[];for(const f of files.filter(f=>!/check_report|audit|README|report|manifest|REMAINING|HANDOFF|^目录\.pdf$/i.test(path.basename(f))&&!/(?:[\\/])(?:ocr|runs|llm_traces|logs|ai_convert|reference)[\\/]/i.test(f))) {const st=await fs.stat(f);sources.push({id:hash(f),name:path.relative(f.startsWith(this.root+path.sep)?this.root:this.readingRoot,f),type:/\.pdf$/i.test(f)?'pdf':'markdown',displayName:path.basename(f).replace(/^[a-f0-9-]{36}-/i,''),bytes:st.size,path:f})}
    return sources
  }
  async upload(name, bytes) { if(typeof name!=='string'||!(/\.(md|markdown|pdf)$/i.test(name))||bytes.length>100*1024*1024)throw new Error('只接受不超过100 MB的PDF或Markdown');const file=path.join(this.base,'uploads',`${randomUUID()}-${path.basename(name).replace(/[^\w.\-一-鿿]/g,'_')}`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return {sourceId:hash(file),filename:path.basename(name)} }
  async create(args) {
    const source=(await this.catalog()).find(s=>s.id===args.sourceId);if(!source)throw new Error('请选择已登记的源文件')
    const isAuto=args.kind==='auto'||!args.kind
    const detection=isAuto?await this.detectSource(args.sourceId):null
    if(detection){
      if(detection.confidence==='low')throw new Error('结构或体裁信息不足（置信度低），请明确选择文档类型：论文、章节节选、整本书或文章合集')
      args={...args,kind:detection.kind}
    }
    if(!['book','paper','chapter','collection'].includes(args.kind))throw new Error('文档类型无效')
    const fingerprint=hash(await fs.readFile(source.path));if(args.forceNew!==true){const existing=(await this.list()).find(t=>t.kind===args.kind&&t.input.fingerprint===fingerprint);if(existing&&await exists(existing.path))return {...existing,reused:true}}
    const config=await readPipelineConfiguration(this.root), worker=config.workers.find(w=>w.id===args.workerId)??config.workers.find(w=>w.default)
    if(!worker?.selectable)throw new Error('此模型不能作主转写')
    const t={id:randomUUID(),name:String(args.name||source.displayName||path.basename(source.path)).slice(0,150),kind:args.kind,typeSuggestion:detection,input:{...source,fingerprint},path:source.path,worker:{provider:worker.provider,model:worker.model,timeout:worker.timeout},state:'queued',stage:'inspect',createdAt:new Date().toISOString(),stages:{},bookmarks:[],log:[],lgUrl:''}
    await fs.mkdir(this.dir(t.id),{recursive:true}); return this.save(t)
  }
  async detectSource(sourceId){
    const source=(await this.catalog()).find(s=>s.id===sourceId);if(!source)throw new Error('源文件未登记')
    return new Promise((resolve,reject)=>execFile(this.python,[path.join(this.root,'lingua/detect_document.py'),source.path],{cwd:this.root,timeout:20000,maxBuffer:65536},(error,stdout)=>{if(error)return reject(new Error('类型识别未完成，可手动选择文档类型'));try{resolve({...JSON.parse(stdout),suggestedName:source.displayName??path.basename(source.path)})}catch{reject(new Error('类型识别结果无效'))}}))
  }
  async rename(id,name){return this.locked(id,async()=>{const t=await this.get(id);if(this.active.has(id))throw new Error('任务运行中暂不能改名');if(typeof name!=='string'||!name.trim()||name.trim().length>150)throw new Error('任务名称须为1至150字');t.name=name.trim();return this.save(t)})}
  async library(){await this.importPapers();await this.ensureIndex();const result=[],seen=new Set();for(const {task:t,proof} of await this.index.library()){
    let valid=proof.kind==='legacy'?await fileStamp(proof.readingPath)===proof.readingStamp:await fileStamp(proof.source)===proof.sourceStamp&&await fileStamp(proof.target)===proof.targetStamp
    if(!valid&&proof.kind==='legacy'){const full=await this.get(t.id),stamp=await fileStamp(proof.readingPath);if(stamp&&hash(await fs.readFile(proof.readingPath))===full.legacy?.readingFingerprint){full.libraryProof={...proof,readingStamp:stamp};await this.save(full);valid=true}}
    if(!valid){await this.index.clearProof(t.id);continue}
    if(seen.has(t.documentId??t.id))continue;seen.add(t.documentId??t.id);result.push({id:t.id,documentId:t.documentId,name:t.documentTitle??t.name,kind:t.kind,ready:true,...(t.paperImport?{author:t.paperImport.metadata.author?.zh??t.paperImport.metadata.author?.source,titleSource:t.paperImport.metadata.title?.source,legacyPaperFile:t.paperImport.file}:{})})
  }return result}
  async bookmarkDocument(source,view='original'){
    if(source?.kind==='task'){const t=await this.get(source.id),doc=await this.reading(t.id);return{id:t.documentId??'document:'+t.input.fingerprint,title:t.name,kind:t.kind,source:{kind:'task',id:t.id},version:doc.version??hash(doc.fingerprint+'|'+(t.translationReport?.targetFingerprint??'')),blocks:doc.standaloneView==='translation'?view==='original'?(doc.originalBlocks??[]):doc.blocks.map(b=>({...b,translation:b.text})):doc.blocks}}
    if(source?.kind!=='paper'||typeof source.id!=='string'||!(/^[\w.\-一-鿿]+\.json$/u.test(source.id)))throw new Error('书签文档无效')
    const file=await fs.realpath(path.join(this.readingRoot,source.id)),base=await fs.realpath(this.readingRoot);if(!file.startsWith(base+path.sep))throw new Error('书签文档路径无效')
    const raw=await fs.readFile(file,'utf8'),doc=JSON.parse(raw);if(doc.status!=='done')throw new Error('此文档尚未完成处理')
    return{id:'paper:'+String(doc.id??source.id),title:doc.title?.zh??doc.title?.source??doc.id,kind:'paper',source:{kind:'paper',id:source.id},version:hash(raw),blocks:(doc.blocks??[]).map(b=>({id:String(b.id),text:b.source??b.text,translation:b.text}))}
  }
  async bookmarks(query={}){
    const saved=await this.bookmarkStore.list(query),ids=new Set(saved.map(b=>b.id));
    await this.ensureIndex();const summaries=await this.index.summaries();for(const t of summaries)for(const b of t.bookmarks??[]){const documentId=t.documentId??'document:'+t.input.fingerprint;if(ids.has(b.id)||query.documentId&&query.documentId!==documentId||query.q&&!([b.excerpt,b.note,t.name].join(' ').toLowerCase().includes(query.q.toLowerCase())))continue;saved.push({...b,documentId,source:{kind:'task',id:t.id},document:{id:documentId,title:t.name,kind:t.kind},quote:b.excerpt,comment:b.note,tags:[],createdAt:t.createdAt,updatedAt:t.updatedAt,selector:{type:'LegacyBlockSelector',startBlockId:b.blockId,endBlockId:b.blockId,view:'original'}})}
    const migrated=(await this.list()).filter(t=>t.paperImport);for(const b of saved){if(b.source?.kind==='paper'){const t=migrated.find(t=>t.paperImport.file===b.source.id);if(t)b.source={kind:'task',id:t.id}}}
    const names=new Map(summaries.map(t=>[t.id,t]));for(const b of saved)if(b.source?.kind==='task'&&names.has(b.source.id)){const t=names.get(b.source.id);b.document={...b.document,title:t.name,kind:t.kind}}
    return saved.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
  }
  async saveSelectionBookmark(args){if(args.remove){const hit=(await this.bookmarks()).find(b=>b.id===args.remove);if(hit?.selector.type==='LegacyBlockSelector')return this.bookmark(hit.source.id,{remove:args.remove});return this.bookmarkStore.remove(args.remove)}return this.bookmarkStore.add(await this.bookmarkDocument(args.source,args.selection?.view),args)}
  docDir(t){return path.join(this.dir(t.id),'document')}
  aiDir(t){return path.join(this.docDir(t),'ai_convert')}
  async command(t, cmd, args, io={}) {
    const entry={stage:t.stage,startedAt:new Date().toISOString(),command: path.basename(args[0]?.startsWith('--')?cmd:args[0]??cmd)}; t.log.push(entry);await this.save(t)
    return new Promise((resolve,reject)=>{
      const childEnv={...process.env,PYTHONUNBUFFERED:'1'};if(cmd===this.cliExecutable)delete childEnv.ELECTRON_RUN_AS_NODE;const child=spawn(cmd,args,{cwd:this.root,detached:true,stdio:['ignore','pipe','pipe'],env:childEnv});const active=this.active.get(t.id);if(active){active.child=child;if(active.cancel)try{process.kill(-child.pid,'SIGTERM')}catch{}}
      let output='',pending='',events=Promise.resolve();const collectStdout=b=>{if(io.onLine){pending+=b.toString();const lines=pending.split('\n');pending=lines.pop();for(const line of lines)events=events.then(()=>io.onLine(line))}collect(b)}; const collect=b=>{output=(output+b.toString()).slice(-512*1024)};child.stdout.on('data',collectStdout);child.stderr.on('data',collect)
      const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM')}catch{};const kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);kill.unref();entry.timedOut=true},3*60*60*1000);timer.unref()
      child.on('error',()=>{clearTimeout(timer);reject(new Error('处理程序无法启动'))});child.on('close',async(code,signal)=>{clearTimeout(timer);if(io.onLine&&pending)events=events.then(()=>io.onLine(pending));try{await events}catch{reject(new Error('CLI 进度记录失败，保留输出等待核验'));return}if(active)active.child=null;entry.exitCode=code;entry.signal=signal;entry.endedAt=new Date().toISOString();if(code!==0)reject(new Error(active?.cancel?'任务已停止':`${entry.command} 未通过，退出码 ${code}；已有产物保留`));else resolve(output)})
    })
  }
  py(t,script,args=[]){return this.command(t,this.python,[path.join(this.root,script),...args])}
  async confirmed(t){if(!t.profile?.confirmed)throw new Error('先检查输入并确认结构配置');if(t.profile.source_fingerprint!==hash(await fs.readFile(t.path)))throw new Error('源文件已变化，必须重新确认');if(t.scope&&(t.scope.fingerprint!==hash(await fs.readFile(path.join(this.docDir(t),'source.pdf')))||t.scope.profileFingerprint!==hash(await fs.readFile(path.join(this.docDir(t),'document_profile.json')))))throw new Error('范围底本或页映射已变化，停止处理');}
  async updateWorker(id, workerId) {return this.locked(id,async()=>{
    const t=await this.get(id)
    if(t.legacy)throw new Error('旧项目模型记录保持只读；请接续现有 Markdown 后再配置后续任务');if(t.legacy?.progress?.auditRecords||t.legacy?.progress?.budget?.length)throw new Error('旧任务的模型与历史预算保留，不能切换后重新转写')
    if(this.active.has(id))throw new Error('任务正在运行，不能更换转写模型')
    if(t.stages.transcribe||(t.log??[]).some(l=>l.stage==='transcribe')||(await fs.stat(path.join(this.aiDir(t),'worker_audit.jsonl')).catch(()=>({size:0}))).size>0)throw new Error('此任务已尝试转写，模型与预算必须保留；请另建任务选择新模型')
    const config=await readPipelineConfiguration(this.root),worker=config.workers.find(w=>w.id===workerId)
    if(!worker?.selectable)throw new Error('请选择可用于主转写的项目模型')
    t.worker={provider:worker.provider,model:worker.model,timeout:worker.timeout}
    t.message='转写模型已更新，尚未启动转写；已有结构与处理记录保留'
    return this.save(t)
  })}
  async updateProfile(id, profile) {return this.locked(id,async()=>{const t=await this.get(id);if(t.legacy)throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务');if(this.active.has(id))throw new Error('运行中不能修改结构');if(t.stages.normalize?.state==='done'||t.stages.lgProject?.state==='done')throw new Error('底本已确定，结构变更须建立新任务');if(!t.inspection)throw new Error('先完成输入检查');const docType=(['book','paper','chapter','collection'].includes(profile.document_type)?profile.document_type:t.kind);t.kind=docType;profile={...profile,document_type:docType,source_fingerprint:t.inspection.fingerprint};const file=path.join(this.dir(id),'profile.candidate.json');await atomic(file,profile);if(t.input.type==='pdf'){await this.py(t,'document_pipeline.py',['validate',t.path,'--profile',file])}else if(profile.confirmed!==true||!(/^[a-z]{2,3}$/.test(profile.language??'')))throw new Error('请确认原文语言与范围');await fs.rename(file,path.join(this.dir(id),'profile.json'));t.profile=profile;delete t.stages.translationCheck;delete t.stages.publish;return this.save(t)})}
  async start(id,stage,options={}) {return this.locked(id,async()=>{const t=await this.get(id);if(t.legacy)throw new Error('旧项目记录保持只读；已有装配原文可建立接续任务，缺少原文时不得重置转写预算。');if(this.active.has(id))throw new Error('此任务正在运行');if(!STAGES.some(s=>s.id===stage))throw new Error('处理入口无效');if(stage!=='inspect')await this.confirmed(t);if(stage==='transcribe'&&t.stages.transcribe?.state==='done'&&(t.inspection?.verdict!=='BORN-DIGITAL'||t.profile.transcription_method==='vision')){for(const c of await this.chapters(t)){try{await this.acceptTranscriptionDelivery(t,c.id)}catch(e){t.state='blocked';t.stages.transcribe={state:'blocked'};t.message=e.message;await this.save(t);throw e}}}if(t.stages[stage]?.state==='done'&&!['inspect','verify','translationCheck','review','publish','lgProject'].includes(stage))return t;if(['translate','lgProject'].includes(stage)&&[...this.active.keys()].some(other=>other!==id&&(this.active.get(other).translationCli||t.lgUrl&&this.active.get(other).lgUrl===t.lgUrl)))throw new Error('同一翻译服务正在处理另一任务');if(t.translationEngine==='http'&&['translate','lgProject'].includes(stage)&&!t.lgUrl)throw new Error('先连接 LinguaGacha 本地服务');if(stage==='transcribe'&&(t.inspection?.verdict!=='BORN-DIGITAL'||t.profile?.transcription_method==='vision')&&!t.observationConfirmed)throw new Error('先完成结构准备与阶段门禁');t.stage=stage;t.state='running';t.message='正在执行';t.stages[stage]={state:'running'};const active={cancel:false,child:null,translationCli:t.translationEngine!=='http'&&['translate','lgProject'].includes(stage),lgUrl:t.translationEngine==='http'&&['translate','lgProject'].includes(stage)?t.lgUrl:null};this.active.set(id,active);await this.save(t);active.promise=this.perform(t,stage,options).then(()=>{t.stages[stage]={state:'done',at:new Date().toISOString()};t.state='idle';t.message='阶段已完成；程序检查不代表语义验收'}).catch(e=>{t.stages[stage]={state:active.cancel?'stopped':'blocked'};t.state=active.cancel?'paused':'blocked';t.message=active.cancel&&['paddle','mineru'].includes(stage)?'已停止本地等待；云端任务可能继续，恢复时复用已保存的任务编号':String(e.message)}).finally(async()=>{await this.save(t);this.active.delete(id)});return t})}
  async stop(id) {const active=this.active.get(id);if(!active)return this.get(id);active.cancel=true;if(active.child){try{process.kill(-active.child.pid,'SIGTERM')}catch{};const child=active.child;const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);timer.unref()}if(active.lgUrl&&(await this.get(id)).stage==='translate')await this.lg(await this.get(id),'/api/batch-translation/stop',{});await active.promise;return this.get(id)}
  async requireDone(t,...stages){for(const s of stages)if(t.stages[s]?.state!=='done')throw new Error(`先完成${STAGES.find(x=>x.id===s)?.name??s}`)}
  async chapters(t){return json(path.join(this.aiDir(t),'chapters.json'),[])}
  async ensureSinglePieceStructure(t){
    if(!['paper','chapter'].includes(t.kind))return
    const ai=this.aiDir(t),total=Number(t.scope?.pages??0);if(total<1)throw new Error('缺少规范化页数，请先完成范围与布局')
    await fs.mkdir(ai,{recursive:true})
    const title=String(t.profile?.title||t.name||'Untitled').trim(),bookType=t.profile?.book_type||'footnote_only'
    const tocPath=path.join(ai,'toc.json'),chPath=path.join(ai,'chapters.json'),baPath=path.join(ai,'book_analysis.json')
    if(!await exists(tocPath))await atomic(tocPath,[{title,printed_start:1,target_pdf_page:1,offset:0,role_hint:'chapter',source:'single_paper_profile'}])
    if(!await exists(chPath)){
      let notePages=null
      if(['endnote_only','mixed'].includes(bookType)){
        if(t.profile?.note_start_page&&t.profile?.note_end_page){
          const docProf=await json(path.join(this.docDir(t),'document_profile.json'),{})
          const map=docProf?.source_page_map??[]
          const s=map.find(m=>m.source_page===t.profile.note_start_page)?.logical_page??1
          const e=map.find(m=>m.source_page===t.profile.note_end_page)?.logical_page??total
          notePages=[s,e]
        }else{
          notePages=[1,total]
        }
      }
      await atomic(chPath,[{id:'001',title,start_page:1,end_page:total,note_pages:notePages}])
    }
    if(!await exists(baPath))await atomic(baPath,{title,document_type:t.kind,language:t.profile?.language||'',book_type:bookType,note_numbering:t.profile?.note_numbering||'continuous',note_location:t.profile?.note_location||'per_page_bottom',layout:t.profile?.layout||'single'})
  }
  async structureCandidates(id){
    const t=await this.get(id)
    if(t.input.type!=='pdf')return {total_pages:0,candidates:[],source_page_map:[],kind:t.kind}
    const doc=this.docDir(t)
    if(!await exists(path.join(doc,'source.pdf'))||!await exists(path.join(doc,'document_profile.json'))){
      throw new Error('请先完成正文范围与规范化底本处理')
    }
    const out=await this.py(t,'document_pipeline.py',['structure',doc])
    const result=JSON.parse(out.trim().split('\n').at(-1))
    const existingChapters=await this.chapters(t)
    return {...result,confirmed:Boolean(t.structureConfirmed),existingChapters}
  }
  async confirmStructure(id,args){
    return this.locked(id,async()=>{
      const t=await this.get(id)
      if(this.active.has(id))throw new Error('运行中不能修改结构')
      const doc=this.docDir(t),ai=this.aiDir(t)
      await fs.mkdir(ai,{recursive:true})
      if(args.delegateObservation){
        t.structureConfirmed=false
        t.observationConfirmed=false
        t.message='已选择由 DSH 会话派发观察 worker 补齐结构与注释范围。'
        await atomic(path.join(ai,'structure_delegate.json'),{requestedAt:new Date().toISOString(),note:args.note??''})
        return this.save(t)
      }
      const chapters=args.chapters
      if(!Array.isArray(chapters)||chapters.length===0)throw new Error('至少需要确认一个有效章节')
      for(let i=0;i<chapters.length;i++){
        const c=chapters[i]
        if(!c.title||typeof c.start_page!=='number'||typeof c.end_page!=='number'||c.start_page>c.end_page||c.start_page<1){
          throw new Error(`章节 ${c.id||i+1} 起止页码无效`)
        }
        if(i>0&&c.start_page<chapters[i-1].start_page){
          throw new Error(`章节 ${c.id||i+1} 起始页必须递增`)
        }
      }
      const chJson=chapters.map((c,idx)=>({
        id:c.id||String(idx+1).padStart(3,'0'),
        title:String(c.title).trim(),
        start_page:c.start_page,
        end_page:c.end_page,
        note_pages:(Array.isArray(c.note_pages)&&c.note_pages.length===2&&typeof c.note_pages[0]==='number'&&typeof c.note_pages[1]==='number')?c.note_pages:null
      }))
      const tocJson=chJson.map(c=>({
        title:c.title,
        printed_start:c.start_page,
        target_pdf_page:c.start_page,
        offset:0,
        role_hint:'chapter'
      }))
      const baPath=path.join(ai,'book_analysis.json')
      const ba=await json(baPath,{})
      const effectiveBa={
        ...ba,
        title:String(t.profile?.title||t.name||'Untitled').trim(),
        document_type:t.kind,
        language:t.profile?.language||'',
        book_type:t.profile?.book_type||'footnote_only',
        note_numbering:t.profile?.note_numbering||'per_chapter',
        note_location:t.profile?.note_location||(t.profile?.book_type==='footnote_only'?'per_page_bottom':'chapter_end_notes'),
        layout:t.profile?.layout||'single'
      }
      await atomic(path.join(ai,'chapters.json'),chJson)
      await atomic(path.join(ai,'toc.json'),tocJson)
      await atomic(path.join(ai,'book_analysis.json'),effectiveBa)
      t.structureConfirmed=true
      t.observationConfirmed=true
      t.message='章节结构与目录已确认，可直接执行结构准备与阶段门禁。'
      return this.save(t)
    })
  }
  async ensureTextLayerReference(t){
    const doc=this.docDir(t),text=s=>`${TEXT}/${s}`,reference=path.join(this.dir(t.id),'reference/text-layer')
    await fs.mkdir(reference,{recursive:true})
    await fs.copyFile(path.join(doc,'source.pdf'),path.join(reference,'source.pdf'))
    await fs.copyFile(path.join(doc,'document_profile.json'),path.join(reference,'document_profile.json'))
    if(!await exists(path.join(reference,'raw_pages.json'))){await this.py(t,text('tl_convert.py'),[reference,'prepare']);await this.py(t,text('tl_convert.py'),[reference,'extract'])}
    for(const file of ['raw_pages.json','raw_pages_paddle.json','raw_pages_mineru.json'])await fs.copyFile(path.join(reference,file),path.join(doc,file))
    return reference
  }
  async original(t) {
    if(t.legacy?.artifacts?.original)return t.legacy.artifacts.original
    if(t.input.type==='markdown')return t.path
    const files=await walk(path.join(this.aiDir(t),'book'),/\.md$/,4),full=files.find(f=>/-full\.md$/.test(f));if(full)return full
    const chapters=await walk(path.join(this.aiDir(t),'chapters'),/\.md$/,1);if(t.kind!=='book'&&t.kind!=='collection'&&chapters.length===1)return chapters[0]
    throw new Error('尚无经过装配的原文 Markdown')
  }
  async perform(t,stage,options) {
    const doc=this.docDir(t),ai=this.aiDir(t),vision=s=>`${VISION}/${s}`,text=s=>`${TEXT}/${s}`
    if(stage==='inspect') {
      if(t.input.type==='markdown'){const source=await fs.readFile(t.path,'utf8');t.inspection={fingerprint:hash(source),verdict:'MARKDOWN',blocks:markdownBlocks(source).length,pages:0};t.profile={document_type:t.kind,language:'',confirmed:false,source_fingerprint:t.inspection.fingerprint};return}
      const out=await this.py(t,'document_pipeline.py',['inspect',t.path]);t.inspection=JSON.parse(out.trim().split('\n').at(-1));t.profile={document_type:t.kind,title:t.name,language:'',book_type:'',note_numbering:['book','collection'].includes(t.kind)?'per_chapter':'continuous',note_location:'',layout:'single',start_page:1,end_page:t.inspection.pages,confirmed:false,source_fingerprint:t.inspection.fingerprint};return
    }
    if(stage==='normalize'){if(t.input.type!=='pdf')throw new Error('Markdown无需PDF范围处理');const result=JSON.parse((await this.py(t,'document_pipeline.py',['normalize',t.path,'--profile',path.join(this.dir(t.id),'profile.json'),'--out',doc])).trim().split('\n').at(-1));t.scope={fingerprint:result.profile.source_fingerprint,profileFingerprint:hash(await fs.readFile(path.join(doc,'document_profile.json'))),pages:result.pages};return}
    if(stage==='images'){await this.requireDone(t,'normalize');await this.py(t,vision('extract_page_images.py'),[path.join(doc,'source.pdf'),'--out',path.join(ai,'page_images')]);return}
    if(['paddle','mineru'].includes(stage)){await this.requireDone(t,'normalize');if(t.inspection.verdict==='BORN-DIGITAL')throw new Error('可靠文字层不调用云 OCR');const config=await readPipelineConfiguration(this.root);if(!config.ocr.find(s=>s.id===stage)?.configured)throw new Error('先填写OCR服务密钥');const raw=await json(path.join(doc,`raw_pages_${stage}.json`),null);if(raw?.pages?.length===t.scope?.pages){if(stage==='paddle')await fs.copyFile(path.join(doc,'raw_pages_paddle.json'),path.join(doc,'raw_pages.json'));return}const output=path.join(doc,'ocr_output',stage);const args=[path.join(doc,'source.pdf'),'--out',doc,'--out-dir',output,'--suffix',stage];const meta=await json(path.join(output,stage==='paddle'?'paddle_meta.json':'batch_meta.json'),null);if(stage==='paddle'){if(options.resumeId)args.push('--job-id',String(options.resumeId));else if(meta){args.push('--resume-meta',path.join(output,'paddle_meta.json'));if(meta.model)args.push('--model',String(meta.model))}}if(stage==='mineru'&&(options.resumeId||meta?.batch_id))args.push('--batch-id',String(options.resumeId??meta.batch_id));await this.py(t,vision(stage==='paddle'?'paddle_ocr.py':'mineru_ocr.py'),args);if(stage==='paddle')await fs.copyFile(path.join(doc,'raw_pages_paddle.json'),path.join(doc,'raw_pages.json'));return}
    if(stage==='prepare'){
      await this.requireDone(t,'normalize')
      const curated=await exists(path.join(ai,'book_analysis.json'))&&await exists(path.join(ai,'chapters.json'))&&await exists(path.join(ai,'toc.json'))
      if(t.inspection.verdict!=='BORN-DIGITAL'){
        await this.requireDone(t,'paddle','mineru','images')
        if(['paper','chapter'].includes(t.kind))await this.ensureSinglePieceStructure(t)
        else if(!curated&&!t.structureConfirmed)throw new Error('书籍缺少已确认的章节结构，请在面板核对确认章节或在 DSH 进行结构观察')
        await this.py(t,vision('gate_check.py'),[doc,'--phase','2'])
        t.transcriptionPlan={method:'vision',referenceType:'dual_ocr_fallback_only',ocrPolicy:'vision_first_fallback_on_moderation_or_failure',worker:{...t.worker}}
        t.observationConfirmed=true
      }else{
        let reference=null
        if(t.profile.transcription_method==='vision'){await this.requireDone(t,'images');reference=await this.ensureTextLayerReference(t)}
        if(['paper','chapter'].includes(t.kind))await this.ensureSinglePieceStructure(t)
        else if(!curated&&!t.structureConfirmed)throw new Error('书籍缺少已确认的章节结构，请在面板核对确认章节或在 DSH 进行结构观察')
        await this.py(t,text('tl_convert.py'),[doc,'prepare',...((curated||t.structureConfirmed)?['--metrics-only']:[])])
        if(t.profile.transcription_method==='vision'){
          t.transcriptionPlan={method:'vision',referenceType:'pdf_text_layer',referenceDirectory:reference,independentOcr:false,worker:{...t.worker}}
          await this.py(t,vision('gate_check.py'),[doc,'--phase','2'])
        }
        t.observationConfirmed=true
      }
      return
    }
    if(stage==='transcribe'){
      await this.requireDone(t,'prepare','images')
      if(t.inspection.verdict==='BORN-DIGITAL'&&t.profile.transcription_method!=='vision'){
        await this.py(t,text('tl_convert.py'),[doc,'extract'])
      }else{
        if(t.inspection.verdict!=='BORN-DIGITAL')await this.requireDone(t,'paddle','mineru')
        await this.py(t,vision('gate_check.py'),[doc,'--phase','2'])
        for(const c of await this.chapters(t)){
          if(this.active.get(t.id).cancel)throw new Error('任务已停止')
          await this.py(t,vision('bounded_chapter.py'),[doc,'--chapter',c.id,'--provider',t.worker.provider,'--model',t.worker.model,'--timeout',String(t.worker.timeout)])
          await this.acceptTranscriptionDelivery(t,c.id)
        }
      }
      return
    }
    if(stage==='verify'){
      await this.requireDone(t,'transcribe')
      if(t.inspection.verdict==='BORN-DIGITAL'&&t.profile.transcription_method!=='vision')await this.py(t,text('verify_textlayer_structure.py'),[doc])
      await this.py(t,vision('gate_check.py'),[doc,'--phase','3c'])
      await this.py(t,vision('verify_page_json.py'),[doc,'--all'])
      return
    }
    if(stage==='assemble'){
      await this.requireDone(t,'verify')
      for(const c of await this.chapters(t)){
        await this.py(t,vision('assemble_chapter.py'),[doc,'--chapter',c.id])
        await this.py(t,vision('verify_output.py'),[doc,'--chapter',c.id])
      }
      if(['book','collection'].includes(t.kind)){
        await this.py(t,vision('assemble_book.py'),[doc])
        const fullMd=(await walk(path.join(ai,'book'),/-full\.md$/,2))[0]
        if(!fullMd)throw new Error('未找到整书拼接产物 *-full.md')
        await this.py(t,vision('verify_output.py'),[doc,'--book',fullMd])
        await this.py(t,vision('audit_book.py'),[doc])
      }
      return
    }
    if(stage==='glossary'){const dir=this.dir(t.id),src=await this.original(t);await fs.mkdir(path.join(dir,'translation/_src'),{recursive:true});await fs.copyFile(src,path.join(dir,'translation/_src/source.md'));const candidates=path.join(dir,'translation/analysis/glossary.json');if(!await exists(candidates))await this.py(t,'lingua/collect_master_glossary.py',[src,'--out',candidates]);await this.py(t,'lingua/curate_glossary.py',['--book-dir',dir]);return}
    if(stage==='lgProject'){if(t.translationEngine!=='http'){await this.prepareCliTranslation(t);return}if(t.input.type==='pdf')await this.requireDone(t,'assemble');const original=await this.original(t);const project=path.join(this.dir(t.id),'translation.lg');const snapshot=await this.lg(t,'/api/session/project/snapshot',{});const current=snapshot.project?.path;if(current&&current!==project)throw new Error('LinguaGacha已有其他工程，关闭该工程后再连接');if(await exists(project))await this.lg(t,'/api/session/project/open',{path:project});else await this.lg(t,'/api/session/project/create',{path:project,source_paths:[original],project_settings:{source_language:t.profile.language.toUpperCase(),target_language:'ZH'}});t.lgProject=project;if(!t.lgConfigured)await this.configureLgProject(t);return}
    if(stage==='translate'){await this.translateTask(t,options);return}
    if(stage==='translationCheck'){if(t.input.type==='pdf')await this.requireDone(t,'assemble');const src=await this.original(t);const destinations=(await walk(path.join(this.dir(t.id),'translation'),/\.md$/,5)).filter(f=>!f.includes(path.sep+'_src'+path.sep)&&!f.includes(path.sep+'analysis'+path.sep)&&!f.endsWith('_report.md'));if(destinations.length!==1)throw new Error('请在译文入口导入唯一的对应 Markdown；多文件须按来源清单配对');const source=await fs.readFile(src,'utf8'),target=await fs.readFile(destinations[0],'utf8');t.translationReport={...checkMarkdownPair(source,target),sourceFingerprint:hash(source),targetFingerprint:hash(target)};await atomic(path.join(this.dir(t.id),'translation-report.json'),t.translationReport);if(!t.translationReport.passed)throw new Error(t.translationReport.errors.join('；'));t.translationPath=destinations[0];return}
    if(stage==='review'){await this.requireDone(t,'translationCheck');const report=path.join(this.dir(t.id),'review/report.md');if(!await exists(report))throw new Error('请先在 DSH 完成独立语义审校，保存 review/report.md');t.review={report,semanticVerified:false,message:'报告存在，需阅读其具体结论'};return}
    if(stage==='publish'){await this.requireDone(t,'translationCheck');t.publication=await this.publishPreview(t);return}
  }
  async acceptTranscriptionDelivery(t,chapter){
    const directory=path.join(this.aiDir(t),'delivery','chapter_'+chapter),reportFile=path.join(directory,'output/report.json'),report=await json(reportFile,null),state=await json(path.join(directory,'state.json'),null);
    if(!report||!state?.finished)throw new Error('转写交付记录不完整，不能认定完成');t.transcriptionDeliveries={...t.transcriptionDeliveries,[chapter]:{reportFile,quality:report.quality_status,attempts:state.attempts,errors:report.errors}};
    if(report.input_protocol?.required!==true||!Array.isArray(report.input_protocol.unverified_pages)||report.input_protocol.unverified_pages.length)throw new Error('转写缺少独立视觉或受控 OCR 降级的文件指纹回执；保留候选与预算，不进入翻译');
    if(report.quality_status!=='program_checks_passed')throw new Error('转写仅交付待核查稿，章节 '+chapter+' 未通过程序验收；预算保留，不进入翻译');
    const selected=path.resolve(state.book),base=path.resolve(directory);if(!selected.startsWith(base+path.sep))throw new Error('交付来源目录无效');
    // Adopt initial worker bytes only. Existing different content is never overwritten.
    for(const kind of ['body','notes'])for(const file of await walk(path.join(selected,'ai_convert/edits',kind),/\.json$/,1)){
      const target=path.join(this.aiDir(t),'edits',kind,path.basename(file));await fs.mkdir(path.dirname(target),{recursive:true});if(await exists(target)){if(hash(await fs.readFile(target))!==hash(await fs.readFile(file)))throw new Error('已有转写与交付候选不同，禁止自动覆盖')}else await fs.copyFile(file,target,1);
    }
    const ledger=await fs.readFile(path.join(selected,'ai_convert/worker_audit.jsonl'),'utf8'),target=path.join(this.aiDir(t),'worker_audit.jsonl'),old=await fs.readFile(target,'utf8').catch(()=>''),lines=new Set(old.split('\n').filter(Boolean)),extra=ledger.split('\n').filter(l=>l&&!lines.has(l));if(extra.length)await fs.appendFile(target,(old&&!old.endsWith('\n')?'\n':'')+extra.join('\n')+'\n',{mode:0o600});
  }
  async prepareCliTranslation(t){
    if(t.input.type==='pdf')await this.requireDone(t,'assemble');const source=await this.original(t),status=await this.cliStatus();
    if(t.profile.translation_model&&status.model.model!==t.profile.translation_model)throw new Error('CLI 翻译模型与任务指定值不一致，未发送翻译');if(!status.model.credentialConfigured)throw new Error('CLI 当前模型缺少凭证，未重试');
    const dir=path.join(this.dir(t.id),'translation-cli');await fs.mkdir(dir,{recursive:true});const prompt=translationPrompt(t.kind),text=await fs.readFile(source,'utf8');await fs.writeFile(path.join(dir,'prompt.txt'),prompt,{mode:0o600});await fs.writeFile(path.join(dir,'source.md'),text,{mode:0o600});
    const glossary=await json(path.join(this.dir(t.id),'glossary.json'),[]);await atomic(path.join(dir,'glossary.json'),glossary);const key=hash(JSON.stringify({source:hash(text),model:status.model,prompt,glossary,language:t.profile.language}));t.translationEngine='cli';t.translationModel={...status.model,connectionVerified:false};t.cliPreparation={key,sourceFingerprint:hash(text),directory:dir,version:status.version,partialResumeSupported:false};await atomic(path.join(dir,'preparation.json'),t.cliPreparation);
  }
  async translateViaCli(t,options){
    await this.requireDone(t,'lgProject');await this.prepareCliTranslation(t);const prep=t.cliPreparation,output=path.join(this.dir(t.id),'translation/translated.md');
    if(t.translationCli?.status==='done'&&t.translationCli.key===prep.key&&await exists(output)&&hash(await fs.readFile(output))===t.translationCli.outputFingerprint){t.translationProgress={status:'done',reused:true};return}
    const attempt=(t.translationCli?.attempt??0)+1,dir=path.join(prep.directory,'runs',String(attempt)),raw=path.join(dir,'output');await fs.mkdir(raw,{recursive:true});t.translationCli={key:prep.key,status:'running',attempt,startedAt:new Date().toISOString(),directory:dir,partialResumeSupported:false};await this.save(t);let finished=false;
    const args=['--cli','translate','--input',path.join(prep.directory,'source.md'),'--output-dir',raw,'--source-language',t.profile.language.toUpperCase(),'--target-language','ZH','--prompt',path.join(prep.directory,'prompt.txt'),'--glossary',path.join(prep.directory,'glossary.json')];
    try{await this.command(t,this.cliExecutable,args,{onLine:async line=>{await fs.appendFile(path.join(dir,'events.jsonl'),line+'\n',{mode:0o600});let e;try{e=JSON.parse(line)}catch{return}if(e.type==='progress'){t.translationProgress={...e,run_progress:{total_line:e.stats.total,line:e.stats.completed,error_line:e.stats.failed}};await this.save(t)}if(e.type==='finished'){finished=e.status==='done';t.translationCli.finishedEvent=e}}});if(!finished)throw new Error('CLI 未报告完成，不能采用输出');
      const files=await walk(raw,/\.md$/,5),candidates=files.filter(f=>!/(?:bilingual|对照)/i.test(path.relative(raw,f)));if(candidates.length!==1)throw new Error('CLI 输出 Markdown 数量异常，保留原始输出等待核验');await fs.mkdir(path.dirname(output),{recursive:true});if(await exists(output))await fs.copyFile(output,output+'.bak-'+Date.now());await fs.copyFile(candidates[0],output);t.translationCli.status='done';t.translationCli.outputFingerprint=hash(await fs.readFile(output));t.translationModel.connectionVerified=true;
    }catch(e){t.translationCli.status=this.active.get(t.id)?.cancel?'stopped':'error';throw e}finally{t.translationCli.endedAt=new Date().toISOString();await atomic(path.join(dir,'receipt.json'),t.translationCli)}
  }
  async setConnection(id,url){return this.locked(id,async()=>{const t=await this.get(id);if(t.legacy)throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务');if(this.active.has(id))throw new Error('运行中不能更换连接');let parsed;try{parsed=new URL(url)}catch{throw new Error('本地连接地址无效')}if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||!parsed.port||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('只接受 http://127.0.0.1:端口');t.lgUrl=parsed.origin;await this.lg(t,'/api/session/project/snapshot',{});return this.save(t)})}
  async lg(t,route,body){const response=await this.fetch(t.lgUrl+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}).catch(()=>{throw new Error('LinguaGacha本地连接不可用')});const value=await response.json();if(!response.ok||!value.ok)throw Object.assign(new Error(`LinguaGacha接口拒绝 ${route}`),{code:value.error?.code,status:response.status});return value.data}
  async translateTask(t,options){
    if(t.translationEngine!=='http')return this.translateViaCli(t,options)
    await this.requireDone(t,'lgProject')
    if(t.input.type==='pdf')await this.requireDone(t,'assemble')
    await this.ensureLgProject(t)
    t.translationModel=await this.modelStatus(t)
    if(t.profile.translation_model&&t.translationModel.model!==t.profile.translation_model)throw new Error('翻译模型与当前任务指定值不一致，未发送翻译请求')
    if(t.translationModel.credentialConfigured===false)throw new Error('当前翻译模型缺少可用密钥，请按项目配置入口更新，不重复重试')
    const settings=(await this.lg(t,'/api/settings/app',{})).settings
    const previous={source_language:settings.source_language,target_language:settings.target_language}
    t.pendingLanguageRestore=previous
    await this.save(t)
    try{
      await this.lg(t,'/api/settings/update',{source_language:t.profile.language.toUpperCase(),target_language:'ZH'})
      await this.lg(t,'/api/batch-translation/start',{operation:'translate',mode:'continue',scope:{kind:'all'},include_errors:options.retryErrors===true})
      for(let poll=0;;poll++){
        if(poll>14400){await this.lg(t,'/api/batch-translation/stop',{});throw new Error('翻译监测超时，请检查持久工程状态')}
        if(this.active.get(t.id).cancel)throw new Error('任务已停止')
        await this.ensureLgProject(t)
        const state=(await this.lg(t,'/api/batch-translation/snapshot',{})).batch_translation
        t.translationProgress=state;await this.save(t)
        const status=state?.status
        if(['done','stopped','error'].includes(status)){
          if(status!=='done')throw new Error('翻译停止或失败，已完成译块保留')
          if((state.run_progress??state.progress)?.error_line>0)throw new Error('翻译仍有失败块，已完成译块保留')
          t.translationModel.connectionVerified=(state.run_progress??state.progress)?.total_tokens>0
          break
        }
        await new Promise(r=>setTimeout(r,1500))
      }
      const generated=await this.generateTranslationFiles(t),output=await walk(generated.output_path,/\.md$/,5)
      if(output.length!==1)throw new Error('导出文件范围异常，未自动配对')
      await fs.mkdir(path.join(this.dir(t.id),'translation'),{recursive:true})
      await fs.copyFile(output[0],path.join(this.dir(t.id),'translation/translated.md'))
    }finally{
      try{
        const snapshot=await this.lg(t,'/api/session/project/snapshot',{})
        if(snapshot.project?.path===t.lgProject){await this.lg(t,'/api/session/project/close',{});await this.lg(t,'/api/settings/update',previous);delete t.pendingLanguageRestore}
        else if(!snapshot.project?.loaded){await this.lg(t,'/api/settings/update',previous);delete t.pendingLanguageRestore}
      }catch{/* Keep the exact pending language settings for an explicit recovery. */}
    }
  }
  async generateTranslationFiles(t){
    try{return await this.lg(t,'/api/translation/files/generate',{})}catch(error){if(error.code!=='request.route_not_found')throw error;return this.lg(t,'/api/translation/files/export',{})}
  }
  async configureLgProject(t){
    await this.ensureLgProject(t)
    const prompt=translationPrompt(t.kind)
    const view=await this.lg(t,'/api/quality/prompts/view',{})
    await this.lg(t,'/api/quality/prompts/save',{text:prompt,enabled:true,expected_section_revisions:view.sectionRevisions})
    const glossary=await json(path.join(this.dir(t.id),'glossary.json'),null)
    if(Array.isArray(glossary)){
      const view=await this.lg(t,'/api/quality/rules/query',{rule_type:'glossary'})
      await this.lg(t,'/api/quality/rules/update',{rule_type:'glossary',entries:glossary.map((e,i)=>({src:e.src,dst:e.dst,info:e.info??'',case_sensitive:false,entry_id:hash(e.src+':'+i).slice(0,20)})),meta:{enabled:true},expected_section_revisions:view.sectionRevisions})
    }
    t.lgConfigured=true;t.translationPrompt={version:1,sha256:hash(prompt),genre:t.kind}
  }
  async modelStatus(t){
    const response=await this.fetch(t.lgUrl+'/api/models/selection',{signal:AbortSignal.timeout(10000)}).catch(()=>{throw new Error('无法读取翻译模型状态')});const selection=(await response.json()).data
    const full=await this.lg(t,'/api/models/snapshot',{}),model=full.snapshot?.models?.find(m=>m.id===selection?.model_selection?.translation)
    if(!model)throw new Error('没有选定翻译模型')
    return {name:model.name,model:model.model_id,thinking:model.thinking?.level,credentialConfigured:model.auth_type==='oauth'?null:typeof model.api_key==='string'&&!!model.api_key.trim(),connectionVerified:false}
  }
  async ensureLgProject(t){const snapshot=await this.lg(t,'/api/session/project/snapshot',{});if(!snapshot.project?.loaded&&t.lgProject){await this.lg(t,'/api/session/project/open',{path:t.lgProject});return}if(snapshot.project?.path!==t.lgProject)throw new Error('LinguaGacha当前工程与任务不一致，未发送翻译')}
  async importTranslation(id,bytes){return this.locked(id,async()=>{const t=await this.get(id);if(t.legacy)throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务');if(this.active.has(id))throw new Error('运行中不能导入译文');if(bytes.length>20*1024*1024)throw new Error('译文文件过大');const file=path.join(this.dir(id),'translation/translated.md');await fs.mkdir(path.dirname(file),{recursive:true});if(await exists(file))await fs.copyFile(file,file+`.bak-${Date.now()}`);await fs.writeFile(file,bytes);delete t.stages.translationCheck;delete t.stages.publish;delete t.translationReport;delete t.translationPath;delete t.publication;return this.save(t)})}
  async baseReading(id){const t=await this.get(id);
    if(t.legacy){const f=t.legacy.artifacts.readingPath;if(!f)throw new Error('此书尚无可阅读的装配成果');const text=await fs.readFile(f,'utf8');if(hash(text)!==t.legacy.readingFingerprint)throw new Error('旧成品已变化，先重新扫描原项目再阅读');const isTranslation=!!t.legacy.artifacts.translation&&f!==t.legacy.artifacts.original,blocks=markdownBlocks(text),source=t.legacy.artifacts.original?await fs.readFile(t.legacy.artifacts.original,'utf8'):null,originalBlocks=source?markdownBlocks(source):null;if(t.paperImport&&source&&hash(source)!==t.input.fingerprint)throw new Error('论文原文快照已变化，保留修订并核验快照');return {id,title:t.name,fingerprint:hash(text),blocks,originalBlocks,version:hash(text+'|'+(source??'')),bookmarkBlocks:[...new Map([...(originalBlocks??[]),...(isTranslation?blocks.map(b=>({...b,translation:b.text})):blocks)].map(b=>[b.id,b])).values()],standaloneView:isTranslation?'translation':'original',bookmarks:t.bookmarks??[]}}
    const file=await this.original(t),source=await fs.readFile(file,'utf8'),blocks=markdownBlocks(source);const translated=t.translationPath?await fs.readFile(t.translationPath,'utf8'):'';const translation=t.translationReport?.passed&&t.translationReport.sourceFingerprint===hash(source)&&t.translationReport.targetFingerprint===hash(translated)?markdownBlocks(translated):[];return {id,title:t.name,fingerprint:hash(source),blocks:blocks.map((b,i)=>({...b,translation:translation[i]?.text})),bookmarks:t.bookmarks.map(b=>({...b,stale:!blocks.some(block=>block.id===b.blockId)}))}}
  async readingTexts(t,base){
    const original=t.legacy?t.legacy.artifacts.original??t.legacy.artifacts.readingPath:await this.original(t),target=t.legacy?(t.legacy.artifacts.readingPath!==original?t.legacy.artifacts.readingPath:null):base.blocks.some(b=>b.translation)?t.translationPath:null;
    const source=original?await fs.readFile(original,'utf8'):null,translation=target?await fs.readFile(target,'utf8'):null;
    return {source,translation,original,target}
  }
  async correctionContext(t){
    const base=await this.baseReading(t.id),texts=await this.readingTexts(t,base),baseVersion=hash((texts.source??'')+'|'+(texts.translation??''));
    const directory=path.join(this.root,'.pipeline/documents',hash(t.documentId)),manifest=path.join(directory,baseVersion+'.json'),record=await json(manifest,null);
    if(record){for(const view of ['original','translation']){if(typeof record.texts?.[view]==='string'){texts[view==='original'?'source':'translation']=record.texts[view];continue}const f=record.storageVersion===2?null:record.files?.[view];if(f){if(path.basename(f)!==f)throw new Error('修订记录路径异常');texts[view==='original'?'source':'translation']=await fs.readFile(path.join(directory,f),'utf8')}}}
    return {base,texts,directory,manifest,record,baseVersion}
  }
  async reading(id){const t=await this.get(id),ctx=await this.correctionContext(t),{base,texts,record}=ctx;
    let doc=base;
    if(record){if(base.standaloneView){doc={...base,blocks:markdownBlocks(base.standaloneView==='translation'?texts.translation:texts.source),originalBlocks:texts.source?markdownBlocks(texts.source):null,version:hash((texts.source??'')+'|'+(texts.translation??''))}}
      else {const blocks=markdownBlocks(texts.source),target=texts.translation?markdownBlocks(texts.translation):[];doc={...base,blocks:blocks.map((b,i)=>({...b,translation:target[i]?.text})),version:hash(texts.source+'|'+(texts.translation??''))}}}
    if(t.paperImport){const src=doc.originalBlocks??[],ids=t.paperImport.blockIds;doc={...doc,documentId:t.documentId,metadata:t.paperImport.metadata,glossary:t.paperImport.glossary,importWarnings:t.paperImport.warnings,explicitPairs:src.length===doc.blocks.length&&src.length===ids.length,blockAliases:{original:Object.fromEntries(ids.map((id,i)=>[id,src[i]?.id])),translation:Object.fromEntries(ids.map((id,i)=>[id,doc.blocks[i]?.id]))}}}
    return enrichReading({...doc,kind:t.kind,documentId:t.documentId,version:hash((texts.source??'')+'|'+(texts.translation??'')),correctionCount:record?.revisions?.length??0,correctionReview:record?.structuralCheck??null})
  }
  async correctReading(id,args){const t=await this.get(id);return this.locked('correction:'+t.documentId,async()=>{
    if(this.active.has(id))throw new Error('任务正在处理，暂不能保存勘误');if(!['original','translation'].includes(args.view))throw new Error('编辑文本类型无效');
    const current=await this.reading(id);if(current.version!==args.version)throw new Error('文档已由另一窗口修改，请重新打开后保存');
    const ctx=await this.correctionContext(t),key=args.view==='original'?'source':'translation',text=ctx.texts[key];if(text===null)throw new Error('此文档没有对应文本');
    let blockId=args.blockId;if(!current.standaloneView&&args.view==='translation'){const i=current.blocks.findIndex(b=>b.id===blockId);blockId=markdownBlocks(text)[i]?.id}
    const next=replaceBlock(text,blockId,args.text);if(next===text)return current;
    await fs.mkdir(ctx.directory,{recursive:true});const files={...ctx.record?.files};
    // Keep one initial snapshot per view and paragraph deltas; no full-book copy per correction.
    const token=randomUUID(),baseFile=ctx.baseVersion+'-'+args.view+'-base.md';if(!await exists(path.join(ctx.directory,baseFile)))await fs.writeFile(path.join(ctx.directory,baseFile),text,{flag:'wx',mode:0o600});files[args.view]=baseFile;
    const beforeBlock=markdownBlocks(text).find(b=>b.id===blockId);ctx.texts[key]=next;
    const record={schemaVersion:1,storageVersion:2,documentId:t.documentId,baseVersion:ctx.baseVersion,files,texts:{...ctx.record?.texts,...Object.fromEntries(['original','translation'].filter(view=>view===args.view||ctx.record?.files?.[view]).map(view=>[view,ctx.texts[view==='original'?'source':'translation']]))},revisions:[...(ctx.record?.revisions??[]),{id:token,view:args.view,blockId:args.blockId,at:new Date().toISOString(),beforeText:beforeBlock.text,afterText:args.text,beforeFingerprint:hash(text),afterFingerprint:hash(next),reason:String(args.reason??'').slice(0,2000)}],structuralCheck:ctx.texts.source&&ctx.texts.translation?checkMarkdownPair(ctx.texts.source,ctx.texts.translation):null,semanticVerified:false};await atomic(ctx.manifest,record);return this.reading(id)
  })}
  async readingDownload(id,view){const t=await this.get(id);await this.baseReading(id);const ctx=await this.correctionContext(t);const value=view==='original'?ctx.texts.source:ctx.texts.translation??ctx.texts.source;if(value===null)throw new Error('尚无对应文本');return value}
  async bookmark(id,args){return this.locked(id,async()=>{if(this.active.has(id))throw new Error('正在保存处理状态，阶段结束后可添加书签');const t=await this.get(id),doc=await this.reading(id);if(args.remove){t.bookmarks=t.bookmarks.filter(b=>b.id!==args.remove)}else {const block=doc.blocks.find(b=>b.id===args.blockId);if(!block)throw new Error('书签段落已变化');const mark=t.bookmarks.find(b=>b.blockId===block.id)??{id:randomUUID(),blockId:block.id};Object.assign(mark,{note:String(args.note??'').slice(0,4000),excerpt:block.text.slice(0,140),fingerprint:doc.fingerprint});if(!t.bookmarks.includes(mark))t.bookmarks.push(mark)}return this.save(t)})}
  async publishPreview(t){return buildPublication(this,t)}
  async publish(id,accepted){return this.locked(id,async()=>{const t=await this.get(id);if(t.legacy)throw new Error('旧项目记录保持只读，请先建立已有 Markdown 的接续任务');if(this.active.has(id))throw new Error('运行中不能发布');await this.confirmed(t);await this.requireDone(t,'translationCheck');t.publication=await commitPublication(this,t,accepted);return this.save(t)})}
}
