/**
 * 「说话视频」结果的格式化。
 *
 * 沿用图片/视频两个工具的排版约定：首行 ✅，空行后**裸绝对路径单独占一行**，
 * 这样前端能识别成可点开的文件引用；参数行把「说了什么、什么音色、多长」一次说清，
 * 因为这三项是用户回看时最想确认的。
 */
                                                   

/** generate_talking_video 的规范化返回值，与 tool.ts 的 OUTPUT_SCHEMA 一一对应。 */
                                    
              
              
                 
              
                
               
             
                       
                       
             
                
               
                
              
                     
                  
                        
                 
                        
                    
                    
 

const TALKING_MODE_LABELS                         = {
  text2talking: '文字 → 语音 → 口型',
  image2talking: '图片 → 说话 → 口型',
  video2talking: '视频换口型'
}

export function renderTalkingResultText(result                   )         {
  const label = TALKING_MODE_LABELS[result.mode] ?? result.mode
  const lines           = []

  lines.push(`✅ 口型视频成功（${label}${result.mode_inferred ? '，模式自动推断' : ''}）`)
  lines.push('')
  lines.push(`视频：${result.path}`)
  if (result.metadata_path) lines.push(`元数据：${result.metadata_path}`)
  lines.push('')
  lines.push(`台词：${result.script}`)
  lines.push(`音色：${result.voice}（${result.tts}）`)
  lines.push(
    `参数：${result.width}x${result.height} ${result.fps} fps · ${result.frames} 帧 / ${result.video_seconds.toFixed(2)} 秒` +
      ` · 语音 ${result.audio_seconds.toFixed(2)} 秒 · seed=${result.seed}`
  )
  lines.push(`耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`)
  if (result.comfy_url) lines.push(`ComfyUI：${result.comfy_url}${result.prompt_id ? `（prompt_id=${result.prompt_id}）` : ''}`)
  if (result.notes.length > 0) {
    lines.push('')
    lines.push('备注：')
    for (const note of result.notes) lines.push(`  - ${note}`)
  }
  lines.push('')
  lines.push(
    '提示：改台词或换音色会重新走一遍语音，但画面可以复用同一个 input_video（mode=video2talking）跳过图生视频那一步。'
  )
  return lines.join('\n')
}

export function formatTalkingResult(run                  )                    {
  const primary = run.outputPaths[0] ?? ''
  const value                    = {
    text: '',
    path: primary,
    files: [...run.outputPaths],
    mode: run.mode,
    script: run.request.script,
    voice: run.voiceLabel,
    tts: run.request.tts,
    audio_seconds: Number(run.audioSeconds.toFixed(3)),
    video_seconds: Number(run.videoSeconds.toFixed(3)),
    fps: run.fps,
    frames: run.frames,
    width: run.width,
    height: run.height,
    seed: run.request.seed,
    duration_ms: run.durationMs,
    success: true,
    mode_inferred: run.modeInferred,
    notes: run.notes
  }
  if (run.metadataPath) value.metadata_path = run.metadataPath
  if (run.comfyUrl) value.comfy_url = run.comfyUrl
  if (run.promptId) value.prompt_id = run.promptId
  value.text = renderTalkingResultText(value)
  return value
}

export function renderTalkingFailureText(error         , mode         )         {
  const label = mode && TALKING_MODE_LABELS[mode] ? TALKING_MODE_LABELS[mode] : '口型视频'
  const message = error instanceof Error ? error.message : String(error)
  const hint =
    error && typeof error === 'object' && 'hint' in error ? String((error                      ).hint ?? '') : ''
  const lines = [`❌ 出片失败（${label}）`, '', message]
  if (hint) {
    lines.push('')
    lines.push(hint)
  }
  return lines.join('\n')
}