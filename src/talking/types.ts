/**
 * 「说话视频」工具（generate_talking_video）的类型与常量。
 *
 * 这条链把两件事串起来：
 *   ① 台词（文本）→ 语音 wav   —— TTS：IndexTTS-2（参考音频克隆音色 + 情绪控制）或 edge-tts（现成音色）
 *   ② 首帧画面（图 / 视频首帧 / 文生图） + 语音 → 口型对得上的成片 —— InfiniteTalk 端到端生成
 *
 * 旧的 MuseTalk 方案是「先出无声视频 → 局部重绘嘴部再贴回」，嘴部边缘有贴片感；
 * 新方案端到端生成，嘴随画面整体出来，边缘自然清晰。
 *
 * 为什么单独做一个工具而不是给 generate_video 加参数：
 *   generate_video 的契约是「画面怎么动」，这里的契约是「说什么、谁的声音、嘴对不对」，
 *   参数集和失败原因完全不同；混在一起会让模型把 script 塞进 prompt 里。
 */

/** 三种输入形态。 */
export type TalkingMode = 'text2talking' | 'image2talking' | 'video2talking'

/** 全部模式（顺序即文档顺序）。 */
export const TALKING_MODES: readonly TalkingMode[] = ['text2talking', 'image2talking', 'video2talking']

export function isTalkingMode(value: unknown): value is TalkingMode {
  return typeof value === 'string' && (TALKING_MODES as readonly string[]).includes(value)
}

/** TTS 引擎。 */
export type TtsEngine = 'indextts' | 'edge'

export const TTS_ENGINES: readonly TtsEngine[] = ['indextts', 'edge']

export function isTtsEngine(value: unknown): value is TtsEngine {
  return typeof value === 'string' && (TTS_ENGINES as readonly string[]).includes(value)
}

/** IndexTTS 的合成语言（它只支持这两个，传别的会被 argparse 拒绝）。 */
export type IndexTtsLang = 'ZH' | 'EN'

export const INDEXTTS_LANGS: readonly IndexTtsLang[] = ['ZH', 'EN']

export function isIndexTtsLang(value: unknown): value is IndexTtsLang {
  return typeof value === 'string' && (INDEXTTS_LANGS as readonly string[]).includes(value)
}

/**
 * IndexTTS 的情绪向量维度顺序（**顺序不能改**，权重就是按这个顺序吃的）。
 * 8 维、每维 0~1；全 0 等价于「不带情绪」。
 */
export const INDEXTTS_EMO_ORDER = [
  'happy',
  'angry',
  'sad',
  'afraid',
  'disgusted',
  'melancholic',
  'surprised',
  'calm'
] as const

export type IndexTtsEmoName = (typeof INDEXTTS_EMO_ORDER)[number]

/** 工具入参（与 tool.ts 的 schema 一一对应）。 */
export interface GenerateTalkingArgs {
  mode?: TalkingMode
  script?: string
  tts?: TtsEngine
  /** IndexTTS 的参考音频：音色完全由它决定，缺了就没法合成。 */
  spk_audio_prompt?: string
  /** 情绪向量：按 INDEXTTS_EMO_ORDER 顺序的 8 个 0~1 数字。 */
  emo_vector?: number[]
  /** 情绪强度 0~1；与 emo_audio_prompt 互斥。 */
  emo_alpha?: number
  /** 用一段参考音频的情绪代替 emo_vector。 */
  emo_audio_prompt?: string
  /** 合成语言 ZH / EN，默认 ZH。 */
  lang?: IndexTtsLang
  /** 时长系数（>1 更慢更长），默认 1。 */
  duration_factor?: number
  edge_voice?: string
  rate?: string
  input_image?: string
  input_video?: string
  prompt?: string
  negative_prompt?: string
  seconds?: number
  fps?: number
  width?: number
  height?: number
  seed?: number
  output_path?: string
  extra_options?: Record<string, unknown>
}

/** 归一化后的请求（所有默认值已填、冲突已校验）。 */
export interface NormalizedTalkingRequest {
  mode: TalkingMode
  modeInferred: boolean
  script: string
  tts: TtsEngine
  /** 最终生效的参考音频（工具入参优先，缺了用配置里的默认值）。 */
  spkAudioPrompt: string
  /** 情绪向量（8 维，未指定时是 undefined，不传该参数）。 */
  emoVector?: number[]
  emoAlpha?: number
  emoAudioPrompt?: string
  lang: IndexTtsLang
  durationFactor?: number
  edgeVoice: string
  rate: string
  inputImage?: string
  inputVideo?: string
  /** 画面提示词：图生视频用，text2talking 时也会拼进人像提示词。 */
  prompt: string
  negativePrompt?: string
  /** 用户显式指定的时长；不传就按语音实际长度算。 */
  seconds?: number
  fps: number
  width: number
  height: number
  seed: number
  outputPath?: string
  notes: string[]
}

/** 一次运行的结果。 */
export interface TalkingOutcome {
  path: string
  files: string[]
  metadataPath?: string
  audioPath: string
  baseVideoPath: string
  audioSeconds: number
  videoSeconds: number
  frames: number
  fps: number
  width: number
  height: number
  script: string
  tts: TtsEngine
  voiceLabel: string
  seed: number
  mode: TalkingMode
  modeInferred: boolean
  notes: string[]
  durationMs: number
  promptId?: string
  comfyUrl?: string
}
