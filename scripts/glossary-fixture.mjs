export function semanticFixture(unit,kind){
 if(kind==='consolidation')return {unitId:unit.unitId,groups:unit.entries.map(e=>({members:[{...(e.entryId?{entryId:e.entryId}:{id:e.id}),dst:e.dst,action:e.initialDecision??'keep',reason:'测试中沿用原文术语判定'}],category:e.category==='unknown'?'concept':e.category,reason:'测试中的原文支持此含义',scope:'原文中的对应概念',uncertain:false,publicEligible:!e.bookSpecific,publicReason:e.bookSpecific?'本书含义保留在本书':'测试原文支持一般术语用法'}))}
}
