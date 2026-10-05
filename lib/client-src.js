// dsh-vision-route client — 浏览器半边源码(scripts/build-client.mjs 打进 lib/client.js)。
// 唯一贡献:设置页「插件 → 可配置」的配置卡片(settings.plugin.item keyed slot)。
// 卡片读写走本插件自己的同源 API(/vision-route/api/config、/catalog):
// provider/model 是下拉框,选项来自已注册 LLM 路由的目录;「图片」标记来自
// 目录声明的 inputModalities(可能与实际不符 —— 白谎的 glm-5.3 也会带标记,
// 用户自行确认哪个真正支持多模态)。textRoutes/maxTokens/defaultQuestion 为
// 普通输入框。每字段支持重置(null = 恢复继承:行 config 或 schema 默认)。
// 卡片 DOM 与样式镜像内置卡(PluginCard/fields),走 --dsh-* 设计令牌。

const API = '/vision-route/api'

const SCHEMA_DEFAULTS = {
  visionProvider: 'zai-coding-cn',
  visionModel: 'glm-5v-turbo',
  textRoutes: ['zai-coding-cn/glm-5.3'],
  maxTokens: 2048,
  defaultQuestion: '详细描述这张图片的内容。',
}

// provider/model 复合键:模型 id 可自带斜杠(nvidia 的 z-ai/glm-5.2),首段之后整体算 model。
const ROUTE_KEY = /^[^\s/]+\/[\w./-]+$/

const CSS = `
.dshvrc-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; }
.dshvrc-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshvrc-card[data-open="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dshvrc-header { width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; }
.dshvrc-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshvrc-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dshvrc-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dshvrc-desc { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshvrc-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; display: inline-block; }
.dshvrc-chevron[data-open="true"] { transform: rotate(180deg); }
.dshvrc-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dshvrc-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dshvrc-field + .dshvrc-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshvrc-head { display: flex; align-items: center; gap: 8px; }
.dshvrc-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dshvrc-badges { display: inline-flex; align-items: center; gap: 8px; }
.dshvrc-badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; white-space: nowrap; font-weight: 500; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dshvrc-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshvrc-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshvrc-reset:disabled { cursor: default; }
.dshvrc-input, .dshvrc-select { height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); width: 100%; box-sizing: border-box; }
.dshvrc-select { appearance: auto; padding-right: 4px; }
.dshvrc-input:focus-visible, .dshvrc-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dshvrc-input:disabled, .dshvrc-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshvrc-input-invalid { border-color: var(--dsw-alias-label-error); }
.dshvrc-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshvrc-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.dshvrc-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshvrc-status { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshvrc-status-err { color: var(--dsw-alias-label-error); }
.dshvrc-discard, .dshvrc-save { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.dshvrc-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dshvrc-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshvrc-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshvrc-discard:disabled, .dshvrc-save:disabled { opacity: 0.4; cursor: default; }
.dshvrc-discard:focus-visible, .dshvrc-save:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
`

let stylesInjected = false
const injectStyles = () => {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const el = document.createElement('style')
  el.textContent = CSS
  document.head.append(el)
}

const fetchJson = url => fetch(url, { headers: { accept: 'application/json' } })
  .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`))))

/** draft:五字段的可编辑形态(textRoutes 拍平成逗号串,maxTokens 转字符串)。 */
const draftOf = value => ({
  visionProvider: String(value.visionProvider ?? ''),
  visionModel: String(value.visionModel ?? ''),
  textRoutes: (Array.isArray(value.textRoutes) ? value.textRoutes : []).join(', '),
  maxTokens: String(value.maxTokens ?? ''),
  defaultQuestion: String(value.defaultQuestion ?? ''),
})

/** 字段的继承值(行 config base 层,或 schema 默认)。 */
const inheritedOf = (base, key) => {
  const b = base && base[key] !== undefined ? base[key] : SCHEMA_DEFAULTS[key]
  return key === 'textRoutes' ? (Array.isArray(b) ? b : []).join(', ') : String(b ?? '')
}

/** 校验 draft,返回 { body } 或 { error }。 */
const buildPayload = (draft, value, user, base) => {
  const body = {}
  if (draft.visionProvider !== value.visionProvider) body.visionProvider = draft.visionProvider.trim()
  if (draft.visionModel !== value.visionModel) body.visionModel = draft.visionModel.trim()
  const routesStr = draft.textRoutes
  if (routesStr !== (Array.isArray(value.textRoutes) ? value.textRoutes : []).join(', ')) {
    const routes = routesStr.split(',').map(s => s.trim()).filter(s => s !== '')
    for (const r of routes) {
      if (!ROUTE_KEY.test(r)) return { error: `剥离路由 "${r}" 必须形如 "provider/model"` }
    }
    body.textRoutes = routes
  }
  if (draft.maxTokens !== String(value.maxTokens)) {
    const n = Number(draft.maxTokens)
    if (!Number.isInteger(n) || n < 1) return { error: 'vision 输出上限必须是 ≥1 的整数' }
    body.maxTokens = n
  }
  if (draft.defaultQuestion !== value.defaultQuestion) body.defaultQuestion = draft.defaultQuestion
  // 用户层已覆盖、且新值回到了继承值(行 config base 层或 schema 默认)
  // → 发 null 抹掉用户层键(下轮解析回到继承,「已覆盖」徽标消失)。
  const inherited = k => (base && base[k] !== undefined ? base[k] : SCHEMA_DEFAULTS[k])
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const k of Object.keys(user ?? {})) {
    if (body[k] !== undefined && same(body[k], inherited(k))) body[k] = null
  }
  return { body }
}

const FieldHead = (label, overridden, onReset, disabled) => React.createElement('div', { className: 'dshvrc-head' },
  React.createElement('span', { className: 'dshvrc-label' }, label),
  overridden ? React.createElement('span', { className: 'dshvrc-badges' },
    React.createElement('span', { key: 'b', className: 'dshvrc-badge' }, '已覆盖'),
    React.createElement('button', { key: 'r', type: 'button', className: 'dshvrc-reset', disabled, onClick: onReset }, '重置')) : null)

function Field({ label, hint, overridden, disabled, onReset, invalid }, control) {
  return React.createElement('div', { className: 'dshvrc-field' },
    FieldHead(label, overridden, onReset, disabled),
    control,
    invalid !== undefined
      ? React.createElement('p', { className: 'dshvrc-invalid' }, invalid)
      : React.createElement('p', { className: 'dshvrc-hint' }, hint))
}

function VisionSettingsCard() {
  const [open, setOpen] = React.useState(false)
  const [loaded, setLoaded] = React.useState(null) // {value,user,base,catalog,catalogError}
  const [draft, setDraft] = React.useState(null)
  const [status, setStatus] = React.useState('')
  const [err, setErr] = React.useState('')

  const load = React.useCallback(() => Promise.all([fetchJson(`${API}/config`), fetchJson(`${API}/catalog`).catch(e => Promise.resolve(null))])
    .then(([config, catalog]) => {
      setLoaded({ ...config, catalog, catalogError: catalog === null })
      setDraft(draftOf(config.value))
      setErr('')
      setStatus('')
    })
    .catch(e => { setErr(`加载失败: ${e.message}`) }), [])

  React.useEffect(() => { if (open && loaded === null) load() }, [open, loaded, load])

  if (loaded === null || draft === null) {
    return React.createElement('li', { className: 'dshvrc-card' },
      React.createElement('button', { type: 'button', className: 'dshvrc-header', onClick: () => setOpen(!open) },
        React.createElement('span', { className: 'dshvrc-headtext' },
          React.createElement('span', { className: 'dshvrc-name' }, '视觉路由 vision-route'),
          React.createElement('span', { className: 'dshvrc-desc' }, '带图请求剥离 + vision 工具:纯文本主模型 + 可配置多模态路由')),
        React.createElement('span', { className: 'dshvrc-chevron', 'data-open': String(open) }, '▾')),
      open ? React.createElement('div', { className: 'dshvrc-body' },
        React.createElement('p', { className: err ? 'dshvrc-invalid' : 'dshvrc-hint' }, err || '加载中…')) : null)
  }

  const { value, user, base, catalog } = loaded
  const overridden = k => Boolean(user && user[k] !== undefined)
  const reset = k => setDraft(d => ({ ...d, [k]: inheritedOf(base, k) }))
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }))
  const disabled = status === 'saving…'

  const providers = catalog?.providers ?? []
  const providerEntry = providers.find(p => p.id === draft.visionProvider)
  const models = providerEntry?.models ?? []

  const save = async () => {
    setErr(''); setStatus('saving…')
    const { body, error } = buildPayload(draft, value, user, base)
    if (error) { setErr(error); setStatus(''); return }
    try {
      const res = await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setLoaded(st => ({ ...st, ...data }))
      setDraft(draftOf(data.value))
      setStatus('已保存')
    } catch (e) { setErr(`保存失败: ${e.message}`); setStatus('') }
  }

  const discard = () => { setDraft(draftOf(value)); setErr(''); setStatus('') }

  const providerControl = providers.length > 0
    ? React.createElement('select', {
        className: 'dshvrc-select', value: draft.visionProvider, disabled,
        onChange: e => set('visionProvider', e.target.value),
      },
      // 当前值不在目录里也保留为选项,避免静默改值。
      providers.some(p => p.id === draft.visionProvider) ? null
        : React.createElement('option', { key: 'current', value: draft.visionProvider }, `${draft.visionProvider}(不在已注册路由中)`),
      providers.map(p => React.createElement('option', { key: p.id, value: p.id }, `${p.name} (${p.id})`)))
    : React.createElement('input', {
        className: 'dshvrc-input', value: draft.visionProvider, disabled,
        onChange: e => set('visionProvider', e.target.value) })

  const modelControl = providers.length > 0
    ? React.createElement('select', {
        className: 'dshvrc-select', value: draft.visionModel, disabled,
        onChange: e => set('visionModel', e.target.value),
      },
      models.some(m => m.id === draft.visionModel) ? null
        : React.createElement('option', { key: 'current', value: draft.visionModel }, `${draft.visionModel}(当前值)`),
      models.map(m => React.createElement('option', { key: m.id, value: m.id },
        `${m.name} (${m.id})${m.image ? ' ·图片' : ''}`)))
    : React.createElement('input', {
        className: 'dshvrc-input', value: draft.visionModel, disabled,
        onChange: e => set('visionModel', e.target.value) })

  return React.createElement('li', { className: 'dshvrc-card', 'data-open': String(open) },
    React.createElement('button', { type: 'button', className: 'dshvrc-header', onClick: () => setOpen(!open) },
      React.createElement('span', { className: 'dshvrc-headtext' },
        React.createElement('span', { className: 'dshvrc-name' }, '视觉路由 vision-route'),
        React.createElement('span', { className: 'dshvrc-desc' },
          `vision 工具走 ${value.visionProvider}/${value.visionModel} · 剥离 ${Array.isArray(value.textRoutes) ? value.textRoutes.join(', ') : ''}`)),
      React.createElement('span', { className: 'dshvrc-chevron', 'data-open': String(open) }, '▾')),
    open ? React.createElement('div', { className: 'dshvrc-body' },
      Field({
        label: '多模态 provider', key: 'fp',
        hint: '已配置的 LLM 路由;没有已注册路由时退化为手填。',
        overridden: overridden('visionProvider'), disabled,
        onReset: () => reset('visionProvider'),
      }, providerControl),
      Field({
        label: '多模态模型', key: 'fm',
        hint: loaded.catalogError
          ? '模型目录不可用,手填模型 id。'
          : '「·图片」= 目录声明支持图片输入(声明可能与实际不符,请自行确认哪个真正多模态)。',
        overridden: overridden('visionModel'), disabled,
        onReset: () => reset('visionModel'),
      }, modelControl),
      Field({
        label: '剥离图片的文本路由', key: 'tr',
        hint: '发往这些路由的请求会把图换成占位符;条目形如 "provider/model",逗号分隔。',
        overridden: overridden('textRoutes'), disabled,
        onReset: () => reset('textRoutes'),
      }, React.createElement('input', {
        className: 'dshvrc-input' + (draft.textRoutes.split(',').map(s => s.trim()).filter(s => s !== '').some(r => !ROUTE_KEY.test(r)) ? ' dshvrc-input-invalid' : ''),
        value: draft.textRoutes, disabled,
        onChange: e => set('textRoutes', e.target.value) })),
      Field({
        label: 'vision 输出上限 (tokens)', key: 'mt',
        hint: '一次 vision 调用的最大输出 token 数。',
        overridden: overridden('maxTokens'), disabled,
        onReset: () => reset('maxTokens'),
      }, React.createElement('input', {
        className: 'dshvrc-input' + (/^\d+$/.test(draft.maxTokens) ? '' : ' dshvrc-input-invalid'),
        value: draft.maxTokens, disabled, inputMode: 'numeric',
        onChange: e => set('maxTokens', e.target.value) })),
      Field({
        label: '缺省提问', key: 'dq',
        hint: '模型调 vision 工具但没给问题时使用的提问。',
        overridden: overridden('defaultQuestion'), disabled,
        onReset: () => reset('defaultQuestion'),
      }, React.createElement('input', {
        className: 'dshvrc-input', value: draft.defaultQuestion, disabled,
        onChange: e => set('defaultQuestion', e.target.value) })),
      React.createElement('div', { className: 'dshvrc-footer' },
        React.createElement('p', { className: err ? 'dshvrc-status dshvrc-status-err' : 'dshvrc-status' }, err || status),
        React.createElement('button', { type: 'button', className: 'dshvrc-discard', disabled, onClick: discard }, '放弃'),
        React.createElement('button', { type: 'button', className: 'dshvrc-save', disabled, onClick: save }, '保存'))) : null)
}

// ── 注册 ─────────────────────────────────────────────────────────────────

function apply(ctx) {
  ctx.effect(() => {
    injectStyles()
    return () => { /* 样式进程级共享,随 HMR 卸载由页面刷新兜底 */ }
  }, 'vision-route: card styles')
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: 'vision-route' },
    VisionSettingsCard,
  )), 'vision-route: settings card')
}

module.exports = { inject: ['slots'], apply }
