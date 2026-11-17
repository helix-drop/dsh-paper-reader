export const PHASES=[
 {id:'transcription',name:'转写',stages:['inspect','normalize','images','paddle','mineru','prepare','transcribe','verify','assemble']},
 {id:'translation',name:'术语分析与翻译',stages:['glossary','lgProject','translate','translationCheck']},
 {id:'delivery',name:'审校与发布',stages:['review','publish']},
]
export const phaseForStage=stage=>PHASES.find(p=>p.id===stage||p.stages.includes(stage))
export const transcriptionComplete=t=>t.input?.type==='markdown'?t.stages?.inspect?.state==='done':t.stages?.assemble?.state==='done'
export function phaseReady(t,phase){
 if(phase==='translation'&&!transcriptionComplete(t))throw new Error('先完成转写与原文装配，再确认术语分析与翻译')
 if(phase==='delivery'&&t.stages?.translationCheck?.state!=='done')throw new Error('先完成术语分析、翻译与译文校验，再确认审校与发布')
}
export function assertPhaseApproved(t,stage){
 const phase=phaseForStage(stage)
 if(!phase||t.phaseApproval?.phase!==phase.id)throw new Error(`请先在面板选择模型并确认进入${phase?.name??'对应'}阶段；会话不能自行跨阶段`)
 phaseReady(t,phase.id)
 if(phase.id==='transcription'&&t.phaseApproval.workerId!==`${t.worker?.provider}:${t.worker?.model}`)throw new Error('转写模型已变化，请在面板重新确认')
 if(phase.id==='transcription'&&JSON.stringify(t.phaseApproval.fallbacks??[])!==JSON.stringify(t.worker?.fallbacks??[]))throw new Error('兜底模型已变化，请在面板重新确认')
 if(phase.id==='delivery'&&JSON.stringify(t.phaseApproval.reviewConfig)!==JSON.stringify(t.reviewConfig))throw new Error('审校模型已变化，请在面板重新确认')
 if(stage==='publish'&&!t.phaseApproval.publishAccepted)throw new Error('请在面板明确确认审校与发布')
 return phase.id
}
