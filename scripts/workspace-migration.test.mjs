import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {mapWorkspacePath} from '../shared/workspace.js'
import {observationImagePaths} from '../modules/pipeline/guard.js'
import {taskRoutes} from '../modules/pipeline/routes.js'
test('path mapping preserves identities and supports spaces and boundary checks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader workspace '))
 try{
  await fs.writeFile(path.join(root,'workspace-migration.json'),JSON.stringify({schemaVersion:1,root,pathMappings:{'/old':root,'/papers':root+'/papers'}}))
  assert.equal(mapWorkspacePath(root,'/old/Book/a'),root+'/Book/a')
  assert.equal(mapWorkspacePath(root,root+'/papers/a.json','identity'),'/papers/a.json')
  assert.equal(mapWorkspacePath(root,'/old-other/a'),'/old-other/a')
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('asset endpoint reads migrated copies for escaped absolute paths and rejects traversal',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reader asset ')))
 try{
  const dir=path.join(root,'Book','a book');await fs.mkdir(dir,{recursive:true})
  const image=path.join(dir,'image.png'),bytes=Buffer.from('migrated image bytes');await fs.writeFile(image,bytes)
  await fs.writeFile(path.join(root,'workspace-migration.json'),JSON.stringify({schemaVersion:1,root,pathMappings:{'/old':root}}))
  const manager={root,readingRoot:path.join(root,'papers'),publishRoot:path.join(root,'published'),get:async()=>({}),original:async()=>path.join(dir,'original.md')}
  const route=taskRoutes(manager).find(r=>r.pattern.test('/pipeline/tasks/id/asset'))
  for(const file of ['/old/Book/a book/image.png','/old/Book/a%20book/image.png','</old/Book/a%20book/image.png>']){
   const url=new URL('http://local/pipeline/tasks/id/asset');url.searchParams.set('path',file)
   let actual,status;await route.handler(null,{writeHead:s=>{status=s},end:b=>{actual=b}},url,['','id'])
   assert.equal(status,200);assert.deepEqual(actual,bytes)
  }
  const outside=path.join(path.dirname(root),'outside.png');await fs.writeFile(outside,bytes)
  try{const url=new URL('http://local/pipeline/tasks/id/asset');url.searchParams.set('path',outside);await assert.rejects(route.handler(null,{},url,['','id']),/附件路径无效/)}finally{await fs.unlink(outside)}
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
test('observer image validation supports migrated roots while retaining foreign paths for rejection',()=>{
 const base='/Users/hao/Library/Application Support/DSH/PaperReader/.pipeline/tasks/id/document/ai_convert/page_images'
 assert.deepEqual(observationImagePaths('Inspect "'+base+'/page_001.png"',base),[base+'/page_001.png'])
 assert.deepEqual(observationImagePaths(base+'/page_001.png\n/tmp/other/page_002.png',base),[base+'/page_001.png','/tmp/other/page_002.png'])
})
