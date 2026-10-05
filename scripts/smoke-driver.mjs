// dsh-vision-route 适配冒烟驱动:由 scripts/smoke.mjs 放进临时目录运行
// (同目录须有 lib/index.js 与指向已安装 dsh 依赖闭包的 node_modules 符号链)。
// 用桩服务驱动 apply() 全链路,断言所有上游接触面仍按契约工作。
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(join(here, 'lib', 'index.js'))
const { name, inject, apply, Config } = plugin

// ── 0) 模块面:入口导出形状 ──
assert.equal(name, 'vision-route')
assert.deepEqual(inject, ['llm', 'attachments', 'tools', 'settings', 'webServer'])
console.log('0) exports shape ok:', name, inject)

// ── 1) schemastery 3.18.4(安装版):schema 可解析、默认值生效、未知键被剥。
// 0.1.7 起 volatile 字段解析产物是 Volatile 活值包装({get,[Symbol(write)]}),
// 经 .get() 取值 —— 与宿主 loader 交给 apply() 的 config 形状一致。 ──
const live = v => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
const resolved = Config({})
assert.equal(live(resolved.visionProvider), 'zai-coding-cn')
assert.equal(live(resolved.visionModel), 'glm-5v-turbo')
assert.deepEqual(live(resolved.textRoutes), ['zai-coding-cn/glm-5.3'])
assert.equal(live(resolved.maxTokens), 2048)
assert.equal(live(resolved.defaultQuestion), '详细描述这张图片的内容。')
const resolved2 = Config({ vision: { provider: 'x', model: 'y' }, visionModel: 'glm-5v-plus' })
assert.equal(live(resolved2.visionModel), 'glm-5v-plus') // 旧 v2 键被剥、新键生效
console.log('1) Config schema resolves against installed schemastery ok')

// ── 桩 ctx:settings/tools/webServer/attachments/llm/logger/effect/on ──
let userLayer = {} // 模拟 $DSH_HOME/settings.yaml 用户层
let baseLayer = undefined // 行 config(cordis.patch.yml config:)
let describeCalled = 0
const scopeLog = []
let streamListener = null // 捕获 llm/stream 监听器
let baseStreamCalls = [] // 模拟 waterfall 最底层 adapterStream 收到的 options
const visionCalls = [] // 视觉路由(vision 工具发起)收到的请求
const savedImages = []

const ref = { attachmentId: 'att-abc123', mediaType: 'image/png', width: 800, height: 600, name: 'cat.png' }

const makeCtx = () => ({
	logger: { info () {}, warn () {} },
	effect (fn, label) { assert.equal(typeof label, 'string'); return fn() },
	on (event, fn) { assert.equal(event, 'llm/stream'); streamListener = fn; return () => {} },
	settings: {
		// 0.1.7 桩:describe/update/replace(旧 register scope 桩已废)。
		describe () {
			describeCalled++
			return [{ ns: 'vision-route', value: Config({ ...(baseLayer ?? {}), ...userLayer }), user: { ...userLayer }, base: baseLayer === undefined ? null : baseLayer }]
		},
		async update (ns, patch) {
			assert.equal(ns, 'vision-route')
			userLayer = { ...userLayer, ...patch }
		},
		async replace (ns, section) {
			assert.equal(ns, 'vision-route')
			scopeLog.push(['replace', section])
			userLayer = { ...section }
		}
	},
	webServer: {
		register (route) {
			assert.equal(route.kind, 'prefix')
			assert.equal(route.path, '/vision-route/api')
			routes.push(route)
			return () => routes.splice(routes.indexOf(route), 1)
		}
	},
	tools: {
		register (tool) { registered.push(tool); return () => {} }
	},
	attachments: {
		async saveImage (input) { savedImages.push(input); return { ...ref, ...input.name ? { name: input.name } : {} } }
	},
	llm: {
		listProviders () { return [{ id: 'zai-coding-cn', name: 'ZAI Coding CN' }, { id: 'other', name: 'Other' }] },
		async listModels (provider) {
			assert.equal(typeof provider, 'string')
			return [
				{ provider, id: 'glm-5.3', name: 'GLM 5.3', inputModalities: ['text', 'image'] },
				{ provider, id: 'glm-5v-turbo', name: 'GLM 5V Turbo', inputModalities: ['text', 'image'] }
			]
		},
		stream (options) {
			// 模拟真实 waterfall:llm/stream 监听器先跑,否则进 adapterStream 底座
			if (streamListener !== null && `${options.provider}/${options.model}` === 'zai-coding-cn/glm-5.3') {
				return streamListener(options, () => baseStream(options))
			}
			return baseStream(options)
		}
	}
})

const routes = []
const registered = []
async function* baseStream (options) {
	baseStreamCalls.push(options)
	if (`${options.provider}/${options.model}` === 'zai-coding-cn/glm-5v-turbo') {
		visionCalls.push(options)
		yield { type: 'text-delta', text: '图里是一只橘猫。' }
		yield { type: 'finish', reason: { kind: 'stop' } }
		return
	}
	yield { type: 'text-delta', text: 'ok' }
	yield { type: 'finish', reason: { kind: 'stop' } }
}

// ── 2) apply():settings 注册 + webServer 路由 + 工具注册 + llm/stream 监听 ──
baseLayer = { visionProvider: 'zai-coding-cn', visionModel: 'glm-5v-turbo', textRoutes: ['zai-coding-cn/glm-5.3'] }
apply(makeCtx(), baseLayer)
assert.equal(routes.length, 1)
assert.equal(registered.length, 1)
assert.equal(registered[0].name, 'vision')
assert.ok(streamListener !== null)
assert.equal(typeof registered[0].execute, 'function')
assert.equal(typeof registered[0].parameters.properties, 'object')
assert.equal(typeof registered[0].parameters.properties.attachmentId, 'object')
console.log('2) apply() wiring against installed dsh-tools defineTool ok (tool:', registered[0].name + ')')

// ── 3) llm/stream 中间件:同步返回 AsyncIterable、图被剥、无递归、白名单外直通 ──
const imgMsg = { role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'text', text: '这是什么?' }] }
const ret = streamListener({ provider: 'zai-coding-cn', model: 'glm-5.3', messages: [imgMsg] }, () => { throw new Error('next should not run for textRoute with images') })
assert.ok(!(ret instanceof Promise), 'listener must return synchronously (waterfall contract)')
assert.equal(typeof ret[Symbol.asyncIterator], 'function')
for await (const _ of ret) { void _ } // 消费到底
assert.equal(baseStreamCalls.length, 1)
const strippedMsgs = baseStreamCalls[0].messages
assert.equal(strippedMsgs.length, 1)
assert.equal(strippedMsgs[0].content[0].type, 'text')
assert.match(strippedMsgs[0].content[0].text, /att-abc123/)
assert.match(strippedMsgs[0].content[0].text, /image\/png, 800x600, "cat\.png"/)
assert.doesNotMatch(strippedMsgs[0].content[0].text, /undefined/)
console.log('3a) llm/stream strips image → placeholder (single nested pass, no recursion)')

// 无图请求直通 next()
const passthrough = { provider: 'zai-coding-cn', model: 'glm-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
let nextRan = false
const ret2 = streamListener(passthrough, () => { nextRan = true; return baseStream(passthrough) })
assert.ok(nextRan, 'image-free request on textRoute must pass through next()')
for await (const _ of ret2) { void _ }
// 非白名单路由(视觉路由本身)直通
const ret3 = streamListener({ provider: 'zai-coding-cn', model: 'glm-5v-turbo', messages: [imgMsg] }, () => baseStream({ provider: 'zai-coding-cn', model: 'glm-5v-turbo', messages: [imgMsg] }))
for await (const _ of ret3) { void _ }
assert.equal(baseStreamCalls.length, 3)
assert.deepEqual(baseStreamCalls[2].messages[0].content[0], { type: 'image', attachment: ref }, 'vision route must receive real image bytes')
console.log('3b) pass-through for image-free requests and non-textRoutes ok')

// 3c) 0.1.3-alpha.2 新增 file 内容块:本中间件不碰它。
// 纯 file 请求 → contentHasImage=false → 直通 next(),由 dsh-llm 在装配层
// 无条件把 file 投影成句柄文本;图+file 混合请求 → 只剥图,file 原样透传。
const fileRef = { attachmentId: 'sha256:deadbeefcafe', name: 'report.pdf', bytes: 1234 }
const fileOnly = { role: 'user', content: [{ type: 'file', attachment: fileRef }, { type: 'text', text: '看看这个文件' }] }
let fileNextRan = false
const retF = streamListener({ provider: 'zai-coding-cn', model: 'glm-5.3', messages: [fileOnly] }, () => {
  fileNextRan = true
  return baseStream({ provider: 'zai-coding-cn', model: 'glm-5.3', messages: [fileOnly] })
})
assert.ok(fileNextRan, 'file-only request on a textRoute must pass through next() (upstream projects files itself)')
for await (const _ of retF) { void _ }
const mixed = { role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'file', attachment: fileRef }] }
const beforeMixed = baseStreamCalls.length
const retM = streamListener({ provider: 'zai-coding-cn', model: 'glm-5.3', messages: [mixed] }, () => {
  throw new Error('next should not run for a mixed request: it still carries an image')
})
assert.ok(!(retM instanceof Promise), 'listener must stay synchronous with file blocks present')
for await (const _ of retM) { void _ }
assert.equal(baseStreamCalls.length, beforeMixed + 1)
const mixedContent = baseStreamCalls.at(-1).messages[0].content
assert.equal(mixedContent[0].type, 'text', 'image block stripped from a mixed message')
assert.match(mixedContent[0].text, /att-abc123/)
assert.deepEqual(mixedContent[1], { type: 'file', attachment: fileRef }, 'file block must survive the middleware untouched')
console.log('3c) new file content block: passthrough + preserved beside stripped images ok')

// ── 4) vision 工具:attachmentId / path / url 三图源 + 真实 defineTool 参数校验 ──
const agent = {
	inbox: { nextTurn: [imgMsg], nextStep: [] },
	session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'image', attachment: { ...ref, attachmentId: 'att-nested' } }] }] }] }
}
const tool = registered[0]
const vBefore = visionCalls.length
const r1 = await tool.execute({ attachmentId: 'att-abc123', question: '猫在干什么?' }, { agent, signal: undefined })
assert.equal(r1.visionModel, 'glm-5v-turbo')
assert.equal(r1.question, '猫在干什么?')
assert.match(r1.answer, /橘猫/)
assert.equal(visionCalls.length, vBefore + 1)
const visionReq = visionCalls.at(-1)
assert.equal(visionReq.provider, 'zai-coding-cn')
assert.equal(visionReq.maxTokens, 2048)
const sent = visionReq.messages[0].content
assert.equal(sent[0].type, 'image')
assert.equal(sent[0].attachment.attachmentId, 'att-abc123')
assert.equal(sent[1].type, 'text')
// 嵌套 tool-result 里的附件也能解析
const r1b = await tool.execute({ attachmentId: 'att-nested' }, { agent, signal: undefined })
assert.match(r1b.answer, /橘猫/)
console.log('4a) vision via attachmentId (inbox + nested tool-result) ok')

const pngDir = mkdtempSync(join(tmpdir(), 'dsh-vr-'))
const pngPath = join(pngDir, 'local.png')
writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const r2 = await tool.execute({ path: pngPath }, { agent, signal: undefined })
assert.match(r2.answer, /橘猫/)
assert.equal(savedImages[0].mediaType, 'image/png')
assert.equal(savedImages[0].name, 'local.png')
assert.equal(r2.question, '详细描述这张图片的内容。', 'default question applies')
const origFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })
try {
	const r3 = await tool.execute({ url: 'https://example.com/a.png' }, { agent, signal: undefined })
	assert.match(r3.answer, /橘猫/)
	assert.equal(savedImages[1].name, 'a.png')
} finally { globalThis.fetch = origFetch }
console.log('4b) vision via path (magic-byte sniff) + url ok')
// 参数互斥校验(defineTool 真实校验 + 插件自身校验)
await assert.rejects(() => tool.execute({ attachmentId: 'x', path: '/tmp/x.png' }, { agent, signal: undefined }), /exactly one/)
await assert.rejects(() => tool.execute({ path: '/nonexistent.png' }, { agent, signal: undefined }), /ENOENT|no such file/)
console.log('4c) argument exclusivity + file errors ok')
// 渲染器契约(output.render(args, value) → [{type:'text',text}])
const rendered = tool.output.render({}, r1)
assert.ok(Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.includes('橘猫'))
console.log('4d) output.render contract ok')

// ── 5) 卡片 API:GET/POST/DELETE /config、GET /catalog、跨源 403、404 ──
const handler = routes[0].handler
const serve = (req) => new Promise(resolve => {
	const res = {
		status: 0, body: '',
		writeHead (s) { this.status = s },
		end (b) { this.body = b ?? ''; resolve(this) }
	}
	handler(req, res)
})
const getReq = (path, extra = {}) => ({ method: 'GET', url: path, headers: { host: 'localhost:7777', ...extra } })
const postReq = (path, body, extra = {}) => ({
	method: 'POST', url: path, headers: { host: 'localhost:7777', 'content-type': 'application/json', ...extra },
	on (ev, cb) {
		if (ev === 'data') setImmediate(() => cb(Buffer.from(JSON.stringify(body))))
		if (ev === 'end') setImmediate(() => cb())
		return this
	}
})
const delReq = (path, extra = {}) => ({
	method: 'DELETE', url: path, headers: { host: 'localhost:7777', ...extra },
	on (ev, cb) { if (ev === 'end') setImmediate(() => cb()); return this }
})

let res = await serve(getReq('/vision-route/api/config'))
assert.equal(res.status, 200)
const view0 = JSON.parse(res.body)
assert.equal(view0.value.visionModel, 'glm-5v-turbo')
res = await serve(getReq('/vision-route/api/catalog'))
assert.equal(res.status, 200)
const cat = JSON.parse(res.body)
assert.equal(cat.providers.length, 2)
assert.equal(cat.providers[0].models[0].image, true)
assert.equal(cat.providers[0].models.length, 2)
// 跨源写被拒
res = await serve(postReq('/vision-route/api/config', { maxTokens: 512 }, { origin: 'http://evil.example' }))
assert.equal(res.status, 403)
// 合法写:update + null 重置语义
res = await serve(postReq('/vision-route/api/config', { maxTokens: 512, defaultQuestion: null }))
assert.equal(res.status, 200)
assert.equal(JSON.parse(res.body).value.maxTokens, 512)
assert.equal(JSON.parse(res.body).value.defaultQuestion, '详细描述这张图片的内容。')
assert.ok(!(('defaultQuestion' in JSON.parse(res.body).user)), 'null key resets user layer')
assert.deepEqual(scopeLog.at(-1)[0], 'replace')
// 非法值被拒(validate 逻辑)
res = await serve(postReq('/vision-route/api/config', { visionModel: 'bad model!' }))
assert.equal(res.status, 400)
assert.match(JSON.parse(res.body).error, /不是合法的 provider\/model/)
// DELETE 整体重置
res = await serve(delReq('/vision-route/api/config'))
assert.equal(res.status, 200)
assert.equal(JSON.parse(res.body).value.maxTokens, 2048)
// 404
res = await serve(getReq('/vision-route/api/nope'))
assert.equal(res.status, 404)
console.log('5) card API GET/POST/DELETE + catalog + 403/404/400 ok (describe calls:', describeCalled + ')')

// ── 6) 行 config(base 层)可被 settings.register 接住:换 base 生效 ──
baseLayer = { visionProvider: 'zai-coding-cn', visionModel: 'glm-5v-plus', textRoutes: ['zai-coding-cn/glm-5.3'] }
userLayer = {}
apply(makeCtx(), baseLayer)
const handler6 = routes.at(-1).handler
res = await new Promise(resolve => handler6(getReq('/vision-route/api/config'), {
	status: 0, body: '',
	writeHead (s) { this.status = s },
	end (b) { this.body = b ?? ''; resolve(this) }
}))
assert.equal(res.status, 200)
assert.equal(JSON.parse(res.body).value.visionModel, 'glm-5v-plus')
assert.equal(JSON.parse(res.body).base.visionModel, 'glm-5v-plus')
console.log('6) line-config base layer flows through profile row config ok')

rmSync(pngDir, { recursive: true, force: true })
console.log('\nALL SMOKE CHECKS PASSED against the installed dsh dependency closure (version printed by the orchestrator above)')
