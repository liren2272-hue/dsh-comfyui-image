/**
 * 「说话视频」编排器：台词 → 语音 → 无声说话视频 → 对口型 → 成片。
 *
 * 整条链路的顺序不能换，因为每一步都要用上一步的**实际产物**：
 *   语音决定视频要多长（MuseTalk 会把视频截/补到音频长度，先定视频再配语音会白跑）。
 *
 * 三层各有一个「必须存在产物」的检查点，因为三个工具都会「零退出但没有产出」：
 *   - IndexTTS 的产物路径是我们指定的（--output），但仍要确认它真的写了；
 *   - 图生视频要确认 outputPaths 非空且文件真的存在；
 *   - MuseTalk 的产物在 results/<version>/ 下，不在 result_dir 直下。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ImagePluginError } from '../errors.js'
import { ensureDir, humanBytes, isFile, planOutputFile, resolveUserPath, timestampSlug, VIDEO_EXTS } from '../files.js'
import { logDebug } from '../log.js'
                                                                    
import { runGeneration } from '../runner.js'
import { runVideoGeneration } from '../video/runner.js'
                                                          
import { lastMeaningfulLine, runProcess,                                } from './exec.js'
import {
  buildMusetalkArgs,
  buildMusetalkYaml,
  musetalkResultPath
} from './lipsync.js'
import { framesForSeconds, normalizeTalkingRequest, voiceLabelOf } from './params.js'
import {
  edgeTtsPlan,
  indexttsTtsPlan,
  normalizeWavPlan,
  parseDuration,
  parseSize,
  probeDurationPlan,
  probeSizePlan,
  punctuateScript
} from './tts.js'
                                                                                            

/** 文字模式下先造一张「正脸对着镜头」的人像。人像提示词写死的部分不暴露成参数：
 *  口型链路对脸的角度、距离极敏感，让模型自由发挥只会得到一张侧脸然后对口型失败。 */
export const DEFAULT_PORTRAIT_PROMPT =
  'close-up portrait photo, a young Chinese woman facing the camera directly, looking at the viewer, ' +
  'mouth slightly open as if speaking, soft even lighting, plain neutral background, 50mm lens, sharp focus'

/** 图生视频的动作提示词：只让它动嘴，不换场景。 */
export const DEFAULT_SPEAKING_PROMPT =
  'the person speaks to the camera, lips and jaw moving naturally, subtle head movement, ' +
  'steady camera, locked framing, same background, no scene change'

                              
                   
                                         
                                      
                                 
 

                                    
                           
             
                        
                      
                    
 

                                   
                                   
                   
                       
                       
                       
                   
                       
                      
                      
                
             
               
                
                    
                   
                   
                    
                 
 

/**
 * 工作目录：所有中间产物都放这里，跑完就删（失败时留着便于排查）。
 *
 * 必须用 mkdtemp 而不是「时间戳 + pid」自己拼：同一进程同一秒内连续跑两次
 * （测试里就这样，实际也可能连点两下），拼出来的目录名会一模一样，后一次
 * 会把前一次的 wav/成片覆盖掉 —— 表现为两次运行拿到同一个 audioPath。
 * mkdtemp 会补随机后缀，天然唯一。
 */
function makeWorkDir()         {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-talking-${timestampSlug()}-`))
}

/** 取目录里最新的 .wav（仅调试用：IndexTTS 的产物路径是固定的，不需要靠它找）。 */
export function newestWav(dir        )                     {
  if (!fs.existsSync(dir)) return undefined
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .map((name) => {
      const full = path.join(dir, name)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.full
}

function assertExit(result           , what        , hint        )       {
  if (result.code === 0) return
  throw new ImagePluginError(
    `${what}失败（退出码 ${result.code ?? 'null'}）：${lastMeaningfulLine(result.stderr, '没有输出')}`,
    hint
  )
}

/** ① 语音：按配置选引擎，统一归一到 16k 单声道 wav，并量出真实时长。 */
async function synthSpeech(
  request                          ,
  config                ,
  workDir        ,
  signal                         ,
  deps             
)                                                                 {
  const notes           = []
  const text = punctuateScript(request.script)
  const rawDir = path.join(workDir, 'tts')
  ensureDir(rawDir)

  let rawFile        
  if (request.tts === 'indextts') {
    const outWav = path.join(rawDir, 'indextts.wav')
    const plan = indexttsTtsPlan({
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
      deps.spawn ? { spawn: deps.spawn } : {}
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
    const plan = edgeTtsPlan({ python: config.musetalkPython, text, voice: request.edgeVoice, rate: request.rate, outFile: mp3 })
    const result = await runProcess(
      { ...plan, timeoutMs: Math.min(config.talkingTimeoutMs, 5 * 60 * 1000), ...(signal ? { signal } : {}) },
      deps.spawn ? { spawn: deps.spawn } : {}
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

  // 归一到 16k 单声道：MuseTalk 的 whisper 特征按 16k 采样，喂 44.1k 会让口型对不齐。
  const wavPath = path.join(workDir, 'speech16k.wav')
  const normalize = await runProcess(
    { ...normalizeWavPlan(config.ffmpeg, rawFile, wavPath), timeoutMs: 120_000, ...(signal ? { signal } : {}) },
    deps.spawn ? { spawn: deps.spawn } : {}
  )
  assertExit(normalize, 'ffmpeg 转换语音格式', '检查 ffmpegBin 配置（当前 ' + config.ffmpegBin + '）是否含 ffmpeg.exe。')
  if (!isFile(wavPath)) throw new ImagePluginError('ffmpeg 没有产出 16k wav。', '语音源文件可能已损坏，删掉重跑一次。')

  const probe = await runProcess(
    { ...probeDurationPlan(config.ffprobe, wavPath), timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    deps.spawn ? { spawn: deps.spawn } : {}
  )
  const seconds = parseDuration(probe.stdout)
  if (!seconds) {
    throw new ImagePluginError('量不出语音时长。', 'ffprobe 可能不在 ffmpegBin 目录里（需要 ffmpeg.exe 与 ffprobe.exe 两个）。')
  }
  logDebug(`语音 ${seconds.toFixed(2)} 秒（${humanBytes(fs.statSync(wavPath).size)}）`)
  notes.push(`语音 ${seconds.toFixed(2)} 秒，音色 ${voiceLabelOf(request)}。`)
  return { wavPath, seconds, notes }
}

/** ② 画面：拿到一段「对着镜头说话」的无声视频。 */
async function makeBaseVideo(
  request                          ,
  config                ,
  workDir        ,
  audioSeconds        ,
  signal                         ,
  deps             
)                                                                                                                                     {
  const notes           = []
  const runVideo = deps.runVideo ?? runVideoGeneration
  const runImage = deps.runImage ?? runGeneration

  // 兜底给 0.3 秒余量：MuseTalk 按音频截视频，视频太短会把尾巴补成静止帧。
  const targetSeconds = request.seconds ?? Math.min(audioSeconds + 0.3, 20)
  const planned = framesForSeconds(targetSeconds, request.fps)
  notes.push(...planned.notes)

  if (request.mode === 'video2talking') {
    const source = resolveUserPath(request.inputVideo ?? '', os.homedir())
    if (!isFile(source)) {
      throw new ImagePluginError(`找不到 input_video：${request.inputVideo}`, '传绝对路径或相对当前工作目录的路径，且文件必须存在。')
    }
    const probe = await runProcess(
      { ...probeDurationPlan(config.ffprobe, source), timeoutMs: 60_000, ...(signal ? { signal } : {}) },
      deps.spawn ? { spawn: deps.spawn } : {}
    )
    const sourceSeconds = parseDuration(probe.stdout) ?? 0
    if (sourceSeconds < audioSeconds) {
      notes.push(
        `源视频只有 ${sourceSeconds.toFixed(2)} 秒、语音 ${audioSeconds.toFixed(2)} 秒：MuseTalk 会把最后一帧静止延长补足，` +
          '尾巴会有点僵，想避免就把源视频做得比语音长。'
      )
    }
    return {
      videoPath: source,
      seconds: sourceSeconds,
      width: request.width,
      height: request.height,
      frames: Math.round(sourceSeconds * request.fps),
      notes
    }
  }

  // image2talking / text2talking 都要先有一段说话视频
  let prompt        
  if (request.mode === 'text2talking') {
    prompt = request.prompt === '' ? DEFAULT_PORTRAIT_PROMPT : `${DEFAULT_PORTRAIT_PROMPT}, ${request.prompt}`
  } else {
    prompt = request.prompt === '' ? DEFAULT_SPEAKING_PROMPT : `${DEFAULT_SPEAKING_PROMPT}, ${request.prompt}`
  }

  let firstFramePath                    
  if (request.mode === 'image2talking') {
    firstFramePath = resolveUserPath(request.inputImage ?? '', os.homedir())
    if (!isFile(firstFramePath)) {
      throw new ImagePluginError(`找不到 input_image：${request.inputImage}`, '图生口型需要一张真实存在的图片；没有图请用 text2talking。')
    }
  } else {
    // 文字模式：先出一张正脸人像当首帧
    const imageArgs                    = {
      mode: 'text2img',
      prompt,
      width: request.width,
      height: request.height,
      seed: request.seed,
      output_path: path.join(workDir, 'keyframe.png')
    }
    const image = await runImage({ args: imageArgs, cwd: workDir, config, ...(signal ? { signal } : {}) })
    firstFramePath = image.outputPaths[0]
    if (!firstFramePath || !isFile(firstFramePath)) {
      throw new ImagePluginError('文字模式的关键帧没有生成成功。', '先确认 ComfyUI 在跑、SDXL 底模可用。')
    }
    notes.push('已用文生图造了一张正脸人像作为首帧。')
  }

  const videoOut = path.join(workDir, 'base_video.mp4')
  const videoArgs                    = {
    mode: 'img2video',
    prompt,
    input_image: firstFramePath,
    width: request.width,
    height: request.height,
    seed: request.seed,
    fps: request.fps,
    seconds: planned.seconds,
    output_path: videoOut
  }
  const video = await runVideo({ args: videoArgs, cwd: workDir, config, ...(signal ? { signal } : {}) })
  const produced = video.outputPaths[0]
  if (!produced || !isFile(produced)) {
    throw new ImagePluginError('图生视频没有产出文件。', '看图生视频那一步的错误；通常是 ComfyUI 队列里还有任务或显存不够。')
  }
  notes.push(`已生成 ${planned.frames} 帧 / ${planned.seconds.toFixed(2)} 秒的无声说话视频。`)
  return {
    videoPath: produced,
    seconds: planned.seconds,
    width: request.width,
    height: request.height,
    frames: planned.frames,
    promptId: video.promptId,
    notes
  }
}

/**
 * ③ 对口型。
 * 素材先拷进 <musetalkDir>/inputs（**无空格目录**），这是整条链最容易踩的坑：
 * 官方脚本拼 ffmpeg 命令时没加引号，路径带空格就整段失败。
 */
async function runLipsync(
  baseVideo        ,
  audioWav        ,
  slug        ,
  config                ,
  signal                         ,
  deps             
)                                                   {
  const notes           = []
  const inputsDir = path.join(config.musetalkDir, 'inputs')
  ensureDir(inputsDir)
  const safeVideo = path.join(inputsDir, `${slug}_base.mp4`)
  const safeAudio = path.join(inputsDir, `${slug}_audio.wav`)
  fs.copyFileSync(baseVideo, safeVideo)
  fs.copyFileSync(audioWav, safeAudio)
  if (/\s/.test(safeVideo) || /\s/.test(safeAudio)) {
    throw new ImagePluginError(
      `MuseTalk 的输入目录里含空格：${inputsDir}`,
      '官方 inference.py 拼 ffmpeg 命令时没有加引号，路径带空格必然失败。请把 musetalkDir 配到无空格路径。'
    )
  }

  const configName = `${slug}.yaml`
  const configPath = path.join(config.musetalkDir, 'configs', 'inference', configName)
  ensureDir(path.dirname(configPath))
  fs.writeFileSync(
    configPath,
    buildMusetalkYaml({ videoPath: safeVideo, audioPath: safeAudio, resultName: `${slug}.mp4` }),
    'utf8'
  )

  const resultDir = 'results'
  const args = buildMusetalkArgs({
    configPath: path.relative(config.musetalkDir, configPath).replace(/\\/g, '/'),
    unetModelPath: 'models/musetalkV15/unet.pth',
    unetConfigPath: 'models/musetalkV15/musetalk.json',
    whisperDir: 'models/whisper',
    resultDir,
    ffmpegPath: config.ffmpegBin.replace(/\//g, '\\')
  })

  logDebug('MuseTalk 对口型', { cwd: config.musetalkDir, slug })
  const env = { ...process.env }                     
  // MuseTalk 自己也会调 ffmpeg，PATH 里没有它时靠 --ffmpeg_path；两个都给最保险。
  env.PATH = `${config.ffmpegBin}${path.delimiter}${env.PATH ?? ''}`
  env.PYTHONIOENCODING = 'utf-8'

  const result = await runProcess(
    { command: config.musetalkPython, args, cwd: config.musetalkDir, env, timeoutMs: config.talkingTimeoutMs, ...(signal ? { signal } : {}) },
    deps.spawn ? { spawn: deps.spawn } : {}
  )
  assertExit(
    result,
    'MuseTalk 对口型',
    `检查 musetalkPython（当前 ${config.musetalkPython}）、musetalkDir（当前 ${config.musetalkDir}）与权重是否齐；` +
      '权重清单见 docs/VIDEO.md 同级的口型文档。'
  )

  const produced = path.join(config.musetalkDir, musetalkResultPath(resultDir, 'v15', `${slug}.mp4`))
  if (!isFile(produced)) {
    throw new ImagePluginError(
      'MuseTalk 正常退出但没有产出成片。',
      `官方把成片写在 ${path.dirname(produced)}；如果那里是空的，看看 stderr 里有没有 "no face detected"。`
    )
  }
  notes.push('口型已重绘并贴回（MuseTalk 1.5，256px 嘴部区域重建，边缘会有轻微柔化）。')
  return { outputPath: produced, notes }
}

export async function runTalkingGeneration(options                   )                            {
  const startedAt = Date.now()
  const { config } = options
  const deps              = options.deps ?? {}
  const request = normalizeTalkingRequest(options.args, config)
  const notes           = [...request.notes]
  const slug = `dsh_talk_${timestampSlug()}`
  const workDir = makeWorkDir()

  try {
    // ① 语音
    const speech = await synthSpeech(request, config, workDir, options.signal, deps)
    notes.push(...speech.notes)

    // ② 画面
    const base = await makeBaseVideo(request, config, workDir, speech.seconds, options.signal, deps)
    notes.push(...base.notes)

    // ③ 口型
    const lip = await runLipsync(base.videoPath, speech.wavPath, slug, config, options.signal, deps)
    notes.push(...lip.notes)

    // ④ 落盘（最终成片由用户指定位置）
    const planned = planOutputFile(request.outputPath, options.cwd, '.mp4', VIDEO_EXTS)
    ensureDir(path.dirname(planned.filePath))
    fs.copyFileSync(lip.outputPath, planned.filePath)
    const size = fs.statSync(planned.filePath).size
    logDebug(`成片已写入 ${planned.filePath}（${humanBytes(size)}）`)

    const durationMs = Date.now() - startedAt
    const voiceLabel = voiceLabelOf(request)

    // ⑤ 元数据 sidecar
    let metadataPath                    
    if (config.writeMetadata) {
      metadataPath = `${planned.filePath}.json`
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify(
          {
            plugin: 'dsh-comfyui-image',
            createdAt: new Date().toISOString(),
            mode: request.mode,
            modeInferred: request.modeInferred,
            script: request.script,
            tts: {
              engine: request.tts,
              label: voiceLabel,
              spkAudioPrompt: request.tts === 'indextts' ? request.spkAudioPrompt : null,
              lang: request.tts === 'indextts' ? request.lang : null,
              emoVector: request.emoVector ?? null,
              emoAlpha: request.emoAlpha ?? null,
              emoAudioPrompt: request.emoAudioPrompt ?? null,
              durationFactor: request.durationFactor ?? null,
              voice: request.edgeVoice,
              rate: request.rate
            },
            audio: { file: speech.wavPath, seconds: Number(speech.seconds.toFixed(3)) },
            baseVideo: { file: base.videoPath, seconds: Number(base.seconds.toFixed(3)), frames: base.frames },
            lipsync: { engine: 'musetalk-1.5', workDir: config.musetalkDir },
            video: { width: request.width, height: request.height, fps: request.fps, frames: base.frames },
            seed: request.seed,
            prompt: request.prompt,
            comfy: { url: config.baseUrl, promptId: base.promptId ?? null },
            durationMs,
            outputFile: planned.filePath,
            notes,
            extra: options.args.extra_options ?? {}
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }

    return {
      request,
      mode: request.mode,
      modeInferred: request.modeInferred,
      outputPaths: [planned.filePath],
      ...(metadataPath ? { metadataPath } : {}),
      audioPath: speech.wavPath,
      baseVideoPath: base.videoPath,
      audioSeconds: speech.seconds,
      videoSeconds: base.seconds,
      frames: base.frames,
      fps: request.fps,
      width: request.width,
      height: request.height,
      voiceLabel,
      ...(base.promptId ? { promptId: base.promptId } : {}),
      comfyUrl: config.baseUrl,
      durationMs,
      notes
    }
  } catch (error) {
    // 失败时保留工作目录，并在错误提示里指出位置——中间产物（语音 / 无声视频）往往还能单独用。
    const keep = process.env.DSH_COMFYUI_KEEP_WORK === '1' ? '（按 DSH_COMFYUI_KEEP_WORK=1 保留）' : ''
    if (error instanceof ImagePluginError) {
      throw new ImagePluginError(error.message, `${error.hint ? `${error.hint} ` : ''}中间产物在 ${workDir}${keep}`)
    }
    throw error
  }
}

/** 供 tool 层复用：把探到的尺寸补进请求（图片尺寸与配置不一致时以图为准）。 */
export async function probeVideoSize(
  input        ,
  config                ,
  deps              = {}
)                                                         {
  if (!isFile(input)) return undefined
  const result = await runProcess(probeSizePlan(config.ffprobe, input), deps.spawn ? { spawn: deps.spawn } : {})
  if (result.code !== 0) return undefined
  return parseSize(result.stdout)
}