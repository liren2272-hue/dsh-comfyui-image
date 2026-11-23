/**
 * 音乐生成（generate_music / ACE-Step 1.5 AIO）共享类型。
 *
 * 和 video/types.ts 一样分两层：
 *   - `GenerateMusicArgs`      = 对外契约（Agent 看到的参数）
 *   - `NormalizedMusicRequest` = 对内契约（默认值填好、路径已解析、纯 BGM 已锁定）
 *
 * 纯 BGM 硬约束：`lyrics` 在归一化层就被钉死为空字符串，下游工作流只管照抄，
 * 任何路径都不允许往里塞人声歌词。
 */

/** 支持的音频封装格式。 */
export type MusicFormat = 'flac' | 'mp3' | 'opus'

/** 顺序即 schema enum 的顺序。 */
export const MUSIC_FORMATS: readonly MusicFormat[] = ['flac', 'mp3', 'opus']

export function isMusicFormat(value: unknown): value is MusicFormat {
  return typeof value === 'string' && (MUSIC_FORMATS as readonly string[]).includes(value)
}

/** 统一的对外参数层（generate_music 的全部旋钮）。 */
export interface GenerateMusicArgs {
  /** 风格描述（必填），例如 "lofi chill beats, soft piano, ambient"。 */
  tags?: string
  /** 时长（秒）。默认 60，范围 1..300（上限取 config.musicMaxDuration）。 */
  duration?: number
  /** 随机种子（整数）。默认 0；同 seed + 同 tags 可复现。 */
  seed?: number
  /** 节拍数。默认 config.musicBpm，范围 10..300。 */
  bpm?: number
  /** 调式/音阶，如 "C major"。默认 config.musicKeyScale。 */
  key?: string
  /** 语言提示（如 'zh'）。默认 config.musicLanguage。 */
  language?: string
  /** 输出格式：flac / mp3 / opus。默认 config.musicFormat。 */
  format?: string
  /** 输出目录或带音频扩展名的文件路径。不传则落到当前工作目录。 */
  output_path?: string
}

/** 归一化后的音乐请求。 */
export interface NormalizedMusicRequest {
  /** 风格描述（必填，已 trim）。 */
  tags: string
  /** 纯 BGM：永远是空字符串，绝不加人声歌词。 */
  lyrics: string
  /** 时长（秒）。 */
  duration: number
  seed: number
  bpm: number
  key: string
  language: string
  format: MusicFormat
  /** 已 resolve 成绝对路径的最终输出文件。 */
  outputPath: string
  /** 本次请求的用户可读提醒。 */
  notes: string[]
}
