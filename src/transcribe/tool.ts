/**
 * 对外工具契约：`comfyui_transcribe_audio`（本地音频 → Whisper 转写文本）。
 *
 * 与 generate_audio 反向：generate_audio 是「台词 → 语音」，这里是「语音 → 文本」。
 * 不碰 ComfyUI 画面、不碰 InfiniteTalk 口型，只用配置里的 Python venv 跑 openai-whisper。
 *
 * ⚠️ 同前几个工具：`parameters` 必须是最原始 JSON Schema，且只能用 DSH 支持的子集。
 *    required 只能是 []；范围/格式等约束一律写进字段 description。
 */
import { resolveConfig } from '../config.js'
import { formatError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ResolvedConfig } from '../types.js'
import { resolveCwd, type ToolExecLike } from '../tool.js'
import { runTranscription } from './runner.js'
import { formatTranscribeResult, renderTranscribeFailureText, type TranscribeToolResult } from './result.js'
import type { TranscribeArgs } from './types.js'

export const TRANSCRIBE_TOOL_NAME = 'comfyui_transcribe_audio'

export const TRANSCRIBE_TOOL_DESCRIPTION = [
  '用本机 openai-whisper 做语音识别（audio → text），不联网、不走同济 AIGC。走配置里的 Python venv（transcribePython，默认 D:/Tools/IndexTTS/.venv/Scripts/python.exe，已装 whisper + torch），传本地音频路径，返回转写文本（含分段，可选词级时间戳）。',
  '',
  '环境：whisper 20250625 + torch 2.8+cu128，权重缓存在 C:/Users/15940/.cache/whisper；device=cuda 失败时脚本内自动回退 cpu。首次用某个模型会先下载权重，耗时较长。',
  '',
  '用法要点：',
  '  - audio_path 必填：本地音频文件的绝对路径（或相对当前工作目录）。',
  '  - model 可选：whisper 模型名，默认 large-v3，可选 tiny/base/small/medium/large-v3/turbo 等。',
  '  - language 可选：语言提示如 zh/en，不传则自动识别。',
  '  - device 可选：cuda 或 cpu，默认 cuda；cuda 失败时脚本内部自动回退 cpu。',
  '  - task 可选：transcribe（默认，保持原语言）或 translate（译成英文）。',
  '  - word_timestamps 可选：是否返回词级时间戳，默认 false。',
  '  - output_path 可选：把转写文本写到文件；不给就只在返回里给文本。'
].join('\n')

/** 参数的原始 JSON Schema（只用 DSH 支持的子集：类型 / 枚举 / 说明）。 */
export const TRANSCRIBE_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    audio_path: {
      type: 'string',
      description: '必填。本地音频文件路径（绝对路径，或相对当前工作目录），支持 mp3/wav/m4a/webm/flac/ogg。'
    },
    model: {
      type: 'string',
      description: 'whisper 模型名，默认取配置 transcribeModel（large-v3）；可选 tiny/base/small/medium/large-v3/turbo 等。'
    },
    language: {
      type: 'string',
      description: '语言提示，如 zh / en；不传（或传 auto）则自动识别音频语言。'
    },
    device: {
      type: 'string',
      enum: ['cuda', 'cpu'],
      description: '推理设备，默认取配置 transcribeDevice（cuda）。cuda 失败时脚本内部会自动回退 cpu。'
    },
    task: {
      type: 'string',
      enum: ['transcribe', 'translate'],
      description: 'transcribe = 按原语言转写（默认）；translate = 翻译成英文。'
    },
    output_path: {
      type: 'string',
      description: '可选。把转写文本写到这个文件（本机路径）；不给就只在返回结果里给文本，不落盘。'
    },
    initial_prompt: {
      type: 'string',
      description: '可选。初始提示词，可改善专有名词/人名的识别（例如一段相关背景文字）。'
    },
    word_timestamps: {
      type: 'boolean',
      description: '是否返回词级时间戳，默认 false。开启后 segments 里每个词带 start/end。'
    }
  },
  required: [],
  additionalProperties: false
} as const

/** 输出契约。 */
export const TRANSCRIBE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    transcript: { type: 'string' },
    language: { type: 'string' },
    segments: { type: 'array', items: { type: 'object' } },
    audio_path: { type: 'string' },
    model: { type: 'string' },
    device: { type: 'string' },
    task: { type: 'string' },
    output_path: { type: 'string' },
    duration_ms: { type: 'number' },
    success: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['text', 'transcript', 'language', 'segments', 'audio_path', 'model', 'device', 'task', 'output_path', 'duration_ms', 'success', 'notes'],
  additionalProperties: false
} as const

/** 造出 comfyui_transcribe_audio 工具定义。配置每次调用时重新解析，改 config.json 立即生效。 */
export function createTranscribeTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: TRANSCRIBE_TOOL_NAME,
    description: TRANSCRIBE_TOOL_DESCRIPTION,
    parameters: TRANSCRIBE_PARAMETERS_SCHEMA,
    output: {
      schema: TRANSCRIBE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as TranscribeToolResult | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as TranscribeToolResult | undefined
        return {
          kind: 'audio-transcription',
          audioPath: result?.audio_path ?? '',
          outputPath: result?.output_path ?? '',
          language: result?.language ?? '',
          seconds: (result?.duration_ms ?? 0) / 1000
        }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<TranscribeToolResult> {
      const config: ResolvedConfig = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('transcribe execute', { cwd, model: config.transcribeModel, device: config.transcribeDevice })
      try {
        const run = await runTranscription({
          args: (args ?? {}) as TranscribeArgs,
          cwd,
          config: {
            transcribePython: config.transcribePython,
            transcribeModel: config.transcribeModel,
            transcribeDevice: config.transcribeDevice,
            transcribeTimeoutMs: config.transcribeTimeoutMs
          },
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatTranscribeResult(run)
      } catch (error) {
        const text = renderTranscribeFailureText(error)
        logDebug('语音识别失败', formatError(error))
        throw new Error(text)
      }
    }
  }
}
