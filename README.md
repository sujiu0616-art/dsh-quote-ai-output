# dsh-quote-ai-output

DeepSeek Harness 持久插件：**引用 AI 回复内容**。

选中 AI 回复中的任意一段文字，通过操作条上的 ❝ 按钮将其「引用」，以官方引用芯片插入输入框；发送时自动序列化为明确的引用块上下文，让 AI 知道"这是我引用的上一段内容，而不是我新输入的文字"。

## 功能

| 功能 | 说明 |
|---|---|
| 划词引用 | 选中 AI 回复中的任意文字 → 点 ❝ → 引用该片段 |
| 整条引用 | 不选文字直接点 ❝ → 引用整条消息 |
| 引用芯片 | 以官方引用芯片（occurrence）形式插入输入框末尾 |
| 发送区分 | 发送时芯片自动展开为 `【引用 · 第 N 轮回复 · 摘要】原文…【引用结束】` |
| 管理条 | ≥2 段引用时输入框上方出现管理条（删除/清空）；单条无多余浮层 |
| 兜底降级 | 芯片插入失败时自动降级为纯文本引用块，内容不丢 |

## 安装

```bash
# 克隆到 dsh web 插件目录
cd ~/.dsh/profiles/web/plugins
git clone https://github.com/sujiu0616-art/dsh-quote-ai-output.git

# 建立 node_modules 链接（pnpm 不自动识别 plugins/* 新包）
cd ~/.dsh/profiles/web
# Windows (PowerShell)
New-Item -ItemType Junction -Path "node_modules\dsh-quote-ai-output" -Target "plugins\dsh-quote-ai-output"
# macOS/Linux
ln -s ../plugins/dsh-quote-ai-output node_modules/dsh-quote-ai-output

# 在 profile 的 cordis.patch.yml 中添加挂载行
# （若已有 custom-skin，加在 insert 列表末尾即可）
# - insert:
#     ...已有行...
#     - id: quote-ai-output
#       name: 'dsh-quote-ai-output'

# 重启 DSH 生效
```

## 技术实现

### 官方 API 管道（零 DOM hack）

```
消息身份：conversation.chat.assistant-actions（owner props.messageId）
消息原文：useSession((s)=>s).nodes[] → AssistantMessageNode.blocks
插入芯片：ctx.conversation.input.for(sessions.binding(id).ctx).insertReference(ref, span)
发送序列化：inputTriggers.registerSource({codec: {serialize}})（官方 sinkSerialized 管道）
管理条：conversation.input.dock（≥2 段才显示）
```

### 芯片机制

DSH 输入机器原生支持「内联引用 occurrence（芯片）」，`@文件`、`@会话` 引用就是用它实现的。本插件注册了一个自定义 `@quote` source，复用同一套管道：

- **插入**：`slash/input-insert-reference` 事件（bail，session scope）
- **序列化**：`codec.serialize(ref)` 在发送时展开为模型可见的引用块格式
- **删除**：用户在输入框中删掉 chip 文本即可（机器自动 reconcile）

### 选区归属

选区文本与原文的对应用**折叠空白 + 索引映射**的纯数据方案（不依赖 DOM 结构）；Markdown 渲染差异（如 `**粗体**` → `粗体`）匹配失败时自动退化用选区文本本身。

## 结构

```
dsh-quote-ai-output/
├── package.json          # dsh.client.platform: web
├── lib/
│   ├── index.js          # host 空壳（纯浏览器功能，host 无需实现）
│   └── client.js         # 浏览器端完整逻辑（module-loader 格式）
└── README.md
```

## 许可

MIT
