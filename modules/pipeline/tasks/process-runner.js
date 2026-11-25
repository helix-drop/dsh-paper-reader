import path from 'node:path'
import { spawn } from 'node:child_process'
import { splitModel, modelFailure } from '../harness-models.js'
import {
  selectHarnessTranslation,
  harnessTranslationStatus,
  setHarnessConcurrency,
  projectTranslationLease,
} from '../harness-translation.js'
import { AGY_CLI_GROUP } from '../review-audit.js'
import { ANALYZER, WORKER_OBSERVER } from './shared.js'

const MODEL_SCRIPT_RE = /analyze_document\.py$|bounded_chapter\.py$|worker_call\.py$|marker_review\.py$/
const IDLE_WATCHDOG_MS = 20 * 60 * 1000
const ABSOLUTE_DEADLINE_MS = 3 * 60 * 60 * 1000
const MAX_OUTPUT_BUFFER_CHARS = 512 * 1024

function formatWorkerRecordText(e) {
  const label = {
    request_started: '请求已发出，等待模型返回',
    response_received: '模型已返回，等待结果校验',
    request_failed: '模型请求失败',
  }[e.event]
  const images = e.images ? `图片：${e.images.join('、')}\n` : ''
  const prompt = e.prompt ? `输入提示：\n${e.prompt}\n` : ''
  const response = e.response
    ? `模型响应（共 ${e.responseCharacters} 字符，最多展示 16000 字符）：\n${e.response}`
    : ''
  const errType = e.errorType ? `失败类型：${e.errorType}` : ''
  const errCode = /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(e.errorCode ?? '') ? `；失败代码：${e.errorCode}` : ''
  const errMsg = e.errorMessage ? `；原因：${modelFailure({ message: e.errorMessage }).message}` : ''
  return `状态：${label}；模型：${e.model}；请求编号：${e.requestId}\n${images}${prompt}${response}${errType}${errCode}${errMsg}`
}

function extractCommandDiagnostic(output) {
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const diagnostic = JSON.parse(line)
      if (diagnostic?.type === 'paper-reader-worker') {
        if (diagnostic.event === 'request_failed' && typeof diagnostic.errorMessage === 'string') {
          return modelFailure({ message: diagnostic.errorMessage }).message
        }
        continue
      }
      if (typeof diagnostic?.error === 'string') {
        return modelFailure({ message: diagnostic.error }).message
      }
    } catch {}
  }

  const lines = output.split('\n').map(l => l.trim()).filter(
    l => Boolean(l) && !l.includes('"type":"paper-reader-worker"') && !l.includes('"type": "paper-reader-worker"'),
  )
  const blocked = lines.filter(l => /^(?:[✗xX*!]\s*)?BLOCKED:|^Error:|^ValueError:/i.test(l))
  let diag = ''
  if (blocked.length) {
    diag = blocked.slice(-3).map(l => l.replace(/^[✗xX*!]\s*/, '')).join('；')
  } else {
    const textLines = lines.filter(l => (
      !l.startsWith('=')
      && !l.startsWith('warning:')
      && !l.startsWith('Traceback')
      && !l.startsWith('File "')
      && !l.startsWith('detected metrics:')
      && !l.startsWith('font sizes')
      && l.length > 5
    ))
    if (textLines.length) diag = textLines.slice(-2).join('；')
  }
  return diag.length > 300 ? diag.slice(-300) : diag || undefined
}

export const processRunnerMethods = {
  async requireModel(choice) {
    if (choice?.provider === 'agy') {
      const m = AGY_CLI_GROUP.models.find(item => item.id === choice.model)
      if (!m) throw new Error('所选 Antigravity CLI 模型不在可用列表中')
      if (choice.reasoningEffort && !m.reasoning.efforts.some(e => e.id === choice.reasoningEffort)) {
        throw new Error('所选思考档位不受该模型支持')
      }
      return choice
    }
    if (this.requireHarnessModels && !this.modelService) throw new Error('DSH 模型服务尚未就绪')
    if (this.modelService) await this.modelService.validate(choice)
    return choice
  },

  async modelCatalog() {
    if (!this.modelService) throw new Error('DSH 模型服务尚未就绪')
    const c = await this.modelService.catalog()
    const groups = Array.isArray(c?.groups) ? c.groups : []
    return {
      ...c,
      groups: groups.some(g => g.id === 'agy') ? groups : [...groups, AGY_CLI_GROUP],
    }
  },

  async selectTranslationModel(id) {
    if ([...this.active.values()].some(a => a.translationCli)) throw new Error('翻译正在运行')
    return selectHarnessTranslation(this, id)
  },

  async translationStatus() {
    return harnessTranslationStatus(this)
  },

  async translationConcurrency(n) {
    if ([...this.active.values()].some(a => a.translationCli)) throw new Error('翻译正在运行')
    return setHarnessConcurrency(this, n)
  },

  async command(t, cmd, args, io = {}) {
    const modelCommand = cmd === this.cliExecutable || args.some(a => MODEL_SCRIPT_RE.test(a))
    if (!modelCommand) return this.rawCommand(t, cmd, args, io)
    if (this.requireHarnessModels && !this.modelService) throw new Error('DSH 模型服务尚未就绪')
    if (!this.modelService) return this.rawCommand(t, cmd, args, io)

    const selections = io.models?.length
      ? io.models
      : cmd === this.cliExecutable
        ? [splitModel(t.phaseApproval?.translationModel?.model)]
        : [t.worker, ...(t.worker.fallbacks ?? [])]

    const lease = await this.modelService.openLease(selections, {
      directory: path.join(this.dir(t.id), 'harness-requests'),
      sessionId: `paper-reader-${t.id}`,
    })
    let restore
    try {
      if (cmd === this.cliExecutable) restore = await projectTranslationLease(this, t, lease)
      const pythonPath = path.dirname(ANALYZER) + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '')
      return await this.rawCommand(t, cmd, args, {
        ...io,
        env: {
          ...io.env,
          ...lease.env,
          DSH_SELECTED_PROVIDER: selections[0]?.provider ?? t.worker?.provider ?? '',
          PYTHONPATH: pythonPath,
        },
      })
    } finally {
      try {
        await restore?.()
      } finally {
        await lease.close()
      }
    }
  },

  async rawCommand(t, cmd, args, io = {}) {
    t.log ??= []
    const firstArg = args[0] && path.basename(args[0]) === path.basename(WORKER_OBSERVER) && args[1]
      ? args[1]
      : args[0]
    const commandName = path.basename(firstArg?.startsWith('--') ? cmd : firstArg ?? cmd)
    const entry = { stage: t.stage, startedAt: new Date().toISOString(), command: commandName }
    t.log.push(entry)
    await this.save(t)

    const role = cmd === this.cliExecutable ? 'linguagacha' : 'worker'
    const record = (key, text) => this.sessionMonitor?.attempt(
      () => this.sessionMonitor.record(t, role, `${entry.startedAt}:${key}`, text),
      t.id,
    )
    await record('start', `程序已启动：${entry.command}；阶段：${t.stage}。此状态尚不能证明模型请求成功。`)

    return new Promise((resolve, reject) => {
      const childEnv = { ...process.env, ...io.env, PYTHONUNBUFFERED: '1' }
      if (cmd === this.cliExecutable) delete childEnv.ELECTRON_RUN_AS_NODE

      const child = spawn(cmd, args, {
        cwd: this.root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      })

      const active = this.active.get(t.id)
      if (active) {
        active.children = active.children || new Set()
        active.children.add(child)
        active.child = child
        if (active.cancel) {
          try { process.kill(-child.pid, 'SIGTERM') } catch {}
        }
      }

      // LinguaGacha runs (glossary analysis/consolidation and translation) are
      // bounded by an idle watchdog instead of an absolute deadline: large books
      // can legitimately need more than 3 hours, while a stalled run still stops.
      const progressTimeout = cmd === this.cliExecutable && ['translate', 'glossary'].includes(t.stage)
      let completed = 0
      let killTimer

      const timer = setTimeout(() => {
        entry.timedOut = true
        if (progressTimeout) {
          entry.diagnostic = t.stage === 'glossary'
            ? '术语分析连续 20 分钟没有新增完成单元，已停止；恢复时复用已完成单元'
            : '翻译连续 20 分钟没有新增完成块，已停止；恢复时复用已完成译块'
        } else {
          entry.diagnostic = '程序运行超过 3 小时，已停止'
        }
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL') } catch {}
          }
        }, 5000)
        killTimer.unref()
      }, progressTimeout ? IDLE_WATCHDOG_MS : ABSOLUTE_DEADLINE_MS)
      timer.unref()

      const progress = line => {
        if (!progressTimeout || entry.timedOut) return
        try {
          const e = JSON.parse(line)
          const n = e.stats?.completed
          if (e.type === 'progress' && Number.isSafeInteger(n) && n > completed) {
            completed = n
            timer.refresh()
          }
        } catch {}
      }

      let output = ''
      let pending = ''
      let events = Promise.resolve()

      const onLine = async line => {
        if (io.onLine) await io.onLine(line)
        if (this.sessionMonitor && role === 'worker') {
          let e
          try { e = JSON.parse(line) } catch { return }
          if (e.type === 'paper-reader-worker' && ['request_started', 'response_received', 'request_failed'].includes(e.event)) {
            await record(`worker:${String(e.requestId)}:${e.event}`, formatWorkerRecordText(e))
          }
        }
        if (this.sessionMonitor && role === 'linguagacha') {
          let e
          try { e = JSON.parse(line) } catch { return }
          if (['progress', 'finished', 'error', 'started'].includes(e.type)) {
            const safe = {
              type: e.type,
              status: typeof e.status === 'string' ? e.status.slice(0, 80) : undefined,
              stats: e.stats
                ? Object.fromEntries(Object.entries(e.stats).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean'))
                : undefined,
            }
            await record('cli:' + JSON.stringify(safe), 'CLI 事件：' + JSON.stringify(safe))
          }
        }
      }

      const collect = b => {
        output = (output + b.toString()).slice(-MAX_OUTPUT_BUFFER_CHARS)
      }
      const collectStdout = b => {
        pending += b.toString()
        const lines = pending.split('\n')
        pending = lines.pop()
        for (const line of lines) {
          progress(line)
          events = events.then(() => onLine(line))
        }
        collect(b)
      }

      child.stdout.on('data', collectStdout)
      child.stderr.on('data', collect)
      child.on('error', () => {
        clearTimeout(timer)
        clearTimeout(killTimer)
        reject(new Error('处理程序无法启动'))
      })

      child.on('close', async (code, signal) => {
        clearTimeout(timer)
        clearTimeout(killTimer)
        if (pending) events = events.then(() => onLine(pending))
        try {
          await events
        } catch {
          reject(new Error('CLI 进度记录失败，保留输出等待核验'))
          return
        }
        if (active) {
          if (active.children) active.children.delete(child)
          if (active.child === child) active.child = null
        }

        entry.exitCode = code
        entry.signal = signal
        entry.endedAt = new Date().toISOString()
        if (code !== 0 && !entry.timedOut && !active?.cancel) {
          const diag = extractCommandDiagnostic(output)
          if (diag) entry.diagnostic = diag
        }

        await record(
          'finish',
          `程序已结束：${entry.command}；退出码：${code}；信号：${signal ?? '无'}。${entry.diagnostic ? `校验原因：${entry.diagnostic}。` : ''}模型返回与产物校验以各自记录为准。`,
        )
        if (this.sessionMonitor) {
          await this.sessionMonitor.attempt(() => this.sessionMonitor.scan(t), t.id)
        }
        if (code !== 0 || entry.timedOut) {
          const msg = active?.cancel
            ? '任务已停止'
            : `${entry.command} 未通过，退出码 ${code}${entry.diagnostic ? `；${entry.diagnostic}` : ''}；已有产物保留`
          const error = new Error(msg)
          if (entry.timedOut) error.timedOut = true
          error.exitCode = code
          reject(error)
        } else {
          resolve(output)
        }
      })
    })
  },

  py(t, script, args = [], io) {
    const file = path.join(this.root, script)
    const observerPrefix = this.sessionMonitor && path.basename(script) === 'bounded_chapter.py'
      ? [WORKER_OBSERVER]
      : []
    return this.command(t, this.python, [...observerPrefix, file, ...args], io)
  },
}
