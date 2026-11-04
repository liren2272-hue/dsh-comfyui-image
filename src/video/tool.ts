/**
 * 对外工具契约：`generate_video`（文生视频 / 图生视频，本地 ComfyUI + Wan2.2）。
 *
 * 为什么和 generate_image 分成两个工具而不是加一个 mode：两者的「必填项」完全不同
 * （图片模式必填 prompt；图生视频有首帧时 prompt 可以省），共用 schema 会让模型
 * 把首帧图塞进 prompt、或者以为 prompt 是必填而不敢只传图。分开之后，
 * 必填性由运行时按模式判断（`required: []`），报错也更准。
 *
 * ⚠️ 三条硬约束（和图片工具一致，都是对着 DSH 的 schema 校验实际踩出来的）：
 *   1. `parameters` 必须是**原始 JSON Schema**，且 `required` 只能是 `[]`——
 *      视频的参数必填性随模式变化，schema 层写死任何一项都会把另一种模式卡死；
 *   2. DSH 的 JSON Schema 子集是**强制**的：`minimum` / `maximum` / `format` /
 *      `pattern` / `multipleOf` 会被直接拒绝。范围只能写在 description 里，
 *      真正的校验在 params.ts 里做（超界一律报错，不静默夹断）；
 *   3. `tool.parameters` 必须是 `VIDEO_PARAMETERS_SCHEMA` **这个对象本身**，
 *      不能 clone / spread——测试用 `assert.equal` 比引用，宿主侧也依赖同一份对象。
 */
import { resolveConfig } from '../config.js'
import { formatError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ResolvedConfig } from '../types.js'
import { resolveCwd, type ToolExecLike } from '../tool.js'
import { runVideoGeneration } from './runner.js'
import { formatVideoResult, renderVideoFailureText, type VideoToolResult } from './result.js'
import type { GenerateVideoArgs } from './types.js'

export const VIDEO_TOOL_NAME = 'generate_video'

/**
 * 给模型看的工具说明。
 *
 * 写得啰嗦是刻意的：视频单次 3~15 分钟，参数用错的代价比图片大一个数量级
 * （图片重跑 20 秒，视频重跑 3 分钟起）。所以耗时、帧数对齐、output_path 语义
 * 全部写在这里，让 Agent 一次就用对。
 */
export const VIDEO_TOOL_DESCRIPTION = [
  '生成一段无声视频（mp4，本地 ComfyUI + Wan2.2 TI2V-5B）。一个工具覆盖两种模式，模式可以不传、由参数自动推断。',
  '',
  '模式 mode：',
  '  text2video  文生视频：只给 prompt，从噪声起步。',
  '  img2video   图生视频：prompt + input_image（首帧图片），保留这张图的内容让它动起来。',
  '',
  '不传 mode 时的推断规则：input_image 是非空字符串 → img2video；否则 text2video。',
  '参数冲突（例如 mode=text2video 却给了 input_image、或 img2video 没给 input_image）会直接报错，不会猜。',
  '',
  '耗时（本机 6GB 显存实测，Wan2.2 TI2V-5B Q4_K_M）：',
  '  49 帧 832x480 约 3~4 分钟；121 帧（约 5 秒）约 14 分钟——帧数是超线性变贵的，不是简单翻倍。',
  '  步数基本线性：步数翻倍耗时翻倍。所以想快速试效果就先用 seconds=2、steps=20。',
  '',
  '帧数与尺寸（两个 Wan 的硬要求，插件会自动对齐并如实告知）：',
  '  - 帧数一律对齐到 4n+1（VAE 时间下采样率是 4），上限 481 帧；超了会报错，不会悄悄截短。',
  '  - width / height 会自动对齐到 32 的倍数；默认 832x480。',
  '  - seconds 只是「意图」，真实时长 = 帧数 / fps，结果里报的是真实值。',
  '',
  '用法要点：',
  '  - 返回文本里的「视频：<绝对路径>」就是成品，可以直接引用给用户。',
  '  - output_path 可以给目录（文件名自动生成、绝不覆盖），也可以给带 .mp4 的完整文件路径。',
  '  - 想换模型：model 传 ComfyUI 的 models/diffusion_models 下的 unet 文件名；不传自动挑 Wan2.2 TI2V-5B。',
  '  - 想复现同一段：把上次返回的 seed 原样传回来；想微调就改 prompt 或换 seed。',
  '  - 需要 ComfyUI 正在运行（默认 http://127.0.0.1:8188），且装了 Wan 相关节点与三件套模型；缺什么会明确报错。',
  '  - 要「人在说话、口型对得上」请用 generate_talking_video；只要图片请用 generate_image。'
].join('\n')

/** 参数的原始 JSON Schema（只用 DSH 支持的子集：类型 / 枚举 / 说明）。 */
export const VIDEO_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['text2video', 'img2video'],
      description:
        '视频模式。不传则自动推断：input_image 非空 → img2video；否则 text2video。显式指定却缺对应输入会报错。'
    },
    prompt: {
      type: 'string',
      description:
        '画面与动作描述。text2video 必填；img2video 可省（省了就只用「自然运动 + 稳定镜头」的默认描述）。' +
        '建议写清「主体做什么动作 + 镜头怎么动」，例如「雨夜东京街头，长发女子缓缓回头，镜头缓慢推近」。'
    },
    negative_prompt: {
      type: 'string',
      description: '负向提示词（不想出现的东西）。不传用配置里的 Wan 官方中文负向串，正常不用改。'
    },
    input_image: {
      type: 'string',
      description: 'img2video 的首帧图片（本机路径，绝对或相对当前工作目录）。正面、主体清楚、别太小。'
    },
    seconds: {
      type: 'number',
      description:
        '想要的时长（秒，>0，建议 0.25~20）。默认按配置（2 秒）。会被换算成 4n+1 帧，真实时长以结果里的为准；' +
        '换算后超过 481 帧会报错。'
    },
    fps: { type: 'number', description: '帧率（4~60），默认 24。fps 越高同样时长帧数越多、耗时线性上涨。' },
    width: { type: 'integer', description: '画面宽度（64~2048），会自动对齐到 32 的倍数；默认 832。' },
    height: { type: 'integer', description: '画面高度（64~2048），会自动对齐到 32 的倍数；默认 480。' },
    seed: {
      type: 'integer',
      description: '随机种子（0~4294967295）。不传则随机；传上次返回的 seed 可复现同一段视频。'
    },
    steps: { type: 'integer', description: '采样步数（1~500），默认按配置（Wan2.2 为 30）。越大越细、耗时线性增加。' },
    cfg_scale: { type: 'number', description: '提示词贴合度 CFG（0~100），默认按配置（Wan2.2 为 5）。' },
    shift: { type: 'number', description: 'ModelSamplingSD3 的 shift（0~100），Wan 系一般 8，正常不用改。' },
    output_path: {
      type: 'string',
      description:
        '输出目录，或带 .mp4 扩展名的具体文件路径。不传则存到当前项目根目录。' +
        '目标已存在时会自动加 -1/-2 后缀，绝不覆盖。'
    },
    model: {
      type: 'string',
      description:
        '覆盖预设的视频模型：ComfyUI 的 models/diffusion_models 下的 unet 文件名（.gguf 走 UnetLoaderGGUF，.safetensors 走 UNETLoader）。不传自动挑 Wan2.2 TI2V-5B。'
    },
    extra_options: {
      type: 'object',
      additionalProperties: true,
      description: '扩展字段（预留）。其中 workflow_path 可以指向一个 API 格式工作流 JSON，接管本次生成。'
    }
  },
  // 全部参数可选：必填性随模式变化（text2video 要 prompt、img2video 要 input_image），由运行时判断。
  required: [],
  additionalProperties: false
} as const

/** 输出契约：字段与 VideoToolResult 一致。 */
export const VIDEO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '给模型看的完整结果说明' },
    path: { type: 'string', description: '产出视频的绝对路径' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部文件路径' },
    mode: { type: 'string', description: '实际使用的模式（text2video / img2video）' },
    mode_inferred: { type: 'boolean', description: '模式是否为自动推断' },
    frames: { type: 'integer', description: '总帧数（已对齐到 4n+1）' },
    fps: { type: 'number', description: '帧率' },
    seconds: { type: 'number', description: '真实时长（秒）= 帧数 / fps' },
    width: { type: 'integer', description: '画面宽度' },
    height: { type: 'integer', description: '画面高度' },
    seed: { type: 'integer', description: '本次使用的种子' },
    steps: { type: 'integer', description: '采样步数' },
    cfg_scale: { type: 'number', description: 'CFG' },
    shift: { type: 'number', description: 'ModelSamplingSD3 的 shift' },
    prompt: { type: 'string', description: '实际使用的正向提示词' },
    model: { type: 'string', description: '实际使用的视频模型（unet 文件名）' },
    vae: { type: 'string', description: '实际使用的 VAE 文件名' },
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
    'mode',
    'mode_inferred',
    'frames',
    'fps',
    'seconds',
    'width',
    'height',
    'seed',
    'steps',
    'cfg_scale',
    'shift',
    'prompt',
    'model',
    'vae',
    'duration_ms',
    'success',
    'notes',
    'comfy_url',
    'prompt_id'
  ],
  additionalProperties: false
} as const

/**
 * 猜模式，只用于失败文案。
 *
 * 失败可能发生在归一化之前（比如连不上 ComfyUI），此时拿不到权威的 request.mode，
 * 只能按 args 猜——但文案里写对「文生视频 / 图生视频」对用户判断问题出在哪很有用。
 */
function guessVideoMode(args: unknown): string {
  const value = (args as GenerateVideoArgs | undefined)?.mode
  if (value === 'text2video' || value === 'img2video') return value
  const input = (args as GenerateVideoArgs | undefined)?.input_image
  if (typeof input === 'string' && input.trim() !== '') return 'img2video'
  return 'text2video'
}

/** 造出 generate_video 工具定义。配置每次调用时重新解析，改 config.json 立即生效。 */
export function createGenerateVideoTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: VIDEO_TOOL_NAME,
    description: VIDEO_TOOL_DESCRIPTION,
    // 必须是同一个对象引用：宿主与测试都按引用比对，clone 会让契约悄悄分叉。
    parameters: VIDEO_PARAMETERS_SCHEMA,
    output: {
      schema: VIDEO_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as VideoToolResult | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as VideoToolResult | undefined
        return {
          kind: 'video-generation',
          mode: result?.mode ?? 'unknown',
          path: result?.path ?? '',
          seconds: result?.seconds ?? 0
        }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<VideoToolResult> {
      const config: ResolvedConfig = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('video execute', { cwd, baseUrl: config.baseUrl })
      try {
        const run = await runVideoGeneration({
          args: (args ?? {}) as GenerateVideoArgs,
          cwd,
          config,
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatVideoResult(run)
      } catch (error) {
        // 失败也把「为什么 + 怎么办」原样交给模型——视频重跑一次要几分钟，报错必须能直接指导下一步。
        const text = renderVideoFailureText(error, guessVideoMode(args))
        logDebug('视频生成失败', formatError(error))
        throw new Error(text)
      }
    }
  }
}
