/**
 * 「独立音频生成」结果的格式化。
 *
 * 首行 ✅，空行后裸绝对路径单独占一行，这样前端能识别成可点开的文件引用。
 * 参数行把「说了什么、什么音色、多长」一次说清。
 */
export interface AudioToolResult {
  text: string
  path: string
  files: string[]
  script: string
  voice: string
  tts: string
  audio_seconds: number
  duration_ms: number
  success: boolean
  notes: string[]
  metadata_path?: string
}

export function renderAudioResultText(result: AudioToolResult): string {
  const lines: string[] = []

  lines.push(`✅ 音频生成成功`)
  lines.push('')
  lines.push(`音频：${result.path}`)
  if (result.metadata_path) lines.push(`元数据：${result.metadata_path}`)
  lines.push('')
  lines.push(`台词：${result.script}`)
  lines.push(`音色：${result.voice}（${result.tts}）`)
  lines.push(`参数：语音 ${result.audio_seconds.toFixed(2)} 秒`)
  lines.push(`耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`)
  if (result.notes.length > 0) {
    lines.push('')
    lines.push('备注：')
    for (const note of result.notes) lines.push(`  - ${note}`)
  }
  lines.push('')
  lines.push('提示：这个工具只生成语音 wav，不碰 ComfyUI 画面和 InfiniteTalk 口型。如需对口型视频，请用 generate_talking_video。')
  return lines.join('\n')
}

export function formatAudioResult(run: {
  request: { script: string; tts: string }
  outputPaths: string[]
  metadataPath?: string
  audioSeconds: number
  voiceLabel: string
  durationMs: number
  notes: string[]
}): AudioToolResult {
  const primary = run.outputPaths[0] ?? ''
  const value: AudioToolResult = {
    text: '',
    path: primary,
    files: [...run.outputPaths],
    script: run.request.script,
    voice: run.voiceLabel,
    tts: run.request.tts,
    audio_seconds: Number(run.audioSeconds.toFixed(3)),
    duration_ms: run.durationMs,
    success: true,
    notes: run.notes
  }
  if (run.metadataPath) value.metadata_path = run.metadataPath
  value.text = renderAudioResultText(value)
  return value
}

export function renderAudioFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const hint =
    error && typeof error === 'object' && 'hint' in error ? String((error as { hint?: unknown }).hint ?? '') : ''
  const lines = [`❌ 音频生成失败`, '', message]
  if (hint) {
    lines.push('')
    lines.push(hint)
  }
  return lines.join('\n')
}
