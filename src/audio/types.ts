/**
 * 「独立音频生成」工具（generate_audio）的类型与常量。
 *
 * 这条链只做一件事：台词（文本）→ 语音 wav，不碰 ComfyUI 画面、不碰 InfiniteTalk 口型。
 * 避免只为了配音跑完整 video2talking 链路（图生视频 + 对口型），浪费几分钟 GPU 时间。
 *
 * 两个引擎（复用 talking/tts.ts 的命令规划器）：
 *   - indextts：IndexTTS-2 克隆音色，spk_audio_prompt 定音色 + emo_* 调情绪；
 *   - edge：现成音色，edge_voice + rate 两个旋钮。
 */

export type AudioTtsEngine = 'indextts' | 'edge'

export const AUDIO_TTS_ENGINES: readonly AudioTtsEngine[] = ['indextts', 'edge']

export function isAudioTtsEngine(value: unknown): value is AudioTtsEngine {
  return typeof value === 'string' && (AUDIO_TTS_ENGINES as readonly string[]).includes(value)
}

/** IndexTTS 的合成语言。 */
export type AudioIndexTtsLang = 'ZH' | 'EN'

export const AUDIO_INDEXTTS_LANGS: readonly AudioIndexTtsLang[] = ['ZH', 'EN']

export function isAudioIndexTtsLang(value: unknown): value is AudioIndexTtsLang {
  return typeof value === 'string' && (AUDIO_INDEXTTS_LANGS as readonly string[]).includes(value)
}

/** 台词上限：600 字，与 talking 层保持一致。 */
export const MAX_AUDIO_SCRIPT_CHARS = 600

/** 工具入参（与 tool.ts 的 schema 一一对应）。 */
export interface GenerateAudioArgs {
  script?: string
  tts?: AudioTtsEngine
  /** IndexTTS 的参考音频：音色来源。 */
  spk_audio_prompt?: string
  /** 8 维情绪向量，顺序见 talking/types.ts 的 INDEXTTS_EMO_ORDER。 */
  emo_vector?: number[]
  emo_alpha?: number
  emo_audio_prompt?: string
  lang?: AudioIndexTtsLang
  duration_factor?: number
  edge_voice?: string
  rate?: string
  edge_pitch?: string
  edge_volume?: string
  output_path?: string
}

/** 归一化后的请求（默认值已填、冲突已校验）。 */
export interface NormalizedAudioRequest {
  script: string
  tts: AudioTtsEngine
  spkAudioPrompt: string
  emoVector?: number[]
  emoAlpha?: number
  emoAudioPrompt?: string
  lang: AudioIndexTtsLang
  durationFactor?: number
  edgeVoice: string
  rate: string
  edgePitch: string
  edgeVolume: string
  outputPath?: string
  notes: string[]
}

/** 一次运行的结果。 */
export interface AudioOutcome {
  path: string
  files: string[]
  audioSeconds: number
  voiceLabel: string
  tts: AudioTtsEngine
  seed: number
  durationMs: number
  notes: string[]
}
