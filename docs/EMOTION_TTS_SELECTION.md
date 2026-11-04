# 情绪 TTS 引擎选型报告（已落地：IndexTTS-2.5）

> 目的：为 `generate_audio` / `generate_talking_video` 选一个带细粒度情绪控制的 TTS 引擎。
>
> **状态：已落地。** 插件 v0.5.0 起 `tts=indextts` 为默认引擎，取代原来的 Spark-TTS；
> 本文保留完整选型过程与对比数据，供日后换型或评估其他候选时参考。
>
> 硬约束环境：Windows 11，RTX 3060 Laptop 6GB VRAM，驱动 617.42，Python 3.11，CUDA Toolkit 12.8 已就绪。D 盘剩余 57GB。

---

## 结论（已执行）

| 推荐 | 引擎 | 理由 |
|------|------|------|
| **首选** | **CosyVoice 3（0.5B）** | Apache-2.0，中文最好，instruct2 支持「生气/开心/伤心」三情绪 + 音量大小 + 语速 + 方言，权重 fp32 3.44GB，6GB 有社区实测，安装难度低-中。 |
| **情绪天花板 → 实际选用** | **IndexTTS-2.5（0.8B）** | 情绪控制最强（8 维情绪向量 + 情感参考音频 + 强度 + 时长系数），已在本机 6GB 上跑通实测（见下方「实测数据」）。 |
| **备选（最省事）** | **GPT-SoVITS v2Pro/v4** | 官方 Windows 一键包，安装最简单，MIT，**但无情绪参数**（只能靠参考音频带风格）。 |

**为什么换掉 Spark-TTS**：它只有 `gender` × `pitch` × `speed` 三个 5 档旋钮，做不出「愤怒/尖锐/提高音量」这类细粒度情绪，
也不能「锁住一个音色再换情绪」。IndexTTS-2.5 用 `spk_audio_prompt` 锁音色、`emo_vector` / `emo_audio_prompt` 换情绪，
两者解耦，正是缺的能力。

### 实测数据（本机 RTX 3060 Laptop 6GB，2026-11-01）

| 指标 | 实测值 |
|---|---|
| 显存峰值 | **5.78GB**（6GB 卡可跑，没有 OOM，但余量很小） |
| RTF（实时率） | 约 **87×**：一条 4 秒台词要 2~4 分钟 |
| 输出 | 22kHz 单声道 wav（插件再归一成 16kHz） |
| 权重体积 | 约 12GB（`D:/Tools/IndexTTS/checkpoints/`） |

结论：**6GB 卡能跑，但慢**。这也是为什么 `generate_audio` 仍保留 `tts=edge`——只要一句配音、不挑情绪时，edge-tts 几秒就出。

---

## 候选对比表

| 候选 | 中文 | 情绪控制机制与粒度 | 6GB 可行性 | 安装难度 | License |
|------|------|-------------------|-----------|---------|---------|
| **CosyVoice 3**（0.5B） | 9 语 + 18+ 方言 | instruct2：3 情绪（开心/伤心/生气）+ 音量大/小 + 语速 + 方言；token 级 `[laughter]`/`[breath]`。**无情绪向量、无情感参考音频** | ✅ 权重 fp32 3.44GB（llm 2.02 + flow 1.33 + hift 0.08），加 ONNX 分词器 <5GB；社区有 6GB 实测 | 低-中：conda py3.10，ttsfrd 仅 Linux 轮子→自动回落 wetext | **Apache-2.0** |
| **IndexTTS-2.5**（0.8B） | 中/英/日/西/阿 | **最强**：`emo_audio_prompt`（情感参考音频）+ `emo_vector` 8 维[高兴,愤怒,悲伤,害怕,厌恶,忧郁,惊讶,平静] + `emo_text` 文本情绪 + `emo_alpha` 强度 + `duration_factor` 语速；与 `spk_audio_prompt` 解耦 | ⚠️ 临界：第三方库标 FP16≥6GB、官方「约 6GB」、8GB 推荐；官方 wiki 无 2.5 具体数字 | 中-高：**官方只支持 uv**（[issue #313](https://github.com/index-tts/index-tts/issues/313)）；Windows 需 CUDA Toolkit 12.8+；DeepSpeed 难装 | bilibili Model Use License（免费；月活>1亿或年营收>10亿须单独授权） |
| IndexTTS-2（1.5B） | 中英 | 与 2.5 同等情绪控制 | ❌ 官方 wiki 10GB 显存 | 同上 | 同上 |
| **GPT-SoVITS v2Pro/v4** | 中英日韩粤 | **无情绪参数**（README Todo「emotion control」未打勾），只能靠参考音频带风格 | ✅ | **最低**：官方 Windows 一键包（HF `lj1995/GPT-SoVITS-windows-package` .7z，双击 `go-webui.bat`） | **MIT** |
| F5-TTS（0.3B） | 中英 | 无参数，仅参考音频风格 | ✅ | 低：`pip install f5-tts` | 代码 MIT / **模型 CC-BY-NC** |
| Fish-Speech S2-Pro（4B） | ~100 语 | 方括号自然语言标签 `[angry]`/`[whisper]`/`[laughing]` | ❌ bf16≈8GB（需量化） | 中 | Fish Audio Community License（年营收<50 万美元可商用） |
| Fish-Speech S1-mini（0.5B） | 13 语含中文 | 括号标签：**50+ 情绪词** (angry)(sad)(excited)(satisfied)…、tone (shouting)(whispering)、special (laughing)(sobbing)；零样本克隆(10–30s 参考音频)＋情绪标签可同用 | ✅ 旧代 4GB(推理)/8GB(微调)，v1.5.1 起 8GB OOM ⇒ 6GB 只有旧代这一线 | 中：`pip install -e .`/`uv sync`；Triton/compile 官方明确不支持 | S1-mini 模型卡 **cc-by-nc-sa-4.0（非商用）** |
| EmotiVoice（网易） | 中英（2000+ 音色）| prompt 文本框格式 `音色id\|情绪\|音素\|文本`，Happy/Sad/Angry 预设 | ✅ 模型很小（~8000万参数，FP32≈320MB，弱证据） | 中：官方只给 Docker（需 WSL2），**无 Windows 一键包** | **Apache-2.0** |
| VibeVoice-1.5B（微软）| 英/中 | **无情绪参数**；官方 2025-09-05 已从仓库移除 TTS 代码（docs 标「Disabled due to widespread misuse」） | ❌ | — | 权重 MIT，仅研究用途 |
| MegaTTS3（字节 0.45B）| 中英+混读 | 无情绪参数；`t_w`(2~5)/`p_w` 间接项 | ❌ [issue #67](https://github.com/bytedance/MegaTTS3/issues/67)：200 字符即占 11GB VRAM；WavVAE encoder 权重未发布 | — | — |
| Step-Audio 2 | 中文最强 | **无独立情绪参数**（情绪只在「理解」侧） | ❌ 官方答 mini 约 17GB VRAM | — | — |
| OpenAudio S1（S1-mini 0.5B）| 13 语含中文 | 括号标签：**50+ 情绪词** (angry)(sad)(excited)(satisfied)…、tone (shouting)(whispering)、special (laughing)(sobbing)(sighing)；零样本克隆＋情绪标签可同用 | ✅ 旧代 4GB(推理)/8GB(微调)，v1.5.1 起 8GB OOM | 中：`pip install -e .`/`uv sync`；Triton/compile 官方明确不支持 | S1-mini 模型卡 **cc-by-nc-sa-4.0（非商用）** |

---

## 云方案（情绪最强，需用户同意联网）

| 方案 | 情绪能力 | 计费 | 备注 |
|------|---------|------|------|
| **火山引擎豆包语音** | 自然语言情绪指令 `[#用试探性的犹豫、带点害羞又藏着温柔期待的语气说]`，支持 `[#上文内容]` 承接语境 | 2.8 元/万字符 | 中文最自然，免费额度需控制台开启 |
| **Fish Audio** | S2 方括号 64+ 情绪标记且允许自然语言 `~[warm and happy]`，可叠加 | s2.1-pro $15/百万 UTF-8 字节，免费 $0 档 8000 credits/月 | 仅非商用、单次 500 字符 |
| **ElevenLabs v3** | audio tags `[curious]`/`[crying]`/`[whispers]` | $80/百万字符，免费 10k credits/月仅非商用 | — |
| **Hume Octave** | `description` 自然语言 acting instructions（最强免费） | $20 credits | **中文支持未证实** |

---

## 已实现的接入（v0.5.0）

`generate_audio` 与 `generate_talking_video` 都新增了 `tts=indextts` 分支（并成为默认），参数与 `edge` 并列：

```
tts=indextts
spk_audio_prompt  # 参考音频路径（锁音色）。缺了就报错——IndexTTS 不做凭空造音色
emo_vector=[0, 0.8, 0, 0, 0, 0, 0, 0]  # 8 维情绪向量，每维 0~1，愤怒=0.8
emo_audio_prompt  # 情感参考音频（与 emo_vector 互斥）
emo_alpha=1.0     # 情绪强度 0~1
lang=ZH           # ZH / EN
duration_factor=1.0  # 时长系数 (0, 3]，>1 更慢更长
```

8 维顺序固定为 `happy / angry / sad / afraid / disgusted / melancholic / surprised / calm`，
写错顺序等于情绪全反——插件导出了 `INDEXTTS_EMO_ORDER` 常量给调用方核对。

**没实现的**：`emo_text`（文本情绪描述，需要额外加载 Qwen 情绪分类器，显存不够）。这条留作后续可选。

输出仍按 `generate_audio` 现有约定：`comfyui-audio-<时间戳>-<随机4位>.wav`，16kHz 单声道，旁边写 `.json` 元数据，绝不覆盖。

---

## 安装路线（IndexTTS 已按此装好）

### IndexTTS-2.5（官方仅支持 uv）

```bash
# 1. 克隆（已完成：D:/Tools/IndexTTS）
git clone https://github.com/index-tts/index-tts.git D:/Tools/IndexTTS

# 2. 预装 torch（PyPI 可能下载失败，可手动下载 wheel）
pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128

# 3. uv 同步（跳过 DeepSpeed）
cd D:/Tools/IndexTTS
set HF_ENDPOINT=https://hf-mirror.com
uv sync --default-index https://mirrors.aliyun.com/pypi/simple

# 4. 下载权重
uv tool install huggingface-hub
hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints

# 5. GPU 自检
uv run tools/gpu_check.py
```

### CosyVoice 3

```bash
conda create -n cosyvoice python=3.10
conda activate cosyvoice
pip install -r requirements.txt
# 下载权重：llm / flow / hift，走 WebUI
```

### GPT-SoVITS（最省事）

HF `lj1995/GPT-SoVITS-windows-package` → 下载 .7z → 解压 → 双击 `go-webui.bat`。

---

## 未证实项（禁止补编，如需精确数字请另行验证）

- ~~IndexTTS-2.5 在 RTX 3060 6GB 上的实际显存峰值与推理耗时~~ → **已实测**：峰值 5.78GB、RTF 87×（见上方「实测数据」）
- CosyVoice 2/3 官方显存数字
- CosyVoice3 细粒度情绪 token 完整名称
- GPT-SoVITS 参数量与权重总 GB
- EmotiVoice 权重体积、显存、是否存在零样本克隆
- 火山豆包免费额度数值、阿里云百炼 CosyVoice 新人免费额度、Hume 当前价目与中文支持
- 各 ComfyUI 节点对情绪参数的暴露深度

---

*报告生成于 2026-11-01；IndexTTS-2.5 已于同日落地并完成真机实测。未标注实测的候选结论仍基于公开 README、GitHub Issues 与 arXiv 论文，未做本地验证。*
