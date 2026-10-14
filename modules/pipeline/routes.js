import {transcriptionProgress} from './progress.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { exportBookmarks } from './bookmarks.js'
import {cliStatus} from './cli.js'
import { hash } from './markdown.js'
import { TaskManager, STAGES } from './tasks.js'
import { discoverLinguaGacha, openLinguaGacha, refreshTranslationModel, adapterStatus, startSubscriptionAdapter } from './linguagacha.js'
async function body(req, limit=1024*1024) {const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw new Error('请求内容过大');chunks.push(Buffer.from(c))}return Buffer.concat(chunks)}
async function payload(req){try{return JSON.parse((await body(req)).toString('utf8'))}catch{throw new Error('任务请求格式无效')}}
function send(res,value){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))}
export function taskRoutes(manager,registerSession){
  return [
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/adopt$/,handler:async(_req,res,_url,m)=>send(res,await manager.adoptLegacy(m[1]))},
    {method:'POST',pattern:/^\/pipeline\/legacy-import$/,handler:async(_req,res)=>send(res,await manager.importLegacy())},
    {method:'POST',pattern:/^\/pipeline\/detect-source$/,handler:async(req,res)=>send(res,await manager.detectSource((await payload(req)).sourceId))},
    {method:'GET',pattern:/^\/pipeline\/library$/,handler:async(_req,res)=>send(res,{documents:await manager.library()})},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/name$/,handler:async(req,res,_url,m)=>send(res,await manager.rename(m[1],(await payload(req)).name))},
    {method:'GET',pattern:/^\/pipeline\/bookmarks$/,handler:async(_req,res,url)=>send(res,{bookmarks:await manager.bookmarks({documentId:url.searchParams.get('documentId')??'',q:url.searchParams.get('q')??''})})},
    {method:'POST',pattern:/^\/pipeline\/bookmarks$/,handler:async(req,res)=>send(res,await manager.saveSelectionBookmark(await payload(req)))},
    {method:'GET',pattern:/^\/pipeline\/bookmarks\/export$/,handler:async(_req,res,url)=>{const format=url.searchParams.get('format')==='markdown'?'markdown':'json',marks=await manager.bookmarks({documentId:url.searchParams.get('documentId')??'',q:url.searchParams.get('q')??''});res.writeHead(200,{'content-type':format==='json'?'application/json; charset=utf-8':'text/markdown; charset=utf-8','content-disposition':'attachment; filename="bookmarks.'+(format==='json'?'json':'md')+'"'});res.end(exportBookmarks(marks,format))}},

    {method:'GET',pattern:/^\/pipeline\/subscription-adapter$/,handler:async(_req,res)=>send(res,await adapterStatus())},
    {method:'POST',pattern:/^\/pipeline\/subscription-adapter$/,handler:async(req,res)=>send(res,await startSubscriptionAdapter(manager.root,(await payload(req)).kind))},
    {method:'POST',pattern:/^\/pipeline\/translation-model$/,handler:async(req,res)=>send(res,refreshTranslationModel(manager.root,(await payload(req)).profile))},
    {method:'GET',pattern:/^\/pipeline\/translation-service$/,handler:async(_req,res)=>send(res,await cliStatus(manager.root))},
    {method:'POST',pattern:/^\/pipeline\/translation-service\/open$/,handler:async(_req,res)=>send(res,openLinguaGacha())},
    {method:'GET',pattern:/^\/pipeline\/catalog$/,handler:async(_req,res)=>send(res,{sources:await manager.catalog(),stages:STAGES})},
    {method:'GET',pattern:/^\/pipeline\/tasks$/,handler:async(_req,res,_url)=>send(res,await manager.listPage({q:_url.searchParams.get('q')??'',offset:_url.searchParams.get('offset'),limit:_url.searchParams.get('limit')}))},
    {method:'POST',pattern:/^\/pipeline\/tasks$/,handler:async(req,res)=>send(res,await manager.create(await payload(req)))},
    {method:'POST',pattern:/^\/pipeline\/upload$/,handler:async(req,res,url)=>send(res,await manager.upload(url.searchParams.get('name'),await body(req,100*1024*1024)))},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)$/,handler:async(_req,res,_url,m)=>{const t=await manager.get(m[1]);send(res,{...t,transcriptionProgress:await transcriptionProgress(t,manager.dir(t.id))})}},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/source$/,handler:async(_req,res,_url,m)=>{const t=await manager.get(m[1]);const source=t.legacy?.artifacts?.sourcePdf??(t.input.type==='pdf'?t.path:null);if(!source)throw new Error('此任务没有源PDF');const bytes=await fs.readFile(source);if(!t.legacy&&t.input.fingerprint&&hash(bytes)!==t.input.fingerprint)throw new Error('源文件已变化，重新检查后再预览');res.writeHead(200,{'content-type':'application/pdf','x-content-type-options':'nosniff'});res.end(bytes)}},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/review$/,handler:async(_req,res,_url,m)=>{await manager.get(m[1]);send(res,{text:await fs.readFile(path.join(manager.dir(m[1]),'review/report.md'),'utf8')})}},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/reading$/,handler:async(_req,res,_url,m)=>send(res,await manager.reading(m[1]))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/corrections$/,handler:async(req,res,_url,m)=>send(res,await manager.correctReading(m[1],await payload(req)))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/worker$/,handler:async(req,res,_url,m)=>send(res,await manager.updateWorker(m[1],(await payload(req)).workerId))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/profile$/,handler:async(req,res,_url,m)=>send(res,await manager.updateProfile(m[1],await payload(req)))},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/structure$/,handler:async(_req,res,_url,m)=>send(res,await manager.structureCandidates(m[1]))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/structure$/,handler:async(req,res,_url,m)=>send(res,await manager.confirmStructure(m[1],await payload(req)))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/run$/,handler:async(req,res,_url,m)=>{const args=await payload(req);send(res,await manager.start(m[1],args.stage,args.options??{}))}},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/stop$/,handler:async(_req,res,_url,m)=>send(res,await manager.stop(m[1]))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/connection$/,handler:async(req,res,_url,m)=>send(res,await manager.setConnection(m[1],(await payload(req)).url))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/translation$/,handler:async(req,res,_url,m)=>send(res,await manager.importTranslation(m[1],await body(req,20*1024*1024)))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/bookmarks$/,handler:async(req,res,_url,m)=>send(res,await manager.bookmark(m[1],await payload(req)))},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/session$/,handler:async(req,res,_url,m)=>{await manager.get(m[1]);const {sessionId,mode,stage}=await payload(req);await registerSession(sessionId,m[1],mode==='inspect'?'inspect':'processing',stage);send(res,{ok:true})}},
    {method:'POST',pattern:/^\/pipeline\/tasks\/([^/]+)\/publish$/,handler:async(req,res,_url,m)=>send(res,await manager.publish(m[1],(await payload(req)).accepted))},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/download$/,handler:async(_req,res,url,m)=>{res.writeHead(200,{'content-type':'text/markdown; charset=utf-8','content-disposition':'attachment; filename="document.md"'});res.end(await manager.readingDownload(m[1],url.searchParams.get('kind')))}},
    {method:'GET',pattern:/^\/pipeline\/tasks\/([^/]+)\/asset$/,handler:async(_req,res,url,m)=>{const t=await manager.get(m[1]),original=t.legacy&&url.searchParams.get('kind')!=='original'?t.legacy.artifacts.readingPath:await manager.original(t),base=await fs.realpath(path.dirname(original));const wanted=path.resolve(base,url.searchParams.get('path')??'');const real=await fs.realpath(wanted);if(![manager.root,manager.readingRoot,manager.publishRoot].some(root=>real.startsWith(root+path.sep))||!(/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(real)))throw new Error('附件路径无效');if(/\.svg$/i.test(real))throw new Error('SVG 请从原文 Markdown 查看');res.writeHead(200,{'content-type':/\.png$/i.test(real)?'image/png':/\.gif$/i.test(real)?'image/gif':/\.webp$/i.test(real)?'image/webp':'image/jpeg','x-content-type-options':'nosniff'});res.end(await fs.readFile(real))}},
  ]
}
export { TaskManager }
