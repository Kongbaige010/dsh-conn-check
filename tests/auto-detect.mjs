/**
 * 回归测试：证明模型清单是**自动读取**的，不是手写死的
 *   node tests/auto-detect.mjs
 *
 * 做法：造一个临时 profile，塞进一个凭空捏造的 provider 与模型，
 * 看 buildCatalog() 能否原样认出来。认得出 = 完全由配置驱动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCatalog } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')) }
}

const FAKE = `
- id: llm-pi-ai
  config:
    providers:
      brandnew:
        displayName: 我瞎编的站点
        baseURL: https://example.invalid/v1
        api: openai-completions
        apiKeyEnv: FAKE_KEY_ENV
        models:
          - id: totally-made-up-model-9b
            name: 随手编的模型
          - id: another-made-up-model
            name: 再编一个
- id: agent-default-model
  config:
    provider: brandnew
    model: totally-made-up-model-9b
`

console.log('=== 塞一个凭空捏造的 provider 进临时 profile ===')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcc-prove-'))
fs.writeFileSync(path.join(tmp, 'cordis.patch.yml'), FAKE, 'utf8')
process.env.DSH_PROFILE_DIR = tmp

const cat = buildCatalog()
console.log('   识别到的 profile: ' + cat.profileDir)
for (const m of cat.models) {
  console.log('   · ' + m.id + '  | ' + m.providerName + ' | ' + m.site + ' | 有密钥=' + m.hasKey)
}
console.log('   默认模型: ' + JSON.stringify(cat.defaults))

ok(cat.profileDir === tmp, '用的是临时 profile（不是我写的固定路径）')
ok(cat.models.some((m) => m.id === 'brandnew::totally-made-up-model-9b'),
  '自动识别了捏造的 provider + 模型 A')
ok(cat.models.some((m) => m.id === 'brandnew::another-made-up-model'),
  '自动识别了捏造的模型 B')
const hit = cat.models.find((m) => m.id === 'brandnew::totally-made-up-model-9b')
ok(hit && hit.providerName === '我瞎编的站点', 'displayName 原样读出（不是硬编码）', hit && hit.providerName)
ok(hit && hit.site === 'https://example.invalid/v1', 'baseURL 原样读出', hit && hit.site)
ok(cat.defaults && cat.defaults.provider === 'brandnew', '默认模型也跟着配置走', JSON.stringify(cat.defaults))
ok(hit && hit.hasKey === false, '没有对应密钥时如实标 false（不假装有）', String(hit && hit.hasKey))

/* 再验一次：删掉配置后应该什么都不剩，说明没有内置兜底清单 */
fs.writeFileSync(path.join(tmp, 'cordis.patch.yml'), '- id: agent-default-model\n  config: {}\n', 'utf8')
const empty = buildCatalog()
ok(empty.models.length === 0, '配置里没 provider 时清单真的为空（无内置清单兜底）', 'got ' + empty.models.length)

fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n========================================')
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL')
console.log('========================================')
process.exit(fail ? 1 : 0)
