# dsh-comfyui-image

[English](./README.en.md) | **简体中文**

[![CI](https://github.com/liren2272-hue/dsh-comfyui-image/actions/workflows/ci.yml/badge.svg)](https://github.com/liren2272-hue/dsh-comfyui-image/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/liren2272-hue/dsh-comfyui-image?label=release)](https://github.com/liren2272-hue/dsh-comfyui-image/releases)
[![License](https://img.shields.io/github/license/liren2272-hue/dsh-comfyui-image)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![npm](https://img.shields.io/npm/v/dsh-comfyui-image?label=npm)](https://www.npmjs.com/package/dsh-comfyui-image)

给 **DeepSeek Harness**（DSH）补上**图片 / 视频 / 说话视频 / 纯配音**生成能力的插件：
后端接**本地 ComfyUI**，对外暴露**四个** Agent 工具 ——

| 工具 | 干什么 |
|---|---|
| `comfyui_generate_image` | 文生图、图生图、局部重绘、背景移除四合一 |
| `comfyui_generate_video` | 文生视频、图生视频（Wan2.2 TI2V-5B） |
| `comfyui_generate_talking_video` | 台词 → TTS → 说话画面 → MuseTalk 对口型 |
| `comfyui_generate_audio` | 台词 → 16kHz wav，**只配音不碰画面** |

不依赖任何外部商业 API，运行时**零第三方依赖**（只用 Node 内置的 `fetch` / `FormData`）。

> 一句话用法：装好 ComfyUI、启用插件，然后对 Agent 说「生成一张柯基宇航员的图」或
> 「让这张照片说『今天天气不错』」就行。

![效果示例：柯基宇航员（本插件 + 本地 ComfyUI 实际出图）](./docs/preview.png)

> 上图就是照着上面这句话出的：`text2img`、SD1.5 底模、512×512、`seed 42`、`dpmpp_2m`/`karras`
> —— 图与复现参数都在仓库里（`docs/preview.png` + 同名 `.json` sidecar）。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能一览](#功能一览)
- [环境要求](#环境要求)
- [安装](#安装)
- [启用与验证](#启用与验证)
- [让 Agent 用它](#让-agent-用它)
- [配置](#配置)
- [工具参数速查](#工具参数速查)
- [模式推断与报错规则](#模式推断与报错规则)
- [输出与文件](#输出与文件)
- [风格 / 角色一致性（V1 现状）](#风格--角色一致性v1-现状)
- [扩展：用自定义工作流接管生成](#扩展用自定义工作流接管生成)
- [常见问题](#常见问题)
- [架构与目录结构](#架构与目录结构)
- [开发](#开发)
- [路线图](#路线图)
- [许可协议](#许可协议)
- [更多文档](#更多文档)

---

## 它解决什么问题

DSH 本身没有出图 / 出片 / 配音能力，而 Agent 又经常需要「画一张图」「来段视频」「让照片说话」。
本插件把**本地 ComfyUI** 与**本机 TTS / 对口型工具链**接进来：

- Agent 侧：多了四个工具，参数少、有默认值、报错能指导下一步；
- 用户侧：产物直接落到**当前项目根目录**，返回的绝对路径在 DSH 里可以直接点开；
- 运维侧：ComfyUI 地址 / 底模 / 视频模型 / TTS 路径都在配置文件里，改完**立即生效**，不用重启 DSH。

## 功能一览

### `comfyui_generate_image` —— 四种图片模式

| 模式 `mode` | 输入 | 干什么 | 备注 |
|---|---|---|---|
| `text2img` | `prompt` | 文生图 | 只有这个模式吃 `width` / `height` |
| `img2img` | `prompt` + `input_image` | 图生图 / 整体重绘 | `strength` 默认 0.6 |
| `inpaint` | `prompt` + `input_image` + `mask_image` | 局部重绘 | 遮罩**白/亮区 = 要重绘的区域**；`strength` 默认 1.0 |
| `remove_background` | `input_image` | 背景移除 | **需要 ComfyUI 装第三方去背节点**（见下） |

### `comfyui_generate_video` —— 文生视频 / 图生视频

| 模式 `mode` | 输入 | 干什么 |
|---|---|---|
| `text2video` | `prompt` | 文生视频 |
| `img2video` | `prompt` + `input_image` | 图生视频（首帧由这张图定） |

视频模型自动挑本机的 Wan2.2 TI2V-5B（`UnetLoaderGGUF` 或 `UNETLoader` 两种加载器都支持），
也能用 `model` / `videoModel` 指定。**帧数会自动对齐到 4n+1**（Wan 的 VAE 时间下采样率是 4，
不对齐末尾会糊），所以 `seconds` 是「期望时长」，真实时长看返回的 `frames / fps`。
2 秒 832×480 30 步在本机约 3.5 分钟。细节见 [docs/PARAMS.md](./docs/PARAMS.md)。

### `comfyui_generate_talking_video` —— 台词 → 语音 → 口型

| 模式 `mode` | 输入 | 干什么 |
|---|---|---|
| `text2talking` | `script` | 文字 → 生成人像 → 说话 → 对口型（最慢，约 8~12 分钟） |
| `image2talking` | `script` + `input_image` | 图片里的人开口说话（约 6~9 分钟） |
| `video2talking` | `script` + `input_video` | 给已有视频换口型 / 换音色（最快，约 3~6 分钟） |

分三段跑：**TTS（IndexTTS-2 克隆音色 / edge-tts）→ 说话画面（ComfyUI）→ 对口型（MuseTalk 1.5）**。
音色由 `spk_audio_prompt` 指向的一段 3~15 秒参考音频决定；`emo_vector` / `emo_alpha` / `emo_audio_prompt`
可以加情绪。完整说明（含为什么必须分三段、踩过的坑、能力边界）见 [docs/TALKING.md](./docs/TALKING.md)。

### `comfyui_generate_audio` —— 只配音

一句台词 → 一个 16kHz 单声道 wav，**不碰画面**，几秒到几分钟。适合「先把音色和语气调好，
再拿去对口型」这种迭代场景。见 [docs/AUDIO.md](./docs/AUDIO.md)。

### 共通能力

- **不传 `mode` 会自动推断**（图片三条规则、视频两条、说话视频三条），见[模式推断](#模式推断与报错规则)；
- **绝不覆盖**已有文件：目标已存在就自动加 `-1` / `-2` 后缀；
- 每个产物旁边写一份 **`.json` 元数据 sidecar**（含完整参数与提交给 ComfyUI 的工作流），可复现、可排查；
- `remove_background` 会在四套**已核实**的第三方去背方案里**择优**（`ComfyUI_essentials` / `ComfyUI-BRIA_AI-RMBG` / `ComfyUI-LayerStyle` / `WAS Node Suite`），一套都没有时列出「装什么、怎么装」；
- 想跑没内置的东西（扩图 / 超分 / 批量），用 [`extra_options.workflow_path`](#扩展用自定义工作流接管生成) 接自己的工作流。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 带 `tools` 服务（工具注册表）的版本；本插件按 `dsh.engines.dsh >= 0.2.0-rc.1` 声明 |
| Node.js | **>= 20**（依赖内置 `fetch` / `FormData` / `Blob`） |
| ComfyUI | 本地可访问的 ComfyUI 服务（默认 `http://127.0.0.1:8188`），`models/checkpoints` 里至少有一个底模 |
| 显卡 | 能跑 ComfyUI 即可；CPU 也能出图，只是慢 |

四个工具的要求是**叠加**的，只用图片就只需要第一行：

| 工具 | 额外需要 |
|---|---|
| `comfyui_generate_image` | 底模（`models/checkpoints/`） |
| `comfyui_generate_video` | Wan2.2 TI2V-5B（`models/diffusion_models/` 或 `unet/`，GGUF 也行）+ `umt5_xxl` 文本编码器 + `Wan2.2_VAE` + ComfyUI 带 `Wan22ImageToVideoLatent` / `ModelSamplingSD3` / `CreateVideo` / `SaveVideo` 四个节点 |
| `comfyui_generate_talking_video` | IndexTTS-2 仓库与 venv + 参考音频；MuseTalk 1.5 仓库与 venv；`ffmpeg` / `ffprobe`（或在 `ffmpegBin` 里指） |
| `comfyui_generate_audio` | 同 TTS 那一条（不需要 ComfyUI 与 MuseTalk） |

> 背景移除是**唯一**需要额外节点的图片功能。装下面**任意一套**即可（插件按此顺序自动择优）：
> `ComfyUI_essentials`（`RemBGSession+` → `ImageRemoveBackground+`）、`ComfyUI-BRIA_AI-RMBG`、
> `ComfyUI-LayerStyle`、`WAS Node Suite`。
> 具体命令见 [docs/INSTALL.md](./docs/INSTALL.md)；注意依赖要写 `pip install "rembg[cpu]"`
> （少了 `[cpu]` 就没有 onnxruntime 后端，这是实测踩过的坑）。
>
> 核心 ComfyUI 0.3x 起自带 `RemoveBackground` 节点（输入图 → 输出 MASK，需自备
> `models/background_removal/` 模型）。它与插件现有的「一张图进、一张图出」路径不同，**暂未接入**，
> 见 [docs/ROADMAP.md](./docs/ROADMAP.md)。
>
> TTS 与 MuseTalk 的装法、权重放哪、参考音频怎么挑，见 [docs/TALKING.md](./docs/TALKING.md) 第三、四节。

## 安装

分两步：**先把 ComfyUI 跑起来**，**再把插件装进 DSH**。

### 1. 装并启动 ComfyUI

按 [ComfyUI 官方说明](https://github.com/comfyanonymous/ComfyUI) 装好，启动后确认这两个地址能打开：

- `http://127.0.0.1:8188/system_stats` —— 健康检查
- `http://127.0.0.1:8188/` —— 界面

然后往 `ComfyUI/models/checkpoints/` 里放至少一个底模（SDXL 或 SD1.5 的 `.safetensors`）。

> 详细步骤（含 Windows 便携版、以及 Intel 显卡的额外注意事项）见 [docs/INSTALL.md](./docs/INSTALL.md)。

### 2. 把插件装进 DSH

> 装法有四种，按方便程度排序：**方式 A 从 npm 装**（已发布到 npm，最省事）；
> **方式 B 从 GitHub 装**（不需要 npm 账号，已实测）；自己 clone 到本地就用**方式 C**；
> 懒得分步就用**方式 D**手改 profile。

**方式 A：从 npm 装（推荐）**

```bash
dsh plugin --profile <你的 profile> add dsh-comfyui-image
```

等价写法：`npm i dsh-comfyui-image`，或在 DSH 的**设置 → 插件**里把安装目标填成
`dsh-comfyui-image`。包里的 `lib/`（33 个文件）是编译好的，**不需要装 TypeScript、不需要构建**。
装完重启 DSH。

**方式 B：一条命令从 GitHub 装（不需要 npm 账号，已实测）**

```bash
dsh plugin --profile <你的 profile> add github:liren2272-hue/dsh-comfyui-image
```

`dsh plugin` 底层走的就是 pnpm（实测 21.6 秒装完）。在 DSH 的**设置 → 插件**里把安装目标填成
`github:liren2272-hue/dsh-comfyui-image` 效果相同。**npm 不可用或想跟随 main 分支时用这条**。装完重启 DSH。

**方式 C：DSH 插件管理器（填本地路径）**

在 DSH 的 **设置 → 插件**里安装，目标填插件所在目录的本地路径，例如：

```
link:D:/dsh/plugins/dsh-comfyui-image
```

管理器会自己改 profile 的 `package.json`（加 `link:` 依赖 + 进 `dsh.profile.bundles`），并在失败时回滚。

**方式 D：手动改 profile**

打开当前 profile 的 `package.json`（`~/.dsh/profiles/<profile>/package.json`），做两件事：

```jsonc
{
  "dependencies": {
    "dsh-comfyui-image": "link:D:/dsh/plugins/dsh-comfyui-image"   // ① 加依赖
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……
        "dsh-comfyui-image"                                        // ② 加进 bundles
      ]
    }
  }
}
```

然后在 profile 目录里装一次依赖（`pnpm install` 或 DSH 界面里的「安装/更新插件」），再重启 DSH。

**方式 D：本地开发**

```bash
git clone <本仓库> dsh-comfyui-image
cd dsh-comfyui-image
npm install          # 只装 typescript 与 @types/node（开发用）
npm run build        # 改过 src/ 才需要；lib/ 已随仓库提交
npm test             # 160 项测试，自带 mock ComfyUI，不需要真装 ComfyUI
```

之后按方式 B / C 把它 link 进 profile 即可。

## 启用与验证

装好后：

1. **插件列表里能看到它**：条目名 `dsh-comfyui-image`（显示名「ComfyUI 图片生成」）；
2. **能开关**：它就是一个普通的 bundle 条目，用插件管理器开关，或在 profile 的 patch 里写 `disabled: true`；
3. **Agent 能看到工具**：模型侧会多出 `comfyui_generate_image` / `comfyui_generate_video` /
   `comfyui_generate_talking_video` / `comfyui_generate_audio` 四个（本会话的工具表里就有它们的完整 schema）；
4. **本机能不能真出图**，跑一次自检最省事：

```bash
cd <插件目录>
npm run doctor
```

自检会打印：生效配置 → ComfyUI 版本与设备 → 底模/采样器**真实可选值** → 逐模式判定可用性。

```
【模式可用性】
  ✓ 文生图 text2img：可用
  ✓ 图生图 img2img：可用
  ✓ 局部重绘 inpaint：可用
  ✗ 背景移除 remove_background：不可用
    → 本机 ComfyUI 里没有任何可用的背景移除节点。
```

退出码：`0` 四种模式全可用 / `1` 连不上 ComfyUI / `2` 连上了但有模式跑不了（便于脚本化）。
加 `--json` 输出机器可读结果，加 `--base-url http://主机:端口` 临时指定地址。

## 让 Agent 用它

启用后直接说人话即可，Agent 会自己填参数：

```text
帮我生成一张柯基宇航员在月球上的图，数字艺术风格
```

工具返回的文本长这样（**绝对路径单独占一行**，在 DSH 里可以直接点开）：

```text
✅ 出图成功（文生图，模式自动推断）

图片：C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png
元数据：C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png.json

参数：seed=1783492011 尺寸=1024x1024 steps=20 cfg=7
底模：sd_xl_base_1.0.safetensors
采样：euler / normal　耗时：12.4 秒
ComfyUI：http://127.0.0.1:8188（prompt_id=8f3c…）
```

更多用法（四种图片模式的调用示例、视频与说话视频怎么调、复现与微调、批量思路）见
[docs/USAGE.md](./docs/USAGE.md)、[docs/TALKING.md](./docs/TALKING.md)、[docs/AUDIO.md](./docs/AUDIO.md)。

另外三个工具同样说人话即可：

```text
让这张照片里的人说「今天天气不错，适合出门走走」，用 IndexTTS 克隆音色
```

```text
✅ 口型视频成功（图片 → 说话 → 口型）

视频：C:\Users\me\Desktop\comfyui-20261104-041233-7f2a.mp4
元数据：C:\Users\me\Desktop\comfyui-20261104-041233-7f2a.mp4.json

台词：今天天气不错，适合出门走走。
音色：IndexTTS-2 克隆音色 · D:/Tools/IndexTTS/ref_audio_voice.wav（indextts）
参数：832x480 24 fps · 141 帧 / 5.88 秒 · 语音 5.62 秒 · seed=1783492011
耗时：412.3 秒
```

## 配置

配置有**四层来源，高的赢**：

```
插件配置（profile 的 cordis.patch.yml 里那条 entry 的 config）
  > 配置文件 ~/.dsh-comfyui-image/config.json
    > 环境变量（COMFYUI_URL 等）
      > 内置默认值
```

插件配置放最高，是因为 DSH 的配置树是权威来源；而**配置文件**是给「只想改个地址、不想动 YAML」的人准备的便利层，
**改完立即生效，不用重启 DSH**。

最常用的一份 `~/.dsh-comfyui-image/config.json` 就长这样：

```json
{
  "baseUrl": "http://127.0.0.1:8188",
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "outputDir": "D:/images",
  "steps": 25,
  "timeoutMs": 600000,

  "videoModel": "Wan2.2-TI2V-5B-Q4_K_M.gguf",
  "videoVae": "Wan2.2_VAE.safetensors",
  "videoSeconds": 2,

  "ttsEngine": "indextts",
  "ttsSpkAudioPrompt": "D:/Tools/IndexTTS/ref_audio_voice.wav",
  "indexttsDir": "D:/Tools/IndexTTS",
  "indexttsPython": "D:/Tools/IndexTTS/.venv/Scripts/python.exe",
  "musetalkDir": "D:/Tools/MuseTalk",
  "musetalkPython": "D:/Tools/MuseTalk/venv/Scripts/python.exe",
  "ffmpegBin": "C:/FFmpeg/bin"
}
```

完整键表、环境变量对照、以及「配置不生效怎么办」见 [docs/CONFIG.md](./docs/CONFIG.md)。

## 工具参数速查

### `comfyui_generate_image`

| 参数 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `text2img` / `img2img` / `inpaint` / `remove_background`；不传按输入推断 |
| `prompt` | string | 正向提示词（`remove_background` 不需要） |
| `negative_prompt` | string | 负向提示词；不传用插件默认值 |
| `input_image` | string | 输入图路径（`img2img` / `inpaint` / `remove_background` 必填） |
| `mask_image` | string | 遮罩图路径（`inpaint` 必填）；**白/亮区 = 要重绘的区域** |
| `width` / `height` | integer | 输出尺寸，**仅 `text2img` 生效**；自动对齐到 8 的倍数 |
| `seed` | integer | 随机种子；同 seed + 同 prompt 可复现 |
| `output_path` | string | 输出目录或文件路径；不传落当前项目根目录 |
| `strength` | number | 改动幅度 0~1；`img2img` 默认 0.6，`inpaint` 默认 1.0 |
| `steps` | integer | 采样步数，默认 20 |
| `cfg_scale` | number | CFG，默认 7 |
| `model` | string | 底模文件名；不传自动挑（优先带 `xl` 的） |
| `sampler_name` / `scheduler` | string | 采样器 / 调度器；不传用默认值，不存在会明确报错 |
| `style_reference` / `character_reference` | string | **预留**：V1 只记录进元数据，不参与生成 |
| `extra_options` | object | 预留扩展位；`workflow_path` 可接管本次生成（见下） |

输出结构（`output.schema`）里包含 `path` / `files` / `mode` / `seed` / `width` / `height` / `steps` /
`cfg_scale` / `strength` / `model` / `sampler` / `scheduler` / `prompt_id` / `comfy_url` /
`duration_ms` / `success` / `mode_inferred` / `metadata_path` / `notes` 与给模型看的 `text`。

### `comfyui_generate_video`

| 参数 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `text2video` / `img2video`；不传按有没有 `input_image` 推断 |
| `prompt` | string | `text2video` 必填；`img2video` 只描述「怎么动」，不传有默认值 |
| `negative_prompt` | string | 不传用 Wan 专用中文负向串 |
| `input_image` | string | 首帧图（`img2video` 必填；`text2video` 给了会报错） |
| `seconds` | number | 期望时长，默认 2；**真实时长按 4n+1 帧对齐**，看返回的 `frames / fps` |
| `fps` | integer | 默认 24 |
| `width` / `height` | integer | 默认 832×480；自动对齐到 32 的倍数 |
| `seed` / `steps` / `cfg_scale` / `shift` | — | 默认 `seed` 随机、`steps` 30、`cfg` 5、`shift` 8 |
| `model` | string | 视频模型（unet）文件名；不传自动挑 Wan2.2 TI2V-5B |
| `output_path` | string | 输出目录或 `.mp4` 文件路径 |
| `extra_options` | object | 预留扩展位 |

输出结构含 `path` / `files` / `mode` / `mode_inferred` / `frames` / `fps` / `seconds` / `width` / `height` /
`seed` / `steps` / `cfg_scale` / `shift` / `prompt` / `model` / `vae` / `duration_ms` / `success` /
`notes` / `comfy_url` / `prompt_id` / `metadata_path` 与 `text`。

### `comfyui_generate_talking_video` / `comfyui_generate_audio`

两个工具共用同一套 TTS 参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `script` | string | **必填**，台词；最多 600 字，末尾没标点会自动补「。」 |
| `tts` | string | `indextts`（默认，克隆音色）/ `edge`（现成音色） |
| `spk_audio_prompt` | string | **indextts 必填**：3~15 秒参考音频，音色完全由它决定 |
| `emo_vector` | number[8] | 8 维情绪，顺序 `happy / angry / sad / afraid / disgusted / melancholic / surprised / calm`，各 0~1 |
| `emo_alpha` | number | 情绪强度 0~1（要配合 `emo_vector` 或 `emo_audio_prompt`） |
| `emo_audio_prompt` | string | 照着另一段音频的语气说（与 `emo_vector` 二选一） |
| `lang` | string | `ZH` / `EN` |
| `duration_factor` | number | 语速系数 (0, 3]，越大越慢 |
| `edge_voice` / `rate` | string | `tts=edge` 时用；另有 `edge_pitch` / `edge_volume`（仅 audio 工具） |
| `output_path` | string | 输出目录或文件路径 |

`comfyui_generate_talking_video` 另有 `input_image`（image2talking）/ `input_video`（video2talking）/
`prompt` / `negative_prompt` / `seconds` / `fps` / `width` / `height` / `seed` / `extra_options`。
它的输出结构含 `path` / `files` / `mode` / `script` / `voice` / `tts` / `audio_seconds` /
`video_seconds` / `fps` / `frames` / `width` / `height` / `seed` / `duration_ms` / `success` /
`mode_inferred` / `notes` / `metadata_path` / `comfy_url` / `prompt_id` 与 `text`。

逐参数的取值范围、默认值来源、以及每个参数在哪种模式下会被忽略，见 [docs/PARAMS.md](./docs/PARAMS.md)。

## 模式推断与报错规则

**图片**：不传 `mode` 时按这三条判断（写在 `src/params.ts` 里，README 只是抄一份）：

1. 有 `input_image` **且**有 `mask_image` → `inpaint`
2. 只有 `input_image` → `img2img`
3. 都没有 → `text2img`

**视频**：有 `input_image`（非空白）→ `img2video`，否则 `text2video`。

**说话视频**：`input_video` → `video2talking`；`input_image` → `image2talking`；都没有 → `text2talking`。

**冲突就报错，绝不猜**。常见的有：

| 情况 | 结果 |
|---|---|
| `mode=text2img` 却给了 `input_image` | 报错，并提示「想改图请显式传 `mode="img2img"`」 |
| `mode=img2img` 却给了 `mask_image` | 报错，并提示「有遮罩属于局部重绘，请传 `mode="inpaint"`」 |
| 给了 `mask_image` 但没有 `input_image` | 报错，局部重绘需要「原图 + 遮罩」两张 |
| `mode=inpaint` 没给 `mask_image` | 报错（V1 要求显式提供遮罩，不做自动抠图） |
| `input_image` / `mask_image` 路径不存在 | 报错，**在上传之前**就拦下来 |
| 非 `text2img` 传了 `width` / `height` | 不报错，但在结果 `notes` 里说明「已忽略，尺寸由输入图决定」 |
| `mode=text2video` 却给了 `input_image` | 报错，提示显式传 `mode="img2video"` |
| `mode=img2video` 没给 `input_image` | 报错 |
| `mode=text2video` 没给 `prompt` | 报错 |
| 视频帧数超过 481 | 报错，并算出该 fps 下最长多少秒 |
| `tts=indextts` 没给 `spk_audio_prompt` | 报错，提示「音色完全由参考音频决定」，或改用 `tts=edge` |
| `emo_vector` 与 `emo_audio_prompt` 同时给 | 报错，二选一 |

## 输出与文件

- **默认位置**：当前**项目根目录**（即 Agent 会话的工作目录）；也可以用 `output_path` 指定目录或文件。
- **命名**：`comfyui-<时间戳>-<随机4位>.png`；指定了文件名时**绝不覆盖**，同名就加 `-1` / `-2`。
- **元数据 sidecar**：`<图片路径>.json`，含插件版本、模式、全部参数、输入图、ComfyUI 地址与 `prompt_id`、
  以及**提交给 ComfyUI 的完整工作流**（可直接拿去 ComfyUI 里复现）。
- **ComfyUI 侧**：默认用 `SaveImage`，产出落在 ComfyUI 的 `output/dsh-comfyui-image/` 子目录里，
  文件名前缀是 `时间戳-seed`；不想污染 ComfyUI 的 output 目录就设 `saveToComfyUI: false`（改用 `PreviewImage`）。

## 风格 / 角色一致性（V1 现状）

V1 对一致性**只做到「预留 + 记录」**，不参与生成——请照这个预期使用：

- `style_reference` / `character_reference`：接收、校验文件存在、**写进元数据**，但不影响出图；
- `seed` + `prompt` + `model` + `sampler` + `scheduler`：V1 里**已经**能靠这一组复现同一张图；
- 元数据 sidecar 就是为后续做一致性准备的：它记录了每次生成的完整参数与工作流，
  以后要做 IPAdapter / 参考图 / 角色 LoRA，可以拿这批数据对齐。

## 扩展：用自定义工作流接管生成

V1 没内置的能力（**扩图 outpaint、超分 upscale、批量多图、特殊节点**），都能用逃生舱接进来：

1. 在 ComfyUI 界面里搭好工作流，导出 **API 格式**（菜单里的 *Save (API Format)*）；
2. 把需要变的字段换成占位符：`{{prompt}}`、`{{negative_prompt}}`、`{{width}}`、`{{height}}`、
   `{{seed}}`、`{{steps}}`、`{{cfg_scale}}`、`{{strength}}`、`{{checkpoint}}`、`{{input_image}}`、
   `{{mask_image}}`、`{{mode}}`；
3. 调用时传 `extra_options.workflow_path` 指向这个 JSON：

```json
{
  "mode": "img2img",
  "prompt": "upscale this, keep details",
  "input_image": "D:/pics/in.png",
  "extra_options": { "workflow_path": "D:/workflows/upscale.json" }
}
```

细节：`"{{width}}"` 这种**整个值就是一个占位符**的写法会保留类型（数字仍是数字），
嵌在句子中间的按字符串拼；没提供的占位符**原样保留**（便于发现自己拼错了）。
工作流末端记得接 `SaveImage` / `PreviewImage`，否则会报「任务结束但没有任何图片产出」。

## 常见问题

| 症状 | 先看这里 |
|---|---|
| 报「连不上 ComfyUI」 | ComfyUI 起了吗？地址对吗？容器里 `127.0.0.1` 指的不是宿主机 |
| 报「没有任何可用的底模」 | 往 `ComfyUI/models/checkpoints/` 放底模并在界面里刷新 |
| 报「没有节点 `ImageRemoveBackground+`」等 | 去背节点没装（只影响 `remove_background`），按提示装一套；注意 `pip install "rembg[cpu]"` |
| 报「任务结束但没有任何图片产出」 | 自定义工作流末端没接 `SaveImage` / `PreviewImage` |
| 报「ComfyUI 里没有节点 `Wan22ImageToVideoLatent`」 | ComfyUI 版本太旧，升级到带 Wan2.2 支持的核心版本 |
| 报「本机没有可用的 Wan 视频模型」 | Wan2.2 TI2V-5B 没放对位置；`models/diffusion_models/`（或 `unet/`）里要有它 |
| 视频出来的时长跟 `seconds` 不一致 | 正常：帧数按 4n+1 对齐，真实时长看返回的 `frames / fps` |
| 报「IndexTTS 合成语音失败」 | 看 hint 里那三条：`indexttsPython` 存在吗、`indexttsDir` 是不是仓库根、参考音频在不在 |
| 报「MuseTalk 没有产出成片」 | 去 `MuseTalk/results/v15/` 看有没有文件；常见是 `ffmpeg` 不在 PATH（插件已把 `ffmpegBin` 加进去，但要真有 `ffmpeg.exe`） |
| 口型对上了但音色不对 | 音色由 `spk_audio_prompt` 决定，换那段参考音频；`tts=edge` 时用 `edge_voice` |
| 出图 / 出片很慢 / 超时 | 调大 `timeoutMs`（图片）或 `videoTimeoutMs` / `talkingTimeoutMs`，或把 `steps` / 尺寸调小 |
| 改了 `config.json` 好像没生效 | 那一项是不是也在 profile 的插件 `config:` 里写了？插件配置优先级更高 |
| `width` 传了没用 | 只有 `text2img` 吃 `width` / `height`，其他模式画布由输入图决定 |

完整排查清单（含 `doctor` 输出怎么读、报错原文对照表）见 [docs/FAQ.md](./docs/FAQ.md)。

## 架构与目录结构

```
src/
  index.ts            插件入口：apply(ctx, config) → 注册四个工具
  tool.ts             图片工具对外契约：工具名、描述、参数 JSON Schema、输出 schema（要稳定）
  runner.ts           图片执行引擎：归一化 → 能力探测 → 上传 → 建工作流 → 提交 → 轮询 → 取图 → 落盘 → 元数据
  params.ts           图片参数层：模式推断、默认值、冲突报错
  config.ts           四层配置合并 + 校验（不依赖任何 schema 库）
  files.ts            路径解析、输出命名、读图
  result.ts           图片结果文本 / 输出结构
  errors.ts           带「下一步怎么办」的错误类型
  log.ts              调试日志
  comfy/
    client.ts         ComfyUI HTTP 客户端（/system_stats /object_info /upload/image /prompt /history /view /interrupt）
    nodes.ts          能力探测：挑底模、校验采样器、择优去背方案
    workflows.ts      纯函数工作流构建（四模式 + 自定义工作流 token 替换）
  video/              文生视频 / 图生视频
    presets.ts        视频模型能力探测与择优（Wan2.2 TI2V-5B + umt5 + Wan VAE）
    workflows.ts      Wan 工作流构建（Wan22ImageToVideoLatent / ModelSamplingSD3 / CreateVideo / SaveVideo）
    params.ts         帧数对齐 4n+1、尺寸对齐 32、耗时估算、模式推断
    runner.ts         视频执行引擎（上传首帧 → 提交 → 轮询 → 取 mp4 → 落盘 → 元数据）
    tool.ts / result.ts / types.ts
  talking/            台词 → 语音 → 说话画面 → 对口型
    tts.ts            TTS 命令行拼装（IndexTTS-2 / edge-tts）+ wav 归一化 + ffprobe 量长
    exec.ts           子进程执行（永不 reject，超时 / abort / error 都归一成退出码）
    lipsync.ts        MuseTalk 的 yaml 与 argv 拼装
    params.ts         台词长度、模式推断、宽高对齐、音色标签
    runner.ts         三段串联 + 中间产物目录 + 元数据
    tool.ts / result.ts / types.ts
  audio/              只配音（复用 talking/tts.ts 的 TTS 链路，不碰画面）
    runner.ts / tool.ts / result.ts / tts.ts / types.ts
lib/                  TypeScript 编译产物（**故意提交**：不装 TS 也能直接跑）
test/                 160 项测试 + mock ComfyUI（真 PNG 编解码、真上传、真轮询、真报错路径，含假 mp4 与假 TTS/MuseTalk 子进程）
scripts/run-tests.mjs 测试入口
scripts/doctor.mjs    自检脚本
docs/                 安装 / 配置 / 用法 / 参数 / 说话视频 / 配音 / FAQ / 路线图
```

设计上刻意分层：**对外契约**（`*/tool.ts`）要稳，**参数层**（`*/params.ts`）要可预测，
**执行层**（`*/runner.ts` + `comfy/`）随便改——换后端、加模式都只动最后一层。

> 两条实现约束（踩过，写在代码注释里）：插件里**不能 import 任何 `@deepseek-ai/*` 宿主包**
> （link 安装时必然 `ERR_MODULE_NOT_FOUND`，宿主服务用 `ctx.reflect.get('tools')` 拿即可）；
> 工具 `parameters` 必须是**原始 JSON Schema**，且只用 DSH 支持的子集（`minimum` / `format` 之类会被直接拒绝）。

## 开发

```bash
npm install
npm run build      # tsc → lib/
npm run typecheck  # 只检查不产出
npm test           # 160 项测试（自带 mock ComfyUI + 假 TTS/MuseTalk 子进程）
npm run doctor     # 对着真实 ComfyUI 体检
```

- `lib/` 是**提交进仓库**的编译产物，改了 `src/` 记得 `npm run build` 并在提交里带上 `lib/`；
- CI 会跑类型检查 + 构建 + 测试，并检查 `lib/` 与 `src/` 是否同步；
- 测试不需要真的装 ComfyUI：`test/mock-comfyui.mjs` 会真的编码 PNG、真的收上传、真的轮询出图。

## 路线图

V1 之后的计划（超分 / 扩图 / 批量 / 多后端 / 一致性）见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

## 许可协议

[MIT](./LICENSE)。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](./docs/INSTALL.md)（英文：[INSTALL.en.md](./docs/INSTALL.en.md)） | 安装教程：ComfyUI（含 Windows / Intel 显卡）+ 插件安装 + 去背节点 |
| [docs/CONFIG.md](./docs/CONFIG.md) | 配置说明：四层优先级、全部键表、环境变量、示例 |
| [docs/USAGE.md](./docs/USAGE.md) | 使用示例：四种图片模式 + 复现 / 微调 + 自定义工作流 + 只要配音 |
| [docs/TALKING.md](./docs/TALKING.md) | 说话视频：为什么分三段、三种模式、TTS / 说话画面 / MuseTalk 怎么装、耗时实测、踩过的坑 |
| [docs/AUDIO.md](./docs/AUDIO.md) | 纯配音：参数、两个 TTS 引擎、用 IndexTTS 表达情绪、输出与边界 |
| [docs/EMOTION_TTS_SELECTION.md](./docs/EMOTION_TTS_SELECTION.md) | 情绪配音选型：IndexTTS-2 与 edge-tts 的能力对照与取舍 |
| [docs/PARAMS.md](./docs/PARAMS.md) | 工具参数与输出结构逐项说明 |
| [docs/FAQ.md](./docs/FAQ.md) | 常见问题与故障排查 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 未来扩展计划 |
| [docs/RELEASING.md](./docs/RELEASING.md) | 发版流程：推 tag 自动建 Release、自动发 npm，以及 `NPM_TOKEN` 怎么配 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变化 |
