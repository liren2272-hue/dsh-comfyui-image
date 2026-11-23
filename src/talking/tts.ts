/**
 * 语音合成（TTS）：把台词变成一段 16kHz 单声道 wav。
 *
 * 两个引擎的取舍：
 *   - indextts：IndexTTS-2 零样本克隆——音色完全由一段参考音频（spk_audio_prompt）决定，
 *     还能用 emo_vector / emo_audio_prompt 控制情绪。本地跑，单条 2~4 分钟。
 *   - edge：现成音色，秒出，但只有固定的十几个嗓子。
 *
 * 为什么不直接用 edge-tts 的 wav：它只出 mp3，而且 InfiniteTalk 的 wav2vec2 音频编码器
 * 按 16k 采样，所以两个引擎最后都过一遍 ffmpeg 归一到 16k 单声道 wav。
 *
 * 本文件只做「命令怎么拼」，不起进程——拼错了可以在单测里立刻发现，不用等 3 分钟。
 */
import type { IndexTtsLang } from './types.js'

export interface CommandPlan {
  command: string
  args: string[]
  cwd?: string
}

export interface IndexTtsOptions {
  python: string
  indexttsDir: string
  /** 参考音频：音色来源，必填（IndexTTS 没有「凭空造音色」这个能力）。 */
  spkAudioPrompt: string
  text: string
  /** 产物 wav 的绝对路径。 */
  outFile: string
  lang?: IndexTtsLang
  /** 8 维情绪向量，顺序见 INDEXTTS_EMO_ORDER。 */
  emoVector?: number[]
  emoAlpha?: number
  emoAudioPrompt?: string
  durationFactor?: number
  cfgPath?: string
  modelDir?: string
  device?: string
}

/**
 * IndexTTS-2 的推理命令（走仓库根下的 dsh_indextts_infer.py 包装脚本）。
 *
 * cwd 必须是 IndexTTS 仓库根：包装脚本默认的 --model_dir / --cfg_path 都是相对路径
 * （checkpoints/...），换到别的目录跑会找不到权重。
 * 产物路径是我们自己指定的 --output，不需要「取目录里最新 wav」那套猜测。
 */
export function indexttsTtsPlan(options: IndexTtsOptions): CommandPlan {
  const args = [
    'dsh_indextts_infer.py',
    '--spk_audio_prompt',
    options.spkAudioPrompt,
    '--text',
    options.text,
    '--output',
    options.outFile
  ]
  if (options.lang) args.push('--lang', options.lang)
  if (options.emoVector && options.emoVector.length > 0) {
    args.push('--emo_vector', options.emoVector.join(','))
  }
  if (options.emoAlpha !== undefined) args.push('--emo_alpha', String(options.emoAlpha))
  if (options.emoAudioPrompt) args.push('--emo_audio_prompt', options.emoAudioPrompt)
  if (options.durationFactor !== undefined) args.push('--duration_factor', String(options.durationFactor))
  if (options.cfgPath) args.push('--cfg_path', options.cfgPath)
  if (options.modelDir) args.push('--model_dir', options.modelDir)
  // --device 传 cuda:0 / cpu 这类字符串（IndexTTS 是 torch.device，不是裸序号）。
  if (options.device) args.push('--device', options.device)
  return { command: options.python, cwd: options.indexttsDir, args }
}

export interface EdgeTtsOptions {
  python: string
  text: string
  voice: string
  rate: string
  /** 相对音高，如 `+30Hz` / `-10Hz`；给了才传（抬音高是「更尖锐/更冲」最便宜的旋钮）。 */
  pitch?: string
  /** 相对音量，如 `+50%` / `-20%`；给了才传（配合 rate/pitch 能做出「提高音量吼」的效果）。 */
  volume?: string
  outFile: string
}

/**
 * edge-tts 用 `python -m edge_tts` 调，不用 Scripts\edge-tts.exe：
 * venv 被移动过之后 .exe 里内嵌的 shebang 绝对路径会失效（我们踩过），-m 永远安全。
 * --text 直接传字符串而不是写临时文件：台词上限 600 字，命令行长度完全够。
 */
export function edgeTtsPlan(options: EdgeTtsOptions): CommandPlan {
  return {
    command: options.python,
    // --rate 必须用 `=` 形式：语速值以 `-` 开头（如 `-4%`），
    // 写成 `--rate -4%` 会被 argparse 当成「--rate 缺少参数」（我们真机踩过）。
    args: edgeTtsArgs(options)
  }
}

/**
 * 组装 edge-tts 的命令行参数。
 * --rate / --pitch / --volume 一律用 `=` 形式：它们的值都以 `+` 或 `-` 开头，
 * 写成 `--rate -4%` 会被 argparse 当成「--rate 缺少参数」（我们真机踩过）。
 * pitch / volume 是可选的——不给就不传，行为与老版本完全一致。
 */
export function edgeTtsArgs(options: Pick<EdgeTtsOptions, 'voice' | 'rate' | 'pitch' | 'volume' | 'text' | 'outFile'>): string[] {
  const args = ['-m', 'edge_tts', '--voice', options.voice, `--rate=${options.rate}`]
  if (options.pitch) args.push(`--pitch=${options.pitch}`)
  if (options.volume) args.push(`--volume=${options.volume}`)
  args.push('--text', options.text, '--write-media', options.outFile)
  return args
}

/** ffmpeg 归一到 16kHz 单声道（InfiniteTalk 的 wav2vec2 音频编码器就是按这个采的）。 */
export function normalizeWavPlan(ffmpeg: string, input: string, output: string): CommandPlan {
  return {
    command: ffmpeg,
    args: ['-y', '-v', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', output]
  }
}

/** ffprobe 取时长（秒）。 */
export function probeDurationPlan(ffprobe: string, input: string): CommandPlan {
  return {
    command: ffprobe,
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input]
  }
}

/** 解析 ffprobe 的时间输出。 */
export function parseDuration(stdout: string): number | undefined {
  const value = Number.parseFloat(stdout.trim())
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** ffprobe 的宽高（视频/图片都能用）。 */
export function probeSizePlan(ffprobe: string, input: string): CommandPlan {
  return {
    command: ffprobe,
    args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', input]
  }
}

export function parseSize(stdout: string): { width: number; height: number } | undefined {
  const match = /^\s*(\d+)x(\d+)\s*$/m.exec(stdout)
  if (!match) return undefined
  const width = Number.parseInt(match[1] ?? '', 10)
  const height = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

/** 台词结尾补个句号：TTS 对没有句末标点的句子容易把尾音吞掉。 */
export function punctuateScript(script: string): string {
  const trimmed = script.trim()
  if (trimmed === '') return trimmed
  return /[。！？.!?…，,、；;：:」』）)】]$/.test(trimmed) ? trimmed : `${trimmed}。`
}
