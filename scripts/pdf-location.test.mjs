import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {attachPdfLocations,locateSourceBlocks} from '../modules/pipeline/pdf-location.js'
const text='Voici, suivant ma promesse, la vérité exacte de ce qui est arrivé dans cette histoire.'
test('locate unique source text and reject repeated or short snippets',()=>{
 const blocks=[{id:'a',type:'paragraph',text},{id:'short',type:'heading',text:'I'}]
 assert.equal(locateSourceBlocks(blocks,[{page:39,text}]).get('a'),39)
 assert.equal(locateSourceBlocks(blocks,[{page:39,text},{page:50,text}]).get('a'),null)
 assert.equal(locateSourceBlocks(blocks,[{page:39,text}]).get('short'),null)
})
test('map normalized pages to original PDF and never pair an unaligned translation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-location-'))
 try{
  await fs.mkdir(path.join(root,'ai_convert/edits/body'),{recursive:true})
  await fs.writeFile(path.join(root,'ai_convert/edits/body/page_001.json'),JSON.stringify({book_page:1,paragraphs:[{text}]}))
  await fs.writeFile(path.join(root,'document_profile.json'),JSON.stringify({source_page_map:[{logical_page:1,source_page:12}]}))
  const manager={docDir:()=>root},t={input:{type:'pdf'}}
  const source={id:'s',type:'paragraph',text}
  assert.equal((await attachPdfLocations(manager,t,{blocks:[source]})).blocks[0].pdfPage,12)
  const doc={standaloneView:'translation',originalBlocks:[source],blocks:[{id:'zh',type:'paragraph',text:'译文',sourceBlockId:'s'},{id:'unmatched',text:'未知对应关系'}]}
  const result=await attachPdfLocations(manager,t,doc)
  assert.equal(result.blocks[0].pdfPage,12);assert.equal(result.blocks[1].pdfPage,null)
  await fs.unlink(path.join(root,'document_profile.json'))
  assert.equal((await attachPdfLocations(manager,t,{blocks:[source]})).blocks[0].pdfPage,null)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
