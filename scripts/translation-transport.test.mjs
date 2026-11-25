import test from 'node:test'
import assert from 'node:assert/strict'
import {translationInput} from '../modules/pipeline/source-map.js'
import {translationChunks,recoverTranslationChunks,assembleTranslationChunks,restorePairVerifiedBlockIds} from '../modules/pipeline/translation-transport.js'

test('partial translation recovery requires exact source, request interval, identifiers and structural fidelity',()=>{
 const source=translationInput('## Heading\n\nA paragraph.[^1]\n\n[^1]: Note.\n').text,[heading,body,note]=translationChunks(source)
 const receipt={startedAt:'2026-10-19T00:00:00Z',endedAt:'2026-10-19T01:00:00Z'}
 const pair={src:body.text,dst:body.text.replace('A paragraph.','一段正文。')}
 const requests=[{ended_at:'2026-10-19T00:30:00Z',pairs:[pair,{src:heading.text,dst:heading.text.replace('## ','')},{src:note.text+'changed',dst:note.text}]}]
 const recovered=recoverTranslationChunks(source,[receipt],requests)
 assert.equal(recovered.recovered.length,1);assert.equal(recovered.pending.length,2)
 assert.equal(recoverTranslationChunks(source,[receipt],[{...requests[0],ended_at:'2026-10-19T02:00:00Z'}]).recovered.length,0)
 assert.equal(recoverTranslationChunks(source,[receipt],[{...requests[0],pairs:[{...pair,dst:pair.dst.replace('[^1]','')}]}]).recovered.length,0)
 assert.equal(recoverTranslationChunks(source,[receipt],[{...requests[0],pairs:[{...pair,dst:pair.dst.replace('B0002','B0003')}]}]).recovered.length,0)
 const assembled=assembleTranslationChunks(source,recovered.recovered,recovered.pending.map(b=>b.text).join('\n\n'))
 assert.equal(translationChunks(assembled).length,3);assert(assembled.includes('一段正文。[^1]'))
 assert.throws(()=>assembleTranslationChunks(source,recovered.recovered,[note.text,heading.text].join('\n\n')),/顺序变化/)
 assert.throws(()=>assembleTranslationChunks(source,recovered.recovered,heading.text),/缺块/)
 assert.throws(()=>assembleTranslationChunks(source,recovered.recovered,[heading.text,heading.text].join('\n\n')),/唯一块编号/)
})

test('pair-verified omitted dsh-block comments are restored without accepting wrong IDs or unverified blocks',()=>{
 const source=translationInput('First paragraph.\n\nSecond paragraph.[^1]\n\nThird paragraph:\n\n[^1]: Note text.\n').text
 const [b1,b2,b3,b4]=translationChunks(source)
 const receipt={startedAt:'2026-11-25T06:42:00Z',endedAt:'2026-11-25T06:44:00Z'}
 const dst2NoComment='第二段“时间性”译文。[^1]'
 const dst2ExportedQuotes='第二段「时间性」译文。[^1]'
 const dst3NoComment='第三段译文：'
 const requests=[{
  ended_at:'2026-11-25T06:43:10Z',
  pairs:[
   {src:b1.text,dst:'第一段译文。 <!--dsh-block:B0001-->'},
   {src:b2.text,dst:dst2NoComment},
   {src:b3.text,dst:dst3NoComment},
   {src:b4.text,dst:'[^1]: 注释译文。 <!--dsh-block:B0004-->'}
  ]
 }]
 // 1. recoverTranslationChunks recovers 1-to-1 pair-verified blocks whose comment was omitted by the model
 const rec=recoverTranslationChunks(source,[receipt],requests)
 assert.equal(rec.recovered.length,4)
 assert.equal(rec.pending.length,0)

 // 2. restorePairVerifiedBlockIds restores omitted markers on exported Markdown (even after LinguaGacha quote replacement) when backed by native requests
 const partialRec=recoverTranslationChunks(source,[receipt],[{ended_at:'2026-11-25T06:43:10Z',pairs:[requests[0].pairs[0],requests[0].pairs[3]]}])
 assert.equal(partialRec.recovered.length,2)
 assert.equal(partialRec.pending.length,2)
 const rawIncremental=[dst2ExportedQuotes,dst3NoComment].join('\n\n')+'\n'
 assert.throws(()=>assembleTranslationChunks(source,partialRec.recovered,rawIncremental),/增量译文返回缺少唯一块编号.*B0002.*B0003/)
 // Without matching native requests, unverified unmarked output stays rejected
 assert.equal(restorePairVerifiedBlockIds(partialRec.pending,rawIncremental,[],[receipt]),rawIncremental)
 // With matching native requests, markers are restored and assembly succeeds
 const repaired=restorePairVerifiedBlockIds(partialRec.pending,rawIncremental,requests,[receipt])
 const combined=assembleTranslationChunks(source,partialRec.recovered,repaired)
 assert.equal(translationChunks(combined).length,4)
 assert(combined.includes('第二段「时间性」译文。[^1] <!--dsh-block:B0002-->'))
 assert(combined.includes('第三段译文： <!--dsh-block:B0003-->'))
})
