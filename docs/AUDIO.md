# 纯配音：一句台词 → 一个 wav

`comfyui_generate_audio` 是四个工具里**最短的一条链**：只做「台词 → 语音」，不碰 ComfyUI、不碰画面、不碰口型。

## 一、为什么要把配音单独拆出来

前面三个工具（`comfyui_generate_image` / `comfyui_generate_video` / `comfyui_generate_talking_video`）最终都要经过 ComfyUI 出画面。
而 `comfyui_generate_talking_video` 是**两段式端到端**：`① TTS → ② InfiniteTalk 一次生成带口型视频`（首帧由文生图 / 你提供 / 抽视频帧得到）。
哪怕你只想要一条配音，它也会老老实实把后面的 InfiniteTalk 生成跑完——那是二十分钟量级的开销，而你要的东西在第①段就做完了。

所以这个工具做的事只有一件：

```
台词 ──① TTS ──> 16kHz 单声道 wav（就这一步）
```

**它不需要 ComfyUI 在跑。** 但它仍然需要 `ffmpeg` / `ffprobe`（把 TTS 原始产物归一到 16kHz 单声道，并量出时长），
装法同[说话视频](./TALKING.md)。

## 二、参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `script` | string | — | **必填**。台词原文（中文直接写）。上限 600 字，句末没标点会自动补句号 |
| `tts` | string 枚举 | 配置里的 `ttsEngine`（默认 `indextts`） | `indextts` / `edge`。传了不认识的值得直接报错 |
| `spk_audio_prompt` | string | 配置里的 `ttsSpkAudioPrompt` | `indextts` 用：参考音频（3~15 秒干净人声）。**音色完全由它决定**，缺了就报错 |
| `emo_vector` | number[] | —（不带情绪） | `indextts` 用：8 维情绪向量，每维 0~1，顺序 `happy / angry / sad / afraid / disgusted / melancholic / surprised / calm`；全 0 等于不带情绪 |
| `emo_audio_prompt` | string | — | `indextts` 用：拿另一段音频的情绪来模仿。**与 `emo_vector` 互斥** |
| `emo_alpha` | number | `1` | `indextts` 用：情绪强度 0~1，越大越贴着指定情绪 |
| `lang` | string 枚举 | `ZH` | `indextts` 用：`ZH` / `EN` |
| `duration_factor` | number | `1` | `indextts` 用：时长系数 (0, 3]，>1 更慢更长 |
| `edge_voice` | string | `zh-CN-XiaoxiaoNeural` | `edge` 用：现成音色名（如 `zh-CN-XiaoyiNeural` / `zh-CN-YunxiNeural` / `zh-CN-YunjianNeural`） |
| `rate` | string | `-4%` | `edge` 用：相对语速，带百分号（如 `+30%`） |
| `edge_pitch` | string | —（不传即引擎默认） | `edge` 用：相对音高（如 `+40Hz`，抬高更尖锐、更冲） |
| `edge_volume` | string | —（不传即引擎默认） | `edge` 用：相对音量（如 `+30%`，提高音量像在吼） |
| `output_path` | string | 当前工作目录 | 给目录 → 里面自动起名；给 `xxx.wav` → 当文件路径（已存在则加 `-1`/`-2`，**绝不覆盖**） |

没有 `seed`：TTS 不是扩散采样，没有种子这一说，同一个引擎同一段台词出来的就是同一条音。

## 三、两个引擎，以及「语气不够强」怎么办

- **`tts=indextts`（默认）**：IndexTTS-2 **零样本克隆**——音色完全由 `spk_audio_prompt` 那段参考音频决定
  （换一段音频就换一个人的嗓子），情绪再由 `emo_vector`（8 维手工指定）或 `emo_audio_prompt`（拿另一段音频的情绪来模仿）
  加上 `emo_alpha` 调强度。代价是慢：6GB 显存上 RTF 约 87×，单条 2~4 分钟。
- **`tts=edge`**：edge-tts 的**现成音色**，`edge_voice` 挑人，`rate` 提语速——三项叠起来才有效果：

| 想要的效果 | 怎么叠 |
|---|---|
| 只是语速快一点 | `rate="+20%"` |
| 更冲、更尖 | `rate="+30%"` + `edge_pitch="+40Hz"` |
| 像在吼 | 上面再加 `edge_volume="+30%"` |

`edge_pitch` / `edge_volume` **不传就是引擎默认，不会塞一个 `+0Hz`**；音色标签里也不会因此多出一段空档。
内部一律按 `--pitch=+40Hz` 这种 `=` 形式拼命令行——值以 `+`/`-` 开头，空格形式会被 argparse 判成「缺参数」。

### 用 IndexTTS 表达情绪

8 维顺序是固定的，写错顺序等于情绪全反：

```json
{ "tts": "indextts", "emo_vector": [0, 0.8, 0, 0, 0, 0, 0, 0.2], "emo_alpha": 0.9 }
```

上面这组是「八成愤怒 + 两成平静，情绪强度 0.9」。不想手工调数字时，改用
`emo_audio_prompt` 给一段「照这个语气说」的参考音频，模型会去模仿它的情绪（两者互斥，同时给会报错）。

> 一句话总结：**要锁音色、要情绪颗粒度用 `indextts`；只要快、要现成嗓子用 `edge`。**
> 真机实测（RTX 3060 Laptop 6GB）：indextts 合成一条 4 秒台词约 **2~4 分钟**（RTF 约 87×，峰值显存 5.78GB）；
> edge 造一条 1.87 秒的 wav 约 **45 秒**（含 mp3 → wav 归一）。

### 传错引擎的参数会怎样

不会报错，但会在结果的 `notes` 里明说，避免你以为它生效了：

- `tts=edge` 时传了 `spk_audio_prompt` / `emo_vector` / `emo_alpha` / `emo_audio_prompt` → 「tts=edge 时 spk_audio_prompt / emo_vector / emo_alpha / emo_audio_prompt 不生效（那是 IndexTTS 的参数）。」
- `emo_vector` 与 `emo_audio_prompt` 同时给 → 直接报错「只能二选一」，不猜你想用哪个。
- 只给 `emo_alpha` 却没给情绪来源 → `notes` 里说明「情绪强度无处施加，已忽略」。

## 四、输出

| 项 | 说明 |
|---|---|
| 音频 | `<output_path 或当前工作目录>/comfyui-audio-<时间戳>-<随机4位>.wav`，16kHz 单声道 |
| 元数据 | 同目录同名 `.json`（台词、引擎与音色标签、时长、耗时、notes）；配置里 `writeMetadata: false` 时不写 |
| 结果文本 | `✅ 音频生成成功` + `音频：<绝对路径>` + 可选 `元数据：<绝对路径>` + 台词 / 音色 / 时长 / 耗时 / notes |

两个细节：

- **绝不覆盖**：目标已存在时依次试 `-1`、`-2`……（到 999），全占满才报错。
- **不落 ComfyUI output**：这个工具压根不连 ComfyUI，产物只在你指定的目录里。

## 五、报错与边界

| 情况 | 表现 |
|---|---|
| `script` 为空 / 只有空白 | 明确报错：「script 不能为空：独立音频工具必须有台词才能合成语音。」 |
| `script` 超过 600 字 | 明确报错并带上实际字数与 600 上限，提示「请拆成多段分别生成再拼接」（**不静默截断**） |
| `tts` 传了不是 `indextts`/`edge` 的值 | 明确报错：「不认识的 tts：…」，提示只能是这两个 |
| `tts=indextts` 但没有可用的参考音频 | 明确报错：「需要 spk_audio_prompt（一段 3~15 秒的参考音频）：IndexTTS 的音色完全由它决定。」 |
| `emo_vector` 不是 8 维 / 有值超出 0~1 | 明确报错并指出是第几维（哪一项情绪） |
| `emo_alpha` 不在 0~1 / `duration_factor` 不在 (0,3] | 明确报错并给范围 |
| `lang` 不是 `ZH`/`EN` | 明确报错：「IndexTTS 只支持 ZH / EN。」 |
| TTS 进程非零退出 | 报错带退出码 + stderr 最后一行有意义的内容 |
| TTS 正常退出但没产出文件 | 报错「…正常退出但没有产出 wav / 文件。」 |
| `ffprobe` 量不出时长 | 报错「量不出语音时长。」 |
| 需要对口型视频 | 用 `comfyui_generate_talking_video`，它内部复用同一套 TTS 计划 |

## 六、能力边界

- **能锁音色、也能换情绪**：`indextts` 用一条参考音频锚定音色，再用 `emo_vector` / `emo_audio_prompt` 换情绪。
  但它**不能凭空造音色**——没有参考音频就没有音色；想要「不用准备素材」仍得用 `edge` 的现成嗓子。
- **慢**：IndexTTS 单条 2~4 分钟（6GB 显存）。只要一句配音、对情绪没要求时，`edge` 几秒就出。
- **不做后处理**：不降噪、不混响、不做等响度，出来的是干净但「素」的 16kHz 单声道。
- **不对口型**：本工具只出音频。要口型请用 `comfyui_generate_talking_video`——它内部会用同一套 TTS 计划**再合成一遍**语音，
  本工具产出的 wav 不参与那条链。