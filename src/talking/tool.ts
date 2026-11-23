/**
 * 对外工具契约：`generate_talking_video`（台词 → 语音 → 说话视频 → 对口型）。
 *
 * 为什么再开第三个工具：这个工具的输入是「说什么」，其余两个的输入是「长什么样」。
 * 共用 schema 会让模型把台词塞进 prompt、把画面描述塞进 script，而这两者失败的
 * 表现相差 20 分钟（要等 ComfyUI 跑完视频才发现嘴没动）。
 *
 * ⚠️ 同前两个工具：`parameters` 必须是最原始 JSON Schema，且只能用 DSH 支持的子集
 * （minimum / maximum / format / pattern 会被拒绝），范围写在 description 里。
 */
import { resolveConfig } from '../config.js'
import { formatError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ResolvedConfig } from '../types.js'
import { resolveCwd, type ToolExecLike } from '../tool.js'
import { INDEXTTS_EMO_ORDER, INDEXTTS_LANGS, TALKING_MODES, TTS_ENGINES, type GenerateTalkingArgs } from './types.js'
import { MAX_SCRIPT_CHARS } from './params.js'
import { runTalkingGeneration } from './runner.js'
import { formatTalkingResult, renderTalkingFailureText, type TalkingToolResult } from './result.js'

export const TALKING_TOOL_NAME = 'comfyui_generate_talking_video'

export const TALKING_TOOL_DESCRIPTION = [
  '生成一段「人在说话、口型对得上」的视频：台词 → AI 语音 → 首帧人像 → InfiniteTalk 端到端生成带口型视频，全自动。',
  '',
  '口型方案：InfiniteTalk（端到端音频驱动，嘴随画面整体生成，无局部贴回/边缘模糊）。',
  '',
  '模式 mode（不传则按输入推断）：',
  '  text2talking   只给台词：先造一张正脸人像，再端到端生成说话视频。',
  '  image2talking  台词 + input_image（人像图）：拿这张图当首帧，端到端生成说话视频。',
  '  video2talking  台词 + input_video（已有视频）：抽首帧后端到端重生成口型（源视频原有动作不会保留）。',
  '',
  '推断规则：有 input_video → video2talking；有 input_image → image2talking；都没有 → text2talking。',
  '显式指定模式却缺对应输入会直接报错，不会猜。',
  '',
  '音色 tts：',
  '  indextts（默认）IndexTTS-2 克隆音色：给一段 3~15 秒的参考音频（spk_audio_prompt），音色完全由它决定；',
  '                 还能用 emo_vector（8 维情绪）或 emo_audio_prompt（照着另一段音频的语气）加情绪，',
  '                 emo_alpha 调情绪强度，lang 选 ZH/EN，duration_factor 调语速。约 2~4 分钟。',
  '  edge          edge-tts 现成音色，用 edge_voice（如 zh-CN-XiaoxiaoNeural）+ rate（如 -4%）调，秒出。',
  '',
  '耗时（本机 6GB 显存实测）：语音 indextts 约 2~4 分钟（edge 几秒）；InfiniteTalk 81 帧 / 4 步约 21 分钟。',
  '  所以一条视频大约 25 分钟起步；台词按秒计费，一次别超过 20 秒（帧数需 4n+1 对齐）；长内容请分段生成再拼。',
  '',
  '用法要点：',
  '  - 返回文本里的「视频：<绝对路径>」就是成片（mp4，含音轨），可以直接引用给用户。',
  '  - 换台词/换音色：直接重跑（video2talking 会抽旧片首帧重生成口型，不保留旧动作）。',
  '  - 口型是端到端生成的，不经过局部贴图，嘴部边缘自然清晰（这是相对旧 MuseTalk 方案的主要改进）。',
  '  - 需要 ComfyUI（127.0.0.1:8188）、WanVideoWrapper + InfiniteTalk 模型与 TTS 环境就位；缺什么会明确报错并说缺哪个。',
  '  - 只要画面不要声音：用 generate_video。只要图片：用 generate_image。'
].join('\n')

/** 参数的原始 JSON Schema（只用 DSH 支持的子集：类型 / 枚举 / 说明）。 */
export const TALKING_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [...TALKING_MODES],
      description:
        '生成模式。不传则自动推断：有 input_video → video2talking；有 input_image → image2talking；都没有 → text2talking。'
    },
    script: {
      type: 'string',
      description: `要说的话（台词原文，中文直接写）。必填，上限 ${MAX_SCRIPT_CHARS} 字。句末没标点会自动补句号。`
    },
    tts: {
      type: 'string',
      enum: [...TTS_ENGINES],
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
      description: `tts=indextts 时的 8 维情绪向量，每维 0~1，顺序固定：${INDEXTTS_EMO_ORDER.join(' / ')}。不传或全 0 表示不带情绪。与 emo_audio_prompt 互斥。`
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
      enum: [...INDEXTTS_LANGS],
      description: 'tts=indextts 时的合成语言，默认 ZH；英文台词请传 EN。'
    },
    duration_factor: {
      type: 'number',
      description: 'tts=indextts 时的时长系数，(0, 3]，默认 1。>1 更慢更长，<1 更快。'
    },
    edge_voice: {
      type: 'string',
      description: 'tts=edge 时的音色名，例如 zh-CN-XiaoxiaoNeural / zh-CN-YunxiNeural / zh-CN-YunjianNeural。'
    },
    rate: {
      type: 'string',
      description: 'tts=edge 时的相对语速，例如 "-4%"/"+10%"（带百分号）。'
    },
    input_image: {
      type: 'string',
      description: 'image2talking 的首帧人像图（本机路径，绝对或相对当前工作目录）。正面、脸够大、别看侧。'
    },
    input_video: {
      type: 'string',
      description: 'video2talking 的源视频（本机路径）。最好是正面对着镜头说话的片段；比语音短会补静止帧。'
    },
    prompt: {
      type: 'string',
      description: '画面补充描述（可选），会拼在默认人像/动作提示词后面。只描述长相与场景，不要写台词。'
    },
    negative_prompt: {
      type: 'string',
      description: '负向提示词（可选）。不传用 Wan2.2 官方中文长负向串。'
    },
    seconds: {
      type: 'number',
      description: '画面时长（秒，0.25~20）。不传就按语音实际长度 +0.3 秒自动算。'
    },
    fps: { type: 'number', description: '帧率，4~60，默认 24。' },
    width: { type: 'number', description: '宽度，64~2048，会向上对齐到 32 的倍数；默认 832。' },
    height: { type: 'number', description: '高度，64~2048，会向上对齐到 32 的倍数；默认 480。' },
    seed: { type: 'number', description: '随机种子。传上次的值可复现同一段画面；不传则随机。' },
    output_path: {
      type: 'string',
      description: '成片输出路径或目录（本机路径）。不给就是当前目录下 comfyui-talking-<时间戳>.mp4，绝不覆盖已有文件。'
    },
    extra_options: { type: 'object', description: '预留扩展字段，一般不用传。' }
  },
  required: ['script'],
  additionalProperties: false
} as const

/** 输出契约：字段与 TalkingToolResult 一致。 */
export const TALKING_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    path: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string' },
    script: { type: 'string' },
    voice: { type: 'string' },
    tts: { type: 'string' },
    audio_seconds: { type: 'number' },
    video_seconds: { type: 'number' },
    fps: { type: 'number' },
    frames: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    seed: { type: 'number' },
    duration_ms: { type: 'number' },
    success: { type: 'boolean' },
    mode_inferred: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
    metadata_path: { type: 'string' },
    comfy_url: { type: 'string' },
    prompt_id: { type: 'string' }
  },
  required: [
    'text',
    'path',
    'files',
    'mode',
    'script',
    'voice',
    'tts',
    'audio_seconds',
    'video_seconds',
    'fps',
    'frames',
    'width',
    'height',
    'seed',
    'duration_ms',
    'success',
    'mode_inferred',
    'notes'
  ],
  additionalProperties: false
} as const

/** 猜模式，只用于失败文案。 */
function guessTalkingMode(args: unknown): string {
  const value = (args as GenerateTalkingArgs | undefined)?.mode
  if (typeof value === 'string') return value
  const input = args as GenerateTalkingArgs | undefined
  if (typeof input?.input_video === 'string' && input.input_video !== '') return 'video2talking'
  if (typeof input?.input_image === 'string' && input.input_image !== '') return 'image2talking'
  return 'text2talking'
}

/** 造出 generate_talking_video 工具定义。配置每次调用时重新解析，改 config.json 立即生效。 */
export function createGenerateTalkingTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: TALKING_TOOL_NAME,
    description: TALKING_TOOL_DESCRIPTION,
    parameters: TALKING_PARAMETERS_SCHEMA,
    output: {
      schema: TALKING_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as TalkingToolResult | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as TalkingToolResult | undefined
        return {
          kind: 'talking-video',
          mode: result?.mode ?? 'unknown',
          path: result?.path ?? '',
          voice: result?.voice ?? '',
          seconds: result?.video_seconds ?? 0
        }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<TalkingToolResult> {
      const config: ResolvedConfig = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('talking execute', { cwd, tts: config.ttsEngine })
      try {
        const run = await runTalkingGeneration({
          args: (args ?? {}) as GenerateTalkingArgs,
          cwd,
          config,
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatTalkingResult(run)
      } catch (error) {
        const text = renderTalkingFailureText(error, guessTalkingMode(args))
        logDebug('口型视频失败', formatError(error))
        throw new Error(text)
      }
    }
  }
}