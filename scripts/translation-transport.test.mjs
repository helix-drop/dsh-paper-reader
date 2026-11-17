import test from 'node:test'
import assert from 'node:assert/strict'
import {translationInput} from '../modules/pipeline/source-map.js'
import {translationChunks,recoverTranslationChunks,assembleTranslationChunks} from '../modules/pipeline/translation-transport.js'

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
