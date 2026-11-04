# 说话视频：台词 → 语音 → 说话画面 → 对口型

`generate_talking_video` 把一句话变成一条**口型对得上**的人像视频。这份文档讲清楚三件事：
为什么必须分三段、每段靠什么工具、以及装这些工具时踩过的坑。

---

## 一、为什么必须分三段

Wan2.2 图生视频**没有音频输入**。它能让人物「像在说话」地开合嘴，但嘴型和台词毫无关系
（我们实测过：用反向验证的手段算嘴部开合与音频包络的相关性，随机开合的相关系数是 **-0.002**，
基本就是无关噪声）。

所以要做的是把一个**只改嘴**的模型接在图生视频后面：

```text
台词 ──① TTS ──> wav ──────────────┐
                                    ├─③ MuseTalk 1.5：只重绘嘴部区域再贴回 ──> 带音轨成片
画面 ──② 图生视频 ──> 无声说话视频 ─┘
```

第 ③ 步不改构图、不改身体、不改背景，只重绘嘴那一块（256×256 的重建区域贴回原图）。
代价是嘴部边缘会有轻微柔化——这是 MuseTalk 的固有特性，不是 bug。

---

## 二、三种模式

| 模式 | 需要的输入 | 内部动作 | 什么时候用 |
|---|---|---|---|
| `text2talking` | 只有 `script` | 文生图造正脸 → 图生视频 → 对口型 | 什么都没准备，先看看效果 |
| `image2talking` | `script` + `input_image` | 图生视频 → 对口型 | 已经有一张人像 |
| `video2talking` | `script` + `input_video` | 只做 TTS → 对口型 | 已经有说话视频，只想换台词/换音色 |

不传 `mode` 时的推断顺序：有 `input_video` → `video2talking`；有 `input_image` → `image2talking`；
都没有 → `text2talking`。显式指定但缺对应输入会**直接报错**，不会猜。

### 素材怎么准备才好用

- **正脸、对着镜头、脸够大**（占画面高度 1/4 以上）。侧脸、低头、脸太小都会让关键点检测失准。
- 画面里**只有一个人**。多人场景 MuseTalk 只会挑最显眼的那张脸。
- 首帧最好是「闭嘴、表情自然」的状态。
- 视频时长**不短于音频**更好：MuseTalk 会把画面补到音频长度（视频短了就在尾部补静止帧）。

---

## 三、三段各自的工具与装法

### ① TTS

| `tts` | 引擎 | 音色来源 | 需要装什么 |
|---|---|---|---|
| `indextts`（默认） | IndexTTS-2 | **零样本克隆**：音色由 `spk_audio_prompt` 参考音频决定，情绪由 `emo_vector` / `emo_audio_prompt` 决定 | `D:/Tools/IndexTTS` + its venv（权重 ~12GB） |
| `edge` | edge-tts | 微软现成音色（14 个中文） | `pip install edge-tts` 即可 |

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

### ② 说话画面

复用 `generate_video` 那套 Wan2.2 TI2V-5B（GGUF Q4_K_M 3.2GB + Wan2.2_VAE 1.3GB + umt5 文本编码器 6.7GB），
见 [VIDEO.md](./VIDEO.md)。这一段的 `prompt` 由插件自动补一段「正面、对着镜头说话、镜头固定」的描述，
用户传的 `prompt` 只用来描述长相与场景——**台词不要写进 prompt**，写进 `script`。

### ③ 对口型：MuseTalk 1.5

```bash
git -c http.sslBackend=openssl clone --depth 1 https://github.com/TMElyralab/MuseTalk.git D:/Tools/MuseTalk
```

权重清单（`D:/Tools/MuseTalk/models/`），字节数是校验过的：

| 文件 | 字节数 | 来源 |
|---|---|---|
| `musetalkV15/unet.pth` | 3,400,074,924 | ModelScope `AI-ModelScope/MuseTalk` |
| `musetalkV15/musetalk.json` | 748 | 同上 |
| `sd-vae/diffusion_pytorch_model.bin` | 334,707,217 | HF `stabilityai/sd-vae-ft-mse` |
| `sd-vae/config.json` | 547 | 同上 |
| `whisper/pytorch_model.bin` | 151,095,027 | HF `openai/whisper-tiny` |
| `dwpose/dw-ll_ucoco_384.pth` | 406,878,486 | HF `yzd-v/DWPose` |
| `face-parse-bisent/79999_iter.pth` | 53,289,463 | HF `ManyOtherFunctions/face-parse-bisent` |
| `face-parse-bisent/resnet18-5c106cde.pth` | **46,827,520** | `download.pytorch.org`（**必须官方那份**） |
| `musetalk/utils/face_detection/detection/sfd/s3fd.pth` | 89,843,225 | `adrianbulat.com` |

SyncNet **不用下**（只有训练脚本 import 它，省 1.4GB）。

venv 用 Python **3.11**：torch 2.0.1+cu118 / torchvision 0.15.2+cu118 / mmcv 2.1.0（openmmlab 官方 cu118 轮子）/
mmengine 0.10.7 / mmpose 1.3.2（`--no-deps` 装）/ mmdet 3.3.0（`--no-deps`）/ numpy 1.26.4 / matplotlib 3.7.5 /
scipy 1.11.4 / diffusers 0.30.2 / accelerate 0.28.0 / transformers 4.39.2 / librosa / soundfile / imageio-ffmpeg
/ pycocotools / edge-tts。

---

## 四、跑一次要多久（RTX 3060 Laptop 6GB 实测）

| 段 | 2 秒画面 / 49 帧 | 5 秒画面 / 121 帧 | 备注 |
|---|---|---|---|
| ① IndexTTS-2 | ≈ 2~4 分钟（RTF 87×） | 同左 | 显存峰值 5.78GB；**这一段最贵** |
| ② Wan2.2 图生视频 | ≈ 3.5 分钟（832×480 / 30 步） | ≈ 14 分钟 | 显存峰值 5.5GB；首帧图另需 ~1 分钟 |
| ③ MuseTalk | ≈ 2 分钟（帧数按音频长度算） | ≈ 2 分钟 | 显存 <4.5GB |
| **合计** | **≈ 9 分钟** | **≈ 20 分钟** | `video2talking` 跳过第 ② 段，≈ 5 分钟 |

真机端到端（`image2talking`，台词 4.18 秒，`seconds=5` → 121 帧）：**1045.2 秒（17.4 分钟）**，
产出 832×480 / h264 **100 帧 / 4.167 秒**画面 + aac 4.18 秒音轨，338,149 字节。
注意成片是 **100 帧而不是 121 帧**：MuseTalk 会把画面裁到音频长度。

> 这组数字是 v0.4.0（Spark-TTS 时代）测的，② ③ 两段与引擎无关、仍然成立；① 段现在换成 IndexTTS-2，
> 单段实测 2~4 分钟（见上表），所以 v0.5.0 的合计会比 17.4 分钟**再长几分钟**。
> 换成 IndexTTS 后尚未重跑完整 `image2talking`（本机 ComfyUI 当时未运行），只单独验证了 ① 段。

**所以别乱传 `seconds`**：不传时插件按「语音时长 + 0.3 秒」自动算，4 秒台词给 2 秒画面就够，
第 ③ 段会自动补齐——这能省掉第 ② 段 10 分钟。

---

## 五、踩过的坑（都已在代码里兜住，但值得知道）

1. **`resnet18-5c106cde.pth` 必须官方那份**。HF 镜像给的只有 44,782,818 B（截断），
   `torch.load` 报 `_pickle.UnpicklingError: unpickling stack underflow`。官方是 **46,827,520 B**。
2. **MuseTalk 的 ffmpeg 调用没有引号**（`scripts/inference.py` 里直接拼 `-i {video_path}`），
   **路径带空格会被拆开**，表现为「读到 0 帧」。插件因此会把素材先拷进 `<musetalkDir>/inputs/` 再跑。
3. **`--ffmpeg_path` 和 PATH 都要给**，否则 MuseTalk 内部拿不到 ffmpeg。
4. **chumpy 在 Python 3.11 上装不动** → mmpose 必须 `--no-deps`，再单独补 scipy / xtcocotools / json_tricks /
   munkres / shapely / terminaltables；mmpose 1.3.2 还会 import mmdet → 再 `--no-deps` 装 mmdet。
5. **numpy 版本三角债**：numpy 1.23.5 会让新版 matplotlib 报错，scipy 1.17 又要 numpy ≥1.26。
   稳定组合是 **numpy 1.26.4 + matplotlib 3.7.5 + scipy 1.11.4**。
6. **IndexTTS 必须有参考音频**：它不做「凭空造音色」，`spk_audio_prompt` 缺失会直接报错。
   插件因此把 `ttsSpkAudioPrompt` 设成配置项（默认 `D:/Tools/IndexTTS/ref_audio_voice.wav`）。
7. **`emo_vector` 与 `emo_audio_prompt` 互斥**，同时给会报错；`emo_vector` 必须正好 8 维、每维 0~1，
   顺序是 `happy / angry / sad / afraid / disgusted / melancholic / surprised / calm`，写错顺序情绪就反了。
8. **venv 移动会让 `Scripts\*.exe` 失效**（内部 shebang 是旧绝对路径）。一律 `venv\Scripts\python.exe -m 模块`；
   `edge-tts` 走 `python -m edge_tts`。
9. **MuseTalk 的坐标缓存**（`results/../<视频名>.pkl`）在同一段视频换音色重跑时能省一遍关键点检测，
   插件对同一工作目录复用这份缓存。

---

## 六、能力边界

- 只重绘嘴部 256px 区域，**嘴部边缘会柔化**；分辨率越高越不明显。
- 成片时长以音频为准：视频比音频短会补静止帧，长会被截断。
- 单条任务，不做超分、不做背景替换、不做多脸。
- 首次运行会各加载一次模型（IndexTTS ~40s、MuseTalk ~10s），之后同一个进程内复用不会更快——插件每条都是新进程。
- **口型是「弱驱动」，不是逐音素精确对口型**。这是 MuseTalk v15 的固有局限（非插件 bug，改插件修不了），
  2026-11 用受控实验逐条验证过：
  - 音画**时间轴严格同步**：成片音轨 vs TTS 源 wav 逐采样点比对，相关 **+0.9998 @ lag 0**，零错位。
  - 嘴部动作**确实由音频驱动**：base 视频 + 前 2s 静音 + 后 2s 语音的受控样本，静音段/语音段嘴张度（MAR）
    分离比 **1.64×**（0.058 vs 0.095）。
  - 但**长静音时嘴不闭合**：真语音中段硬插 1.5s 静音，中段 MAR 与语音段几乎相同（1.01×）——
    重绘结果与基础视频的嘴形混合，不主动收嘴。
- **别用「嘴张度×音量相关性」或 SyncNet 类自动指标评判这条链路的口型**——已全部证伪：
  在**对齐已知正确**的受控样本上，嘴张度与音量的相关照样是 **r≈−0.5**（指标本身无效）。
  唯一有效判据是上面那种**静音段 vs 语音段的嘴张度分离度**对照实验。
