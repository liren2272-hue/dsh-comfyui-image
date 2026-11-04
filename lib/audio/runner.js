/**
 * 「独立音频生成」编排器：台词 → 语音 wav（仅此而已）。
 *
 * 故意不碰 ComfyUI（画面）和 MuseTalk（口型），避免只为了配音
 * 跑完整 text2talking / video2talking 链路浪费几分钟 GPU 时间。
 *
 * 三层检查点：
 *   - IndexTTS 走 --output 指定路径，确认文件真的出现；
 *   - edge-tts 只出 mp3，需 ffmpeg 归一到 16k 单声道 wav；
 *   - ffprobe 量出真实时长。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ImagePluginError } from '../errors.js'
import { ensureDir, humanBytes, isFile } from '../files.js'
import { logDebug } from '../log.js'
import { runProcess,                              } from '../talking/exec.js'
import {
  audioEdgeTtsPlan,
  audioIndexTtsPlan,
  audioNormalizeWavPlan,
  audioParseDuration,
  audioPunctuateScript,
  validateAudioScript
} from './tts.js'
import { isAudioIndexTtsLang, isAudioTtsEngine } from './types.js'
                                                                                           
import { INDEXTTS_EMO_ORDER } from '../talking/types.js'
import { normalizeEmoVector } from '../talking/params.js'

/** 工作目录：中间产物都放这里，跑完就删（失败时留着便于排查）。 */
function makeWorkDir()         {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-audio-${Date.now()}-`))
}

/** 把 stderr 压成一行，用于错误信息。 */
function lastMeaningfulLine(text        , fallback = '')         {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('WARNING') && !line.startsWith('INFO'))
  return lines.length > 0 ? lines[lines.length - 1] : fallback
}

/** 非零退出码一律转成带 hint 的插件错误。 */
function assertExit(result           , what        , hint        )       {
  if (result.code === 0) return
  throw new ImagePluginError(
    `${what}失败（退出码 ${result.code ?? 'null'}）：${lastMeaningfulLine(result.stderr, '没有输出')}`,
    hint
  )
}

/** ① 语音：按配置选引擎，统一归一到 16k 单声道 wav，并量出真实时长。 */
async function synthSpeech(
  request                        ,
  config   
                          
                       
                          
                  
                   
                            
   ,
  workDir        ,
  signal                         ,
  deps         
)                                                                 {
  const notes           = []
  const text = audioPunctuateScript(request.script)
  const rawDir = path.join(workDir, 'tts')
  ensureDir(rawDir)

  let rawFile        
  if (request.tts === 'indextts') {
    const outWav = path.join(rawDir, 'indextts.wav')
    const plan = audioIndexTtsPlan({
      python: config.indexttsPython,
      indexttsDir: config.indexttsDir,
      spkAudioPrompt: request.spkAudioPrompt,
      text,
      outFile: outWav,
      lang: request.lang,
      ...(request.emoVector ? { emoVector: request.emoVector } : {}),
      ...(request.emoAlpha !== undefined ? { emoAlpha: request.emoAlpha } : {}),
      ...(request.emoAudioPrompt ? { emoAudioPrompt: request.emoAudioPrompt } : {}),
      ...(request.durationFactor !== undefined ? { durationFactor: request.durationFactor } : {}),
      device: 'cuda:0'
    })
    logDebug('IndexTTS 合成语音', { cwd: plan.cwd, text, spkAudioPrompt: request.spkAudioPrompt })
    // IndexTTS 在 6GB 显存上单条 2~4 分钟，超时给到 15 分钟。
    const result = await runProcess(
      { ...plan, timeoutMs: Math.min(config.talkingTimeoutMs, 15 * 60 * 1000), ...(signal ? { signal } : {}) },
      deps
    )
    assertExit(
      result,
      'IndexTTS 合成语音',
      `检查 indexttsPython 是否存在（当前 ${config.indexttsPython}）、indexttsDir 是否是 IndexTTS 仓库根（当前 ${config.indexttsDir}）、参考音频是否存在（当前 ${request.spkAudioPrompt}）。`
    )
    if (!isFile(outWav)) {
      throw new ImagePluginError(
        'IndexTTS 正常退出但没有产出 wav。',
        `去看 ${rawDir} 里有没有文件；常见原因是参考音频太短/太吵，或 checkpoints 没下全。`
      )
    }
    rawFile = outWav
  } else {
    const mp3 = path.join(rawDir, 'edge.mp3')
    const plan = audioEdgeTtsPlan({
      python: config.musetalkPython,
      text,
      voice: request.edgeVoice,
      rate: request.rate,
      ...(request.edgePitch ? { pitch: request.edgePitch } : {}),
      ...(request.edgeVolume ? { volume: request.edgeVolume } : {}),
      outFile: mp3
    })
    const result = await runProcess(
      { ...plan, timeoutMs: Math.min(config.talkingTimeoutMs, 5 * 60 * 1000), ...(signal ? { signal } : {}) },
      deps
    )
    assertExit(
      result,
      'edge-tts 合成语音',
      `edge-tts 装在 musetalkPython（当前 ${config.musetalkPython}）里；没装就跑 venv\\Scripts\\python.exe -m pip install edge-tts。`
    )
    if (!isFile(mp3)) {
      throw new ImagePluginError('edge-tts 正常退出但没有产出文件。', `检查 ${mp3} 是否可写；网络不通时 edge-tts 会静默失败。`)
    }
    rawFile = mp3
  }

  // 归一到 16k 单声道
  const wavPath = path.join(workDir, 'speech16k.wav')
  const normalize = await runProcess(
    { ...audioNormalizeWavPlan(config.ffmpeg, rawFile, wavPath), timeoutMs: 120_000, ...(signal ? { signal } : {}) },
    deps
  )
  assertExit(normalize, 'ffmpeg 转换语音格式', '检查 ffmpegBin 配置（当前 ' + config.ffmpeg + '）是否含 ffmpeg.exe。')
  if (!isFile(wavPath)) throw new ImagePluginError('ffmpeg 没有产出 16k wav。', '语音源文件可能已损坏，删掉重跑一次。')

  const probe = await runProcess(
    {
      command: config.ffprobe,
      args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wavPath],
      timeoutMs: 60_000,
      ...(signal ? { signal } : {})
    },
    deps
  )
  const seconds = audioParseDuration(probe.stdout)
  if (!seconds) {
    throw new ImagePluginError('量不出语音时长。', 'ffprobe 可能不在 ffmpeg 目录里（需要 ffmpeg.exe 与 ffprobe.exe 两个）。')
  }
  logDebug(`语音 ${seconds.toFixed(2)} 秒（${humanBytes(fs.statSync(wavPath).size)}）`)
  notes.push(`语音 ${seconds.toFixed(2)} 秒，音色 ${voiceLabelOf(request)}。`)
  return { wavPath, seconds, notes }
}

/** 音色的对外显示名（结果与元数据里都用它，便于复现）。 */
function voiceLabelOf(request                        )         {
  if (request.tts === 'edge') {
    // 音高/音量只在真的传了的时候才写进标签——不传就是引擎默认，写出来反而误导。
    const extra = [request.edgePitch, request.edgeVolume].filter((value) => value !== '').join(' · ')
    return `edge-tts · ${request.edgeVoice} · ${request.rate}${extra ? ` · ${extra}` : ''}`
  }
  const parts = [`IndexTTS-2 克隆音色 · ${request.spkAudioPrompt}`]
  if (request.emoVector) {
    const named = request.emoVector
      .map((weight, index) => ({ name: INDEXTTS_EMO_ORDER[index], weight }))
      .filter((item) => item.weight > 0)
      .map((item) => `${item.name} ${item.weight}`)
    if (named.length > 0) parts.push(`情绪 ${named.join(' / ')}`)
  } else if (request.emoAudioPrompt) {
    parts.push(`情绪取自 ${request.emoAudioPrompt}`)
  }
  if (request.lang !== 'ZH') parts.push(`lang ${request.lang}`)
  return parts.join(' · ')
}

                                  
         
                   
                
                             
                         
                      
                             
                 
                            
                       
                 
                       
                        
                        
   
             
           
                     
                             
                     
                    
                          
                       
                          
                  
                   
                            
                          
   
                      
                                                      
                
 

                                 
                                 
                       
                       
                   
                      
                    
                    
                 
 

export async function runAudioGeneration(options                 )                          {
  const startedAt = Date.now()
  const { config } = options
  const deps          = options.deps ?? {}
  const request = normalizeAudioRequest(options.args, config)
  const notes           = [...request.notes]
  const workDir = makeWorkDir()

  try {
    // ① 语音
    const speech = await synthSpeech(request, {
      indexttsPython: config.indexttsPython,
      indexttsDir: config.indexttsDir,
      musetalkPython: config.musetalkPython,
      ffmpeg: config.ffmpeg,
      ffprobe: config.ffprobe,
      talkingTimeoutMs: config.talkingTimeoutMs
    }, workDir, options.signal, deps)
    notes.push(...speech.notes)

    // ② 落盘（最终 wav 由用户指定位置）
    const planned = planAudioFile(request.outputPath, options.cwd, '.wav')
    ensureDir(path.dirname(planned.filePath))
    fs.copyFileSync(speech.wavPath, planned.filePath)
    const size = fs.statSync(planned.filePath).size
    logDebug(`音频已写入 ${planned.filePath}（${humanBytes(size)}）`)

    const durationMs = Date.now() - startedAt

    // ③ 元数据 sidecar
    let metadataPath                    
    if (config.writeMetadata) {
      metadataPath = `${planned.filePath}.json`
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify(
          {
            plugin: 'dsh-comfyui-image',
            tool: 'generate_audio',
            createdAt: new Date().toISOString(),
            script: request.script,
            tts: {
              engine: request.tts,
              label: voiceLabelOf(request),
              ...(request.tts === 'indextts'
                ? {
                    spkAudioPrompt: request.spkAudioPrompt,
                    lang: request.lang,
                    ...(request.emoVector ? { emoVector: request.emoVector } : {}),
                    ...(request.emoAlpha !== undefined ? { emoAlpha: request.emoAlpha } : {}),
                    ...(request.emoAudioPrompt ? { emoAudioPrompt: request.emoAudioPrompt } : {}),
                    ...(request.durationFactor !== undefined ? { durationFactor: request.durationFactor } : {})
                  }
                : { voice: request.edgeVoice, rate: request.rate })
            },
            audio: { file: speech.wavPath, seconds: Number(speech.seconds.toFixed(3)) },
            outputFile: planned.filePath,
            durationMs,
            notes
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }

    return {
      request,
      outputPaths: [planned.filePath],
      ...(metadataPath ? { metadataPath } : {}),
      audioPath: speech.wavPath,
      audioSeconds: speech.seconds,
      voiceLabel: voiceLabelOf(request),
      durationMs,
      notes
    }
  } catch (error) {
    const keep = process.env.DSH_COMFYUI_KEEP_WORK === '1' ? '（按 DSH_COMFYUI_KEEP_WORK=1 保留）' : ''
    if (error instanceof ImagePluginError) {
      throw new ImagePluginError(error.message, `${error.hint ? `${error.hint} ` : ''}中间产物在 ${workDir}${keep}`)
    }
    throw error
  }
}

/** 决定最终往哪个文件写（与 files.planOutputFile 同逻辑，仅扩展名限定为音频）。 */
function planAudioFile(outputPath                    , cwd        , extension = '.wav')                                          {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  const fallbackName = `comfyui-audio-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`

  if (!outputPath || outputPath.trim() === '') {
    ensureDir(cwd)
    return { filePath: path.join(cwd, fallbackName), directory: cwd }
  }

  const resolved = path.resolve(path.isAbsolute(outputPath) ? outputPath : path.join(cwd, outputPath))
  const treatAsFile = ext === path.extname(resolved).toLowerCase() && !/[/\\]$/.test(outputPath)

  if (!treatAsFile) {
    ensureDir(resolved)
    return { filePath: path.join(resolved, fallbackName), directory: resolved }
  }

  const directory = path.dirname(resolved)
  ensureDir(directory)
  if (!fs.existsSync(resolved)) return { filePath: resolved, directory }

  const base = path.basename(resolved, path.extname(resolved))
  const dir = path.dirname(resolved)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${path.extname(resolved)}`)
    if (!fs.existsSync(candidate)) return { filePath: candidate, directory }
  }
  throw new ImagePluginError(
    `输出路径已被占满，找不到空位：${resolved}`,
    '换一个输出目录，或先清掉同名文件。'
  )
}

/** 归一化 + 校验（纯函数，不碰网络/文件系统，便于离线单测）。 */
export function normalizeAudioRequest(
  args   
                   
                
                             
                         
                      
                             
                 
                            
                       
                 
                       
                        
                        
   ,
  config   
                     
                             
                     
                    
                          
   
)                         {
  const notes           = []

  // ── 台词 ──
  const script = typeof args.script === 'string' ? args.script.trim() : ''
  const validation = validateAudioScript(script)
  if (!validation.ok) {
    throw new ImagePluginError(validation.message, validation.hint)
  }

  // ── TTS ──
  let tts                 = isAudioTtsEngine(config.ttsEngine) ? config.ttsEngine : 'indextts'
  if (args.tts !== undefined && args.tts !== null) {
    if (!isAudioTtsEngine(args.tts)) throw new ImagePluginError(`不认识的 tts：${JSON.stringify(args.tts)}。`, '只能是 indextts 或 edge。')
    tts = args.tts
  }

  const edgeVoice = typeof args.edge_voice === 'string' && args.edge_voice.trim() !== '' ? args.edge_voice.trim() : config.edgeVoice
  const rate = typeof args.rate === 'string' && args.rate.trim() !== '' ? args.rate.trim() : config.edgeRate
  // edge 的音高/音量是可选旋钮：空串 = 压根不传该参数（保持老行为），而不是传 +0Hz / +0%。
  const edgePitch = typeof args.edge_pitch === 'string' && args.edge_pitch.trim() !== '' ? args.edge_pitch.trim() : ''
  const edgeVolume = typeof args.edge_volume === 'string' && args.edge_volume.trim() !== '' ? args.edge_volume.trim() : ''

  // ── IndexTTS ──
  const spkAudioPrompt =
    typeof args.spk_audio_prompt === 'string' && args.spk_audio_prompt.trim() !== ''
      ? args.spk_audio_prompt.trim()
      : config.ttsSpkAudioPrompt
  const emoVector = normalizeEmoVector(args.emo_vector)
  const emoAudioPrompt =
    typeof args.emo_audio_prompt === 'string' && args.emo_audio_prompt.trim() !== '' ? args.emo_audio_prompt.trim() : undefined
  let emoAlpha                    
  if (args.emo_alpha !== undefined && args.emo_alpha !== null) {
    if (typeof args.emo_alpha !== 'number' || !Number.isFinite(args.emo_alpha) || args.emo_alpha < 0 || args.emo_alpha > 1) {
      throw new ImagePluginError(`emo_alpha 必须是 0~1 的数字，收到 ${JSON.stringify(args.emo_alpha)}。`)
    }
    emoAlpha = args.emo_alpha
  }
  let durationFactor                    
  if (args.duration_factor !== undefined && args.duration_factor !== null) {
    // 与 talking/params.ts 的 pickDurationFactor 保持同一口径：(0, 3]，超出就报错而不是照单全收。
    if (typeof args.duration_factor !== 'number' || !Number.isFinite(args.duration_factor) || args.duration_factor <= 0 || args.duration_factor > 3) {
      throw new ImagePluginError(
        `duration_factor 必须是 (0, 3] 的数字，收到 ${JSON.stringify(args.duration_factor)}。`,
        '1 是原速；1.2 会明显更慢更长。'
      )
    }
    durationFactor = args.duration_factor
  }
  let lang                    = 'ZH'
  if (args.lang !== undefined && args.lang !== null) {
    if (!isAudioIndexTtsLang(args.lang)) {
      throw new ImagePluginError(`不认识的 lang：${JSON.stringify(args.lang)}。`, 'IndexTTS 只支持 ZH / EN。')
    }
    lang = args.lang
  }

  if (tts === 'indextts') {
    if (spkAudioPrompt.trim() === '') {
      throw new ImagePluginError(
        'tts=indextts 需要 spk_audio_prompt（一段 3~15 秒的参考音频）：IndexTTS 的音色完全由它决定。',
        '要么在参数里传 spk_audio_prompt，要么在配置里设 ttsSpkAudioPrompt；不想克隆音色就用 tts=edge。'
      )
    }
    if (emoVector && emoAudioPrompt) {
      throw new ImagePluginError('emo_vector 与 emo_audio_prompt 只能二选一。', 'emo_vector 手工指定 8 维情绪；emo_audio_prompt 拿另一段音频的情绪来模仿。')
    }
  } else if (args.spk_audio_prompt || args.emo_vector || args.emo_alpha !== undefined || args.emo_audio_prompt) {
    notes.push('tts=edge 时 spk_audio_prompt / emo_vector / emo_alpha / emo_audio_prompt 不生效（那是 IndexTTS 的参数）。')
  }

  const outputPath = typeof args.output_path === 'string' && args.output_path.trim() !== '' ? args.output_path.trim() : undefined

  return {
    script,
    tts,
    spkAudioPrompt,
    ...(emoVector ? { emoVector } : {}),
    ...(emoAlpha !== undefined ? { emoAlpha } : {}),
    ...(emoAudioPrompt ? { emoAudioPrompt } : {}),
    lang,
    ...(durationFactor !== undefined ? { durationFactor } : {}),
    edgeVoice,
    rate,
    edgePitch,
    edgeVolume,
    outputPath,
    notes
  }
}

export { MAX_AUDIO_SCRIPT_CHARS } from './types.js'
                                                                                           
