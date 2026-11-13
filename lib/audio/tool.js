/**
 * 对外工具契约：`comfyui_generate_audio`（台词 → 语音 wav，仅音频，不碰 ComfyUI 画面、不碰 MuseTalk 口型）。
 *
 * 为什么单独做一个工具：comfyui_generate_talking_video 的链路是「语音 → 画面 → 对口型」，
 * 只为了配音跑完整链路要浪费几分钟 GPU 时间。这个工具只做 TTS 合成，秒出 wav。
 *
 * ⚠️ 同前几个工具：`parameters` 必须是最原始 JSON Schema，且只能用 DSH 支持的子集。
 */
import { resolveConfig } from '../config.js'
import { formatError } from '../errors.js'
import { logDebug } from '../log.js'
                                                 
import { resolveCwd,                   } from '../tool.js'
import { runAudioGeneration } from './runner.js'
import { formatAudioResult, renderAudioFailureText,                      } from './result.js'
                                                   

export const AUDIO_TOOL_NAME = 'comfyui_generate_audio'

export const AUDIO_TOOL_DESCRIPTION = [
  '只生成语音音频（wav，16kHz 单声道），不碰 ComfyUI 画面、不碰 MuseTalk 口型。',
  '适合「只要配音、不要视频」的场景，避免跑完整 text2talking / video2talking 链路浪费 GPU 时间。',
  '',
  '音色 tts：',
  '  indextts（默认）IndexTTS-2 零样本克隆：音色由 spk_audio_prompt（一段 3~15 秒参考音频）决定，',
  '                 还能用 emo_vector（8 维情绪）/ emo_audio_prompt（用另一段音频的情绪）调语气，',
  '                 lang 选 ZH/EN，duration_factor 调语速；本地跑，单条 2~4 分钟。',
  '  edge          edge-tts 现成音色，用 edge_voice（如 zh-CN-XiaoyiNeural）+ rate（如 +30%）调，秒出；',
  '                想更冲、更像在吼，可以再加 edge_pitch（如 +40Hz）与 edge_volume（如 +30%）。',
  '',
  '耗时（本机 6GB 显存实测）：indextts 约 2~4 分钟，edge-tts 几秒即出。',
  '',
  '用法要点：',
  '  - 返回文本里的「音频：<绝对路径>」就是成品（wav），可以直接引用给用户。',
  '  - 台词按秒计费，一次别超过 600 字；长内容请分段生成再拼接。',
  '  - 如需对口型视频，请用 comfyui_generate_talking_video（会复用画面但重新走语音）。',
  '  - 不需要 ComfyUI 画面，但需要 ffmpeg 与 ffprobe（配置 ffmpegBin）。'
].join('\\n')

/** 参数的原始 JSON Schema（只用 DSH 支持的子集：类型 / 枚举 / 说明）。 */
export const AUDIO_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: `要说的话（台词原文，中文直接写）。必填，上限 600 字。句末没标点会自动补句号。`
    },
    tts: {
      type: 'string',
      enum: ['indextts', 'edge'],
      description: 'indextts = IndexTTS-2 克隆音色（默认，用 spk_audio_prompt 定音色 + emo_* 调情绪）；edge = 现成音色（用 edge_voice/rate 调）。'
    },
    spk_audio_prompt: {
      type: 'string',
      description:
        'tts=indextts 时的参考音频（本机路径，3~15 秒、干净人声）。音色完全由它决定，不传就用配置里的 ttsSpkAudioPrompt。'
    },
    emo_vector: {
      type: 'array',
      items: { type: 'number' },
      description:
        'tts=indextts 时的 8 维情绪向量，每维 0~1，顺序固定：happy / angry / sad / afraid / disgusted / melancholic / surprised / calm。不传或全 0 表示不带情绪。与 emo_audio_prompt 互斥。'
    },
    emo_alpha: {
      type: 'number',
      description: 'tts=indextts 时的情绪强度 0~1（默认 1）。越大越贴着 emo_vector 描述的情绪。'
    },
    emo_audio_prompt: {
      type: 'string',
      description: 'tts=indextts 时用另一段音频的情绪来模仿（本机路径）。与 emo_vector 互斥；适合「照这个语气说」。'
    },
    lang: {
      type: 'string',
      enum: ['ZH', 'EN'],
      description: 'tts=indextts 时的合成语言，默认 ZH；英文台词请传 EN。'
    },
    duration_factor: {
      type: 'number',
      description: 'tts=indextts 时的时长系数，(0, 3]，默认 1。>1 更慢更长，<1 更快。'
    },
    edge_voice: {
      type: 'string',
      description: 'tts=edge 时的音色名，例如 zh-CN-XiaoyiNeural / zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural / zh-CN-YunjianNeural。'
    },
    rate: {
      type: 'string',
      description: 'tts=edge 时的相对语速，例如 "-4%"/"+10%"（带百分号）。'
    },
    edge_pitch: {
      type: 'string',
      description: 'tts=edge 时的相对音高，例如 "+40Hz"（抬高更尖锐、更冲）。不传则用引擎默认。'
    },
    edge_volume: {
      type: 'string',
      description: 'tts=edge 时的相对音量，例如 "+30%"（提高音量像在吼）。不传则用引擎默认。'
    },
    output_path: {
      type: 'string',
      description: 'wav 输出路径或目录（本机路径）。不给就是当前目录下 comfyui-audio-<时间戳>-<随机>.wav，绝不覆盖已有文件。'
    }
  },
  required: ['script'],
  additionalProperties: false
}         

/** 输出契约。 */
export const AUDIO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    path: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    script: { type: 'string' },
    voice: { type: 'string' },
    tts: { type: 'string' },
    audio_seconds: { type: 'number' },
    duration_ms: { type: 'number' },
    success: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
    metadata_path: { type: 'string' }
  },
  required: ['text', 'path', 'files', 'script', 'voice', 'tts', 'audio_seconds', 'duration_ms', 'success', 'notes'],
  additionalProperties: false
}         

/** 造出 comfyui_generate_audio 工具定义。配置每次调用时重新解析，改 config.json 立即生效。 */
export function createGenerateAudioTool(pluginConfig          )                          {
  return {
    name: AUDIO_TOOL_NAME,
    description: AUDIO_TOOL_DESCRIPTION,
    parameters: AUDIO_PARAMETERS_SCHEMA,
    output: {
      schema: AUDIO_OUTPUT_SCHEMA,
      render: (_args         , value         )            => [
        { type: 'text', text: String((value                               )?.text ?? '') }
      ],
      presentationMeta: (_args         , value         )                          => {
        const result = value                               
        return {
          kind: 'audio-generation',
          path: result?.path ?? '',
          voice: result?.voice ?? '',
          seconds: result?.audio_seconds ?? 0
        }
      }
    },
    async execute(args         , exec              )                           {
      const config                 = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('audio execute', { cwd, tts: config.ttsEngine })
      try {
        const run = await runAudioGeneration({
          args: (args ?? {})                     ,
          cwd,
          config: {
            ttsEngine: config.ttsEngine,
            ttsSpkAudioPrompt: config.ttsSpkAudioPrompt,
            edgeVoice: config.edgeVoice,
            edgeRate: config.edgeRate,
            indexttsPython: config.indexttsPython,
            indexttsDir: config.indexttsDir,
            musetalkPython: config.musetalkPython,
            ffmpeg: config.ffmpeg,
            ffprobe: config.ffprobe,
            talkingTimeoutMs: config.talkingTimeoutMs,
            writeMetadata: config.writeMetadata
          },
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatAudioResult(run)
      } catch (error) {
        const text = renderAudioFailureText(error)
        logDebug('音频生成失败', formatError(error))
        throw new Error(text)
      }
    }
  }
}