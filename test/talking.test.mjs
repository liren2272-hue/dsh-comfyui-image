/**
 * generate_talking_video（台词 → 语音 → 说话视频 → 对口型）的测试。
 *
 * 分三层：
 *   1. **纯函数层**：参数归一、帧数对齐、命令拼装、MuseTalk 的 yaml/args —— 秒级，无副作用；
 *   2. **编排层**：用假 spawn 把「python 合成语音 / ffmpeg 转码 / ffprobe 量时长 /
 *      MuseTalk 出片」整条链跑一遍，验证「每一步真的用了上一步的产物」；
 *   3. **契约层**：工具 schema 只用 DSH 支持的子集，失败文案带 ❌。
 *
 * 假 spawn 的意义：真跑一次要 8~10 分钟，而这条链最贵的 bug 恰恰是「参数传错但跑得通」。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildMusetalkArgs,
  buildMusetalkYaml,
  createGenerateTalkingTool,
  DEFAULT_PORTRAIT_PROMPT,
  edgeTtsPlan,
  formatTalkingResult,
  framesForSeconds,
  INDEXTTS_EMO_ORDER,
  INDEXTTS_LANGS,
  indexttsTtsPlan,
  inferTalkingMode,
  isIndexTtsLang,
  isTalkingMode,
  isTtsEngine,
  MAX_SCRIPT_CHARS,
  musetalkResultPath,
  normalizeTalkingRequest,
  normalizeWavPlan,
  parseDuration,
  parseSize,
  punctuateScript,
  renderTalkingResultText,
  runTalkingGeneration,
  TALKING_MODES,
  TALKING_OUTPUT_SCHEMA,
  TALKING_PARAMETERS_SCHEMA,
  TALKING_TOOL_NAME,
  voiceLabelOf
} from '../lib/index.js'
import { tempDir, testConfig, writePng } from './helpers.mjs'

/* ─────────────────────────── 纯函数层 ─────────────────────────── */

test('TALKING_MODES / 枚举守卫：只认设计过的值', () => {
  assert.deepEqual([...TALKING_MODES], ['text2talking', 'image2talking', 'video2talking'])
  assert.equal(isTalkingMode('video2talking'), true)
  assert.equal(isTalkingMode('txt2talk'), false)
  assert.equal(isTtsEngine('indextts'), true)
  assert.equal(isTtsEngine('gpt-sovits'), false)
  assert.equal(isIndexTtsLang('ZH'), true)
  assert.equal(isIndexTtsLang('zh'), false)
  assert.deepEqual([...INDEXTTS_LANGS], ['ZH', 'EN'])
  assert.equal(INDEXTTS_EMO_ORDER.length, 8)
})

test('framesForSeconds：2 秒 → 49 帧，且换算回真实秒数', () => {
  const plan = framesForSeconds(2, 24)
  assert.equal(plan.frames, 49)
  assert.ok(Math.abs(plan.seconds - 49 / 24) < 1e-9)
  assert.equal(plan.notes.length, 0)
})

test('framesForSeconds：超上限的时长会被夹住并写明', () => {
  const plan = framesForSeconds(120, 24)
  assert.equal(plan.frames, 481)
  assert.ok(plan.notes.some((note) => note.includes('夹到')))
})

test('inferTalkingMode：视频优先于图，都没有就是文字', () => {
  assert.equal(inferTalkingMode({ input_video: 'a.mp4' }), 'video2talking')
  assert.equal(inferTalkingMode({ input_image: 'a.png' }), 'image2talking')
  assert.equal(inferTalkingMode({ input_image: 'a.png', input_video: 'a.mp4' }), 'video2talking')
  assert.equal(inferTalkingMode({ script: '你好' }), 'text2talking')
})

test('normalizeTalkingRequest：默认值来自配置，模式自动推断', () => {
  const config = testConfig({ ttsEngine: 'edge', edgeVoice: 'zh-CN-YunxiNeural', edgeRate: '+5%' })
  const request = normalizeTalkingRequest({ script: '  大家好  ' }, config)
  assert.equal(request.mode, 'text2talking')
  assert.equal(request.modeInferred, true)
  assert.equal(request.script, '大家好')
  assert.equal(request.tts, 'edge')
  assert.equal(request.edgeVoice, 'zh-CN-YunxiNeural')
  assert.equal(request.rate, '+5%')
  assert.ok(request.notes.some((note) => note.includes('推断')))
})

test('normalizeTalkingRequest：模式与输入不匹配就报错，不猜', () => {
  const config = testConfig()
  assert.throws(() => normalizeTalkingRequest({ mode: 'video2talking', script: '你好' }, config), /需要 input_video/)
  assert.throws(() => normalizeTalkingRequest({ mode: 'image2talking', script: '你好' }, config), /需要 input_image/)
  assert.throws(
    () => normalizeTalkingRequest({ mode: 'text2talking', script: '你好', input_video: 'a.mp4' }, config),
    /不接受 input_video/
  )
})

test('normalizeTalkingRequest：台词为空或过长都拒绝', () => {
  const config = testConfig()
  assert.throws(() => normalizeTalkingRequest({ script: '   ' }, config), /script 不能为空/)
  assert.throws(() => normalizeTalkingRequest({}, config), /script 不能为空/)
  const long = '字'.repeat(MAX_SCRIPT_CHARS + 1)
  assert.throws(() => normalizeTalkingRequest({ script: long }, config), new RegExp(`超过 ${MAX_SCRIPT_CHARS}`))
})

test('normalizeTalkingRequest：非法枚举与越界数字都带范围提示', () => {
  const config = testConfig()
  assert.throws(() => normalizeTalkingRequest({ script: '你好', lang: 'JP' }, config), /不认识的 lang/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', emo_vector: [1, 2] }, config), /emo_vector 必须是 8 维|8 个 0~1/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', emo_alpha: 2 }, config), /emo_alpha 必须是 0~1/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', duration_factor: 0 }, config), /duration_factor 必须是/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', tts: 'wav' }, config), /不认识的 tts/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', fps: 240 }, config), /fps 必须在/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', seconds: 0 }, config), /seconds 必须大于 0/)
  assert.throws(() => normalizeTalkingRequest({ script: '你好', width: 10 }, config), /width 必须是/)
})

test('normalizeTalkingRequest：宽高对齐到 32 的倍数并留备注', () => {
  const config = testConfig()
  const request = normalizeTalkingRequest({ script: '你好', width: 700, height: 500 }, config)
  assert.equal(request.width, 704)
  assert.equal(request.height, 512)
  assert.ok(request.notes.some((note) => note.includes('32 的倍数')))
})

test('normalizeTalkingRequest：tts=edge 时 IndexTTS 专属参数不生效会说明', () => {
  const config = testConfig()
  const request = normalizeTalkingRequest(
    { script: '你好', tts: 'edge', spk_audio_prompt: 'D:/ref/a.wav', emo_alpha: 0.5 },
    config
  )
  assert.equal(request.tts, 'edge')
  assert.ok(request.notes.some((note) => note.includes('不生效')))
})

test('voiceLabelOf：两种引擎的标签都能复现音色', () => {
  const config = testConfig()
  const indexReq = normalizeTalkingRequest(
    { script: '你好', tts: 'indextts', spk_audio_prompt: 'D:/ref/voice.wav', lang: 'EN' },
    config
  )
  assert.match(voiceLabelOf(indexReq), /IndexTTS-2.*克隆音色/)
  assert.match(voiceLabelOf(indexReq), /lang EN/)
  const edgeReq = normalizeTalkingRequest({ script: '你好', tts: 'edge', edge_voice: 'zh-CN-XiaoyiNeural' }, config)
  assert.match(voiceLabelOf(edgeReq), /edge-tts.*zh-CN-XiaoyiNeural/)
})

/* ─────────────────────────── 命令拼装 ─────────────────────────── */

test('indexttsTtsPlan：cwd 必须是仓库根，参考音频与产物路径原样传进去', () => {
  const plan = indexttsTtsPlan({
    python: 'D:/Tools/IndexTTS/.venv/Scripts/python.exe',
    indexttsDir: 'D:/Tools/IndexTTS',
    spkAudioPrompt: 'D:/ref/voice.wav',
    text: '你好。',
    outFile: 'D:/tmp/indextts/out.wav',
    lang: 'ZH',
    device: 'cuda:0'
  })
  assert.equal(plan.command, 'D:/Tools/IndexTTS/.venv/Scripts/python.exe')
  assert.equal(plan.cwd, 'D:/Tools/IndexTTS')
  assert.equal(plan.args[0], 'dsh_indextts_infer.py')
  assert.equal(plan.args[plan.args.indexOf('--spk_audio_prompt') + 1], 'D:/ref/voice.wav')
  assert.equal(plan.args[plan.args.indexOf('--text') + 1], '你好。')
  // 产物路径必须是我们指定的那个：IndexTTS 不像 Spark-TTS 那样自己编时间戳文件名
  assert.equal(plan.args[plan.args.indexOf('--output') + 1], 'D:/tmp/indextts/out.wav')
  assert.equal(plan.args[plan.args.indexOf('--lang') + 1], 'ZH')
  assert.equal(plan.args[plan.args.indexOf('--device') + 1], 'cuda:0')
})

test('indexttsTtsPlan：情绪参数与时长系数只在给了才出现', () => {
  const base = {
    python: 'py',
    indexttsDir: 'D:/Tools/IndexTTS',
    spkAudioPrompt: 'D:/ref/v.wav',
    text: '你好。',
    outFile: 'a.wav'
  }
  const plain = indexttsTtsPlan(base)
  assert.equal(plain.args.includes('--emo_vector'), false)
  assert.equal(plain.args.includes('--emo_alpha'), false)
  assert.equal(plain.args.includes('--duration_factor'), false)

  const rich = indexttsTtsPlan({
    ...base,
    emoVector: [0, 0.8, 0, 0, 0, 0, 0, 0.2],
    emoAlpha: 0.7,
    durationFactor: 1.2
  })
  // 8 维情绪按 INDEXTTS_EMO_ORDER 顺序逗号连接
  assert.equal(rich.args[rich.args.indexOf('--emo_vector') + 1], '0,0.8,0,0,0,0,0,0.2')
  assert.equal(rich.args[rich.args.indexOf('--emo_alpha') + 1], '0.7')
  assert.equal(rich.args[rich.args.indexOf('--duration_factor') + 1], '1.2')
})

test('edgeTtsPlan：用 -m edge_tts，不用 Scripts\\*.exe', () => {
  const plan = edgeTtsPlan({ python: 'py.exe', text: '你好。', voice: 'zh-CN-YunxiNeural', rate: '-4%', outFile: 'a.mp3' })
  assert.deepEqual(plan.args.slice(0, 2), ['-m', 'edge_tts'])
  assert.equal(plan.args[plan.args.indexOf('--voice') + 1], 'zh-CN-YunxiNeural')
  // 语速值以 - 开头，必须用 --rate=-4% 的等号形式，否则 argparse 报 "expected one argument"
  assert.ok(plan.args.includes('--rate=-4%'), 'rate 必须走 --rate= 形式')
  assert.ok(!plan.args.includes('--rate'), '不能把 --rate 单独作为一项')
  assert.equal(plan.args[plan.args.indexOf('--voice') + 1], 'zh-CN-YunxiNeural')
  assert.equal(plan.args[plan.args.indexOf('--write-media') + 1], 'a.mp3')
})

test('normalizeWavPlan：强制 16k 单声道（MuseTalk 的 whisper 特征按 16k 采）', () => {
  const plan = normalizeWavPlan('ffmpeg', 'in.mp3', 'out.wav')
  assert.deepEqual(plan.args.slice(-7), ['-ar', '16000', '-ac', '1', '-sample_fmt', 's16', 'out.wav'])
})

test('punctuateScript / parseDuration / parseSize', () => {
  assert.equal(punctuateScript('大家好'), '大家好。')
  assert.equal(punctuateScript('大家好！'), '大家好！')
  assert.equal(punctuateScript(''), '')
  assert.equal(parseDuration('5.616\n'), 5.616)
  assert.equal(parseDuration('abc'), undefined)
  assert.deepEqual(parseSize('832x480\n'), { width: 832, height: 480 })
  assert.equal(parseSize('garbage'), undefined)
})

/* ───────────────────── MuseTalk 的 yaml 与参数 ───────────────────── */

test('buildMusetalkYaml：反斜杠换成正斜杠，结构是 task_talk', () => {
  const yaml = buildMusetalkYaml({
    videoPath: 'D:\\Tools\\MuseTalk\\inputs\\a.mp4',
    audioPath: 'D:\\Tools\\MuseTalk\\inputs\\b.wav',
    resultName: 'out.mp4'
  })
  assert.ok(yaml.startsWith('task_talk:\n'))
  assert.ok(yaml.includes('video_path: D:/Tools/MuseTalk/inputs/a.mp4'))
  assert.ok(yaml.includes('audio_path: D:/Tools/MuseTalk/inputs/b.wav'))
  assert.ok(yaml.includes('result_name: out.mp4'))
})

test('buildMusetalkArgs：默认带 use_float16 与 jaw 模式，可关掉', () => {
  const base = {
    configPath: 'configs/inference/a.yaml',
    unetModelPath: 'models/musetalkV15/unet.pth',
    unetConfigPath: 'models/musetalkV15/musetalk.json',
    whisperDir: 'models/whisper',
    resultDir: 'results',
    ffmpegPath: 'C:\\FFmpeg\\bin'
  }
  const args = buildMusetalkArgs(base)
  assert.deepEqual(args.slice(0, 2), ['-m', 'scripts.inference'])
  assert.equal(args[args.indexOf('--version') + 1], 'v15')
  assert.equal(args[args.indexOf('--parsing_mode') + 1], 'jaw')
  assert.ok(args.includes('--use_float16'))
  const noFp16 = buildMusetalkArgs({ ...base, useFloat16: false })
  assert.equal(noFp16.includes('--use_float16'), false)
})

test('musetalkResultPath：成片在 results/<version>/ 下，不是 resultDir 直下', () => {
  assert.equal(musetalkResultPath('results', 'v15', 'a.mp4'), 'results/v15/a.mp4')
  assert.equal(musetalkResultPath('results/', 'v15', 'a.mp4'), 'results/v15/a.mp4')
})

/* ─────────────────────── 编排层（假 spawn） ─────────────────────── */

/** 假的 child_process.spawn：handler 可以写文件、返回退出码与输出。 */
function fakeSpawn(handler) {
  return (command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      Promise.resolve()
        .then(() => handler(command, args))
        .then((out = {}) => {
          if (out.stdout) child.stdout.emit('data', Buffer.from(out.stdout))
          if (out.stderr) child.stderr.emit('data', Buffer.from(out.stderr))
          child.emit('close', out.code ?? 0)
        })
        .catch((error) => child.emit('error', error))
    })
    return child
  }
}

function argValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** 造一条完整的假链路：语音→(假)图生视频→假 MuseTalk 出片。 */
function setupChain(options = {}) {
  const workRoot = tempDir('dsh-talk')
  const indexttsDir = path.join(workRoot, 'indextts')
  const musetalkDir = path.join(workRoot, 'musetalk')
  const outDir = path.join(workRoot, 'out')
  fs.mkdirSync(indexttsDir, { recursive: true })
  fs.mkdirSync(musetalkDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })

  const seen = { musetalkArgs: null, wavBytes: 0, yaml: '', ttsArgs: null }
  const spawn = fakeSpawn((command, args) => {
    if (command === 'ffprobe') {
      return { stdout: options.duration ?? '5.616\n' }
    }
    if (command === 'ffmpeg') {
      const out = args[args.length - 1]
      fs.writeFileSync(out, Buffer.from([0x52, 0x49, 0x46, 0x46]))
      return {}
    }
    const module = `${args[0] ?? ''} ${args[1] ?? ''}`
    if (args[0] === 'dsh_indextts_infer.py') {
      // IndexTTS 的产物路径由 --output 指定（不像 Spark-TTS 自己编文件名）
      seen.ttsArgs = args
      const out = argValue(args, '--output')
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from('wav'))
      seen.wavBytes = 3
      return {}
    }
    if (module === '-m scripts.inference') {
      seen.musetalkArgs = args
      const configPath = argValue(args, '--inference_config')
      const fullYaml = path.join(musetalkDir, configPath)
      seen.yaml = fs.readFileSync(fullYaml, 'utf8')
      const name = /result_name:\s*(\S+)/.exec(seen.yaml)?.[1] ?? 'out.mp4'
      const resultFile = path.join(musetalkDir, 'results', 'v15', name)
      fs.mkdirSync(path.dirname(resultFile), { recursive: true })
      fs.writeFileSync(resultFile, Buffer.from([0x00, 0x00, 0x00, 0x18]))
      return {}
    }
    if (module === '-m edge_tts') {
      fs.writeFileSync(argValue(args, '--write-media'), Buffer.from('mp3'))
      return {}
    }
    return {}
  })

  const config = testConfig({
    ttsEngine: 'indextts',
    ttsSpkAudioPrompt: path.join(workRoot, 'ref.wav'),
    indexttsDir,
    indexttsPython: 'py-indextts',
    musetalkDir,
    musetalkPython: 'py-musetalk',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    writeMetadata: true
  })

  const videoCalls = []
  const runVideo = async (request) => {
    videoCalls.push(request.args)
    const target = request.args.output_path
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from('BASEVI'))
    return { outputPaths: [target], promptId: 'fake-prompt-1', comfyUrl: config.baseUrl }
  }
  const runImage = async (request) => {
    const target = request.args.output_path
    fs.writeFileSync(target, Buffer.from('PNG'))
    return { outputPaths: [target], promptId: 'fake-image-1' }
  }

  return { workRoot, indexttsDir, musetalkDir, outDir, config, spawn, seen, runVideo, runImage, videoCalls }
}

test('runTalkingGeneration：text2talking 全链路打通，产物与元数据齐全', async () => {
  const chain = setupChain()
  const run = await runTalkingGeneration({
    args: { script: '大家好，今天聊个小事。', seed: 42, output_path: path.join(chain.outDir, 'talk.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
  })

  // ① 成片真的存在，且是「MuseTalk 的产物被拷过来」而不是空文件
  const output = path.join(chain.outDir, 'talk.mp4')
  assert.ok(fs.existsSync(output))
  assert.equal(fs.statSync(output).size, 4)

  // ② 语音时长来自 ffprobe 的真值，视频时长按 4n+1 反算
  assert.equal(run.audioSeconds, 5.616)
  assert.equal(run.frames, 141) // (5.616 + 0.3) 秒 → 141 帧（4n+1）
  assert.ok(Math.abs(run.videoSeconds - 141 / 24) < 1e-9)

  // ③ 图生视频那一步用的是「文字造出来的正脸首帧」和默认说话提示词
  assert.equal(chain.videoCalls.length, 1)
  const videoArgs = chain.videoCalls[0]
  assert.equal(videoArgs.mode, 'img2video')
  assert.ok(videoArgs.input_image.endsWith('keyframe.png'))
  assert.ok(videoArgs.prompt.startsWith(DEFAULT_PORTRAIT_PROMPT.slice(0, 20)))

  // ④ MuseTalk 拿到的 yaml 指向当前这条链的素材，参数带 v15 / jaw
  assert.match(chain.seen.yaml, /result_name: out|result_name: dsh_talk_/)
  assert.equal(argValue(chain.seen.musetalkArgs, '--version'), 'v15')
  assert.equal(argValue(chain.seen.musetalkArgs, '--parsing_mode'), 'jaw')

  // ⑤ 元数据能复现这条片子
  const metadata = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'))
  assert.equal(metadata.script, '大家好，今天聊个小事。')
  assert.equal(metadata.tts.engine, 'indextts')
  assert.equal(metadata.tts.lang, 'ZH')
  assert.equal(metadata.audio.seconds, 5.616)
  assert.equal(metadata.video.frames, 141)
  assert.equal(metadata.comfy.promptId, 'fake-prompt-1')
  assert.ok(metadata.notes.some((note) => note.includes('口型已重绘')))
})

test('runTalkingGeneration：video2talking 跳过图生视频，只跑语音 + 口型', async () => {
  const chain = setupChain()
  const sourceVideo = path.join(chain.workRoot, 'source.mp4')
  fs.writeFileSync(sourceVideo, Buffer.from('SOURCEVIDEO'))
  const run = await runTalkingGeneration({
    args: { script: '换一句台词。', input_video: sourceVideo, output_path: path.join(chain.outDir, 'relip.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
  })
  assert.equal(run.mode, 'video2talking')
  assert.equal(chain.videoCalls.length, 0)
  assert.ok(fs.existsSync(path.join(chain.outDir, 'relip.mp4')))
})

test('runTalkingGeneration：edge-tts 路径也能走通', async () => {
  const chain = setupChain()
  const run = await runTalkingGeneration({
    args: { script: '看晓晓说话。', tts: 'edge', edge_voice: 'zh-CN-XiaoxiaoNeural', output_path: path.join(chain.outDir, 'edge.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
  })
  assert.equal(run.request.tts, 'edge')
  assert.match(run.voiceLabel, /edge-tts.*Xiaoxiao/)
})

test('runTalkingGeneration：MuseTalk 没产出成片 → 明确报错，不假装成功', async () => {
  const chain = setupChain()
  const spawn = fakeSpawn((command, args) => {
    if (command === 'ffprobe') return { stdout: '2.0\n' }
    if (command === 'ffmpeg') {
      fs.writeFileSync(args[args.length - 1], Buffer.from('wav'))
      return {}
    }
    const module = `${args[0] ?? ''} ${args[1] ?? ''}`
    if (args[0] === 'dsh_indextts_infer.py') {
      fs.writeFileSync(argValue(args, '--output'), Buffer.from('wav'))
      return {}
    }
    // scripts.inference 故意不写产物
    return {}
  })
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', output_path: path.join(chain.outDir, 'nope.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn, runVideo: chain.runVideo, runImage: chain.runImage }
    }),
    /没有产出成片/
  )
  assert.equal(fs.existsSync(path.join(chain.outDir, 'nope.mp4')), false)
})

test('runTalkingGeneration：TTS 非零退出时把 stderr 末行带出来', async () => {
  const chain = setupChain()
  const spawn = fakeSpawn((command, args) => {
    if (args[0] === 'dsh_indextts_infer.py') {
      return { code: 1, stderr: 'Traceback...\nRuntimeError: 模型目录不完整\n' }
    }
    return {}
  })
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', output_path: path.join(chain.outDir, 'x.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn, runVideo: chain.runVideo, runImage: chain.runImage }
    }),
    /模型目录不完整/
  )
})

test('runTalkingGeneration：input_image 不存在 → 立刻报错（不白跑图生视频）', async () => {
  const chain = setupChain()
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', input_image: path.join(chain.workRoot, 'missing.png'), output_path: path.join(chain.outDir, 'y.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
    }),
    /找不到 input_image/
  )
  assert.equal(chain.videoCalls.length, 0)
})

/* ─────────────────────────── 契约层 ─────────────────────────── */

test('工具 schema 只用 DSH 支持的子集（无 minimum / format / pattern）', () => {
  const banned = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'format', 'pattern', 'multipleOf'])
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      assert.equal(banned.has(key), false, `${where} 里出现了不支持的键 ${key}`)
      walk(value, `${where}.${key}`)
    }
  }
  walk(TALKING_PARAMETERS_SCHEMA, 'parameters')
  assert.deepEqual([...TALKING_PARAMETERS_SCHEMA.required], ['script'])
  assert.equal(TALKING_PARAMETERS_SCHEMA.additionalProperties, false)
  for (const key of ['path', 'mode', 'voice', 'audio_seconds', 'video_seconds', 'frames']) {
    assert.ok(TALKING_OUTPUT_SCHEMA.required.includes(key), `输出 schema 缺少 ${key}`)
  }
})

test('工具定义：name/description/parameters/output/execute 齐全，失败带 ❌', async () => {
  const tool = createGenerateTalkingTool()
  assert.equal(tool.name, TALKING_TOOL_NAME)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.parameters.properties.script)
  await assert.rejects(
    tool.execute({ script: '   ' }, { agent: { meta: { cwd: tempDir('dsh-talk-tool') } } }),
    /❌ 出片失败/
  )
})

test('formatTalkingResult / renderTalkingResultText：首行状态 + 裸路径单独一行', () => {
  const value = formatTalkingResult({
    request: {
      mode: 'image2talking',
      modeInferred: false,
      script: '你好。',
      tts: 'indextts',
      spkAudioPrompt: 'D:/ref/voice.wav',
      lang: 'ZH',
      edgeVoice: 'zh-CN-XiaoxiaoNeural',
      rate: '-4%',
      prompt: '',
      fps: 24,
      width: 832,
      height: 480,
      seed: 7,
      notes: []
    },
    mode: 'image2talking',
    modeInferred: false,
    outputPaths: ['D:/out/a.mp4'],
    audioPath: 'D:/w/a.wav',
    baseVideoPath: 'D:/w/base.mp4',
    audioSeconds: 5.616,
    videoSeconds: 2.0416,
    frames: 49,
    fps: 24,
    width: 832,
    height: 480,
    voiceLabel: 'IndexTTS-2 克隆音色 · D:/ref/voice.wav',
    comfyUrl: 'http://127.0.0.1:8188',
    promptId: 'p1',
    durationMs: 12345,
    notes: []
  })
  assert.ok(value.text.startsWith('✅ 口型视频成功（图片 → 说话 → 口型）'))
  assert.ok(value.text.includes('\n\n视频：D:/out/a.mp4'))
  assert.ok(value.text.includes('49 帧 / 2.04 秒'))
  assert.ok(value.text.includes('语音 5.62 秒'))
  const rendered = renderTalkingResultText(value)
  assert.equal(rendered.split('\n')[0], '✅ 口型视频成功（图片 → 说话 → 口型）')
})

test('两句台词走同一套默认配置时，语音文件名取最新的那个', async () => {
  const chain = setupChain()
  // 两次独立运行都写进各自的工作目录，互不干扰（工作目录带时间戳+pid）
  const first = await runTalkingGeneration({
    args: { script: '第一句。', output_path: path.join(chain.outDir, 'one.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
  })
  const second = await runTalkingGeneration({
    args: { script: '第二句。', output_path: path.join(chain.outDir, 'two.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runVideo: chain.runVideo, runImage: chain.runImage }
  })
  assert.notEqual(first.audioPath, second.audioPath)
  assert.ok(fs.existsSync(path.join(chain.outDir, 'one.mp4')))
  assert.ok(fs.existsSync(path.join(chain.outDir, 'two.mp4')))
})