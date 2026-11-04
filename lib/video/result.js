/**
 * 视频结果的格式化。
 *
 * 沿用图片 / 说话视频两个工具的排版约定，但有两点必须钉死：
 *
 *   1. **首行是状态行**，且必须带上模式（`✅ 出片成功（图生视频）`）。
 *      模式自动推断时再补一句「，模式自动推断」——用户回看时最想知道「这到底是我要的模式吗」，
 *      而推断错了的代价是白等十几分钟，所以这件事必须显式写在第一行。
 *   2. **裸绝对路径单独占一行**（`视频：D:/out/clip.mp4`），不带任何修饰。
 *      DSH 前端靠这个把路径渲染成可点开的文件引用；一旦拼成「视频文件：xxx（mp4）」就识别不出来。
 *
 * 参数行按「尺寸 · 帧数/帧率 · 真实时长 · 步数 · cfg · shift · seed」排，
 * 其中**时长用 actualSeconds 而不是调用方要的 seconds**：49 帧 @24fps 是 2.04 秒，
 * 如果照抄「2 秒」，用户拿着片子和参数对不上，会怀疑是不是插件改了参数。
 */
                                                 

/** generate_video 的规范化返回值，与 tool.ts 的 VIDEO_OUTPUT_SCHEMA 一一对应。 */
                                  
              
              
                 
              
                        
                
             
                 
               
                
              
               
                   
               
                
               
             
                     
                  
                 
                        
                   
                   
 

const VIDEO_MODE_LABELS                         = {
  text2video: '文生视频',
  img2video: '图生视频'
}

/** 模式的中文名（失败文案也要用，所以单独导出个小工具）。 */
export function videoModeLabel(mode        )         {
  return VIDEO_MODE_LABELS[mode] ?? mode
}

export function renderVideoResultText(result                 )         {
  const label = videoModeLabel(result.mode)
  const lines           = []

  lines.push(`✅ 出片成功（${label}${result.mode_inferred ? '，模式自动推断' : ''}）`)
  lines.push('')
  lines.push(`视频：${result.path}`)
  if (result.metadata_path) lines.push(`元数据：${result.metadata_path}`)
  lines.push('')
  lines.push(`提示词：${result.prompt}`)
  lines.push(
    `参数：${result.width}x${result.height} · ${result.frames} 帧 / ${result.fps} fps · ` +
      `${result.seconds.toFixed(2)} 秒 · ${result.steps} 步 · cfg ${result.cfg_scale} · ` +
      `shift ${result.shift} · seed=${result.seed}`
  )
  lines.push(`模型：${result.model} · VAE ${result.vae}`)
  lines.push(`耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`)
  lines.push(`ComfyUI：${result.comfy_url}（prompt_id=${result.prompt_id}）`)
  if (result.notes.length > 0) {
    lines.push('')
    lines.push('备注：')
    for (const note of result.notes) lines.push(`  - ${note}`)
  }
  lines.push('')
  lines.push('提示：想换首帧就把 input_image 换成图片路径；想换模型就传 model。')
  return lines.join('\n')
}

/** VideoRunResult → 工具返回值。 */
export function formatVideoResult(run                )                  {
  const primary = run.outputPaths[0] ?? ''
  const value                  = {
    text: '',
    path: primary,
    files: [...run.outputPaths],
    mode: run.mode,
    mode_inferred: run.modeInferred,
    frames: run.request.frames,
    fps: run.request.fps,
    seconds: run.request.actualSeconds,
    width: run.request.width,
    height: run.request.height,
    seed: run.request.seed,
    steps: run.request.steps,
    cfg_scale: run.request.cfgScale,
    shift: run.request.shift,
    prompt: run.request.prompt,
    model: run.preset.unet,
    vae: run.preset.vae,
    duration_ms: run.durationMs,
    success: true,
    notes: run.notes,
    comfy_url: run.comfyUrl,
    prompt_id: run.promptId
  }
  if (run.metadataPath) value.metadata_path = run.metadataPath
  value.text = renderVideoResultText(value)
  return value
}

/**
 * 失败时给模型看的文本。
 *
 * 首行固定「❌ 出片失败（<模式>）」：模式由调用方按 args 猜一个（推断过的也能猜对），
 * 因为失败时往往还没走到归一化层，拿不到权威的 request.mode。
 * 第二段是原始 message，第三段是 hint（「怎么办」）——这两段绝不能合并，
 * 否则模型会把建议当成错误原因去改参数。
 */
export function renderVideoFailureText(error         , mode         )         {
  const label = mode ? videoModeLabel(mode) : '视频'
  const message = error instanceof Error ? error.message : String(error)
  const hint =
    error && typeof error === 'object' && 'hint' in error ? String((error                      ).hint ?? '') : ''
  const lines = [`❌ 出片失败（${label}）`, '', message]
  if (hint) {
    lines.push('')
    lines.push(`建议：${hint}`)
  }
  return lines.join('\n')
}
