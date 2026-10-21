/**
 * 链路与图片：宣告「任一成员能看图」，并在带图回合里只走能看图的成员。
 *
 * ## 这个文件存在的理由
 *
 * 宿主按适配器播报的 `inputModalities` 决定**要不要把附件换成文本占位符**——
 * 渠道包自己在 `raccoon-adapter.ts` / `trae-adapter.ts` 都写明了这个前提。
 * 所以链路宣告 `vision = 成员交集` 不是保守，而是让**整条链拒绝图片**：能看图
 * 的成员永远收不到，用户连附上图片的机会都没有，模型则对着占位符答
 * 「看不到图片」。
 *
 * 正确的分工是：链路宣告「任一成员能看图」（这样宿主保留图片），真正的保护
 * 放在 `runCombo` 里 —— 带图回合只在声明支持图片的成员里走；一个都没有时
 * 立即报错说清原因。
 *
 * 容量（`contextWindow` / `maxOutput`）不受影响，仍是交集：那是每个成员都必须
 * 兑现的承诺，和「这一轮谁来服务」不是一回事。
 *
 * 全套件离线：不联网、不启动 OAuth 监听、不消耗额度。
 *
 * Run: node scripts/chain-vision-test.mjs
 */
import assert from 'node:assert/strict'
import { buildComboCatalog, normalizeCombos, resetRotation } from '../src/combos.js'
import { FreeModelAdapter } from '../src/adapter.js'
import { needsVision } from '../src/messages.js'

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

/** 一条能看图的成员 + 一条纯文本成员，纯文本的排在前面（链首）。 */
const catalog = [
  { id: 'blind', name: 'Blind', channel: 'anonymous', vision: false, contextWindow: 128000, maxOutput: 16000 },
  { id: 'sighted', name: 'Sighted', channel: 'anonymous', vision: true, contextWindow: 200000, maxOutput: 32000 },
]

const IMAGE_TURN = [{ role: 'user', content: [
  { type: 'text', text: '这是什么？' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
] }]
const TEXT_TURN = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]

function chainOf(models) {
  const normalized = normalizeCombos([{ name: 'vision', models }])
  const [entry] = buildComboCatalog(normalized, catalog)
  return entry
}

/** 记录实际发出的模型，并让它们立刻给出正文。 */
function adapterThat(dispatched, failFor = () => false) {
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership: {}, settings: {}, attributionUserAgent: 'test' }),
    recordUsage: () => {},
    recordTurn: () => {},
  })
  adapter.runSingle = async function* (options, candidate) {
    dispatched.push(candidate.id)
    if (failFor(candidate.id)) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `${candidate.id} refused`, code: 'PERMISSION_DENIED', status: 403 } } }
      return { advance: true, verdict: { kind: 'permission', scope: 'account', cooldownMs: 120000 }, ok: false }
    }
    yield { type: 'text-delta', text: 'ANSWER' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { advance: false, verdict: null, ok: true }
  }
  return adapter
}

async function drain(adapter, entry, messages) {
  const snapshot = { catalog, settings: {}, attributionUserAgent: 'test' }
  const chunks = []
  for await (const chunk of adapter.runStream({ model: entry.id, messages, provider: 'our-free-model' }, entry, snapshot)) {
    chunks.push(chunk)
  }
  return chunks
}

try {
  resetRotation()

  await check('needsVision 认得图片块，也认得纯文本轮', () => {
    assert.equal(needsVision(IMAGE_TURN), true)
    assert.equal(needsVision(TEXT_TURN), false)
    assert.equal(needsVision([]), false)
  })

  await check('链路宣告「任一成员能看图」，容量仍是交集', () => {
    const entry = chainOf(['blind', 'sighted'])
    assert.equal(entry.vision, true, '交集会让整条链拒绝图片')
    assert.equal(entry.contextWindow, 128000, '容量必须仍取交集')
    assert.equal(entry.maxOutput, 16000)
  })

  await check('只有纯文本成员时，链路不宣告视觉', () => {
    assert.equal(chainOf(['blind']).vision, false)
  })

  await check('带图回合跳过链首的纯文本成员，图片交给能看图的成员', async () => {
    resetRotation()
    const dispatched = []
    const entry = chainOf(['blind', 'sighted'])
    const chunks = await drain(adapterThat(dispatched), entry, IMAGE_TURN)
    assert.deepEqual(dispatched, ['sighted'], `图片被发给了 ${dispatched.join(',') || '（无）'}`)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ANSWER')
  })

  await check('纯文本回合仍然从链首开始（过滤只作用于带图回合）', async () => {
    resetRotation()
    const dispatched = []
    const entry = chainOf(['blind', 'sighted'])
    await drain(adapterThat(dispatched), entry, TEXT_TURN)
    assert.deepEqual(dispatched, ['blind'], '纯文本回合不该被视觉过滤影响')
  })

  await check('带图回合里能看图的成员失败时，不会降级到纯文本成员', async () => {
    resetRotation()
    const dispatched = []
    const entry = chainOf(['blind', 'sighted'])
    const chunks = await drain(adapterThat(dispatched, id => id === 'sighted'), entry, IMAGE_TURN)
    assert.deepEqual(dispatched, ['sighted'], '图片被降级发给了纯文本成员，模型会对着占位符作答')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish && finish.reason.kind === 'error', '没有报错终止')
  })

  await check('没有一个成员能看图时，一次请求都不发并报错说清原因', async () => {
    resetRotation()
    const dispatched = []
    const entry = chainOf(['blind'])
    const chunks = await drain(adapterThat(dispatched), entry, IMAGE_TURN)
    assert.deepEqual(dispatched, [], '纯文本成员仍然收到了图片')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish && finish.reason.kind === 'error', '没有报错终止')
    assert.match(String(finish.reason.failure.message), /image/i)
  })

  console.log(`chain-vision: ${checks}/${checks} 项通过`)
} finally {
  resetRotation()
}
