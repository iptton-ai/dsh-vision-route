// dsh-vision-route — 把多模态模型封装成一个工具,主会话永远留在纯文本模型上。
//
// v3(配置面):多模态路由不再写死 —— 配置进 settings 服务(namespace
// vision-route),设置页「插件 → 可配置」卡片下拉选择已注册 provider 里的
// 模型(用户自己要知道哪个真正支持多模态;卡片按目录声明给「图片」提示,
// 目录可能撒谎,仅作参考)。解析顺序:
//   schema 默认 < 行 config(profile cordis.patch.yml;0.1.7 起 settings.yaml
//   已迁入 profile 行,设置页卡片写 profile 行,经 volatile-update 热生效)。
// scope.get() 每次请求时读取,用户改设置即刻生效,无需重启。
//
// 机制(v2 起):glm-5.3 全程主持会话,图片字节永远不进它的请求。
//   - llm/stream 中间件:凡发往 textRoutes 的请求(agent loop、compaction
//     摘要、标题生成一律),把消息树里的 image 块(含 tool-result 嵌套)替换
//     成占位文本(含 attachmentId),再以同一配置发起嵌套流式调用。
//   - vision 工具:模型按需调用,拿 attachmentId/path/url 解析出持久附件,
//     单独发给多模态路由,文字回答作为 tool-result 塞回会话。
//
// 卡片 API(同源,/vision-route/api/*):
//   GET  /catalog  已注册 provider + 各自模型目录(listProviders/listModels)
//   GET  /config   解析值 + 用户层(哪些字段被覆盖)
//   POST /config   保存 patch;值为 null 表示重置该字段(恢复继承)
//   DELETE /config 整体重置用户层
//   写操作按 Sec-Fetch-Site/Origin 拒跨源(与 dsh-term/grok-media 同款)。
//
// 前提(三件套之一):settings.yaml 给文本模型声明 image 输入
//   (modelOverrides.<id>.input: [text, image])—— 白谎只为准入三道门
//   (prompt 准入 / read_image / selectModel)放行;本中间件保证图片字节
//   依然到不了文本模型。若撤掉本插件,记得同步撤掉白谎,否则图会真的发给
//   纯文本模型而被网关拒绝。
//
// 仅图片:附件层 v1 只有 PNG/JPEG/WebP/GIF;视频无内容块契约,须等上游。

import { readFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
const name = 'vision-route'

/** Services this plugin cannot work without. */
const inject = ['llm', 'attachments', 'tools', 'settings', 'webServer']

const NS = 'vision-route'
const ROOT = '/vision-route/api'

const DEFAULTS = {
	visionProvider: 'zai-coding-cn',
	visionModel: 'glm-5v-turbo',
	textRoutes: ['zai-coding-cn/glm-5.3'],
	maxTokens: 2048,
	defaultQuestion: '详细描述这张图片的内容。'
}

/** 插件 Config schema:字段说明随 schema.toJSON() 下发到配置界面。
 * 0.1.7-alpha.2:字段须 .volatile() 才会进入 SettingsForms 表单,
 * 且 settings 服务的 describe/update/replace 只接受 volatile 字段。 */
const Config = z.object({
	visionProvider: z.string().volatile().default(DEFAULTS.visionProvider)
		.description('多模态模型的 provider(须是已配置的路由,如 zai-coding-cn)'),
	visionModel: z.string().volatile().default(DEFAULTS.visionModel)
		.description('多模态模型 id(用户须自行确认它真的支持图片输入,如 glm-5v-turbo)'),
	textRoutes: z.array(z.string()).volatile().default(DEFAULTS.textRoutes)
		.description('剥离图片的纯文本路由列表,条目形如 "provider/model"'),
	maxTokens: z.number().step(1).min(1).volatile().default(DEFAULTS.maxTokens)
		.description('vision 调用的输出 token 上限'),
	defaultQuestion: z.string().volatile().default(DEFAULTS.defaultQuestion)
		.description('模型调用 vision 工具但未给问题时使用的缺省提问')
})

/** 跨字段校验(旧 settings.register 的 validate 语义,改在写路径手动执行)。 */
const validateConfig = v => {
	if (!ROUTE_KEY.test(`${v.visionProvider}/${v.visionModel}`)) {
		throw new Error(`vision-route: visionProvider/visionModel "${v.visionProvider}/${v.visionModel}" 不是合法的 provider/model 组合`)
	}
	for (const route of v.textRoutes ?? []) {
		if (!ROUTE_KEY.test(route)) throw new Error(`vision-route: textRoutes 条目 "${route}" 必须形如 "provider/model"`)
	}
	if ((v.textRoutes ?? []).includes(`${v.visionProvider}/${v.visionModel}`)) {
		throw new Error(`vision-route: vision 路由 ${v.visionProvider}/${v.visionModel} 不得出现在 textRoutes 里(它要收图,不能被剥离)`)
	}
}

/** "provider/model" 路由键形状:首段斜杠前是 provider(无空白/斜杠),其余整体是 model —— 模型 id 可自带斜杠(如 nvidia 的 z-ai/glm-5.2)。 */
const ROUTE_KEY = /^[^\s/]+\/[\w./-]+$/

/** Placeholder text substituting one stripped image block. */
function imagePlaceholder(ref, model) {
	const meta = `${ref.mediaType}, ${ref.width}x${ref.height}${ref.name ? `, "${ref.name}"` : ''}`
	return `[An image (${meta}) was attached here, but its bytes are not sent to the text-only model ${model}. ` +
		`To see it, call the vision tool with attachmentId "${String(ref.attachmentId)}" and a focused question.]`
}

/** Replace image blocks (recursing through tool-result) with placeholder text. Returns the original array when nothing changed. */
function stripBlocks(blocks, model) {
	let changed = false
	const out = []
	for (const block of blocks) {
		if (block.type === 'image') {
			out.push({ type: 'text', text: imagePlaceholder(block.attachment, model) })
			changed = true
			continue
		}
		if (block.type === 'tool-result') {
			const inner = stripBlocks(block.content, model)
			if (inner !== block.content) {
				out.push({ ...block, content: inner })
				changed = true
				continue
			}
		}
		out.push(block)
	}
	return changed ? out : blocks
}

/** Shallow message copy with stripped content, or the original message. */
function stripMessage(message, model) {
	const content = stripBlocks(message.content ?? [], model)
	return content === message.content ? message : { ...message, content }
}

/** Sniff the four v1 media types from magic bytes, falling back to the extension. */
function sniffMediaType(buf, pathHint) {
	const ascii = (start, end) => buf.toString('latin1', start, end)
	if (buf.length >= 8 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
	if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
	if (buf.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
	const ext = (pathHint.split('.').pop() ?? '').toLowerCase()
	return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext]
}

/** Walk content blocks for the image ref matching one opaque attachment id. */
function findRefInBlocks(blocks, id) {
	for (const block of blocks) {
		if (block.type === 'image' && String(block.attachment.attachmentId) === id) return block.attachment
		if (block.type === 'tool-result') {
			const found = findRefInBlocks(block.content, id)
			if (found !== undefined) return found
		}
	}
	return undefined
}

/** Resolve one attachment id against the agent's model-visible surface (inbox + history). */
function refForAttachmentId(agent, id) {
	const surface = [
		...(agent?.inbox?.nextTurn ?? []),
		...(agent?.inbox?.nextStep ?? []),
		...(agent?.session?.deriveMessages?.() ?? [])
	]
	for (const message of surface) {
		const found = findRefInBlocks(message.content ?? [], id)
		if (found !== undefined) return found
	}
	return undefined
}

/** One auxiliary vision-model call: image + question in, text out. */
async function askVisionModel(llm, vision, maxTokens, ref, question, signal) {
	const content = [
		{ type: 'image', attachment: ref },
		{ type: 'text', text: question }
	]
	const messages = [createUserMessage({ content, source: { kind: 'user' } })]
	let text = ''
	let failure
	for await (const chunk of llm.stream({
		provider: vision.provider,
		model: vision.model,
		messages,
		maxTokens,
		...(signal === undefined ? {} : { signal })
	})) {
		if (chunk.type === 'text-delta') text += chunk.text
		else if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') failure = chunk.reason
	}
	if (failure !== undefined) {
		const detail = JSON.stringify(failure.failure ?? failure.kind)
		throw new Error(`vision-route: vision model ${vision.provider}/${vision.model} failed: ${detail}`)
	}
	const trimmed = text.trim()
	if (trimmed === '') throw new Error('vision-route: vision model returned no text')
	return trimmed
}

const read = req => new Promise(resolve => {
	const chunks = []
	req.on('data', c => chunks.push(c))
	req.on('end', () => {
		try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')) } catch { resolve(null) }
	})
})

const send = (res, status, value) => {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(value))
}

/** 同源校验:写操作拒绝跨源(读设置页与宿主同源,照搬 dsh-term/grok-media)。 */
const sameOrigin = req => {
	const site = req.headers['sec-fetch-site']
	if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
	const origin = req.headers.origin
	if (origin === undefined) return true
	try { return new URL(origin).host === req.headers.host } catch { return false }
}

function apply(ctx, config) {
	// ── 配置:0.1.7 契约(样板 dsh-grok-media)──
	// settings.register(ns, schema, {base, validate}) 已被移除:config 是
	// loader 解析后的 Volatile 投影(字段带 .get() 活值,profile 行 config
	// 编辑后即时生效),经 live() 解包;行 id 即 settings 表单命名空间,
	// 读写走 ctx.settings.describe()/update()/replace(),validate 语义在
	// 写路径手动执行(见 validateConfig)。scope shim 保持内部调用面不变。
	const live = v => (v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
	const scope = {
		get: () => ({
			visionProvider: String(live(config?.visionProvider) ?? DEFAULTS.visionProvider),
			visionModel: String(live(config?.visionModel) ?? DEFAULTS.visionModel),
			textRoutes: (Array.isArray(live(config?.textRoutes)) ? live(config.textRoutes).map(String)
				: DEFAULTS.textRoutes),
			maxTokens: Number(live(config?.maxTokens) ?? DEFAULTS.maxTokens),
			defaultQuestion: String(live(config?.defaultQuestion) ?? DEFAULTS.defaultQuestion),
		}),
		async update(patch) { await ctx.settings.update(NS, patch) },
		async replace(section) { await ctx.settings.replace(NS, section) },
	}

	/** 每次请求时读取的解析值(schema 默认 < 行 config < 用户层),改设置即刻生效。 */
	const current = () => scope.get()
	const visionOf = v => ({ provider: v.visionProvider, model: v.visionModel })

	// ── 卡片 API ──
	const configView = async () => {
		const descriptor = ctx.settings.describe().find(d => d.ns === NS)
		const user = descriptor?.user ?? null
		// value = 活配置 ∪ 用户层(用户层键优先)。正常态活配置已含用户层
		//(volatile-update 热同步),并集只为写后响应即时可见,不依赖事件时序。
		return { value: { ...current(), ...(user ?? {}) }, user, base: descriptor?.base ?? null }
	}

	/** 已注册 provider + 各自模型目录(inputModalities 含 image 的标 image:true)。 */
	const catalog = async () => {
		const providers = ctx.llm.listProviders()
		const lists = await Promise.all(providers.map(p =>
			ctx.llm.listModels(p.id).then(models => ({ ...p, models }), () => ({ ...p, models: [] }))
		))
		return {
			providers: lists.map(p => ({
				id: p.id,
				name: p.name,
				models: p.models.map(m => ({
					id: m.id,
					name: m.name,
					image: m.inputModalities?.includes('image') === true
				}))
			}))
		}
	}

	const route = {
		kind: 'prefix',
		path: ROOT,
		handler: async (req, res) => {
			const u = new URL(req.url, 'http://x')
			const p = u.pathname.slice(ROOT.length)

			if (p === '/catalog' && req.method === 'GET') {
				return send(res, 200, await catalog())
			}
			if (p === '/config' && req.method === 'GET') {
				return send(res, 200, await configView())
			}
			if (p === '/config' && req.method === 'POST') {
				if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request rejected' })
				const body = await read(req)
				if (!body || typeof body !== 'object') return send(res, 400, { error: '请求体必须是 JSON 对象' })
				try {
					// 值为 null 表示从用户层删除该键(字段重置,恢复继承默认);
					// 其余键合并进用户层。
					const nullKeys = Object.keys(body).filter(k => body[k] === null)
					const view = await configView()
					const user = { ...(view.user ?? {}) }
					for (const k of nullKeys) delete user[k]
					for (const [k, v] of Object.entries(body)) {
						if (v !== null && v !== undefined) user[k] = v
					}
					// 跨字段校验(旧 register validate 语义):跑在合成值上
					//(schema 默认 + 行 config + 本次写后的用户层)。
					validateConfig({ ...scope.get(), ...user })
					if (nullKeys.length > 0) {
						await scope.replace(user)
					} else {
						await scope.update(body)
					}
				} catch (e) {
					return send(res, 400, { error: e && e.message ? e.message : String(e) })
				}
				return send(res, 200, await configView())
			}
			if (p === '/config' && req.method === 'DELETE') {
				if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request rejected' })
				await scope.replace({})
				return send(res, 200, await configView())
			}
			res.writeHead(404)
			res.end()
		}
	}
	const disposers = [ctx.webServer.register(route)]
	ctx.effect(() => () => {
		for (const d of disposers) {
			try { d() } catch { /* noop */ }
		}
		disposers.length = 0
	}, 'dsh-vision-route: route cleanup')

	// ── 1) 剥离中间件:发往文本路由的请求,图 → 占位文本 ──
	// 监听器必须同步返回 AsyncIterable(waterfall 契约):外层 session-checkpoint-policy
	// 用 yield* next() 消费返回值,声明成 async 会把返回包成 Promise,整轮直接报
	// "yield* ... is not async iterable"(文本请求同样炸,与图片无关)。
	ctx.on('llm/stream', (options, next) => {
		const key = `${options.provider}/${options.model}`
		if (!current().textRoutes.includes(key)) return next()
		const messages = options.messages
		if (!Array.isArray(messages) || !messages.some((m) => contentHasImage(m.content))) return next()
		const stripped = messages.map((m) => stripMessage(m, options.model))
		ctx.logger.info(`vision-route: stripped images from ${key} request (${messages.length} messages inspected)`)
		return ctx.llm.stream({ ...options, messages: stripped })
	})

	// ── 2) vision 工具:模型按需取图问多模态模型 ──
	disposers.push(ctx.tools.register(defineTool({
		name: 'vision',
		description: 'Inspect one image with a multimodal vision model and get a textual description. '
			+ 'Use this whenever an image placeholder in the conversation says its bytes are not sent to you, '
			+ 'or whenever you need to understand any local image file or image URL. '
			+ 'Identify the image by attachmentId (from the placeholder text or a read_image result), '
			+ 'by local file path, or by URL — exactly one of the three. '
			+ 'The question should be focused and carry any context the conversation gives, '
			+ 'because it is the ONLY text the vision model sees. '
			+ 'Returns the vision model\'s answer as plain text.',
		parameters: {
			attachmentId: {
				type: 'string',
				description: 'Attachment id shown in image placeholders or read_image results. Preferred when the image is already in this conversation.'
			},
			path: {
				type: 'string',
				description: 'Local image file path (png/jpg/webp/gif), when the image is not yet in the conversation.'
			},
			url: {
				type: 'string',
				description: 'Image URL (http/https), when the image lives on the web.'
			},
			question: {
				type: 'string',
				description: 'What to answer about the image, with conversation context when relevant. Defaults to a full description.'
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					visionModel: { type: 'string', required: true, description: 'The multimodal model that answered.' },
					question: { type: 'string', required: true, description: 'The question the vision model was asked.' },
					answer: { type: 'string', required: true, description: 'The vision model\'s textual answer.' }
				}
			},
			render: (args, value) => [{
				type: 'text',
				text: `vision (${value?.visionModel ?? ''}) answered ${value?.question ? `"${String(value.question).slice(0, 200)}"` : ''}:\n${String(value?.answer ?? '').slice(0, 4000)}`
			}]
		},
		async execute(args, exec) {
			const v = current()
			const vision = visionOf(v)
			const given = ['attachmentId', 'path', 'url'].filter((k) => typeof args[k] === 'string' && args[k] !== '')
			if (given.length !== 1) throw new Error(`vision-route: provide exactly one of attachmentId / path / url (got: ${given.join(', ') || 'none'})`)
			const question = (typeof args.question === 'string' && args.question.trim() !== '') ? args.question.trim() : v.defaultQuestion

			let ref
			if (given[0] === 'attachmentId') {
				ref = refForAttachmentId(exec?.agent, args.attachmentId)
				if (ref === undefined) throw new Error(`vision-route: no image with attachmentId "${args.attachmentId}" in this conversation; check the id or use path/url instead`)
			} else if (given[0] === 'path') {
				const buf = await readFile(args.path)
				const mediaType = sniffMediaType(buf, args.path)
				if (mediaType === undefined) throw new Error(`vision-route: cannot determine image type of "${args.path}" (want png/jpg/webp/gif)`)
				ref = await ctx.attachments.saveImage({ data: buf, mediaType, name: args.path.split('/').pop() })
			} else {
				const res = await fetch(args.url)
				if (!res.ok) throw new Error(`vision-route: fetching "${args.url}" failed: HTTP ${res.status}`)
				const buf = new Uint8Array(await res.arrayBuffer())
				const mediaType = sniffMediaType(buf, args.url)
				if (mediaType === undefined) throw new Error(`vision-route: "${args.url}" is not a recognized png/jpg/webp/gif image`)
				ref = await ctx.attachments.saveImage({ data: buf, mediaType, name: args.url.split('/').pop().split('?')[0] })
			}

			const answer = await askVisionModel(ctx.llm, vision, v.maxTokens, ref, question, exec?.signal)
			return { visionModel: vision.model, question, answer }
		}
	})))
}

export { Config, apply, inject, name }
