/**
 * 「语音识别（Whisper ASR）」工具（comfyui_transcribe_audio）的类型定义。
 *
 * 这条链只做一件事：本地音频文件 → 转写文本（可选词级时间戳），
 * 用 openai-whisper（Python venv）跑，不走 ComfyUI、不碰 InfiniteTalk。
 *
 * 约定：
 *   - 工具输入参数全部可选（schema 的 required 只能是 []），默认值写在 description 里；
 *   - `audio_path` 虽然语义上必填，但 schema 层仍放进 properties 而非 required，
 *     缺失/空值在 normalizeTranscribeRequest 里报带 hint 的 ImagePluginError。
 */

/** Whisper 的 task：转写（保持原语言）或翻译（统一译成英文）。 */
export type TranscribeTask = 'transcribe' | 'translate'

export const TRANSCRIBE_TASKS: readonly TranscribeTask[] = ['transcribe', 'translate']

export function isTranscribeTask(value: unknown): value is TranscribeTask {
  return typeof value === 'string' && (TRANSCRIBE_TASKS as readonly string[]).includes(value)
}

/** 工具入参（与 tool.ts 的 schema 一一对应）。 */
export interface TranscribeArgs {
  /** 本地音频文件路径，支持 mp3/wav/m4a/webm/flac/ogg；必填（校验在 normalize 里做）。 */
  audio_path?: string
  /** whisper 模型名，默认 config.transcribeModel（large-v3）。 */
  model?: string
  /** 语言提示，如 zh / en；不传（或 auto）则自动识别。 */
  language?: string
  /** 推理设备：cuda 或 cpu，默认 config.transcribeDevice（cuda）。 */
  device?: string
  /** transcribe 或 translate，默认 transcribe。 */
  task?: TranscribeTask
  /** 可选：把转写文本写到文件；不给只在返回里给文本。 */
  output_path?: string
  /** 可选：初始提示词（能改善专有名词识别）。 */
  initial_prompt?: string
  /** 可选：是否返回词级时间戳，默认 false。 */
  word_timestamps?: boolean
}

/** 归一化后的请求（默认值已填、校验已通过）。 */
export interface NormalizedTranscribeRequest {
  /** 已按 cwd 解析成绝对路径。 */
  audioPath: string
  model: string
  /** 空串 = 自动识别（传给 Python 时不在 kw 里写 language）。 */
  language: string
  device: string
  task: TranscribeTask
  outputPath?: string
  initialPrompt: string
  wordTimestamps: boolean
  notes: string[]
}

/** Whisper 转写结果里的一段。 */
export interface TranscribeSegment {
  start: number
  end: number
  text: string
  words?: Array<{ word: string; start: number; end: number }>
}

/** 一次转写运行的结果（runner 产出，交给 result 格式化）。 */
export interface TranscribeOutcome {
  request: NormalizedTranscribeRequest
  /** 完整转写文本。 */
  text: string
  /** 识别/指定的语言代码。 */
  language: string
  segments: TranscribeSegment[]
  /** 可选：转写文本落盘路径。 */
  outputPath?: string
  durationMs: number
  notes: string[]
}

/** 一次运行失败时的复原信息（Python 脚本在 cuda 失败后回退 cpu 时记一笔）。 */
export interface WhisperPlan {
  /** 传给 python 解释器的参数：[脚本路径, JSON 字符串]。 */
  args: string[]
  /** 中间工作目录（脚本就写在里面）。 */
  workDir: string
  scriptPath: string
}
