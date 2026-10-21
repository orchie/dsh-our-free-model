/**
 * 渠道包的图片能力判定：日期快照变体必须继承本族的实测结论。
 *
 * ## 这个文件存在的理由
 *
 * 宿主（`dsh-llm`）按适配器播报的 `inputModalities` 决定**要不要把用户附上的
 * 图片换成文本占位符**。渠道包自己也把这个前提写在两处注释里
 * （`raccoon-adapter.ts` / `trae-adapter.ts`），所以「少报图片能力」不是保守，
 * 而是直接让模型对着占位符作答 —— 用户看到的就是「模型说看不到图片」。
 *
 * raccoon 的远端目录把同一模型按快照日期重复上架：
 *
 *     sn-deepseek-v4-1-flash
 *     sn-deepseek-v4-1-flash-1017     ← 实测被真实调用过（token-ledger.json）
 *
 * 而 `RACCOON_IMAGE_CAPABILITY_OVERRIDES` 的实测证据是按**基础 id** 记的，
 * 精确匹配让 `-1017` 掉回纯文本。修复是「按族名再查一次」，且**只剥 4 位数字**
 * —— 真正不同的模型不能继承。
 *
 * 本套件直接加载 `vendor/channel-pack/pack.js`，不联网、不登录、不消耗额度。
 *
 * Run: node scripts/channel-image-capability-test.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const packPath = path.join(here, '..', 'vendor', 'channel-pack', 'pack.js')
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href

// 渠道包按宿主的包名 import 内核能力；单测里指向本地 shim。
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
  },
})

let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`ok  ${name}`)
}

const pack = await import(pathToFileURL(packPath).href)

await check('基础 id 与其实测组里的第二个模型都仍然判定为可看图', () => {
  assert.equal(pack.raccoonSupportsImage('sn-deepseek-v4-1-flash', []), true)
  assert.equal(pack.raccoonSupportsImage('sn-glm-5-3-flash', []), true)
})

await check('日期快照变体继承本族结论（本次报障的 sn-deepseek-v4-1-flash-1017）', () => {
  assert.equal(pack.raccoonImageFamily('sn-deepseek-v4-1-flash-1017'), 'sn-deepseek-v4-1-flash')
  assert.equal(pack.raccoonSupportsImage('sn-deepseek-v4-1-flash-1017', []), true, '变体掉回了纯文本，图片会被换成占位符')
  assert.equal(pack.raccoonSupportsImage('sn-glm-5-3-flash-1005', []), true)
})

await check('真正不同的模型不会继承（只剥 4 位数字，不做前缀匹配）', () => {
  // 另一个模型，不是快照。
  assert.equal(pack.raccoonSupportsImage('sn-deepseek-v4-1-flash-lite', []), false)
  // 数字长度不对：3 位 / 5 位都不算日期快照。
  assert.equal(pack.raccoonSupportsImage('sn-deepseek-v4-1-flash-105', []), false)
  assert.equal(pack.raccoonSupportsImage('sn-deepseek-v4-1-flash-100517', []), false)
  // 白名单里根本没有的族，带不带后缀都不该被判定为可看图。
  assert.equal(pack.raccoonSupportsImage('sn-unknown-model-1017', []), false)
})

await check('远端 tags 通路不受影响', () => {
  assert.equal(pack.raccoonSupportsImage('sn-unknown-model', ['vision']), true)
  assert.equal(pack.raccoonSupportsImage('sn-unknown-model', ['image-understanding']), true)
  assert.equal(pack.raccoonSupportsImage('sn-unknown-model', ['chat']), false)
})

console.log(`channel-image-capability: ${checks}/${checks} 项通过`)
