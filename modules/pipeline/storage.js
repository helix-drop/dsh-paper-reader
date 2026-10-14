import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS tasks_document ON tasks(document_id);
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
      PRAGMA user_version=1;`);return db
  })();return this.opening}
  async put(t,stamp){const db=await this.open();const summary={id:t.id,documentId:t.documentId,name:t.name,documentTitle:t.documentTitle,kind:t.kind,state:t.state,stage:t.stage,updatedAt:t.updatedAt,createdAt:t.createdAt,bookmarks:t.bookmarks??[],paperImport:t.paperImport?{file:t.paperImport.file,metadata:t.paperImport.metadata}:undefined,caption:t.legacy?.caption,legacy:!!t.legacy,stages:t.stages,input:{type:t.input.type},profile:{confirmed:t.profile?.confirmed},publication:{published:t.publication?.published},inspection:{verdict:t.inspection?.verdict}}
    db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id,title=excluded.title,state=excluded.state,updated_at=excluded.updated_at,summary=excluded.summary,payload=excluded.payload,library=excluded.library,json_stamp=excluded.json_stamp').run(t.id,t.documentId??null,t.name,t.state,t.updatedAt,JSON.stringify(summary),JSON.stringify(t),t.libraryProof?JSON.stringify(t.libraryProof):null,stamp)
    if(t.documentId){const previous=db.prepare('SELECT artifacts FROM documents WHERE id=?').get(t.documentId),artifacts={...(previous?JSON.parse(previous.artifacts):{}),source:t.path,...(t.legacy?.artifacts??{})};db.prepare('INSERT INTO documents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artifacts=excluded.artifacts').run(t.documentId,t.legacy?.key??null,t.documentTitle??t.name,t.kind,JSON.stringify(artifacts))}db.prepare("DELETE FROM documents WHERE id='document:undefined' AND NOT EXISTS(SELECT 1 FROM tasks WHERE document_id='document:undefined')").run();db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  }
  async papers(){return (await this.open()).prepare("SELECT payload FROM tasks WHERE document_id LIKE 'paper:%'").all().map(r=>JSON.parse(r.payload)).filter(t=>t.paperImport)}
  async all(){return (await this.open()).prepare('SELECT payload FROM tasks ORDER BY updated_at DESC,id').all().map(r=>JSON.parse(r.payload))}
  async page({q='',offset=0,limit=40,state=''}={}){limit=Math.max(1,Math.min(100,Number(limit)||40));offset=Math.max(0,Number(offset)||0);const db=await this.open(),pattern='%'+String(q).replace(/[\\%_]/g,'\\$&')+'%',where="WHERE title LIKE ? ESCAPE '\\' AND (?='' OR state=?)",params=[pattern,state,state];return {tasks:db.prepare(`SELECT summary FROM tasks ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params,limit,offset).map(r=>JSON.parse(r.summary)),total:db.prepare(`SELECT count(*) AS n FROM tasks ${where}`).get(...params).n,offset,limit}}
  async summaries(){return (await this.open()).prepare('SELECT summary FROM tasks ORDER BY updated_at DESC,id').all().map(r=>JSON.parse(r.summary))}
  async clearProof(id){(await this.open()).prepare('UPDATE tasks SET library=NULL WHERE id=?').run(id)}
  async library(){return (await this.open()).prepare('SELECT summary,library FROM tasks WHERE library IS NOT NULL ORDER BY updated_at DESC,id').all().map(r=>({task:JSON.parse(r.summary),proof:JSON.parse(r.library)}))}
  async stamps(){return new Map((await this.open()).prepare('SELECT id,state,document_id,json_stamp FROM tasks').all().map(r=>[r.id,r.document_id&&r.document_id!=='document:undefined'&&r.state!=='running'?r.json_stamp:null]))}
  async close(){if(this.opening)(await this.opening).close();this.opening=null}
}
