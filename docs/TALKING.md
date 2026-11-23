# 说话视频：台词 → 语音 → 首帧 → InfiniteTalk 端到端

`comfyui_generate_talking_video` 把一句话变成一条**口型对得上**的人像视频。这份文档讲清楚三件事：
为什么可以端到端一次生成、依赖哪些模型、以及装这些模型时踩过的坑。

---

## 一、为什么是端到端，而不是「无声视频 + 贴嘴」

旧方案（v0.5.0 及之前）走的是 Wan2.2 图生视频 + MuseTalk 局部重绘：先出一条无声说话视频，
再用 MuseTalk 只重绘嘴部 256×256 区域贴回，代价是嘴部边缘轻微柔化、贴片发糊。

现在对口型引擎换成 **InfiniteTalk**（kijai 版 `ComfyUI-WanVideoWrapper` 内），一次生成就把口型带出来：

```text
台词 ──① TTS ──> wav ─────────────────┐
                                       ├─③ InfiniteTalk 一次生成 ──> 带音轨成片
首帧 ──② 文生图 / 你提供 / 抽视频帧 ───┘
```

第 ③ 步是**端到端生成**：台词 → TTS → 首帧人像 → InfiniteTalk 一次生成带口型视频。
**没有**「无声视频 + 局部贴回嘴部」两步，因此**没有 MuseTalk 那种嘴部边缘柔化 / 贴片模糊**。
首帧只决定长相与起始构图，台词与口型由 InfiniteTalk 一次生成。

---

## 二、三种模式

| 模式 | 需要的输入 | 内部动作 | 什么时候用 |
|---|---|---|---|
| `text2talking` | 只有 `script` | 文生图造首帧 → TTS → InfiniteTalk | 什么都没准备，先看看效果 |
| `image2talking` | `script` + `input_image` | 图片作首帧 → TTS → InfiniteTalk | 已经有一张人像 |
| `video2talking` | `script` + `input_video` | 抽视频首帧 → TTS → InfiniteTalk 重新生成 | 已有视频，想换台词 / 换音色 |

不传 `mode` 时的推断顺序：有 `input_video` → `video2talking`；有 `input_image` → `image2talking`；
都没有 → `text2talking`。显式指定但缺对应输入会**直接报错**，不会猜。

> `video2talking` 只抽视频的首帧当起点，**不保留原视频的动作**——口型、动作都由 InfiniteTalk 重新生成。

### 素材怎么准备才好用

- **正脸、对着镜头、脸够大**（占画面高度 1/4 以上）。侧脸、低头、脸太小都会让效果打折。
- 画面里**只有一个人**。多人场景容易挑错人。
- 首帧最好是「闭嘴、表情自然」的状态。
- 帧数由语音时长算（25fps，对齐到 4n+1），不用手填。

---

## 三、依赖与装法

### ① TTS

| `tts` | 引擎 | 音色来源 | 需要装什么 |
|---|---|---|---|
| `indextts`（默认） | IndexTTS-2 | **零样本克隆**：音色由 `spk_audio_prompt` 参考音频决定，情绪由 `emo_vector` / `emo_audio_prompt` 决定 | `D:/Tools/IndexTTS` + its venv（权重 ~12GB） |
| `edge` | edge-tts | 微软现成音色（14 个中文） | 已迁到 **IndexTTS 的 venv**（`D:/Tools/IndexTTS/.venv/Scripts/python.exe`），在该 venv 里 `pip install edge-tts` 即可 |

IndexTTS-2 装法（权重放 `D:/Tools/IndexTTS/checkpoints/`）：

```bash
git -c http.sslBackend=openssl clone --depth 1 https://github.com/index-tts/index-tts.git D:/Tools/IndexTTS
# 权重放 D:/Tools/IndexTTS/checkpoints/（HF/ModelScope 仓库 IndexTeam/IndexTTS-2）
# 参考音频放 D:/Tools/IndexTTS/ref_audio_voice.wav（3~15 秒干净人声，音色完全由它决定）
```

venv 用 Python 3.11 + torch 2.x + transformers，装好仓库自带的 `uv pip install -e .` 依赖。
本机额外放了一个包装脚本 `D:/Tools/IndexTTS/dsh_indextts_infer.py`（插件调它，负责把
`--spk_audio_prompt / --text / --output / --lang / --emo_vector / --emo_alpha / --emo_audio_prompt /
--duration_factor` 转成 IndexTTS2 的 `infer()` 调用），并把产物写到 `--output` 指定路径。

### ② InfiniteTalk 模型清单（都在 ComfyUI/models 下，需用户预先下载）

ComfyUI 需要先装 kijai 的 `ComfyUI-WanVideoWrapper`（含 InfiniteTalk / multitalk 支持）及其依赖节点。
下列模型缺一不可，放到对应目录：

| 文件 | 大小 | 作用 | 常见来源 |
|---|---|---|---|
| `diffusion_models/wan2.1-i2v-14b-480p-Q3_K_S.gguf` | ~7.4GB | 主模型（i2v 14B 480p，Q3_K_S 量化） | HF `kijai/WanVideo_comfy` |
| `diffusion_models/Wan2_1-InfiniteTalk_Single_Q4_K_M.gguf` | ~1.4GB | InfiniteTalk patch | HF `kijai/WanVideo_comfy` |
| `loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank16_bf16.safetensors` | — | 4 步蒸馏 LoRA（把采样压到 4 步） | HF `lightx2v/I2V_14B_480p_cfg_step_distill` |
| `wav2vec2/wav2vec2-chinese-base_fp16.safetensors` | — | 音频编码器（中文 wav2vec2） | HF `kijai/WanVideo_comfy` / 由中文 wav2vec2-base 转 fp16 |
| `vae/wan_2.1_vae.safetensors` | — | Wan 2.1 VAE | HF `kijai/WanVideo_comfy` |
| `text_encoders/umt5_xxl_bf16_dequant.safetensors` | — | 文本编码器（**bf16 反量化版**） | 由 fp8 scaled 版反量化得到；`WanVideoTextEncodeCached` 节点拒绝 fp8 scaled，必须转成 bf16 |

---

## 四、分辨率自动分级与耗时（RTX 3060 Laptop 6GB 实测）

InfiniteTalk 端到端的耗时对**帧数**呈超线性；本机 6GB 显存下，同一台词用 832x480 可能卡死近 2 小时，
降到 512x320 就能在分钟级出片，而口型清晰度无损（端到端生成，没有贴片柔化）。
所以插件**按规划帧数自动选分辨率**：

| 规划帧数 | 自动分辨率 | 说明 |
|---|---|---|
| ≤ 60 帧（约 ≤ 2 秒台词） | 832x480 | 高清，短台词耗时可控 |
| > 60 帧（长台词） | 512x320 | 保出片；口型清晰度不受影响 |

- **显式传了 `width` 或 `height` 就完全尊重你的选择**，不自动降级（想长台词又高清就自己传，但要接受可能超时）。
- 分级发生在 TTS 之后、首帧之前：先用语音真实时长算帧数，再定分辨率，首帧缩放与采样用同一个尺寸。
- 结果 `notes` 里会写明「分辨率自动从 832x480 降到 512x320」，结果与元数据里的 `width`/`height` 是实际用值。

实测耗时对照（`image2talking` + `tts=edge`）：

| 台词 | 帧数 | 832x480 | 512x320 |
|---|---|---|---|
| 1.5 秒 | 41 帧 | ≈ 7 分钟 ✅ | — |
| 2.9 秒 | 77 帧 | 卡死 ~2 小时 ❌ | ≈ 3 分钟 ✅ |
| 5 秒 | 121 帧 | 超时 2 小时 ❌ | ≈ 12.5 分钟 ✅ |
| 7 秒 | 172 帧 | 超时 2 小时 ❌ | 卡死 20 分钟 0/4 ❌ |

帧数由语音时长算（25fps，4n+1 对齐），不传 `seconds` 时插件自动算。
`tts=index` 还要先花 2~4 分钟合成语音（`tts=edge` 秒出）；`text2talking` 另加约 1 分钟文生图首帧。
实用边界约 5 秒台词；再长的台词建议拆成多段分别生成再拼接。别拿它跟「MuseTalk 2 分钟」对比——那是两种引擎。

---

## 五、踩过的坑（都已在代码 / 环境里兜住，但值得知道）

1. **6GB 显卡必须这么配**：`attention_mode=sdpa`、T5 用 `umt5_xxl_bf16_dequant`（不是 fp8 scaled）、
   LoRA `merge_loras=false`、开 **block swap**。少一项就可能 OOM 或节点报错。
2. **`WanVideoTextEncodeCached` 拒绝 fp8 scaled 文本编码器**：umt5_xxl 的 fp8 scaled 版会被拒，
   必须先反量化成 bf16（`umt5_xxl_bf16_dequant.safetensors`）。
3. **transformers 5.x 补丁**：本机 transformers 5.x 的 `Wav2Vec2Encoder` 不再返回逐层 `hidden_states`，
   导致 WanVideoWrapper 的 `multitalk/nodes.py` 报 `'NoneType' object is not subscriptable`。
   已给 `ComfyUI-WanVideoWrapper` 的 `multitalk/wav2vec2.py` 打了 forward hook 补丁，重建 13 层
   `hidden_states`（保留 `.bak` 可回退）。**升级 transformers 或 wrapper 后若复现需重打补丁。**
4. **edge-tts 已迁到 IndexTTS 的 venv**（`D:/Tools/IndexTTS/.venv/Scripts/python.exe`），
   不再依赖 MuseTalk 的 venv。配置项删掉了旧的 MuseTalk 路径项，
   环境变量也删掉了对应的旧项；edge-tts 现在走 `indexttsPython`。
5. **IndexTTS 必须有参考音频**：`spk_audio_prompt` 缺失会直接报错。配置项 `ttsSpkAudioPrompt`
   默认 `D:/Tools/IndexTTS/ref_audio_voice.wav`。
6. **`emo_vector` 与 `emo_audio_prompt` 互斥**，同时给会报错；`emo_vector` 必须正好 8 维、每维 0~1，
   顺序是 `happy / angry / sad / afraid / disgusted / melancholic / surprised / calm`，写错顺序情绪就反了。
7. **venv 移动会让 `Scripts\*.exe` 失效**（内部 shebang 是旧绝对路径）。一律用
   `venv\Scripts\python.exe -m 模块`；edge-tts 走 `python -m edge_tts`。

---

## 六、能力边界

- **端到端一次生成**，没有嘴部贴片与边缘柔化；成片时长由语音时长决定（25fps，4n+1 对齐）。
- 单条任务，不做超分、不做背景替换、不做多脸；`video2talking` 不保留原视频动作。
- **慢且对帧数敏感**：靠上面的自动分级把长台词降到 512x320 保出片；再长建议拆段。
- 首次运行会各加载一次模型，之后同一个进程内复用不会更快——插件每条都是新进程。
- **口型是「弱驱动」，不是逐音素精确对口型**。这是此类音频驱动说话模型的普遍局限（非插件 bug）：
  - 音画**时间轴严格同步**：成片音轨 vs TTS 源 wav 逐采样点比对，相关 **+0.9998 @ lag 0**，零错位。
  - 嘴部动作**确实由音频驱动**：base + 前 2s 静音 + 后 2s 语音的受控样本，静音段 / 语音段
    嘴张度（MAR）分离比约 **1.64×**（0.058 vs 0.095）。
  - 但**长静音时嘴不闭合**：真语音中段硬插 1.5s 静音，中段 MAR 与语音段几乎相同（约 1.01×）——
    生成结果与基础嘴形混合，不主动收嘴。
- **别用「嘴张度×音量相关性」或 SyncNet 类自动指标评判这条链路的口型**——已全部证伪：
  在**对齐已知正确**的受控样本上，嘴张度与音量的相关照样是 **r≈−0.5**（指标本身无效）。
  唯一有效判据是上面那种**静音段 vs 语音段的嘴张度分离度**对照实验。
