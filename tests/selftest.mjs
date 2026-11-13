/**
 * 宿主侧自检：不依赖 DSH 进程，直接跑真实逻辑
 *   node tests/selftest.mjs            # 只查配置解析（不发网络请求）
 *   node tests/selftest.mjs --net      # 额外真发一次请求
 */
import {
  findProfileDir, buildCatalog, materialize, probeOne, miniYaml, STATE_FILE,
} from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

section('1. 最小 YAML 解析')
{
  const y = miniYaml([
    '- id: agent-default-model',
    '  config:',
    '    provider: alpha',
    '    model: demo/chat-flash',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      alpha:',
    '        displayName: Alpha-Free',
    '        baseURL: https://api.alpha.example/v1',
    '        apiKeyEnv: ALPHA_API_KEY',
    '        models:',
    '          - id: demo-flash',
    '            name: demo-flash-Free',
  ].join('\n'))
  ok(Array.isArray(y) && y.length === 2, '顶层是含 2 个条目的数组', JSON.stringify(y && y.length))
  ok(y && y[0].config.provider === 'alpha', 'agent-default-model.provider = alpha')
  ok(y && y[1].config.providers.alpha.displayName === 'Alpha-Free', 'providers.alpha.displayName')
  const models = y && y[1].config.providers.alpha.models
  ok(Array.isArray(models) && models[0].id === 'demo-flash', 'models[0].id 解析正确')
  ok(y && y[1].config.providers.alpha.baseURL === 'https://api.alpha.example/v1', 'baseURL 未被注释符污染')
}

section('2. profile 与模型清单')
const catalog = buildCatalog()
ok(!!catalog.profileDir, '找到 profile 目录', String(catalog.profileDir))
ok(Array.isArray(catalog.models) && catalog.models.length > 0, '解析出模型', 'count=' + (catalog.models || []).length)
console.log('   profile     : ' + catalog.profileDir)
console.log('   credentials : ' + catalog.credentialsFile)
console.log('   默认模型    : ' + JSON.stringify(catalog.defaults))
console.log('   模型清单    : ' + catalog.models.map((m) => m.providerName + '/' + m.model + (m.isDefault ? '★' : '') + (m.hasKey ? '' : '(无key)')).join(', '))
console.log('   当前激活    : ' + JSON.stringify(catalog.selected))
ok(catalog.models.filter((m) => m.isDefault).length === 1, '恰好一个默认模型')
ok(catalog.selected.length >= 1, '有激活项')
ok(catalog.models.every((m) => typeof m.id === 'string' && m.id.indexOf('::') > 0), 'id 形如 provider::model')
ok(catalog.models.filter((m) => m.hasKey).length >= 1, '至少一个模型能取到密钥')

section('3. 取密钥')
{
  const target = materialize(catalog, catalog.models[0].id)
  ok(!!target, 'materialize 返回目标')
  ok(!!target && target.baseURL.length > 0, 'target.baseURL 非空')
  const keyed = catalog.models.map((m) => materialize(catalog, m.id)).filter((t) => t && t.apiKey)
  ok(keyed.length >= 1, '至少一个模型带 apiKey（内存中）', 'count=' + keyed.length)
}

section('4. 状态文件路径')
ok(STATE_FILE.endsWith('dsh-conn-check.json'), 'STATE_FILE 指向 dsh-conn-check.json', STATE_FILE)

if (process.argv.includes('--net')) {
  section('5. 真发一次请求（--net）')
  const pick = catalog.models.find((m) => m.isDefault) || catalog.models[0]
  const target = materialize(catalog, pick.id)
  console.log('   目标: ' + target.id + ' @ ' + target.baseURL)
  const t0 = Date.now()
  const r = await probeOne(target)
  console.log('   结果: ' + JSON.stringify(r))
  ok(typeof r.ms === 'number' && r.ms >= 0, '返回耗时字段')
  ok(r.ok === true || r.ok === false, '返回 ok 布尔值')
  ok(Date.now() - t0 < 25000, '在超时上限内返回')
}

console.log('\n========================================')
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL')
console.log('========================================')
process.exit(fail ? 1 : 0)
