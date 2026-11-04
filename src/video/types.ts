/**
 * 视频模式共享类型。
 *
 * 和图片模式的 types.ts 一样分两层：
 *   - `GenerateVideoArgs`         = 对外契约（Agent 看到的参数）
 *   - `NormalizedVideoRequest`    = 对内契约（默认值填好、帧数已对齐、路径已解析）
 */

/** V1 暴露的两种视频模式。 */
export type VideoMode = 'text2video' | 'img2video'

/** 顺序即「模式推断」的判定顺序。 */
export const VIDEO_MODES: readonly VideoMode[] = ['text2video', 'img2video']

export function isVideoMode(value: unknown): value is VideoMode {
  return typeof value === 'string' && (VIDEO_MODES as readonly string[]).includes(value)
}

/** 统一的对外参数层（generate_video 的全部旋钮）。 */
export interface GenerateVideoArgs {
  /** 操作模式。不传则按 input_image 自动推断（有图 → img2video）。 */
  mode?: VideoMode
  /** 正向提示词（必填）。 */
  prompt?: string
  /** 负向提示词。不传用配置里的默认值。 */
  negative_prompt?: string
  /** 输入图片路径（img2video 必填）。 */
  input_image?: string
  /** 时长（秒）。默认 2；会被换算成帧数并对齐到 4n+1。 */
  seconds?: number
  /** 帧率。默认 24。 */
  fps?: number
  /** 画布宽度。默认按预设（Wan2.2 5B 为 832）。 */
  width?: number
  /** 画布高度。默认按预设（Wan2.2 5B 为 480）。 */
  height?: number
  /** 随机种子。不传则随机；同 seed 同 prompt 可复现。 */
  seed?: number
  /** 采样步数。默认按预设（Wan2.2 为 30）。 */
  steps?: number
  /** CFG。默认按预设（Wan2.2 为 5）。 */
  cfg_scale?: number
  /** ModelSamplingSD3 的 shift，Wan 系一般 8。 */
  shift?: number
  /** 输出目录或带扩展名的文件路径（.mp4）。 */
  output_path?: string
  /** 覆盖预设里的 diffusion 模型（unet）文件名。 */
  model?: string
  /** 扩展字段：`workflow_path` 可用自定义 API 工作流接管本次生成。 */
  extra_options?: Record<string, unknown>
}

/** 归一化后的视频请求。 */
export interface NormalizedVideoRequest {
  mode: VideoMode
  prompt: string
  negativePrompt: string
  /** 已解析成绝对路径；仅 img2video 有。 */
  inputImage?: string
  width: number
  height: number
  /** 总帧数（已对齐到 4n+1）。 */
  frames: number
  /** 调用方想要的秒数（换算前的意图值）。 */
  seconds: number
  /** 按 frames / fps 反算出的真实时长（秒）。 */
  actualSeconds: number
  fps: number
  seed: number
  steps: number
  cfgScale: number
  shift: number
  samplerName: string
  scheduler: string
  /** 未指定时为空串，表示「让预设解析层自动挑」。 */
  unet: string
  outputPath: string
  notes: string[]
  extra: Record<string, unknown>
}
