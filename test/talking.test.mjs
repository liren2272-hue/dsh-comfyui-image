/**
 * generate_talking_video（台词 → 语音 → 首帧 → InfiniteTalk 端到端口型）的测试。
 *
 * 分三层：
 *   1. **纯函数层**：参数归一、帧数对齐、命令拼装、InfiniteTalk 工作流构建 —— 秒级，无副作用；
 *   2. **编排层**：用假 spawn + 假 ComfyUI client 把「python 合成语音 / ffmpeg 转码 /
 *      ffprobe 量时长 / 文生图首帧 / InfiniteTalk 出片」整条链跑一遍，验证「每一步真的用了上一步的产物」；
 *   3. **契约层**：工具 schema 只用 DSH 支持的子集，失败文案带 ❌。
 *
 * 假 spawn / 假 client 的意义：真跑一次要 20 分钟以上，而这条链最贵的 bug 恰恰是「参数传错但跑得通」。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  autoResolutionForFrames,
  buildInfiniteTalkWorkflow,
  createGenerateTalkingTool,
  DEFAULT_INFINITETALK_NEGATIVE,
  DEFAULT_INFINITETALK_PROMPT,
  DEFAULT_PORTRAIT_PROMPT,
  edgeTtsPlan,
  formatTalkingResult,
  framesForSeconds,
  INDEXTTS_EMO_ORDER,
  INDEXTTS_LANGS,
  INFINITETALK_MODELS,
  indexttsTtsPlan,
  inferTalkingMode,
  isIndexTtsLang,
  isTalkingMode,
  isTtsEngine,
  MAX_SCRIPT_CHARS,
  normalizeTalkingRequest,
  normalizeWavPlan,
  parseDuration,
  parseSize,
  punctuateScript,
  renderTalkingResultText,
  runTalkingGeneration,
  TALKING_HD_MAX_FRAMES,
  TALKING_LOWRES_SIZE,
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

test('autoResolutionForFrames：短台词保持高清、长台词降到 512x320', () => {
  const hd = { width: 832, height: 480 }
  // 临界 60 帧（含）保持高清
  assert.deepEqual(autoResolutionForFrames(TALKING_HD_MAX_FRAMES, hd, {}), { width: 832, height: 480 })
  // 61 帧起降级
  const lo = autoResolutionForFrames(TALKING_HD_MAX_FRAMES + 1, hd, {})
  assert.equal(lo.width, TALKING_LOWRES_SIZE.width)
  assert.equal(lo.height, TALKING_LOWRES_SIZE.height)
  assert.ok(lo.note && lo.note.includes('512x320'))
  // 典型长台词 121 帧
  const lo121 = autoResolutionForFrames(121, hd, {})
  assert.equal(lo121.width, 512)
  assert.equal(lo121.height, 320)
})

test('autoResolutionForFrames：显式传 width 或 height 时完全尊重，不自动降级', () => {
  const hd = { width: 832, height: 480 }
  // 显式场景下 current 已是归一化后的值（含用户传的那维）
  assert.deepEqual(autoResolutionForFrames(172, { width: 1024, height: 480 }, { width: 1024 }), { width: 1024, height: 480 })
  assert.deepEqual(autoResolutionForFrames(172, { width: 832, height: 576 }, { height: 576 }), { width: 832, height: 576 })
  const explicit = autoResolutionForFrames(172, { width: 1024, height: 576 }, { width: 1024, height: 576 })
  assert.deepEqual(explicit, { width: 1024, height: 576 })
  assert.equal(explicit.note, undefined) // 尊重用户时不加降级说明
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

test('normalizeWavPlan：强制 16k 单声道（InfiniteTalk 的 wav2vec2 按 16k 采）', () => {
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

/* ───────────────────── InfiniteTalk 工作流构建 ───────────────────── */

test('buildInfiniteTalkWorkflow：14 节点齐全，首帧/音频/帧数接对了', () => {
  const wf = buildInfiniteTalkWorkflow({
    imageName: 'frame.png',
    audioName: 'voice.wav',
    frames: 81,
    fps: 25,
    width: 832,
    height: 480,
    seed: 42,
    filenamePrefix: 'dsh_talk'
  })
  assert.deepEqual(Object.keys(wf).sort(), Array.from({ length: 14 }, (_, i) => String(i + 1)).sort())
  assert.equal(wf['1'].inputs.image, 'frame.png')
  assert.equal(wf['2'].inputs.audio, 'voice.wav')
  assert.equal(wf['10'].inputs.num_frames, 81)
  assert.equal(wf['11'].inputs.frame_window_size, 81)
  assert.equal(wf['10'].inputs.fps, 25)
  assert.equal(wf['11'].inputs.width, 832)
  assert.equal(wf['11'].inputs.height, 480)
  assert.equal(wf['11'].inputs.mode, 'infinitetalk')
  assert.equal(wf['14'].class_type, 'VHS_VideoCombine')
  assert.equal(wf['14'].inputs.format, 'video/h264-mp4')
  assert.deepEqual(wf['14'].inputs.audio, ['10', 1])
  assert.equal(wf['14'].inputs.filename_prefix, 'dsh_talk')
})

test('buildInfiniteTalkWorkflow：默认提示词/种子，6GB 关键的三个坑都避开', () => {
  const wf = buildInfiniteTalkWorkflow({ imageName: 'a.png', audioName: 'b.wav', frames: 41 })
  assert.equal(wf['9'].inputs.positive_prompt, DEFAULT_INFINITETALK_PROMPT)
  assert.equal(wf['9'].inputs.negative_prompt, DEFAULT_INFINITETALK_NEGATIVE)
  assert.equal(wf['12'].inputs.seed, 42)
  assert.equal(wf['7'].inputs.merge_loras, false)
  assert.equal(wf['9'].inputs.model_name, INFINITETALK_MODELS.textEncoder)
  assert.ok(wf['9'].inputs.model_name.includes('bf16_dequant'))
  assert.equal(wf['8'].inputs.attention_mode, 'sdpa')
  assert.equal(wf['3'].inputs.model, INFINITETALK_MODELS.patchModel)
  assert.equal(wf['8'].inputs.model, INFINITETALK_MODELS.mainModel)
  assert.equal(wf['4'].inputs.model, INFINITETALK_MODELS.wav2vec2)
  assert.equal(wf['12'].inputs.steps, 4)
  assert.equal(wf['12'].inputs.cfg, 1)
})

test('buildInfiniteTalkWorkflow：自定义提示词生效，帧数能反映时长', () => {
  const wf = buildInfiniteTalkWorkflow({
    imageName: 'x.png',
    audioName: 'y.wav',
    frames: 161,
    prompt: 'CUSTOM PROMPT',
    negativePrompt: 'CUSTOM NEGATIVE'
  })
  assert.equal(wf['9'].inputs.positive_prompt, 'CUSTOM PROMPT')
  assert.equal(wf['9'].inputs.negative_prompt, 'CUSTOM NEGATIVE')
  assert.equal(wf['10'].inputs.num_frames, 161)
  assert.equal(wf['11'].inputs.frame_window_size, 161)
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

/** 假的 ComfyUI client：不真跑 GPU，按提交的工作流造一个 mp4 返回。 */
function fakeComfyClient(chain, options = {}) {
  const nodeInfo = {}
  // reconcileWorkflow 需要 object_info；用一个足够真实的节点表，声明所有键都合法。
  const wfNodeTypes = ['LoadImage', 'LoadAudio', 'MultiTalkModelLoader', 'Wav2VecModelLoader',
    'WanVideoVAELoader', 'WanVideoBlockSwap', 'WanVideoLoraSelect', 'WanVideoModelLoader',
    'WanVideoTextEncodeCached', 'MultiTalkWav2VecEmbeds', 'WanVideoImageToVideoMultiTalk',
    'WanVideoSampler', 'WanVideoDecode', 'VHS_VideoCombine']
  // reconcileWorkflow 只保留在 object_info 里声明过的输入键，所以这里为每个节点
  // 声明它实际用到的全部输入（值类型任意，reconcile 只看键是否存在 / 是否枚举）。
  const nodeInputs = {
    LoadImage: ['image'],
    LoadAudio: ['audio'],
    MultiTalkModelLoader: ['model'],
    Wav2VecModelLoader: ['model', 'base_precision', 'load_device'],
    WanVideoVAELoader: ['model_name', 'precision', 'use_cpu_cache', 'verbose'],
    WanVideoBlockSwap: ['blocks_to_swap', 'offload_img_emb', 'offload_txt_emb', 'use_non_blocking',
      'vace_blocks_to_swap', 'prefetch_blocks', 'block_swap_debug'],
    WanVideoLoraSelect: ['lora', 'strength', 'low_mem_load', 'merge_loras'],
    WanVideoModelLoader: ['model', 'base_precision', 'quantization', 'load_device', 'attention_mode',
      'block_swap_args', 'lora', 'multitalk_model', 'rms_norm_function'],
    WanVideoTextEncodeCached: ['model_name', 'precision', 'positive_prompt', 'negative_prompt',
      'quantization', 'use_disk_cache', 'device'],
    MultiTalkWav2VecEmbeds: ['wav2vec_model', 'audio_1', 'normalize_loudness', 'num_frames',
      'fps', 'audio_scale', 'audio_cfg_scale', 'multi_audio_type'],
    WanVideoImageToVideoMultiTalk: ['vae', 'width', 'height', 'frame_window_size', 'motion_frame',
      'force_offload', 'colormatch', 'start_image', 'mode', 'output_path'],
    WanVideoSampler: ['model', 'image_embeds', 'steps', 'cfg', 'shift', 'seed', 'force_offload',
      'scheduler', 'riflex_freq_index', 'text_embeds', 'multitalk_embeds', 'rope_function',
      'start_step', 'end_step', 'add_noise_to_samples'],
    WanVideoDecode: ['vae', 'samples', 'enable_vae_tiling', 'tile_x', 'tile_y', 'tile_stride_x', 'tile_stride_y'],
    VHS_VideoCombine: ['images', 'frame_rate', 'loop_count', 'filename_prefix', 'format',
      'pingpong', 'save_output', 'audio']
  }
  for (const type of wfNodeTypes) {
    const required = {}
    for (const key of nodeInputs[type]) required[key] = []
    nodeInfo[type] = { input: { required, optional: {} } }
  }
  return {
    url: 'http://127.0.0.1:8188',
    systemStats: async () => ({}),
    objectInfo: async () => nodeInfo,
    uploadImage: async ({ filename }) => {
      chain.uploaded.push(filename)
      return { name: filename, subfolder: '', type: 'input' }
    },
    queuePrompt: async (workflow, clientId) => {
      chain.submitted.push({ workflow, clientId })
      return { promptId: options.promptId ?? 'fake-prompt-1' }
    },
    historyEntry: async () => {
      if (options.noVideo) {
        return { outputs: {}, status: { status_str: 'success', completed: true, messages: [] } }
      }
      if (options.historyError) {
        return {
          outputs: {},
          status: {
            status_str: 'error', completed: true,
            messages: [['execution_error', { node_type: 'WanVideoSampler', node_id: '12', exception_message: 'CUDA out of memory' }]]
          }
        }
      }
      return {
        outputs: {
          '14': { gifs: [{ filename: 'infinitetalk.mp4', subfolder: '', type: 'output' }] }
        },
        status: { status_str: 'success', completed: true, messages: [] }
      }
    },
    viewImage: async () => Buffer.from([0x00, 0x00, 0x00, 0x18]),
    interrupt: async () => {}
  }
}

/** 造一条完整的假链路：语音→(假)文生图首帧→假 InfiniteTalk 出片。 */
function setupChain(options = {}) {
  const workRoot = tempDir('dsh-talk')
  const indexttsDir = path.join(workRoot, 'indextts')
  const outDir = path.join(workRoot, 'out')
  fs.mkdirSync(indexttsDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })

  const seen = { wavBytes: 0, ttsArgs: null }
  const spawn = fakeSpawn((command, args) => {
    if (command === 'ffprobe') return { stdout: options.duration ?? '5.616\n' }
    if (command === 'ffmpeg') {
      const out = args[args.length - 1]
      fs.writeFileSync(out, Buffer.from([0x52, 0x49, 0x46, 0x46]))
      return {}
    }
    const module = `${args[0] ?? ''} ${args[1] ?? ''}`
    if (args[0] === 'dsh_indextts_infer.py') {
      seen.ttsArgs = args
      const out = argValue(args, '--output')
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from('wav'))
      seen.wavBytes = 3
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
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    writeMetadata: true
  })

  const imageCalls = []
  const runImage = async (request) => {
    imageCalls.push(request.args)
    const target = request.args.output_path
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from('PNG'))
    return { outputPaths: [target], promptId: 'fake-image-1' }
  }

  const chain = {
    workRoot, indexttsDir, outDir, config, spawn, seen, runImage, imageCalls,
    uploaded: [], submitted: []
  }
  chain.client = fakeComfyClient(chain, options)
  return chain
}

test('runTalkingGeneration：text2talking 全链路打通，产物与元数据齐全', async () => {
  const chain = setupChain()
  const run = await runTalkingGeneration({
    args: { script: '大家好，今天聊个小事。', seed: 42, output_path: path.join(chain.outDir, 'talk.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
  })

  // ① 成片真的存在，且是 InfiniteTalk 的产物被拷过来
  const output = path.join(chain.outDir, 'talk.mp4')
  assert.ok(fs.existsSync(output))
  assert.equal(fs.statSync(output).size, 4)

  // ② 语音时长来自 ffprobe 的真值，视频时长按 4n+1 反算
  assert.equal(run.audioSeconds, 5.616)
  assert.equal(run.frames, 141) // (5.616 + 0.3) 秒 → 141 帧（4n+1）
  assert.ok(Math.abs(run.videoSeconds - 141 / 24) < 1e-9)

  // ③ 文生图那步用的是「文字造出来的正脸首帧」和默认说话提示词
  assert.equal(chain.imageCalls.length, 1)
  const imageArgs = chain.imageCalls[0]
  assert.equal(imageArgs.mode, 'text2img')
  assert.ok(imageArgs.prompt.startsWith(DEFAULT_PORTRAIT_PROMPT.slice(0, 20)))

  // ④ 首帧图片与语音都上传了，提交的工作流帧数 = 141、种子 = 42
  assert.equal(chain.uploaded.length, 2)
  assert.ok(chain.uploaded[0].endsWith('.png'))
  assert.ok(chain.uploaded[1].endsWith('_audio.wav'))
  assert.equal(chain.submitted.length, 1)
  const wf = chain.submitted[0].workflow
  assert.equal(wf['10'].inputs.num_frames, 141)
  assert.equal(wf['12'].inputs.seed, 42)
  // 141 帧 > 60，自动分级应把宽高降到 512x320
  assert.equal(wf['11'].inputs.width, 512)
  assert.equal(wf['11'].inputs.height, 320)
  assert.equal(run.width, 512)
  assert.equal(run.height, 320)
  assert.ok(run.notes.some((n) => n.includes('降到 512x320')))

  // ⑤ 元数据能复现这条片子
  const metadata = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'))
  assert.equal(metadata.script, '大家好，今天聊个小事。')
  assert.equal(metadata.tts.engine, 'indextts')
  assert.equal(metadata.tts.lang, 'ZH')
  assert.equal(metadata.audio.seconds, 5.616)
  assert.equal(metadata.video.frames, 141)
  assert.equal(metadata.comfy.promptId, 'fake-prompt-1')
  assert.equal(metadata.lipsync.engine, 'infinitetalk')
  assert.ok(metadata.notes.some((note) => note.includes('端到端生成完成')))
})

test('runTalkingGeneration：短台词保持 832x480 高清，显式 width 覆盖生效', async () => {
  // duration 1.0s（+0.3 余量）→ 约 33 帧 ≤ 60，保持高清
  const short = setupChain({ duration: '1.0\n' })
  const runShort = await runTalkingGeneration({
    args: { script: '你好。', seed: 1, output_path: path.join(short.outDir, 'short.mp4') },
    cwd: short.outDir, config: short.config,
    deps: { spawn: short.spawn, runImage: short.runImage, client: short.client }
  })
  assert.equal(runShort.width, 832)
  assert.equal(runShort.height, 480)
  assert.equal(short.submitted[0].workflow['11'].inputs.width, 832)

  // 显式 width=1024 → 尊重，即使长台词也不降级
  const explicit = setupChain()
  const runExplicit = await runTalkingGeneration({
    args: { script: '大家好，今天聊个小事。', width: 1024, seed: 2, output_path: path.join(explicit.outDir, 'exp.mp4') },
    cwd: explicit.outDir, config: explicit.config,
    deps: { spawn: explicit.spawn, runImage: explicit.runImage, client: explicit.client }
  })
  assert.equal(runExplicit.width, 1024)
  assert.equal(explicit.submitted[0].workflow['11'].inputs.width, 1024)
  assert.ok(!runExplicit.notes.some((n) => n.includes('降到 512x320')))
})

test('runTalkingGeneration：video2talking 抽首帧重生成，不跑文生图', async () => {
  const chain = setupChain()
  const sourceVideo = path.join(chain.workRoot, 'source.mp4')
  fs.writeFileSync(sourceVideo, Buffer.from('SOURCEVIDEO'))
  const run = await runTalkingGeneration({
    args: { script: '换一句台词。', input_video: sourceVideo, output_path: path.join(chain.outDir, 'relip.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
  })
  assert.equal(run.mode, 'video2talking')
  assert.equal(chain.imageCalls.length, 0) // 不调文生图
  assert.ok(fs.existsSync(path.join(chain.outDir, 'relip.mp4')))
  assert.ok(run.notes.some((n) => n.includes('抽取首帧')))
  assert.equal(run.baseVideoPath, sourceVideo)
})

test('runTalkingGeneration：edge-tts 路径也能走通', async () => {
  const chain = setupChain()
  const run = await runTalkingGeneration({
    args: { script: '看晓晓说话。', tts: 'edge', edge_voice: 'zh-CN-XiaoxiaoNeural', output_path: path.join(chain.outDir, 'edge.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
  })
  assert.equal(run.request.tts, 'edge')
  assert.match(run.voiceLabel, /edge-tts.*Xiaoxiao/)
})

test('runTalkingGeneration：ComfyUI 没产出视频 → 明确报错，不假装成功', async () => {
  const chain = setupChain({ noVideo: true })
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', output_path: path.join(chain.outDir, 'nope.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
    }),
    /没有产出视频文件/
  )
  assert.equal(fs.existsSync(path.join(chain.outDir, 'nope.mp4')), false)
})

test('runTalkingGeneration：ComfyUI 执行错误时把节点与原因带出来', async () => {
  const chain = setupChain({ historyError: true })
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', output_path: path.join(chain.outDir, 'err.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
    }),
    /CUDA out of memory/
  )
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
      deps: { spawn, runImage: chain.runImage, client: chain.client }
    }),
    /模型目录不完整/
  )
})

test('runTalkingGeneration：input_image 不存在 → 立刻报错（不白跑文生图）', async () => {
  const chain = setupChain()
  await assert.rejects(
    runTalkingGeneration({
      args: { script: '你好。', input_image: path.join(chain.workRoot, 'missing.png'), output_path: path.join(chain.outDir, 'y.mp4') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
    }),
    /找不到 input_image/
  )
  assert.equal(chain.imageCalls.length, 0)
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
    deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
  })
  const second = await runTalkingGeneration({
    args: { script: '第二句。', output_path: path.join(chain.outDir, 'two.mp4') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn, runImage: chain.runImage, client: chain.client }
  })
  assert.notEqual(first.audioPath, second.audioPath)
  assert.ok(fs.existsSync(path.join(chain.outDir, 'one.mp4')))
  assert.ok(fs.existsSync(path.join(chain.outDir, 'two.mp4')))
})