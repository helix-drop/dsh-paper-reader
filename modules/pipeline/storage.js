import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {pageTaskRows} from './task-list.js'

export async function fileStamp(file) {
  if (!file) return null
  try { const s=await fs.stat(file,{bigint:true}); return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':') } catch { return null }
}
export class PipelineIndex {
  constructor(root){this.file=path.join(root,'.pipeline/catalog.sqlite');this.opening=null}
  async open(){if(!this.opening)this.opening=(async()=>{
    await fs.mkdir(path.dirname(this.file),{recursive:true});const db=new DatabaseSync(this.file);await fs.chmod(this.file,0o600)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, legacy_key TEXT UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL, artifacts TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, document_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL, library TEXT, json_stamp TEXT);
      CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item_meta(id TEXT PRIMARY KEY, folder_id TEXT, hidden INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS tasks_document ON tasks(document_id);
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
      CREATE INDEX IF NOT EXISTS item_meta_folder ON item_meta(folder_id);
      CREATE INDEX IF NOT EXISTS item_meta_hidden ON item_meta(hidden);
      PRAGMA user_version=1;`);return db
  })();return this.opening}
  async put(t,stamp){const db=await this.open();const summary={id:t.id,documentId:t.documentId,name:t.name,documentTitle:t.documentTitle,kind:t.kind,state:t.state,stage:t.stage,updatedAt:t.updatedAt,createdAt:t.createdAt,bookmarks:t.bookmarks??[],paperImport:t.paperImport?{file:t.paperImport.file,metadata:t.paperImport.metadata}:undefined,caption:t.legacy?.caption,legacy:!!t.legacy,review:t.review?{status:t.review.status,semanticVerified:t.review.semanticVerified}:undefined,stages:t.stages,input:{type:t.input.type},profile:{confirmed:t.profile?.confirmed},profileAnalysis:t.profileAnalysis?{status:t.profileAnalysis.status}:undefined,publication:{published:t.publication?.published},inspection:{verdict:t.inspection?.verdict}}
    db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id,title=excluded.title,state=excluded.state,updated_at=excluded.updated_at,summary=excluded.summary,payload=excluded.payload,library=excluded.library,json_stamp=excluded.json_stamp').run(t.id,t.documentId??null,t.name,t.state,t.updatedAt,JSON.stringify(summary),JSON.stringify(t),t.libraryProof?JSON.stringify(t.libraryProof):null,stamp)
    if(t.documentId){const previous=db.prepare('SELECT artifacts FROM documents WHERE id=?').get(t.documentId),artifacts={...(previous?JSON.parse(previous.artifacts):{}),source:t.path,...(t.legacy?.artifacts??{})};db.prepare('INSERT INTO documents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artifacts=excluded.artifacts').run(t.documentId,t.legacy?.key??null,t.documentTitle??t.name,t.kind,JSON.stringify(artifacts))}db.prepare("DELETE FROM documents WHERE id='document:undefined' AND NOT EXISTS(SELECT 1 FROM tasks WHERE document_id='document:undefined')").run();db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  }
  async papers(){return (await this.open()).prepare("SELECT payload FROM tasks WHERE document_id LIKE 'paper:%'").all().map(r=>JSON.parse(r.payload)).filter(t=>t.paperImport)}
  async all(){return (await this.open()).prepare('SELECT payload FROM tasks ORDER BY updated_at DESC,id').all().map(r=>JSON.parse(r.payload))}
  async page({q='',state='',...query}={}){
    const db=await this.open(),pattern='%'+String(q).replace(/[\\%_]/g,'\\$&')+'%'
    const rows=db.prepare("SELECT t.summary,t.library,m.folder_id AS folderId,m.hidden FROM tasks t LEFT JOIN item_meta m ON m.id=t.id WHERE t.title LIKE ? ESCAPE '\\' AND (?='' OR t.state=?) ORDER BY t.updated_at DESC,t.id").all(pattern,state,state)
    return pageTaskRows(rows,query)
  }
  async summaries(){return (await this.open()).prepare('SELECT summary FROM tasks ORDER BY updated_at DESC,id').all().map(r=>JSON.parse(r.summary))}
  async clearProof(id){(await this.open()).prepare('UPDATE tasks SET library=NULL WHERE id=?').run(id)}
  async library(){return (await this.open()).prepare('SELECT summary,library FROM tasks WHERE library IS NOT NULL ORDER BY updated_at DESC,id').all().map(r=>({task:JSON.parse(r.summary),proof:JSON.parse(r.library)}))}
  async stamps(){return new Map((await this.open()).prepare('SELECT id,state,document_id,json_stamp FROM tasks').all().map(r=>[r.id,r.document_id&&r.document_id!=='document:undefined'&&r.state!=='running'?r.json_stamp:null]))}
  async getFolders(){return (await this.open()).prepare('SELECT id, name, created_at AS createdAt FROM folders ORDER BY created_at ASC').all()}
  async saveFolder(arg1, arg2){let id, name; if(typeof arg1==='object'&&arg1!==null){id=arg1.id;name=arg1.name}else if(arg2!==undefined){id=arg1;name=arg2}else{id=null;name=arg1} const db=await this.open(),folderId=id||randomUUID(),now=new Date().toISOString(),fName=String(name||'').trim();db.prepare('INSERT INTO folders(id, name, created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(folderId,fName,now);return {id:folderId,name:fName,createdAt:now}}
  async deleteFolder(id){const db=await this.open();db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM folders WHERE id=?').run(id);const rows=db.prepare('SELECT id, folder_id AS folderId FROM item_meta WHERE folder_id IS NOT NULL').all();for(const r of rows){const list=String(r.folderId).split(',').map(s=>s.trim()).filter(Boolean);if(list.includes(id)){const next=list.filter(x=>x!==id).join(',')||null;db.prepare('UPDATE item_meta SET folder_id=? WHERE id=?').run(next,r.id);}}db.exec('COMMIT');return {ok:true}}catch(e){db.exec('ROLLBACK');throw e}}
  async getItemMeta(id){const row=(await this.open()).prepare('SELECT id, folder_id AS folderId, hidden FROM item_meta WHERE id=?').get(id);return row?{id:row.id,folderId:row.folderId,hidden:Boolean(row.hidden)}:{id,folderId:null,hidden:false}}
  async getAllItemMeta(){const rows=(await this.open()).prepare('SELECT id, folder_id AS folderId, hidden FROM item_meta').all(),out={};for(const r of rows)out[r.id]={folderId:r.folderId,hidden:Boolean(r.hidden)};return out}
  async setItemMeta(id,{folderId,hidden}){const db=await this.open(),now=new Date().toISOString(),prev=await this.getItemMeta(id),nextFolder=folderId!==undefined?folderId:prev.folderId,nextHidden=hidden!==undefined?(hidden?1:0):(prev.hidden?1:0);db.prepare('INSERT INTO item_meta(id, folder_id, hidden, updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id, hidden=excluded.hidden, updated_at=excluded.updated_at').run(id,nextFolder,nextHidden,now);return {id,folderId:nextFolder,hidden:Boolean(nextHidden)}}
  async removeTask(id){const db=await this.open();db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM tasks WHERE id=?').run(id);db.prepare('DELETE FROM item_meta WHERE id=?').run(id);db.exec('COMMIT');return {ok:true}}catch(e){db.exec('ROLLBACK');throw e}}
  async close(){if(this.opening)(await this.opening).close();this.opening=null}
}
