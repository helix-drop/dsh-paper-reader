import fs from 'node:fs/promises'
import path from 'node:path'
import {responseText,safeText} from './sessions.js'

export function publicExecutionText(text){
  const marker='\n响应内容：\n',offset=text.indexOf(marker)
  if(offset<0)return safeText(text)
  const prefix=text.slice(0,offset+marker.length),raw=text.slice(offset+marker.length)
  try{return prefix+safeText(responseText(JSON.parse(raw)))}catch{
    const hidden=raw.indexOf('"reasoning_content"')
    return prefix+safeText(hidden<0?raw:raw.slice(0,hidden)+'\n响应正文截断，完整原始证据保留在任务目录。')
  }
}

/** Byte cursors preserve UTF-8 lines and never turn a partial final record into an event. */
export async function executionEvents(directory,cursor){
  let handle
  try{
    handle=await fs.open(path.join(directory,'execution-events.jsonl'),'r')
    const {size}=await handle.stat(),initial=cursor===null||cursor===undefined
    let offset=initial?Math.max(0,size-128*1024):Number(cursor)
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('执行记录游标无效')
    const reset=offset>size;if(reset)offset=0
    const bytes=Buffer.alloc(Math.min(256*1024,size-offset));await handle.read(bytes,0,bytes.length,offset)
    const end=bytes.lastIndexOf(10)
    if(end<0)return {events:[],cursor:offset,reset}
    const complete=bytes.subarray(0,end+1),start=initial&&offset>0?complete.indexOf(10)+1:0
    const events=complete.subarray(start).toString('utf8').split('\n').filter(Boolean).map(line=>{const event=JSON.parse(line);return {...event,text:publicExecutionText(event.text)}})
    return {events,cursor:offset+complete.length,reset}
  }catch(e){if(e.code==='ENOENT')return {events:[],cursor:0,reset:false};throw e}finally{await handle?.close()}
}
