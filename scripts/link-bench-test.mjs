/**
 * 链路降级后的冷却（bench）：降级一次，该成员歇一天。
 *
 * ## 为什么要有这个
 *
 * 之前 `fallback` 策略**每轮都从 members[0] 开始**，而 `classifyFailure` 算出的
 * `cooldownMs` 只用来判断「本轮要不要继续往下走」（`shouldAdvance`），算完即丢。
 * 于是首个成员坏掉之后，每一轮都要先白白撞它一次：
 *
 *   - 延迟：每个回合多一次注定失败的请求；
 *   - 风控：`unapproved channel` 这类拒绝**本身就是反滥用机制**，每轮重复撞它
 *     正是它要抓的模式。
 *
 * ## 固定的四条契约
 *
 * 1. **按「链路 + 成员」记。** 同一个模型在别的链路里是另一回事，全局禁用会
 *    悄悄收窄用户自己搭的路由。
 * 2. **固定 24 小时，不按失败类型区分。** 歇久了最坏是同门模型代打一天；
 *    歇短了是每轮再撞一次被拒的账号。宁可长。
 * 3. **按失败顺序重排，不删除。** 被歇的成员排到队尾，相对顺序两边都保留
 *    （用户的梯队偏好仍然有效）。
 * 4. **全员歇着就清空重来**，从队首开始 —— 也就是「一直降级又回到第一个」
 *    那种情况，避免整条链路停摆一天。
 *
 * 全套件纯内存，不出网、不启动 OAuth 监听、不消耗额度。
 *
 * Run: node scripts/link-bench-test.mjs
 */
import assert from 'node:assert/strict'
import {
  LINK_BENCH_MS,
  benchedMembers,
  emptyLinkHealth,
  linkKey,
  preferHealthy,
  pruneLinkHealth,
  shouldRetireBench,
  splitLinkKey,
} from '../src/link-health.js'
import { buildComboCatalog, comboChain, comboId, comboMembers, normalizeCombos, resetRotation } from '../src/combos.js'
import { FreeModelAdapter } from '../src/adapter.js'

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

const CHAIN = 'combo:fish'
const NOW = 1_700_000_000_000

/** 三个成员，按用户配置的梯队顺序。 */
const rows = ['a', 'b', 'c'].map(letter => ({
  id: `${letter}`,
  name: letter.toUpperCase(),
  channel: 'anonymous',
  contextWindow: 128000,
  maxOutput: 16000,
}))

/** 造一份「某成员在 NOW 之前刚被歇下」的状态。 */
function restedAt(members, at = NOW - 1000, chainId = CHAIN) {
  const value = emptyLinkHealth()
  for (const id of members) {
    value.links[linkKey(chainId, id)] = { until: at + LINK_BENCH_MS, at, kind: 'permission', scope: 'account' }
  }
  return value
}

try {
  await check('被歇的成员会被识别出来，过期的不会', () => {
    assert.deepEqual([...benchedMembers(restedAt(['a']), CHAIN, NOW)], ['a'])
    // 正好到期的一刻视为已恢复：`until > now` 才算歇着。
    const expired = emptyLinkHealth()
    expired.links[linkKey(CHAIN, 'a')] = { until: NOW, at: NOW - LINK_BENCH_MS }
    assert.deepEqual([...benchedMembers(expired, CHAIN, NOW)], [])
  })

  await check('冷却按链路隔离：同一模型在别的链路里仍可用', () => {
    const health = restedAt(['a'], NOW - 1000, 'combo:other')
    assert.deepEqual([...benchedMembers(health, CHAIN, NOW)], [], '别的链路的冷却影响了本条链路')
    assert.deepEqual([...benchedMembers(health, 'combo:other', NOW)], ['a'])
  })

  await check('成员 id 里带分隔符也不会串到别的链路或成员', () => {
    assert.deepEqual(splitLinkKey(linkKey('combo:x', 'm')), { chainId: 'combo:x', memberId: 'm' })
    // 分隔符是 NUL：组合 id 由 `comboId()` 生成，字符集限死了 `[a-z0-9-]` 或十六进制，
    // 不可能含 NUL，所以「切在第一个 NUL」对真实输入是唯一正确的切法。
    // 下面是这条约束本身，避免以后有人放宽 id 生成规则却忘了这个分隔符。
    for (const name of ['白嫖大肥鱼', 'My Fast Chain', 'a/b:c', 'a\u0000b']) {
      assert.equal(comboId(name).includes('\u0000'), false, `comboId("${name}") 产生了分隔符`)
    }
    assert.equal(splitLinkKey('no-separator'), null)
    assert.equal(splitLinkKey('\u0000'), null)
  })

  await check('降级后的重排：被歇的排到队尾，两边都保留原顺序', () => {
    const members = comboMembers({ id: CHAIN, combo: ['a', 'b', 'c'] }, rows)
    const ordered = preferHealthy(members, new Set(['a']))
    assert.deepEqual(ordered.map(row => row.id), ['b', 'c', 'a'], '链路仍从被歇的成员开始')
    // 中间那个被歇，两边的顺序都不能动。
    const middle = preferHealthy(members, new Set(['b']))
    assert.deepEqual(middle.map(row => row.id), ['a', 'c', 'b'])
  })

  await check('全员被歇时判定为「该清空重来」', () => {
    const members = comboMembers({ id: CHAIN, combo: ['a', 'b', 'c'] }, rows)
    assert.equal(shouldRetireBench(members, new Set(['a', 'b', 'c'])), true)
    assert.equal(shouldRetireBench(members, new Set(['a', 'b'])), false)
    assert.equal(shouldRetireBench(members, new Set()), false)
    assert.equal(shouldRetireBench([], new Set()), false, '空链路不该被当成"全员被歇"')
  })

  await check('过期记录与已删除链路的记录都会在写入时清掉', () => {
    const value = emptyLinkHealth()
    value.links[linkKey(CHAIN, 'a')] = { until: NOW + LINK_BENCH_MS, at: NOW }
    value.links[linkKey(CHAIN, 'gone')] = { until: NOW + LINK_BENCH_MS, at: NOW }
    value.links[linkKey('combo:dead', 'a')] = { until: NOW + LINK_BENCH_MS, at: NOW }
    value.links[linkKey(CHAIN, 'old')] = { until: NOW - 1, at: NOW - LINK_BENCH_MS }
    const live = new Set([linkKey(CHAIN, 'a'), linkKey(CHAIN, 'old')])
    const pruned = pruneLinkHealth(value, NOW, live)
    assert.deepEqual(Object.keys(pruned.links), [linkKey(CHAIN, 'a')], '文件会一直长大，或者留下了过期记录')
    // 不传 live 时只按时间过期，不误删。
    assert.equal(Object.keys(pruneLinkHealth(value, NOW).links).length, 3)
  })

  await check('comboChain 从没被歇的第一个成员开始（这是本次的核心修复）', () => {
    const members = comboMembers({ id: CHAIN, combo: ['a', 'b', 'c'] }, rows)
    const entry = { id: CHAIN, name: 'fish', combo: ['a', 'b', 'c'], strategy: 'fallback', stickyLimit: 1 }
    // 对照：没有冷却时从队首开始，正是线上"每轮先撞 a"的成因。
    assert.deepEqual(comboChain(entry, rows).map(row => row.id), ['a', 'b', 'c'])
    assert.equal(members.length, 3)
    // 修好之后：a 被歇，直接从 b 开始，且 a 仍在候选里（最后兜底）。
    const benched = benchedMembers(restedAt(['a']), CHAIN, NOW)
    assert.deepEqual(comboChain(entry, rows, { benched }).map(row => row.id), ['b', 'c', 'a'])
  })

  await check('runCombo 真的从第二个成员开始，且被歇的那个本轮不发出请求', async () => {
    resetRotation()
    const dispatched = []
    const benched = new Set(['a'])
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: rows, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      benchedLinks: () => new Set(benched),
      dispatchForeign: undefined,
    })
    const entry = { id: CHAIN, name: 'fish', combo: ['a', 'b', 'c'], strategy: 'fallback', stickyLimit: 1, channel: 'combo' }
    const snapshot = { catalog: rows, settings: {}, attributionUserAgent: 'test' }
    // 走本车道（非 foreign），用 dispatch 钩子观察实际发出的调用顺序。
    const original = adapter.runSingle.bind(adapter)
    adapter.runSingle = async function* (options, candidate, snap, plan) {
      dispatched.push(candidate.id)
      if (candidate.id === 'a') assert.fail('被歇的第一个成员仍然被请求了')
      yield { type: 'text-delta', text: 'ANSWER' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return { advance: false, verdict: null, ok: true }
    }
    void original
    const chunks = []
    for await (const chunk of adapter.runCombo({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }
    assert.deepEqual(dispatched, ['b'], `实际请求了 ${dispatched.join(',') || '（无）'}`)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ANSWER')
  })

  await check('降级时把失败成员登记为歇一天', async () => {
    resetRotation()
    const benched = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: rows, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      benchedLinks: () => new Set(),
      benchLink: record => benched.push(record),
    })
    const entry = { id: CHAIN, name: 'fish', combo: ['a', 'b'], strategy: 'fallback', stickyLimit: 1, channel: 'combo' }
    const snapshot = { catalog: rows, settings: {}, attributionUserAgent: 'test' }
    adapter.runSingle = async function* (options, candidate) {
      if (candidate.id === 'a') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unapproved channel', code: 'INVALID_REQUEST', status: 400 } } }
        return { advance: true, verdict: { kind: 'permission', scope: 'account', rule: 'marker', cooldownMs: 120000 }, ok: false }
      }
      yield { type: 'text-delta', text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return { advance: false, verdict: null, ok: true }
    }
    for await (const _ of adapter.runCombo({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) { /* drain */ }
    assert.equal(benched.length, 1, `登记了 ${benched.length} 次`)
    assert.equal(benched[0].chainId, CHAIN)
    assert.equal(benched[0].memberId, 'a')
    assert.equal(benched[0].kind, 'permission')
    // 成功的那一个不该被歇。
    assert.equal(benched.some(record => record.memberId === 'b'), false)
  })

  await check('全员被歇时清空登记并从队首重来', async () => {
    resetRotation()
    const dispatched = []
    const retired = []
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: rows, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      benchedLinks: () => new Set(['a', 'b', 'c']),
      retireBench: chainId => retired.push(chainId),
      benchLink: () => {},
    })
    const entry = { id: CHAIN, name: 'fish', combo: ['a', 'b'], strategy: 'fallback', stickyLimit: 1, channel: 'combo' }
    const snapshot = { catalog: rows, settings: {}, attributionUserAgent: 'test' }
    adapter.runSingle = async function* (options, candidate) {
      dispatched.push(candidate.id)
      yield { type: 'text-delta', text: 'OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return { advance: false, verdict: null, ok: true }
    }
    for await (const _ of adapter.runCombo({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) { /* drain */ }
    assert.equal(retired.length, 1, '全员歇着时没有清空，链路会停摆一天')
    assert.equal(dispatched[0], 'a', '清空后没有回到队首')
  })

  await check('全部成员失败时链路报错终止（既有行为，钉住它）', async () => {
    resetRotation()
    const adapter = new FreeModelAdapter({
      state: () => ({ catalog: rows, membership: {}, settings: {}, attributionUserAgent: 'test' }),
      recordUsage: () => {},
      benchedLinks: () => new Set(),
      benchLink: () => {},
    })
    const entry = { id: CHAIN, name: 'fish', combo: ['a', 'b'], strategy: 'fallback', stickyLimit: 1, channel: 'combo' }
    const snapshot = { catalog: rows, settings: {}, attributionUserAgent: 'test' }
    adapter.runSingle = async function* (options, candidate) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `${candidate.id} refused`, code: 'PERMISSION_DENIED', status: 403 } } }
      return { advance: true, verdict: { kind: 'permission', scope: 'account', cooldownMs: 120000 }, ok: false }
    }
    const chunks = []
    for await (const chunk of adapter.runCombo({ model: entry.id, messages: [], provider: 'our-free-model' }, entry, snapshot)) {
      chunks.push(chunk)
    }
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish && finish.reason.kind === 'error', '全部失败时没有报错终止')
    assert.match(String(finish.reason.failure.message), /exhausted every candidate/)
    assert.match(String(finish.reason.failure.message), /a .*; b /, '错误信息没有列出试过的成员')
  })

  console.log(`link-bench: ${checks}/${checks} 项通过`)
} finally {
  resetRotation()
}
