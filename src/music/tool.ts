/**
 * 对外工具契约：`comfyui_generate_music`（纯 BGM，本地 ComfyUI + ACE-Step 1.5 AIO）。
 *
 * 严格照抄 video/tool.ts 的 Shape：
 *   { name, description, parameters, output: { schema, render, presentationMeta }, async execute }
 *
 * ⚠️ 三条硬约束（和图片/视频工具一致，对着 DSH 的 schema 校验踩出来的）：
 *   1. `parameters` 必须是**原始 JSON Schema**，且 `required` 只能是 `[]`——
 *      运行时统一校验必填性（tags 必填），schema 层写死会把调用卡死；
 *   2. DSH 的 JSON Schema 子集是**强制**的：`minimum` / `maximum` / `format` /
 *      `pattern` / `multipleOf` 会被直接拒绝。范围只能写在 description 里，
 *      真正的校验在 params.ts 里做（超界一律报错，不静默夹断）；
 *   3. `tool.parameters` 必须是 `MUSIC_PARAMETERS_SCHEMA` **这个对象本身**，
 *      不能 clone / spread——测试用 `assert.equal` 比引用，宿主侧也依赖同一份对象。
 */
import { resolveConfig } from '../config.js'
import { formatError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ResolvedConfig } from '../types.js'
import { resolveCwd, type ToolExecLike } from '../tool.js'
import { runMusicGeneration } from './runner.js'
import { formatMusicResult, renderMusicFailureText, type MusicToolResult } from './result.js'
import type { GenerateMusicArgs } from './types.js'

export const MUSIC_TOOL_NAME = 'comfyui_generate_music'

/** 给模型看的工具说明。写清「纯 BGM、无人声」和耗时，让 Agent 一次就用对。 */
export const MUSIC_TOOL_DESCRIPTION = [
  '生成一段背景音乐（纯器乐 BGM，无人声，本地 ComfyUI + ACE-Step 1.5 AIO）。',
  '',
  '只需给 tags（风格描述），lyrics 永远传空字符串，绝不生成人声歌词。',
  '',
  '用法要点：',
  '  - tags（必填）：风格描述，例如 "lofi chill beats, soft piano, ambient"。',
  '  - duration：秒，默认 60，范围 1..300（上限取配置的 musicMaxDuration）。',
  '  - seed：整数，默认 0；同 seed + 同 tags 可复现同一段音乐。',
  '  - bpm：默认配置值（120），范围 10..300；key：调式如 "C major"；language：如 "zh"。',
  '  - format：flac / mp3 / opus，默认配置值（flac）。',
  '  - output_path：可选，输出目录或带音频扩展名的具体文件路径；已存在会自动加后缀，绝不覆盖。',
  '',
  '  - 返回文本里的「音乐：<绝对路径>」就是成品（flac/mp3/opus），可以直接引用给用户。',
  '  - 耗时：ACE-Step turbo 是蒸馏模型（官方模板 8 步），单次通常 1~3 分钟；2~4 分钟属于正常。',
  '  - 需要 ComfyUI 正在运行（默认 http://127.0.0.1:8188），且装了 ACE-Step 1.5 原生节点' +
    '（CheckpointLoaderSimple / TextEncodeAceStepAudio1.5 / EmptyAceStep1.5LatentAudio 等）' +
    '并把 AIO 单文件放进了 models/checkpoints；缺什么会明确报错。',
  '  - 想复现同一段：把上次返回的 seed 原样传回来；想微调就改 tags 或 seed。'
].join('\n')

/** 参数的原始 JSON Schema（只用 DSH 支持的子集：类型 / 枚举 / 说明）。 */
export const MUSIC_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    tags: {
      type: 'string',
      description:
        '风格描述（必填），例如 "lofi chill beats, soft piano, ambient" 或 "宁静的钢琴曲，轻柔，适合阅读"。' +
        '纯 BGM 只按 tags 生成，不会有人声歌词。'
    },
    duration: {
      type: 'number',
      description: '时长（秒），默认 60，范围 1..300（上限取配置 musicMaxDuration）。超界会报错，不会静默夹断。'
    },
    seed: {
      type: 'integer',
      description: '随机种子（整数），默认 0。同 seed + 同 tags 可复现同一段音乐。'
    },
    bpm: {
      type: 'number',
      description: '节拍数，默认取配置 musicBpm（120），范围 10..300。常见值：60 慢、90 lofi、120 流行、140 电子。'
    },
    key: {
      type: 'string',
      description: '调式/音阶（keyscale），默认取配置 musicKeyScale，例如 "C major"。'
    },
    language: {
      type: 'string',
      description: '语言提示，默认取配置 musicLanguage（如 "zh"）。'
    },
    format: {
      type: 'string',
      enum: ['flac', 'mp3', 'opus'],
      description: '输出格式，默认取配置 musicFormat（flac）。flac 无损，mp3 通用，opus 体积小。'
    },
    output_path: {
      type: 'string',
      description:
        '输出目录，或带音频扩展名的具体文件路径。不传则存到当前工作目录。' +
        '目标已存在时会自动加 -1/-2 后缀，绝不覆盖。'
    }
  },
  // 全部参数可选：必填性（tags）在 params.ts 运行时判断。
  required: [],
  additionalProperties: false
} as const

/** 输出契约：字段与 MusicToolResult 一致。 */
export const MUSIC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型看的完整结果说明' },
    path: { type: 'string', description: '产出音乐的绝对路径' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部文件路径' },
    tags: { type: 'string', description: '实际使用的风格描述' },
    duration: { type: 'number', description: '时长（秒）' },
    seed: { type: 'integer', description: '本次使用的种子' },
    bpm: { type: 'number', description: '节拍数' },
    key: { type: 'string', description: '调式/音阶' },
    language: { type: 'string', description: '语言提示' },
    format: { type: 'string', description: '输出格式（flac / mp3 / opus）' },
    duration_ms: { type: 'integer', description: '耗时（毫秒）' },
    success: { type: 'boolean', description: '是否成功' },
    notes: { type: 'array', items: { type: 'string' }, description: '本次的提醒/注意事项' },
    metadata_path: { type: 'string', description: '元数据 sidecar（.json）路径，含完整参数与工作流' },
    comfy_url: { type: 'string', description: '使用的 ComfyUI 地址' },
    prompt_id: { type: 'string', description: 'ComfyUI 的 prompt_id，便于去它的界面里查' }
  },
  required: [
    'text',
    'path',
    'files',
    'tags',
    'duration',
    'seed',
    'bpm',
    'key',
    'language',
    'format',
    'duration_ms',
    'success',
    'notes',
    'comfy_url',
    'prompt_id'
  ],
  additionalProperties: false
} as const

/** 造出 generate_music 工具定义。配置每次调用时重新解析，改 config.json 立即生效。 */
export function createGenerateMusicTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: MUSIC_TOOL_NAME,
    description: MUSIC_TOOL_DESCRIPTION,
    // 必须是同一个对象引用：宿主与测试都按引用比对，clone 会让契约悄悄分叉。
    parameters: MUSIC_PARAMETERS_SCHEMA,
    output: {
      schema: MUSIC_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as MusicToolResult | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as MusicToolResult | undefined
        return {
          kind: 'music-generation',
          path: result?.path ?? '',
          duration: result?.duration ?? 0,
          format: result?.format ?? ''
        }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<MusicToolResult> {
      const config: ResolvedConfig = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('music execute', { cwd, baseUrl: config.baseUrl })
      try {
        const run = await runMusicGeneration({
          args: (args ?? {}) as GenerateMusicArgs,
          cwd,
          config,
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatMusicResult(run)
      } catch (error) {
        // 失败也把「为什么 + 怎么办」原样交给模型——音乐重跑一次要几分钟，报错必须能直接指导下一步。
        const text = renderMusicFailureText(error)
        logDebug('音乐生成失败', formatError(error))
        throw new Error(text)
      }
    }
  }
}
