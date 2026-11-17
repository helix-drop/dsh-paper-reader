import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {projectTranslationLease} from '../modules/pipeline/harness-translation.js'

test('lease failures distinguish running GUI, live owner, changed configuration and unknown errors without leaking stderr',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lease-diagnostic-'))
 try{
  await fs.mkdir(path.join(root,'lingua'))
  const manager={root,python:process.execPath,cliStatus:async()=>({model:{model:'test/model',agent:{},threshold:{}}})},task={phaseApproval:{translationModel:{model:'test/model'}}},lease={url:'http://127.0.0.1:1',token:'synthetic-capability'}
  for(const [stderr,expected] of [
   ['RuntimeError: LinguaGacha 正在运行，不能更换临时连接','LinguaGacha 正在运行'],
   ['RuntimeError: 另一个 DSH 翻译进程仍持有临时配置','另一个 DSH 翻译进程'],
   ['RuntimeError: LinguaGacha 配置在执行期间变化，保留恢复副本，不覆盖修改','配置在执行期间变化'],
   ['JSONDecodeError: synthetic-private','不是有效 JSON'],
   ['unexpected synthetic-private','不能据此判断应用仍在运行']]){
    await fs.writeFile(path.join(root,'lingua/lg-config'),`process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`)
    await assert.rejects(projectTranslationLease(manager,task,lease),e=>e.message.includes(expected)&&!e.message.includes('synthetic-private')&&!e.message.includes('synthetic-capability'))
    assert.deepEqual(await fs.readdir(path.join(root,'.pipeline/private-transports')),[])
  }
  await fs.writeFile(path.join(root,'lingua/lg-config'),`if(process.argv[2]==='harness-end'){process.stderr.write('RuntimeError: LinguaGacha 配置在执行期间变化，保留恢复副本，不覆盖修改');process.exit(1)}`)
  const restore=await projectTranslationLease(manager,task,lease)
  await assert.rejects(restore(),/配置恢复失败.*配置在执行期间变化/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
