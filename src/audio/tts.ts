/**
 * 独立音频工具的 TTS 命令规划——复用 talking/tts.ts 的现有规划器，
 * 不重复造轮子。只做「拼命令」，不碰文件系统、不起进程。
 */
import { edgeTtsPlan, indexttsTtsPlan, normalizeWavPlan, parseDuration, punctuateScript } from '../talking/tts.js'
import type { CommandPlan } from '../talking/tts.js'
import { MAX_AUDIO_SCRIPT_CHARS } from './types.js'
import type { AudioIndexTtsLang } from './types.js'

/** IndexTTS 合成语音的命令规划。 */
export function audioIndexTtsPlan(options: {
  python: string
  indexttsDir: string
  spkAudioPrompt: string
  text: string
  outFile: string
  lang?: AudioIndexTtsLang
  emoVector?: number[]
  emoAlpha?: number
  emoAudioPrompt?: string
  durationFactor?: number
  cfgPath?: string
  modelDir?: string
  device?: string
}): CommandPlan {
  return indexttsTtsPlan(options)
}

/** edge-tts 合成语音的命令规划。 */
export function audioEdgeTtsPlan(options: {
  python: string
  text: string
  voice: string
  rate: string
  pitch?: string
  volume?: string
  outFile: string
}): CommandPlan {
  return edgeTtsPlan({
    python: options.python,
    text: options.text,
    voice: options.voice,
    rate: options.rate,
    pitch: options.pitch,
    volume: options.volume,
    outFile: options.outFile
  })
}

/** 归一化到 16k 单声道 wav 的命令规划。 */
export function audioNormalizeWavPlan(ffmpeg: string, input: string, output: string): CommandPlan {
  return normalizeWavPlan(ffmpeg, input, output)
}

/** 从 ffprobe 输出解析语音时长。 */
export function audioParseDuration(stdout: string): number | undefined {
  return parseDuration(stdout)
}

/** 台词结尾补句号。 */
export function audioPunctuateScript(script: string): string {
  return punctuateScript(script)
}

/** 台词必须非空且不超长（纯函数，便于单测）。 */
export function validateAudioScript(script: string): { ok: true } | { ok: false; message: string; hint: string } {
  const trimmed = script.trim()
  if (trimmed === '') {
    return {
      ok: false,
      message: 'script 不能为空：独立音频工具必须有台词才能合成语音。',
      hint: '例如 script="这是谁家的小孩？"'
    }
  }
  if (trimmed.length > MAX_AUDIO_SCRIPT_CHARS) {
    return {
      ok: false,
      message: `script 有 ${trimmed.length} 字，超过 ${MAX_AUDIO_SCRIPT_CHARS} 字上限。`,
      hint: '请拆成多段分别生成再拼接。'
    }
  }
  return { ok: true }
}

/** 导出常量与类型。 */
export { MAX_AUDIO_SCRIPT_CHARS } from './types.js'
export type { AudioIndexTtsLang, AudioTtsEngine, NormalizedAudioRequest } from './types.js'
