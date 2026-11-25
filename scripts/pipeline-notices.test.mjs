import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CloudSyncStore } from '../sync-server/store.mjs'
import {
  createNoticeStore,
  decidePipelineNotice,
  deviceWantsPipelineNotices,
  publishTaskNotice,
  sanitizeNotices,
} from '../modules/pipeline/notices.js'
import {
  deviceWantsPipelineNotices as phoneWantsNotices,
  noticeStorageKey,
  selectFreshNotices,
  startPipelineNoticeWatch,
} from '../mobile-app/www/js/pipeline-notices.js'

const base = {
  taskId: 'task-1',
  taskName: '疯癫与文明',
  phase: 'transcription',
  state: 'idle',
  phaseComplete: true,
  message: '转写已完成',
}

test('transcription and translation completion produce a notice', () => {
  const transcription = decidePipelineNotice(base)
  assert.equal(transcription.outcome, 'done')
  assert.equal(transcription.title, '转写完成')
  assert.match(transcription.body, /疯癫与文明/)
  assert.match(transcription.body, /术语分析与翻译/)

  const translation = decidePipelineNotice({
    ...base,
    phase: 'translation',
    message: '术语分析、翻译与校验已完成',
  })
  assert.equal(translation.title, '翻译完成')
  assert.equal(translation.outcome, 'done')
})

test('a blocked run or an idle timeout is a problem, and a user stop is quiet', () => {
  const blocked = decidePipelineNotice({ ...base, state: 'blocked', phaseComplete: false, message: '第 12 页校验未通过' })
  assert.equal(blocked.outcome, 'problem')
  assert.equal(blocked.title, '转写遇到问题')
  assert.match(blocked.body, /第 12 页校验未通过/)

  const timedOut = decidePipelineNotice({ ...base, phase: 'translation', state: 'paused', timedOut: true, phaseComplete: false, message: '模型长时间没有返回' })
  assert.equal(timedOut.outcome, 'problem')
  assert.equal(timedOut.title, '翻译遇到问题')

  assert.equal(decidePipelineNotice({ ...base, userStop: true, state: 'paused', phaseComplete: false }), null)
  assert.equal(decidePipelineNotice({ ...base, state: 'paused', phaseComplete: false }), null)
})

test('an unfinished step and the delivery phase do not notify', () => {
  assert.equal(decidePipelineNotice({ ...base, phase: 'translation', phaseComplete: false, message: '术语分析已完成' }), null)
  assert.equal(decidePipelineNotice({ ...base, phase: 'delivery' }), null)
  assert.equal(decidePipelineNotice({ ...base, state: 'running' }), null)
})

test('a finished stuck-page retry uses the retry title', () => {
  const notice = decidePipelineNotice({ ...base, scope: 'retry', message: '已用 fixture 重试第 21 页，相关章节已通过' })
  assert.equal(notice.title, '转写重试完成')
  assert.match(notice.body, /第 21 页/)
})

test('the same outcome is kept once inside the dedupe window', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-notices-'))
  const sent = []
  let clock = Date.parse('2026-11-25T00:00:00.000Z')
  const store = createNoticeStore(path.join(root, 'notices.json'), {
    notify: notice => { sent.push(notice.title); return true },
    now: () => clock,
  })
  try {
    const decision = decidePipelineNotice(base)
    const first = await store.publish(decision)
    const second = await store.publish(decision)
    clock += 120_000
    const third = await store.publish(decision)
    assert.equal(second, null)
    assert.notEqual(first.id, third.id)
    assert.deepEqual(sent, ['转写完成', '转写完成'])
    assert.equal((await store.list()).length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('publishing a notice asks the cloud sync to run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-notice-publish-'))
  const reasons = []
  const store = createNoticeStore(path.join(root, 'notices.json'), { notify: () => true })
  try {
    const saved = await publishTaskNotice({
      notices: store,
      scheduleBackgroundSync: (_delay, reason) => reasons.push(reason),
    }, { id: 'task-1', name: '疯癫与文明', state: 'blocked', message: '校验未通过' }, {
      phase: 'transcription',
      phaseComplete: false,
    })
    assert.equal(saved.outcome, 'problem')
    assert.deepEqual(reasons, ['pipeline-notice'])
    assert.equal(await publishTaskNotice({ notices: null }, { id: 'task-1', state: 'blocked' }, { phase: 'transcription' }), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cloud sync stores notices and leaves them in place when a later push omits them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-notice-cloud-'))
  const store = new CloudSyncStore(root)
  const notice = {
    id: 'n-01234567-89ab-4cde-8fab-0123456789ab',
    at: '2026-11-25T01:02:03.000Z',
    taskId: 'task-1',
    phase: 'translation',
    outcome: 'done',
    title: '翻译完成',
    body: '《疯癫与文明》术语分析、翻译与校验已完成',
  }
  try {
    await store.pushState({ pipelineNotices: [notice, { id: 'bad', title: 'no' }] })
    assert.deepEqual(await store.listPipelineNotices(), [notice])
    await store.pushState({ folders: [] })
    assert.equal((await store.pullState()).pipelineNotices.length, 1)
    assert.deepEqual(sanitizeNotices([{ ...notice, phase: 'delivery' }]), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('e-ink mode does not request a phone notification, and the first pull only marks history seen', () => {
  assert.equal(deviceWantsPipelineNotices({ deviceMode: 'phone', theme: 'paper' }), true)
  assert.equal(phoneWantsNotices({ deviceMode: 'phone', theme: 'paper' }), true)
  assert.equal(deviceWantsPipelineNotices({ deviceMode: 'eink', theme: 'eink' }), false)
  assert.equal(phoneWantsNotices({ deviceMode: 'eink', theme: 'paper' }), false)
  assert.equal(phoneWantsNotices({ deviceMode: 'phone', theme: 'eink' }), false)
  assert.equal(phoneWantsNotices(null), false)

  const history = selectFreshNotices([{ id: 'n-old', title: '转写完成' }], new Set(), false)
  assert.deepEqual(history.deliver, [])
  assert.equal(history.primed, true)
  const next = selectFreshNotices(
    [{ id: 'n-old' }, { id: 'n-new', title: '翻译完成' }],
    history.seen,
    history.primed,
  )
  assert.deepEqual(next.deliver.map(item => item.id), ['n-new'])
})

test('notice storage key is scoped by server and vault, and denied permission does not mark new notices seen', async () => {
  assert.notEqual(
    noticeStorageKey({ serverUrl: 'https://a.example.com/', vaultName: 'vault-1' }),
    noticeStorageKey({ serverUrl: 'https://a.example.com', vaultName: 'vault-2' }),
  )

  const store = new Map()
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
  }
  try {
    let pulls = 0
    const delivered = []
    let unavailable = 0
    const settings = { serverUrl: 'https://sync.example.com', vaultName: 'main', deviceMode: 'phone' }
    const watch = startPipelineNoticeWatch({
      getSettings: () => settings,
      isNative: () => true,
      pull: async () => {
        pulls += 1
        return pulls === 1
          ? { notices: [{ id: 'n-1', title: '旧通知', body: '已读' }] }
          : { notices: [{ id: 'n-1', title: '旧通知', body: '已读' }, { id: 'n-2', title: '转写完成', body: '新通知' }] }
      },
      ensurePermission: async () => false,
      notify: item => { delivered.push(item.id) },
      onUnavailable: () => { unavailable += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    watch.kick()
    await new Promise(resolve => setTimeout(resolve, 20))
    watch.stop()

    assert.equal(unavailable, 1)
    assert.deepEqual(delivered, [])
    const saved = JSON.parse(store.get(noticeStorageKey(settings)))
    assert.equal(saved.primed, true)
    assert.deepEqual(saved.ids, ['n-1'])
  } finally {
    globalThis.localStorage = prevStorage
  }
})
