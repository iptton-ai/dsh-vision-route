# dsh-vision-route

把多模态模型封装成一个**工具**:纯文本主力模型(如 `glm-5.3`)全程主持会话,图片字节永远不进它的请求;模型需要看图时自己调用 `vision` 工具,工具单独把图(和模型组织好的问题)发给**可配置的**多模态模型(如 `glm-5v-turbo`),把文字回答作为 tool-result 插回会话。

> v1(整请求改道)已被取代:改道后图会「粘住」会话(后续全部请求都留在视觉模型上);工具化之后会话永远在主力模型上,视觉模型只在被问到时出场一次。

## v0.3:多模态路由可在设置页配置

多模态模型不再写死。配置进 dsh settings 服务(namespace `vision-route`),解析顺序:

```
schema 默认 < 行 config(profile cordis.patch.yml) < 用户层(设置页卡片写入)
```

设置 → 插件 → 可配置 → **视觉路由 vision-route** 卡片:

- **多模态 provider / 多模态模型**:下拉框,选项来自已注册 LLM 路由的实时目录(`listProviders`/`listModels`)。模型带 `·图片` 标记表示**目录声明**支持图片输入 —— 声明可能与实际不符(比如给 glm-5.3 声明了 image 输入的白谎也会带标记),哪个真正多模态由用户自己判断。
- **剥离图片的文本路由**、**vision 输出上限**、**缺省提问**:普通输入框。
- 每字段有「已覆盖」徽标与「重置」链接(null = 抹掉用户层,恢复继承)。
- 改完**保存即生效**,无需重启(每次请求实时读解析值)。

无已注册路由时下拉退化为手填输入框。卡片 API:`GET/POST/DELETE /vision-route/api/config`、`GET /vision-route/api/catalog`(写操作拒跨源)。

## 工作机制(两半配合)

**前提——settings 白谎**:dsh 有三道图片准入门(发送 prompt、`read_image`、切换模型),全部按「当前路由模型是否声明 image 输入」拒绝纯文本模型。所以在 settings.yaml 给主力模型声明 `input: [text, image]` 让图能进会话;真正的安全由下面第 1 半保证。

**1. 剥离中间件(`llm/stream`)**:凡发往 `textRoutes` 的请求——agent loop、compaction 摘要、标题生成一律——把消息树里的 `image` 块(含 tool-result 嵌套)就地替换成占位文本:

```
[An image (image/png, 800x600, "cat.png") was attached here, but its bytes are not
sent to the text-only model glm-5.3. To see it, call the vision tool with
attachmentId "att-abc123" and a focused question.]
```

再以同一配置(保留 system/tools/采样参数)发起嵌套流式调用。替换后的请求不含图,二次穿过本中间件时自然放行,无递归;图片本体留在会话历史与 UI 画廊里。

**2. `vision` 工具**:模型按需调用。三个互斥图源:`attachmentId`(占位符/read_image 输出里有)、`path`(本地文件,魔数嗅探类型后入附件库)、`url`。工具解析出持久附件引用,经 `ctx.llm.stream` 单独发给设置里选的多模态路由,收齐文字回答作为 tool-result 返回。**提问内容由模型自己组织**——可携带会话上下文,比转发用户原文更准。

典型一轮:用户拖图问「这是什么」→ 剥离中间件换成占位符 → glm-5.3 调 `vision(attachmentId, question)` → 多模态模型看图回答 → 描述回到会话 → glm-5.3 综合作答。会话模型自始至终是 glm-5.3。

## 安装(三件套,缺一不可)

```bash
# a. 符号链进 profile
ln -s /Users/zxnap/code/MyWorks/yltech.ai/dsh/dsh-vision-route \
      ~/.dsh/profiles/web/node_modules/dsh-vision-route
```

`~/.dsh/profiles/web/cordis.patch.yml` 的 insert 列表加:

```yaml
- id: vision-route
  name: 'dsh-vision-route'
```

`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.zai-coding-cn.models` 里给 `glm-5.3` 条目加 `input` 行(与 `id`/`name` 并列):

```yaml
        - id: glm-5.3
          name: GLM-5.3
          input: [text, image]
```

> 不要写成同级 `modelOverrides:`。`modelOverrides` 与 `models` 并存时会让整条 `zai-coding-cn` 路由失效(本机 2026-08 事故),白谎必须落在 `models` 条目上。

重启 `dsh web` 生效;此后多模态路由在设置页改。**撤插件时同步撤掉白谎**,否则图会真的发给纯文本模型而被网关拒绝。

## 配置

设置页卡片为准;等价的行 config(cordis.patch.yml,作为 base 层):

```yaml
- id: vision-route
  name: 'dsh-vision-route'
  config:
    visionProvider: zai-coding-cn   # 多模态路由 provider
    visionModel: glm-5v-turbo       # 多模态模型 id(自带斜杠也行,如 z-ai/glm-5.2)
    textRoutes: ['zai-coding-cn/glm-5.3']  # 剥离图片的文本路由
    maxTokens: 2048                 # vision 调用输出上限
    defaultQuestion: 详细描述这张图片的内容。
```

校验:`provider/model` 形状(首段斜杠前是 provider,其余整体是 model);vision 路由不得出现在 textRoutes 里(它要收图,不能被剥离)——违反即拒载/拒存。

## 语义与边界

- **KV cache 友好**:占位文本按附件稳定,请求前缀不因剥离而抖动。
- **辅助调用全覆盖**:compaction 摘要、标题生成若走文本路由,同样被剥离。
- **read_image 仍可用**:白谎使 `read_image` 放行;读出的 ImageBlock 同样被换成占位符,模型再调 `vision` 取描述。
- **手动切到真·多模态模型**:不在 textRoutes 的路由图片原生直达,行为不变。
- **上游运行时投影(既有行为)**:dsh-llm 对 catalog 声明 `inputModalities` 且不含 `image` 的模型,会在 adapter 层自动把请求里的图投影成文本占位符。与本插件不冲突(本中间件在 waterfall 更外层、先剥为敬);但**视觉路由要选 catalog 声明支持图片的模型**,否则图会在上游被投掉、vision 调用变成「盲答」(卡片里的 `·图片` 标记即目录声明)。
- **仅图片(vision 工具)**:vision 工具只收 PNG/JPEG/WebP/GIF。0.1.3-alpha.2 起附件层新增通用 `file` 内容块,但 dsh-llm 在请求装配层对所有路由**无条件**把 `file` 块投影成只读句柄文本(永不进 provider),本中间件不碰它也无需碰它;视频仍无原生内容块契约(视频中抽帧转图片可绕)。
- **path 输入的权限**:vision 工具由宿主进程直接读文件(与 grok-media 等宿主侧工具同权),不走会话沙箱收敛;仅信任本机部署使用。

## 开发

```
npm run build:client   # 编辑 lib/client-src.js 后重打包 lib/client.js
npm test               # 适配冒烟:把 host 半边加载到「已安装 dsh」的依赖闭包上,
                       # 桩服务驱动 apply() 全链路(中间件/工具/卡片 API/配置分层)
                       # 定位闭包:DSH_INSTALL 环境变量 > npm root -g 的 @deepseek-ai/dsh
```

依赖声明(`@deepseek-ai/dsh-*`)按开发适配的版本写(当前 `^0.1.5-rc.1`;0.1.5-alpha.2→rc.1 对本插件接触面复判:**零代码改动**,仅同步版本记录——packages/api RPC schema、`llm/stream` waterfall 中间件、`dsh-tools` defineTool 工具注册、settings 分节、`attachments.saveImage`、`__ModuleLoader__`/`dsh.client` manifest 加载、cordis.patch 清单结构全部未动;base cordis.patch 唯一变更是 agent-default-model 默认值 `deepseek-v4-flash`→`deepseek-flash`(数据非结构,且本机由 settings.yaml 用户层 glm-5.3-flash 覆盖);llm-deepseek 目录新增 `deepseek-flash`(V41-Flash,`inputModalities:['text','image']` + `systemPromptUpdate:'in-history'`)并保留 V4 全系,与「上游运行时投影」既有边界相容,不影响白谎三件套;apps/web 仅测试变更,无 src/协议改动)。历史:0.1.5-alpha.1→alpha.2 复判同样全部无变化或纯增量(`LlmConfigurableProvider.error` 可选诊断字段、pi-ai 适配器 strict/deferred 目录校验、client slot 全体新增可选 `usePanelInfo` hook、`settings.plugin.item` keyed slot 契约逐字未变、`workspace-files` RPC 内部签名重构(`Agent`→header 派生 `WorkspaceFileScope`)但本插件不消费该面、cordis.patch 清单结构与 `__ModuleLoader__`/`dsh.client` manifest 加载未变、三道图片准入门(acp content / session-controller commands / tool-fs read-image)未动故 settings 白谎照旧);0.1.3-alpha.2 适配时接触面亦全为增量(`file` 内容块、`attachment.saveFile/readFileStream/fileHostPath`、`agent/assistant-stream` 事件),冒烟的 `file` 块回归用例即该轮锁定。运行期插件 import 实际经 profile 的 module-fallback 解析到所装 dsh 的依赖闭包,与这里的 semver 范围无关)。
