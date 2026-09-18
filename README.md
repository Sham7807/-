# 小小宇宙无敌 · 模型渠道测试台

在一个网页中测试文本、图像、视频和音频渠道，预览生成结果，并执行独立的 CCMax 渠道验收或官方 Kimi Vendor Verifier 验证。

基础网页可直接打开。CCMax / Kimi 专项需要本地 Python 服务，目前支持 macOS 和 Linux。调用真实渠道会按渠道规则计费；测试结果以实际响应为准，不代表官方认证或模型身份鉴定。

## 直接使用基础测试

下载或克隆项目后，打开根目录的 **中转站测试工具-多模态版.html**。

1. 选择文本、图像、视频或音频。
2. 填写渠道地址、API Key 与模型 ID，也可以获取渠道模型列表。
3. 按渠道文档选择接口协议、尺寸等参数。
4. 选择代表性测试场景，提示词会立即填入，可继续编辑。
5. 检查请求预览并开始测试，返回的媒体可直接预览、打开或下载。

浏览器直连要求渠道允许跨域请求。静态 HTML 或 GitHub Pages 本身不能执行 CCMax / Kimi 的 Python 验收程序。

## 启动完整工作台

需要 Git、Python 3.9+ 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。初始化会从官方 GitHub 获取固定版本 KVV 和约 75 KB 的必要测试素材，再安装 Python 依赖；不会调用模型渠道。

macOS 用户可双击 **启动验收工作台.command**。也可以在项目根目录执行：

```bash
python3 scripts/prepare_kvv.py
uv venv --python 3.13 integrations/.venv
uv pip install --python integrations/.venv/bin/python -e integrations/Kimi-Vendor-Verifier
integrations/.venv/bin/python integrations/server.py --open
```

打开 [http://127.0.0.1:8877/](http://127.0.0.1:8877/)。服务只监听本机，终端中按 `Ctrl+C` 停止。更换端口可使用 `--port 8878`。

官方源码会放在 `integrations/Kimi-Vendor-Verifier/`，固定版本记录在 [integrations/SOURCE.json](integrations/SOURCE.json)。安装脚本不会自动切换或覆盖已有的不同版本及修改过的素材，也不会下载未使用的 BEAM 大型数据集。

检查依赖源码和必要素材是否完整，不联网：

```bash
python3 scripts/prepare_kvv.py --check
```

## 可以测试什么

| 类型 | 功能 | 适用接口 |
| --- | --- | --- |
| 文本 | 普通对话、流式响应、通用深度检测 | OpenAI Chat Completions / Responses、Anthropic Messages、Gemini |
| 图像 | 文生图、图生图 / 编辑、多图参考 | OpenAI 兼容图片接口、Gemini 图像接口 |
| 视频 | 创建任务、轮询进度、播放与下载 | 兼容 Videos、OpenAI Videos、豆包 / Seedance、自定义 JSON |
| 音频 | 语音生成、音频对话、转写与翻译 | Speech、Chat Completions Audio、Gemini TTS、Transcriptions / Translations |

模型名称可以手动填写。兼容性取决于渠道的协议、鉴权和模型能力；未实现的原生协议需要单独适配，不能仅靠更改模型名称覆盖所有供应商。

## CCMax 与 Kimi 专项

入口：**文本模型 → 深度检测**。

**CCMax渠道验收** 使用独立的 Anthropic Messages 检测器，检查无效 thinking 签名、message_start 唯一性、message_stop、连接关闭、流中错误、错误状态与格式、usage / 缓存字段、工具参数 JSON。快速采样默认 6 次请求，批量默认 57 次，可自定义采样数量。Claude 检测不运行 KVV。

**Kimi KVV** 由同一本地服务调用 [MoonshotAI/Kimi-Vendor-Verifier](https://github.com/MoonshotAI/Kimi-Vendor-Verifier)：

- **11 项预检**：基础请求、非法参数、工具 Schema、动态工具、JSON 输出、required tool choice 和 prompt token 计数的代表性用例。
- **全套 API 验证**：`tests/params`、`tests/tool_call_json_schema`、`tests/k3_features`、`tests/prompt_tokens`。当前固定版本收集 611 个 pytest 项，包含跳过项与本地检查，项目数不等于实际 API 请求数。

全套 API 验证不包含 OCRBench、MMMU、AIME、BEAM 或 DeepSWE 等独立 benchmark。Kimi 普通文本 / 通用检测不依赖 KVV。

## 报告与本地数据

完成或取消专项后，可以下载 HTML 报告、JSON 结果和 ZIP 证据包。本机副本位于 `integrations/reports/<任务ID>/`。

HTML 报告包含测试方法、预期与实际结果、问题影响、排查建议、耗时以及请求 / 响应证据，支持搜索、状态筛选和打印为 PDF。CCMax 与 Kimi 的结果及下载分别关联各自任务。

`.gitignore` 已排除本机环境、真实测试报告、日志、截图和原始评估文件。不要把 API Key 写入源码或提交到 Git；分享报告前请检查响应正文是否含业务数据。

## 开发与离线验证

前端是原生 HTML、CSS 和 JavaScript，源码在 `multimodal-workbench/`。修改后重新生成单文件版本：

```bash
python3 multimodal-workbench/build.py
```

前端测试需要 Node.js 20+：

```bash
npm ci
npx playwright install chromium
npm test
npm run test:choices
npm run test:acceptance
npm run test:workflows
```

UI 测试默认使用 Playwright 浏览器；也可以通过 `CHROME_PATH` 指定已有 Chromium / Chrome，通过 `PLAYWRIGHT_MODULE` 指定已有 Playwright 模块。测试使用本地模拟接口，不需要真实渠道密钥。

安装完整工作台依赖后，可运行后端离线测试：

```bash
integrations/.venv/bin/python -m unittest discover -s integrations -p 'test_*.py'
```

依赖本机历史报告的回归在没有对应报告时会跳过。

更多操作说明见 [使用说明](multimodal-workbench/使用说明.txt)，第三方来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。
