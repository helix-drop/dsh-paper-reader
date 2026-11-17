// A native session tool owns the run until the controlled program settles.
// Session cancellation must stop its children rather than detach the work.
export async function executeInSession(manager, taskId, stage, options, exec) {
  const sessionId = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
  if (!sessionId) throw new Error('缺少编排者 session，任务未启动')
  const signal = exec.signal
  signal?.throwIfAborted()
  let active = manager.active.get(taskId)
  if (active && (active.sessionId !== sessionId || active.requestedStage !== stage)) {
    throw new Error('任务已由其他执行请求运行，请查看对应编排者会话')
  }
  let stopping
  const cancel = () => {
    // start() may still be validating. Check again once it has registered the run.
    if (active && !stopping) stopping = manager.stop(taskId)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (!active) {
      await manager.start(taskId, stage, options, { sessionId, signal })
      active = manager.active.get(taskId)
    }
    if (signal?.aborted) cancel()
    await active?.promise
    await stopping
    const task = await manager.get(taskId)
    return {
      taskId, sessionId, requestedStage: stage, state: task.state,
      stage: task.stage, message: task.message, stages: task.stages,
      execution: task.execution,
      approvedPhase:task.phaseApproval?.phase??null,
      phaseBoundary:'当前阶段完成后停止。下一阶段须由用户在面板选择模型并确认；不得自行继续。',
      completed: task.state === 'idle',
      interrupted: signal?.aborted || task.state === 'paused',
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
