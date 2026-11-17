// Kimi may report a context overflow as INVALID_REQUEST instead of the
// normalized code understood by the host's native compaction recovery.
export function isContextOverflow(failure){
  return failure?.code==='INVALID_REQUEST'&&/request exceeded .+ model token limit:\s*\d+/i.test(failure.message??'')
}
export function installContextRecovery(ctx){
  ctx.inject(['compaction'],({compaction})=>{
    const attempted=new WeakSet()
    ctx.on('agent/status',({agent,status})=>{if(status==='idle')attempted.delete(agent)})
    ctx.on('agent/request-error',async({agent,failure,signal},next)=>{
      if(!isContextOverflow(failure)||signal.aborted||attempted.has(agent))return next()
      attempted.add(agent)
      const before=agent.session.surface.replaceGeneration
      try{await compaction.compactIfNeeded(agent,'context-overflow',signal)}
      catch(error){ctx.logger.warn(`Reader context recovery failed: ${error.message}`);return next()}
      return !signal.aborted&&agent.session.surface.replaceGeneration>before?{kind:'retry'}:next()
    })
  })
}
