# 更新日志

## [0.7.0] — 2026-11-23

### 新增

- **`comfyui_generate_music`（ACE-Step 1.5 背景音乐生成）**：本机 ComfyUI 0.43 原生 `TextEncodeAceStepAudio1.5` 节点 + `ace_step_1.5_turbo_aio.safetensors` 单文件 AIO（9.33GiB，RTX3060 6GB 可跑）。纯器乐：lyrics 留空即可，无歌词无人声。参数 `tags`（风格描述）/ `duration`（1~300 秒）/ `seed` / `bpm` / `key` / `language` / `format`（flac/mp3/opus）/ `output_path`。官方模板 8 步采样。
- **`comfyui_transcribe_audio`（Whisper 语音识别）**：复用 IndexTTS 的 venv（`D:/Tools/IndexTTS/.venv/Scripts/python.exe`，whisper 20250625 + torch 2.8+cu128 已装），默认 `large-v3`（whisper 系列最强，本机 6GB 可跑），CUDA 失败自动回退 CPU；权重缓存在 `~/.cache/whisper`。参数 `audio_path` / `model` / `language` / `device` / `task` / `initial_prompt` / `word_timestamps` / `output_path`。返回 text + 分段（可选词级时间戳）。
- 新增配置项：`musicCheckpoint` / `musicTimeoutMs` / `musicFormat` / `musicSteps` / `musicCfg` / `musicSampler` / `musicScheduler` / `musicBpm` / `musicKeyScale` / `musicLanguage` / `musicMaxDuration`，`transcribePython` / `transcribeModel` / `transcribeDevice` / `transcribeTimeoutMs`；对应 `COMFYUI_MUSIC_*` / `COMFYUI_TRANSCRIBE_*` 环境变量。
- 修复 `src/params.ts` 构造 `NormalizedRequest` 时缺四个 `*FromArgs` 字段的既存 typecheck 错误。

## [0.6.1] — 2026-11-22

### 新增

- **分辨率自动分级（6GB 显存实测调优）**：InfiniteTalk 端到端耗时对帧数超线性——本机 6GB 下 832x480 的 77 帧就卡死近 2 小时，
  降到 512x320 后 121 帧 12.5 分钟能出片，且口型清晰度无损。插件现在按语音时长算出的规划帧数自动选分辨率：
  **≤60 帧（约 ≤2 秒台词）用 832x480 高清，>60 帧自动降到 512x320**；显式传 `width`/`height` 时完全尊重用户选择、不自动降级。
  分级发生在 TTS 之后、首帧之前，结果 `notes` 与元数据里的 `width`/`height` 记录的是实际用值。
- 实测边界：512x320 下 2.9 秒/77 帧≈3 分钟、5 秒/121 帧≈12.5 分钟；7 秒/172 帧仍卡死，建议拆段。
- 新增 `autoResolutionForFrames` 纯函数与 `TALKING_HD_MAX_FRAMES` / `TALKING_HD_SIZE` / `TALKING_LOWRES_SIZE` 常量；
  测试数 164 → 167，全绿。



本文件记录 **dsh-comfyui-image** 的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0] — 2026-11-22

### 变更

- **对口型引擎从 MuseTalk 1.5 换成 InfiniteTalk**（kijai 版 `ComfyUI-WanVideoWrapper` 内），改为**端到端一次生成**：台词 → TTS → 首帧人像 → InfiniteTalk 一次生成带口型视频。
  移除旧的「Wan2.2 无声说话视频 + MuseTalk 局部重绘嘴部再贴回」两步，因此不再有嘴部边缘柔化 / 贴片模糊。
  三种模式相应调整为：text2talking（文生图首帧）、image2talking（图片首帧）、video2talking（抽视频首帧，**不保留原视频动作**）。
- **新增 InfiniteTalk 模型清单**（都在 `ComfyUI/models` 下，需用户预先下载）：主模型 `wan2.1-i2v-14b-480p-Q3_K_S.gguf`（~7.4GB）、
  InfiniteTalk patch `Wan2_1-InfiniteTalk_Single_Q4_K_M.gguf`（~1.4GB）、4 步蒸馏 LoRA `lightx2v_I2V_14B_480p_cfg_step_distill_rank16_bf16.safetensors`、
  音频编码器 `wav2vec2/wav2vec2-chinese-base_fp16.safetensors`、VAE `vae/wan_2.1_vae.safetensors`、文本编码器 `text_encoders/umt5_xxl_bf16_dequant.safetensors`
  （由 fp8 scaled 版反量化为 bf16；`WanVideoTextEncodeCached` 节点拒绝 fp8 scaled）。
- **6GB 显卡（RTX 3060 Laptop）可跑的关键设置**：`attention_mode=sdpa`、T5 用 bf16_dequant 版、LoRA `merge_loras=false`、block swap。
  81 帧 / 4 步约 20 分钟（分钟级，远慢于旧 MuseTalk 的 2 分钟），是清晰度换速度的取舍；帧数由语音时长算（25fps，4n+1 对齐）。
- **edge-tts 迁到 IndexTTS 的 venv**（`D:/Tools/IndexTTS/.venv/Scripts/python.exe`），不再依赖 MuseTalk 的 venv。
- **配置清理**：删除旧的 MuseTalk 路径配置项与对应环境变量，edge-tts 改用 `indexttsPython`。
- **兼容性补丁**：本机 transformers 5.x 的 `Wav2Vec2Encoder` 不再返回逐层 `hidden_states`，导致 WanVideoWrapper 的
  `multitalk/nodes.py` 报 `'NoneType' object is not subscriptable`；已给 `multitalk/wav2vec2.py` 打 forward hook 补丁重建
  13 层 `hidden_states`（保留 `.bak` 可回退）。升级 transformer 或 wrapper 后若复现需重打补丁。
- 测试数从 160 增至 **164**；文档（TALKING / AUDIO / CONFIG / 中英 README）同步为 InfiniteTalk 口径。

## [0.5.0] — 2026-11-04

从「只管图片」扩到**图片 / 视频 / 说话视频 / 纯配音**四件套。图片工具的行为与参数**完全不变**，
已有配置与调用方无需改动；新增的三个工具各自独立，不用就不会有额外开销。

### 新增

- **`comfyui_generate_video`：文生视频 / 图生视频**（`src/video/`）。
  后端走 Wan2.2 TI2V-5B，`UnetLoaderGGUF` 与 `UNETLoader` 两种加载器都支持，模型 / 文本编码器 / VAE
  都按本机实际可选项**择优**，也能用 `model` / `videoModel` 显式指定。
  - **帧数自动对齐到 4n+1**：Wan 的 VAE 时间下采样率是 4，不对齐末尾会糊。所以 `seconds` 是「期望时长」，
    真实时长以返回的 `frames / fps` 为准，结果 `notes` 里会写清「约 48 帧 → 49 帧（真实时长 2.04 秒）」。
  - 尺寸自动对齐到 32 的倍数；超出上限（481 帧）**报错而不是静默夹断**，报错里给出该 fps 下最长多少秒。
  - `estimateSeconds()` 按本机 49 帧 / 30 步 / 832×480 ≈ 210 秒标定，返回量级估算，供 Agent 决定要不要降参。
- **`comfyui_generate_talking_video`：台词 → 语音 → 说话画面 → 对口型**（`src/talking/`）。
  三段串联，三种模式（`text2talking` / `image2talking` / `video2talking`），中间产物落在独立临时目录，
  失败时 hint 里给出该目录，便于查是哪一段挂了。
- **`comfyui_generate_audio`：只配音**（`src/audio/`）。一句台词 → 16kHz 单声道 wav，不碰画面，
  方便「先把音色和语气调好，再拿去对口型」这种迭代。
- **TTS 换成 IndexTTS-2 克隆音色**（`ttsEngine: 'indextts'`，默认）：音色由 `spk_audio_prompt`
  指向的 3~15 秒参考音频决定；`emo_vector`（8 维情绪）/ `emo_alpha`（强度）/ `emo_audio_prompt`
  （照着另一段音频的语气）/ `duration_factor`（语速）可调。`tts: 'edge'` 保留，用 `edge_voice` + `rate` 秒出。
- **对口型走 MuseTalk 1.5**（0.6.0 起已换成 InfiniteTalk）：`--version v15` + `--parsing_mode jaw` + `--use_float16`。
  素材会先拷进临时无空格目录——旧 `inference.py` 拼 ffmpeg 命令时没加引号，
  路径带空格会直接断掉，这个坑当时在代码里兜住了。
- **配置新增 video 段与 talking 段**：`videoModel` / `videoVae` / `videoSeconds` / `videoFps` / `videoSteps` /
  `videoCfgScale` / `videoShift` / `ttsEngine` / `ttsSpkAudioPrompt` / `indexttsDir` / `indexttsPython` /
  （旧的 MuseTalk 路径项 0.6.0 已删除）/ `ffmpegBin` / `videoTimeoutMs` / `talkingTimeoutMs`，
  对应环境变量 `COMFYUI_VIDEO_*`、`COMFYUI_INDEXTTS_*`、`COMFYUI_FFMPEG_BIN`、
  `COMFYUI_TALKING_TIMEOUT_MS`。四层优先级不变。
- **文档**：新增 [docs/TALKING.md](docs/TALKING.md)（为什么必须分三段、装法、耗时实测、踩过的坑、能力边界）、
  [docs/AUDIO.md](docs/AUDIO.md)（纯配音参数与两个引擎）、
  [docs/EMOTION_TTS_SELECTION.md](docs/EMOTION_TTS_SELECTION.md)（情绪配音选型）；
  README / PARAMS / USAGE / CONFIG / FAQ 同步扩到四工具。

### 变更

- `PLUGIN_VERSION` 从 `0.1.0` 升到 `0.5.0`，与 `package.json` 一致（此前两者不同步）。
- `package.json` 的 `description` / `keywords` / `meta` 从单工具口径改成四工具口径。
- 测试从 88 项扩到 **160 项**：新增 video 21 项、talking 29 项、audio 22 项；
  `test/mock-comfyui.mjs` 增加 `videoNodes()` 与 `makeFakeMp4()`，`/view` 按扩展名分流回 mp4，
  `buildHistoryEntry` 识别 `SaveVideo` 并把产物挂在 `gifs` 键上（照抄真机形状）；
  子进程用 `fakeSpawn` 假造 TTS / InfiniteTalk 的输出，不需要真装模型就能跑全套。

### 未变

- `comfyui_generate_image` 的工具名、参数、输出结构、报错文案**一字未改**，已有调用与配置照旧。

## [未发布]

### 修复

- **`publish.yml` 只挂 `release` 事件，导致 npm 漏发**（`v0.1.1` 实测暴露，属真机验证才看得见的 bug）：
  `release.yml` 用仓库自带的 `GITHUB_TOKEN` 建 Release，而 GitHub 规定 **`GITHUB_TOKEN` 产生的事件不会再触发
  其他 workflow**（防止递归）。结果是 tag 推上去了、Release 建好了、**npm 上却没有 0.1.1**，
  两条流水线还都是绿的——没有任何红灯提示你漏了东西。
  现在 `publish.yml` **自己监听 `v*.*.*` tag push**，与 release.yml 成为两条独立并行的触发链；
  `release` 事件与手动触发保留，覆盖「在 GitHub 界面手动发 Release」和「补发历史 tag」。
- **发布幂等**：新增「该版本在 npm 上是否已存在」检查，已存在就打 notice 跳过，
  不再以 npm 403 的形式变成一次失败的构建（重复触发不再是噪声）。
- **手动触发可指定 tag**：`workflow_dispatch` 增加 `tag` 输入，会检出该 tag 的内容去发，
  保证「npm 上的包 = tag 指向的代码」；留空则用默认分支 `package.json` 的版本号，并在运行摘要里给出结论表。
- 文档同步：[docs/RELEASING.md](docs/RELEASING.md) 写明三条触发关系，以及为什么不能只依赖 release 事件。

## [0.1.1] — 2026-10-04

### 新增

- **自动发版流水线**（都由 tag 驱动，不需要在本地跑发布命令）：
  - [.github/workflows/release.yml](.github/workflows/release.yml)：推 `v*.*.*` tag 自动建 GitHub Release
    （变更说明由 GitHub 按提交生成；同名 Release 已存在时跳过而不是报错；支持在 Actions 页面手动补发历史 tag）。
  - [.github/workflows/publish.yml](.github/workflows/publish.yml)：Release 发布后自动
    `npm test` + `npm publish --provenance --access public`。发布前会**校验 tag 名与 `package.json` 的 version 一致**
    （npm 同一版本号不能覆盖重发，这个防呆比事后改版本值钱）；未配置 `NPM_TOKEN` secret 时**跳过发布并打 notice**，
    工作流保持绿色，fork 出去推 tag 不会红。
- 包元数据补齐 `repository` / `bugs` / `homepage` / `publishConfig`（`publishConfig` 显式钉官方源，
  避免本机或 CI 的镜像 registry 影响发布目标；`repository` 也是 npm provenance 签名要求的前置条件）。
- 文档：新增 [docs/RELEASING.md](docs/RELEASING.md)（发版步骤、`NPM_TOKEN` 怎么生成与配置、
  手动补发、provenance 说明、`npm pack` 清单核对），并在中英 README 的文档表里挂上。
- README 顶部加了**效果示例图** [docs/preview.png](docs/preview.png)：本插件配本地 ComfyUI 实出的图，
  连同复现参数（`seed 42` / 512×512 / SD1.5 底模）一起写进文档，新访客第一眼能看到它真能出图。
- 安装方式改为**首选从 npm 装**：`dsh plugin --profile <你的 profile> add dsh-comfyui-image`
  （等价 `npm i dsh-comfyui-image`，或在 DSH 的**设置 → 插件**里把目标填成包名）。
  同时保留**从 GitHub 装**的路径：`dsh plugin --profile <你的 profile> add github:liren2272-hue/dsh-comfyui-image`
  （`dsh plugin` 底层是 pnpm；实测 21.6 秒装完、装到的 `lib/` 13 个文件可直接运行——
  **不需要 npm 账号、不需要本地 clone、不需要构建**），npm 不可用或想跟随 `main` 分支时走这条。
- **已发布到 npm**：`dsh-comfyui-image@0.1.0`（2026-10-04）。两点必须记清楚：
  ①这**首次发布是本地手动完成的**（`npm publish`），因此这一版**没有 provenance 签名**，
  npm 页面上不会出现「Built and signed on GitHub Actions」——从下一个版本起走 `publish.yml` 才会带上；
  ②npm 同一版本号**不能覆盖重发**，`0.1.0` 已占号，任何改动想再发布都必须先升版本号（0.1.1）。
- README 顶部加 **npm 徽章**（随 `publish.yml` 的发布状态自动显示版本号）。
- **npm 上 `0.1.0` 包内的 README 是旧版**：那个 tarball 打包于提交 `aecc4b6`，而「安装首选 npm」的文档改动
  （`21064fd`）在它之后，所以 `0.1.0` 的读者在 npm 页面上看到的仍是「首选从 GitHub 装」。
  从 **0.1.1** 起包内文档与仓库一致（`npm view dsh-comfyui-image@0.1.0 gitHead` 可以自己核对这一点）。

### 修复

- **CI 依赖的 Actions 升到 v7**：`actions/checkout` 与 `actions/setup-node` 由 `@v4` 升为 `@v7`。
  起因是 GitHub 给每个 job 弹了 `Node.js 20 is deprecated` 注解——v4 系列的这几个 Action 声明的是 Node 20 运行时，
  被强制跑在 Node 24 上。升级前先取了两者的 `action.yml` 逐项核对，确认仍支持本仓库用到的
  `fetch-depth` / `node-version` / `registry-url` 三个输入，且 `using: node24`——不是凭版本号猜能升。

- **`docs/RELEASING.md` 里的 token 配置说明与 npm 现行界面不符**：原文写「选 Granular Access Token，
  或者选经典的 **Automation** 类型」，但现在的 npm 点了 **Generate New Token** 之后
  **直接进入 `New Granular Access Token` 表单，根本没有 Classic 入口**；原文里「包范围选本包或 all packages」
  在实际界面中也不存在这一项。现已按真实界面改成逐项对照表，其中三项最容易踩：
  `Bypass two-factor authentication (2FA)` **必须勾**（不勾发布会要验证码，CI 会卡死）、
  `Permissions` 必须选 **Read and write (publish and stage)**（选成 `stage only` 发不出去）、
  `Allowed IP ranges` **必须留空**（GitHub Actions 出口 IP 每次都变）。另补上 **90 天有效期与轮换**说明。
  凭据类文档写错，代价是让人在界面里白找半小时——这次是拿真实截图逐项核对后重写的。

## [0.1.0] — 2026-10-03

首个可用版本（需求书里的「实用版 V1」）。

### 新增

- **统一的 Agent 工具 `comfyui_generate_image`**：一个入口覆盖四种模式，内部按模块拆分，
  对外只暴露一个工具（`text2img` / `img2img` / `inpaint` / `remove_background`）。
- **参数推断**：不传 `mode` 时按 `input_image` / `mask_image` 推断（有图+遮罩 → inpaint，只有图 → img2img，
  都没有 → text2img）；模式**不猜**，冲突直接报错并给出怎么改。
- **统一抽象参数层**：`prompt` / `negative_prompt` / `input_image` / `mask_image` / `width` / `height` /
  `seed` / `output_path` / `strength` / `steps` / `cfg_scale` / `model` / `sampler_name` / `scheduler` /
  `extra_options`；`style_reference` / `character_reference` 作为一致性预留位（V1 只记录进元数据）。
- **合理默认值**：尺寸按底模自动（SDXL 1024 / SD1.5 512）、seed 随机、steps 20、cfg 7、
  输出落到当前项目根目录、文件名带时间戳且**绝不覆盖**已有文件。
- **本地 ComfyUI 后端**：只用 Node 内置能力（`fetch` / `FormData`），零运行时依赖；
  自己实现 `/system_stats`、`/object_info`、`/upload/image`、`/prompt`、`/history`、`/view`、`/interrupt` 的调用。
- **能力探测**：自动挑底模（优先带 `xl` 的）、校验采样器/调度器是否真的存在、按可用性挑一套去背方案
  （ComfyUI_essentials / ComfyUI-BRIA_AI-RMBG / ComfyUI-LayerStyle / WAS Node Suite 四套择优；
  仓库与节点类名取自 ComfyUI-Manager 的 `extension-node-map.json` 索引，不凭记忆写）。
- **明确报错**：连不上 ComfyUI、输入文件不存在、工作流执行失败、超时、缺去背节点……
  每条错误都带「下一步怎么办」，而不是一句 `fetch failed`。
- **结果与元数据**：返回本地绝对路径（单独一行，DSH 里可直接点开）、mode / seed / 尺寸 / 耗时 / prompt_id 等；
  每张图旁边写一份 `.json` 元数据 sidecar（含完整参数与提交的工作流，可复现、可调试）。
- **配置四层来源**：插件配置 > `~/.dsh-comfyui-image/config.json` > 环境变量 > 内置默认值；
  改配置文件**立刻生效**，不用重启 DSH。
- **扩展逃生舱**：`extra_options.workflow_path` 可指向任意 API 格式工作流 JSON，
  用 `{{prompt}}` / `{{seed}}` / `{{input_image}}` 等占位符接管本次生成（扩图、超分、批量、特殊节点都能自己接）。
- **自检脚本** `npm run doctor`：打印生效配置、ComfyUI 版本与设备、底模/采样器真实可选值，
  并逐模式判定能不能跑（退出码 0 全部可用 / 1 连不上 / 2 有模式不可用）。
- **测试**：88 项测试，含一个「假 ComfyUI」（真 PNG 编解码、真上传、真轮询、真报错路径）的端到端验证——
  没装 ComfyUI 的机器也能跑。
- **文档**：中英双语 README（`README.md` / `README.en.md`）与安装教程（`docs/INSTALL.md` / `docs/INSTALL.en.md`），
  另有 `docs/`（配置、用法、参数、FAQ、路线图）。

### 修复

真机验证（ComfyUI 0.38.0 + Intel Arc XPU）跑出来的两个 bug，都已修并带回归测试：

- **默认尺寸的「按底模自适应」在最常见的路径上不生效**：参数层解析时底模可能还没定
  （用户没传 `model`、配置里也没写 `checkpoint`，得靠自动挑选），于是尺寸永远落到配置默认值——
  本机只有 SD1.5 底模时仍出 1024×1024，与工具说明承诺的 512 自相矛盾。
  现在把「哪些维度是显式给的」记在请求里，等底模真正选定（可能是自动挑的）后再补默认尺寸，
  并在 `notes` 里写明依据；mock 也补上了「只放 SD1.5 底模」的用例，消除
  「自适应值恰好等于配置默认值」造成的盲区。
- **`img2img` / `inpaint` 报告的尺寸与产出图不符**：`width` / `height` 在 `OUTPUT_SCHEMA` 里的含义是
  「输出宽度 / 输出高度」，但报告与 sidecar 之前照抄请求值——512×512 的输入图产出 512 的图，
  报告里却写着 1024。现在一律以**产出文件字节**里的真实像素为准（解析 PNG / JPEG 头部），
  与请求值不同时额外在 `notes` 里说明原因。顺带把 mock 改忠实：`img2img` / `inpaint` 的产出尺寸
  改为跟随上传的输入图（与真实 ComfyUI 一致），不再一律回 64×64。
- **一条测试的环境依赖**：它要求「默认地址必然连不上」，本机装了 ComfyUI 就会失败（CI 上绿、
  开发机红）。现已按测试套件自己的原则把默认地址钉到不可达端口，只验证该验证的事。
- **`npm test` 在 Node 20 上直接报错**（CI 矩阵里 Node 20 两个平台全红、Node 22 全绿）：
  `node --test "test/*.test.mjs"` 依赖 `--test` 的 glob 展开，而那是 Node 21 才有的能力，
  Node 20 会把引号里的通配符当字面路径，报 `Could not find '.../test/*.test.mjs'`；
  去掉引号交给 shell 展开也不行——npm scripts 在 Windows 走 cmd（不展开 glob）、POSIX 走 sh（展开）。
  现改为 `scripts/run-tests.mjs`：自己列出 `test/*.test.mjs`，把**显式路径**交给 `--test`，
  Node 18+ 通用、两个平台行为一致（`engines` 仍声明 `>=20`，不靠提高门槛掩盖兼容问题）。
- **去背方案清单里的三处硬伤**（真机装上 `ComfyUI_essentials` 之后才暴露，靠 ComfyUI-Manager 的
  `extension-node-map.json` 索引定证）：
  1. 原第一优先方案写的是节点类名 `RemBG`，而索引里**没有任何仓库**声明这个类名，
     安装提示指向的 `Limbicnation/ComfyUI_RemBG-U2Net` 仓库也**不存在**（API 返回 404）；
  2. 提示里说 `git clone https://github.com/1038lab/ComfyUI-RMBG` 就能拿到 `BRIA_RMBG_Zho`，
     但该仓库提供的是 `AILab_*` 那一套，真正的提供者是 `ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG`；
  3. essentials 方案把 `ImageRemoveBackground+` 当**单节点**用，可它的 `rembg_session` 是必填输入，
     必须由 `RemBGSession+` 喂进来；缺了会在真机上以
     「HTTP 400 required_input_missing: rembg_session」失败——**`doctor` 还会误报「可用」**，
     因为探测阶段只检查节点是否存在。
  现在四套方案全部换成索引里可查的真实仓库，essentials 改为 `RemBGSession+ → ImageRemoveBackground+`
  **成对**构建并断言接线，另补一个单节点方案（WAS）的回归测试，覆盖 `buildSingle` 分支。

### 已知限制

- 背景移除依赖第三方自定义节点，本插件只做择优与安装指引，不打包节点。核心 ComfyUI 0.3x 起自带
  `LoadBackgroundRemovalModel` + `RemoveBackground`（输入图 → 输出 MASK，需自备
  `models/background_removal/` 模型），与现有「一张图进、一张图出」的路径不同，**暂未接入**。
- `upscale` / `outpaint` / 批量多图**不在 V1 内置范围**，走 `extra_options.workflow_path` 自定义工作流实现。
- `style_reference` / `character_reference` **V1 只记录、不参与生成**（一致性属于后续版本）。
- 真机已验：ComfyUI 0.38.0 + Intel Arc（XPU 后端，`torch 2.14.0+xpu`），**四种模式全部端到端跑通**——
  `text2img` / `img2img` / `inpaint` 直接出图；`remove_background` 走
  `RemBGSession+ → ImageRemoveBackground+`，产出 512×512 的 RGBA（真 alpha 通道，可验证）。
  缺第三方节点时的报错路径同样实测过，会列出四套可照做的安装方案。
  节点键名与枚举已与 ComfyUI 官方源码（`nodes.py` / `samplers.py`）逐字对账。
