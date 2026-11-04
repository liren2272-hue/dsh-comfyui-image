/**
 * generate_video（文生视频 / 图生视频）的测试。
 *
 * 分三层，和图片测试保持一样的口径：
 *   1. **纯函数层**（帧数换算、尺寸对齐、工作流构建、输入纠偏）—— 不需要服务，秒级；
 *   2. **探测层**（resolveVideoPreset）—— 连假 ComfyUI 的 /object_info，验证选型与报错；
 *   3. **端到端**（runVideoGeneration → 假 ComfyUI → 落盘 .mp4 + 元数据）——
 *      断言「参数真的变成了视频文件」，而不是只断言「有个文件被创建了」。
 *
 * 假 ComfyUI 在 /view 里对视频请求返回一段带 ftyp 头的字节，所以这里可以
 * 逐字节比对落盘内容，确认插件只是搬运、没有改写。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  buildVideoWorkflow,
  estimateSeconds,
  inferVideoMode,
  MAX_FRAMES,
  normalizeVideoRequest,
  pickVideoRef,
  reconcileWorkflow,
  resolveVideoPreset,
  runVideoGeneration,
  secondsToFrames,
  VIDEO_NODE,
  VIDEO_PARAMETERS_SCHEMA,
  VIDEO_TOOL_NAME,
  VIDEO_OUTPUT_SCHEMA,
  createGenerateVideoTool,
  formatVideoResult,
  renderVideoResultText
} from '../lib/index.js'
import { isVideoMode, VIDEO_MODES } from '../lib/video/types.js'
import { createMockComfyUI, defaultNodes, makeFakeMp4, videoNodes } from './mock-comfyui.mjs'
import { fakeExec, tempDir, testConfig, writePng } from './helpers.mjs'

const running = []

async function startMock(options = {}) {
  const mock = createMockComfyUI({ nodes: videoNodes(), ...options })
  const baseUrl = await mock.listen()
  running.push(mock)
  return { mock, baseUrl }
}

after(async () => {
  for (const mock of running) await mock.close()
})

/** 视频测试用的配置：小而快，别让 CI 等 3 分钟。 */
function videoConfig(baseUrl, overrides = {}) {
  return testConfig({
    baseUrl,
    videoWidth: 320,
    videoHeight: 192,
    videoSeconds: 0.5,
    videoFps: 8,
    videoSteps: 4,
    videoTimeoutMs: 30_000,
    ...overrides
  })
}

/** 一个「合法的最小视频请求」，供纯函数用例复用。 */
function sampleRequest(overrides = {}) {
  return {
    mode: 'text2video',
    prompt: '雨夜东京街头，长发女子缓缓回头',
    negativePrompt: '静态，模糊',
    width: 832,
    height: 480,
    frames: 49,
    seconds: 2,
    actualSeconds: 49 / 24,
    fps: 24,
    seed: 12345,
    steps: 30,
    cfgScale: 5,
    shift: 8,
    samplerName: 'euler',
    scheduler: 'simple',
    unet: '',
    outputPath: '',
    notes: [],
    extra: {},
    ...overrides
  }
}

const samplePreset = {
  id: 'wan22-ti2v-5b',
  label: 'Wan2.2 TI2V-5B',
  loader: 'UnetLoaderGGUF',
  unet: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
  clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  vae: 'Wan2.2_VAE.safetensors',
  fps: 24,
  shift: 8,
  steps: 30,
  cfgScale: 5,
  width: 832,
  height: 480,
  samplerName: 'euler',
  scheduler: 'simple',
  negativePrompt: '静态，模糊'
}

/* ─────────────────────────── 1. 纯函数层 ─────────────────────────── */

test('VIDEO_MODES / isVideoMode 只认两种视频模式', () => {
  assert.deepEqual([...VIDEO_MODES], ['text2video', 'img2video'])
  assert.equal(isVideoMode('text2video'), true)
  assert.equal(isVideoMode('img2video'), true)
  assert.equal(isVideoMode('text2img'), false)
  assert.equal(isVideoMode(undefined), false)
})

test('secondsToFrames：一律对齐到 4n+1，并反算出真实时长', () => {
  // 2 秒 @24fps = 48 帧 → 49（离 4n+1 最近）
  assert.deepEqual(secondsToFrames(2, 24), { frames: 49, actualSeconds: 49 / 24 })
  // 5 秒 @24fps = 120 → 121
  assert.deepEqual(secondsToFrames(5, 24), { frames: 121, actualSeconds: 121 / 24 })
  // 0.5 秒 @8fps = 4 → 下限 5 帧（不能再少）
  assert.deepEqual(secondsToFrames(0.5, 8), { frames: 5, actualSeconds: 5 / 8 })
  // 1 秒 @24fps = 24 → round(23/4)=6 → 25
  assert.deepEqual(secondsToFrames(1, 24), { frames: 25, actualSeconds: 25 / 24 })
  for (const [seconds, fps] of [[0.25, 24], [1.5, 16], [3, 30], [10, 24]]) {
    const { frames } = secondsToFrames(seconds, fps)
    assert.equal((frames - 1) % 4, 0, `${seconds}s@${fps} 的帧数 ${frames} 必须是 4n+1`)
  }
})

test('estimateSeconds：帧数不是线性增长，长视频要明显更贵', () => {
  // 49 帧 / 30 步 / 832x480 是本机实测标定值（约 210 秒）
  const base = estimateSeconds(49, 30, 832, 480)
  assert.ok(Math.abs(base - 210) < 1, `标定点应约 210 秒，实际 ${base}`)
  // 帧数翻 2.5 倍，耗时应超过 2.5 倍（注意力对帧数超线性）
  const long = estimateSeconds(121, 30, 832, 480)
  assert.ok(long > base * 2.5, `121 帧应显著慢于 49 帧的 2.5 倍，实际 ${long} vs ${base * 2.5}`)
  // 步数线性
  assert.equal(estimateSeconds(49, 60, 832, 480), estimateSeconds(49, 30, 832, 480) * 2)
})

test('inferVideoMode：有 input_image 就是图生视频', () => {
  assert.equal(inferVideoMode({ prompt: 'x' }), 'text2video')
  assert.equal(inferVideoMode({ prompt: 'x', input_image: 'a.png' }), 'img2video')
  assert.equal(inferVideoMode({ prompt: 'x', input_image: '   ' }), 'text2video')
})

test('normalizeVideoRequest：默认取配置、尺寸对齐 32、帧数对齐 4n+1', () => {
  const config = testConfig({ videoWidth: 1000, videoHeight: 700, videoFps: 24, videoSeconds: 2, videoSteps: 30 })
  const { request, modeInferred } = normalizeVideoRequest({ prompt: '雨夜街头' }, { cwd: tempDir('vid-norm'), config })

  assert.equal(modeInferred, true)
  assert.equal(request.mode, 'text2video')
  // 1000 → 992、700 → 704（32 的倍数）
  assert.equal(request.width, 992)
  assert.equal(request.height, 704)
  assert.equal(request.frames, 49)
  assert.ok(
    request.notes.some((note) => note.includes('对齐到 32 的倍数')),
    '对齐过尺寸必须如实告知'
  )
  assert.ok(request.notes.some((note) => note.includes('4n+1')), '对齐过帧数必须如实告知')
  assert.equal(request.samplerName, 'euler')
  assert.equal(request.scheduler, 'simple')
  assert.equal(request.shift, 8)
  assert.equal(request.cfgScale, 5)
  assert.ok(request.negativePrompt.length > 0, '没给负向词时应回落到配置里的官方串')
})

test('normalizeVideoRequest：参数冲突与超界都报错，不静默凑合', () => {
  const cwd = tempDir('vid-conflict')
  const config = testConfig({})

  assert.throws(
    () => normalizeVideoRequest({ mode: 'text2video', prompt: 'x', input_image: 'a.png' }, { cwd, config }),
    /不接受 input_image/
  )
  assert.throws(
    () => normalizeVideoRequest({ mode: 'img2video', prompt: 'x' }, { cwd, config }),
    /需要 input_image/
  )
  assert.throws(
    () => normalizeVideoRequest({ mode: 'text2video' }, { cwd, config }),
    /需要 prompt/
  )
  assert.throws(
    () => normalizeVideoRequest({ mode: 'video', prompt: 'x' }, { cwd, config }),
    /不认识的视频 mode/
  )
  assert.throws(
    () => normalizeVideoRequest({ prompt: 'x', seconds: 60, fps: 24 }, { cwd, config }),
    /超过上限/
  )
  assert.throws(
    () => normalizeVideoRequest({ prompt: 'x', width: 'big' }, { cwd, config }),
    /width 必须是数字/
  )
  // 上限本身是 481 帧
  assert.equal(MAX_FRAMES, 481)
})

test('normalizeVideoRequest：output_path 带 .mp4 时当文件，不带扩展名时当目录', () => {
  const cwd = tempDir('vid-out')
  const config = testConfig({})

  const asFile = normalizeVideoRequest(
    { prompt: 'x', output_path: path.join(cwd, 'my-clip.mp4') },
    { cwd, config }
  )
  assert.equal(asFile.request.outputPath, path.join(cwd, 'my-clip.mp4'))

  const asDir = normalizeVideoRequest({ prompt: 'x', output_path: 'videos' }, { cwd, config })
  assert.equal(path.dirname(asDir.request.outputPath), path.join(cwd, 'videos'))
  assert.match(path.basename(asDir.request.outputPath), /^comfyui-.*\.mp4$/)
})

test('buildVideoWorkflow：文生视频不接 start_image、也不建 LoadImage 节点', () => {
  const built = buildVideoWorkflow({
    request: sampleRequest(),
    preset: samplePreset,
    filenamePrefix: 'dsh-video/text2video-x'
  })
  const wf = built.workflow

  assert.equal(built.outputNodeId, VIDEO_NODE.saveVideo)
  assert.equal(Object.keys(wf).length, 11, '文生视频只有 11 个节点（没有 LoadImage）')
  assert.ok(
    !Object.values(wf).some((node) => node.class_type === 'LoadImage'),
    '文生视频不该出现 LoadImage'
  )
  const latent = wf[VIDEO_NODE.latent]
  assert.equal(latent.class_type, 'Wan22ImageToVideoLatent')
  assert.equal(latent.inputs.length, 49)
  assert.equal(latent.inputs.width, 832)
  assert.equal(latent.inputs.start_image, undefined, 'start_image 不接 = 全噪声起步')

  const sampler = wf[VIDEO_NODE.sampler]
  assert.equal(sampler.inputs.denoise, 1.0, 'i2v 的保真靠 noise_mask，不靠 denoise 调小')
  assert.deepEqual(sampler.inputs.latent_image, [VIDEO_NODE.latent, 0])
  assert.deepEqual(sampler.inputs.model, [VIDEO_NODE.sampling, 0])

  assert.equal(wf[VIDEO_NODE.sampling].inputs.shift, 8)
  assert.equal(wf[VIDEO_NODE.unet].class_type, 'UnetLoaderGGUF')
  assert.equal(wf[VIDEO_NODE.unet].inputs.unet_name, 'Wan2.2-TI2V-5B-Q4_K_M.gguf')
  assert.equal(wf[VIDEO_NODE.clip].inputs.type, 'wan', 'CLIPLoader 必须按 wan 类型加载 umt5')
  assert.equal(wf[VIDEO_NODE.positive].inputs.text, sampleRequest().prompt)
  assert.equal(wf[VIDEO_NODE.createVideo].inputs.fps, 24)
  assert.equal(wf[VIDEO_NODE.saveVideo].inputs.format, 'auto')
  assert.equal(wf[VIDEO_NODE.saveVideo].inputs.codec, 'auto')
})

test('buildVideoWorkflow：图生视频接上 LoadImage 与 start_image', () => {
  const built = buildVideoWorkflow({
    request: sampleRequest({ mode: 'img2video', prompt: '长发被风吹动' }),
    preset: samplePreset,
    uploadedInput: 'uploaded-frame.png',
    filenamePrefix: 'dsh-video/img2video-x'
  })
  const wf = built.workflow

  assert.equal(Object.keys(wf).length, 12)
  assert.equal(wf[VIDEO_NODE.loadImage].class_type, 'LoadImage')
  assert.equal(wf[VIDEO_NODE.loadImage].inputs.image, 'uploaded-frame.png')
  assert.deepEqual(wf[VIDEO_NODE.latent].inputs.start_image, [VIDEO_NODE.loadImage, 0])
})

test('reconcileWorkflow：删掉节点没声明的输入，并把枚举值纠偏', () => {
  const nodes = videoNodes()
  const built = buildVideoWorkflow({
    request: sampleRequest(),
    preset: samplePreset,
    filenamePrefix: 'p'
  })
  // 造两个真机上会遇到的毛病：多余输入 + 不存在的枚举值
  built.workflow[VIDEO_NODE.saveVideo].inputs.some_unknown_option = true
  built.workflow[VIDEO_NODE.saveVideo].inputs.format = 'avi'

  const fixed = reconcileWorkflow(built.workflow, nodes)
  const save = fixed[VIDEO_NODE.saveVideo]

  assert.equal(save.inputs.some_unknown_option, undefined, '未声明的输入必须删掉，否则 /prompt 拒收')
  assert.equal(save.inputs.format, 'auto', 'SaveVideo 不认 avi → 回落到 specDefault(auto)')
  assert.equal(save.inputs.codec, 'auto')
  // 声明过的输入不能被误删
  assert.equal(save.inputs.filename_prefix, 'p')
  assert.deepEqual(save.inputs.video, [VIDEO_NODE.createVideo, 0])
})

test('reconcileWorkflow：文件名输入（LoadImage.image）即使不在枚举里也不能被换掉', () => {
  // 2026-10-29 真机 bug：/object_info 有 60 秒缓存，先探测模型、后上传首帧，
  // 纠偏用的是上传前的文件列表 → `i2v_source.png` 被判非法 → 换成列表第一项
  // `clover_guide.png`，静默出成「别人的图做首帧」的文生视频，白等 194 秒。
  // 文件名类输入的候选是「input 目录快照」，不是能力枚举，一律不许纠偏。
  const nodes = videoNodes()
  const built = buildVideoWorkflow({
    request: sampleRequest({ mode: 'img2video', prompt: '长发被风吹动' }),
    preset: samplePreset,
    uploadedInput: 'i2v_source.png',
    filenamePrefix: 'p'
  })

  const fixed = reconcileWorkflow(built.workflow, nodes)

  assert.equal(fixed[VIDEO_NODE.loadImage].inputs.image, 'i2v_source.png')
  assert.notEqual(
    fixed[VIDEO_NODE.loadImage].inputs.image,
    'clover_guide.png',
    '把用户的首帧换成别的文件是最坏的失败方式：不报错、还白跑几分钟'
  )
})

test('pickVideoRef：优先取出片节点，四个键都扫，兼容 VideoHelperSuite', () => {
  const entry = {
    outputs: {
      '99': { images: [{ filename: 'other.png', subfolder: '', type: 'output' }] },
      '12': { gifs: [{ filename: 'clip.mp4', subfolder: 'dsh-video', type: 'output' }] }
    }
  }
  assert.deepEqual(pickVideoRef(entry, '12'), {
    filename: 'clip.mp4',
    subfolder: 'dsh-video',
    type: 'output'
  })
  // 没有首选节点时也要能找到（对象里整数键按数值升序，'12' 在 '99' 之前）
  assert.equal(pickVideoRef(entry, undefined)?.filename, 'clip.mp4')
  // videos / audio 键同样认
  assert.equal(pickVideoRef({ outputs: { '12': { videos: [{ filename: 'a.webm' }] } } }, '12')?.filename, 'a.webm')
  assert.equal(pickVideoRef({ outputs: { '12': { audio: [{ filename: 'b.wav' }] } } }, '12')?.filename, 'b.wav')
  // 什么都没有就是 undefined（交给上层报错）
  assert.equal(pickVideoRef({ outputs: {} }, '12'), undefined)
})

/* ─────────────────────────── 2. 探测层 ─────────────────────────── */

test('resolveVideoPreset：从 /object_info 里挑出 unet/clip/vae 三件套', async () => {
  const { baseUrl } = await startMock()
  const config = videoConfig(baseUrl)

  // 用最小的 cast：测试只关心返回的预设
  const { ComfyUIClient } = await import('../lib/index.js')
  const client = new ComfyUIClient({ baseUrl, requestTimeoutMs: 3000 })
  const resolution = await resolveVideoPreset(client, config, '')

  assert.equal(resolution.preset.loader, 'UnetLoaderGGUF')
  assert.equal(resolution.preset.unet, 'Wan2.2-TI2V-5B-Q4_K_M.gguf', '应挑 TI2V-5B 而不是 t2v 1.3B')
  assert.equal(resolution.preset.clip, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors')
  assert.equal(resolution.preset.vae, 'Wan2.2_VAE.safetensors', '应挑 wan2.2 的 VAE，不是 2.1')
  assert.ok(
    resolution.notes.some((note) => note.includes('自动选用视频模型')),
    '自动挑模型要如实告知'
  )
})

test('resolveVideoPreset：缺视频节点 / 缺模型 / 指定了不存在的模型都要明确报错', async () => {
  // 只有图片节点 → 缺 Wan22ImageToVideoLatent
  {
    const mock = createMockComfyUI({ nodes: defaultNodes() })
    const baseUrl = await mock.listen()
    running.push(mock)
    const { ComfyUIClient } = await import('../lib/index.js')
    const client = new ComfyUIClient({ baseUrl, requestTimeoutMs: 3000 })
    await assert.rejects(
      () => resolveVideoPreset(client, videoConfig(baseUrl), ''),
      /没有节点 \\?`?Wan22ImageToVideoLatent/
    )
  }

  // 节点齐但没下 Wan 模型 → 告知要下哪个文件
  {
    const mock = createMockComfyUI({
      nodes: videoNodes({ unets: ['sd_xl_base_1.0.safetensors'], clips: ['t5xxl_fp16.safetensors'] })
    })
    const baseUrl = await mock.listen()
    running.push(mock)
    const { ComfyUIClient } = await import('../lib/index.js')
    const client = new ComfyUIClient({ baseUrl, requestTimeoutMs: 3000 })
    await assert.rejects(
      () => resolveVideoPreset(client, videoConfig(baseUrl), ''),
      /没有可用的 Wan 视频模型/
    )
  }

  // 显式指定了不存在的模型 → 错误里带 hint，列出本机有哪些可选
  {
    const { baseUrl } = await startMock()
    const { ComfyUIClient } = await import('../lib/index.js')
    const client = new ComfyUIClient({ baseUrl, requestTimeoutMs: 3000 })
    await assert.rejects(
      () => resolveVideoPreset(client, videoConfig(baseUrl), 'wan2.2-not-exist.gguf'),
      (error) => {
        assert.match(error.message, /指定的视频模型不存在：wan2\.2-not-exist\.gguf/)
        assert.match(error.hint, /Wan2\.2-TI2V-5B-Q4_K_M\.gguf/, 'hint 要告诉用户本机有什么')
        return true
      }
    )
  }
})

/* ─────────────────────────── 3. 端到端 ─────────────────────────── */

test('text2video 端到端：提交 → 轮询 → 取回 mp4 → 落盘 + 元数据', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-t2v')
  const config = videoConfig(baseUrl)

  const run = await runVideoGeneration({ args: { prompt: '雨夜东京街头，长发女子缓缓回头' }, cwd, config })

  assert.equal(run.mode, 'text2video')
  assert.equal(run.modeInferred, true)
  assert.equal(run.outputPaths.length, 1)
  const output = run.outputPaths[0]
  assert.ok(fs.existsSync(output), `输出文件应存在：${output}`)
  assert.equal(path.dirname(output), cwd, '默认输出到项目根目录')
  assert.match(path.basename(output), /^comfyui-.*\.mp4$/)

  // 字节原样搬运（假 ComfyUI 给的是 ftyp + mdat）
  const bytes = fs.readFileSync(output)
  assert.equal(bytes.subarray(8, 12).toString('latin1'), 'isom', '落盘内容应是 mp4（ftyp 头）')
  assert.equal(bytes.length, makeFakeMp4().length)

  // 请求参数真的进入了工作流
  const wf = mock.state.lastPrompt
  assert.equal(wf[VIDEO_NODE.latent].inputs.length, 5, '0.5s@8fps 应换成 5 帧')
  assert.equal(wf[VIDEO_NODE.latent].inputs.width, 320)
  assert.equal(wf[VIDEO_NODE.createVideo].inputs.fps, 8)
  assert.equal(wf[VIDEO_NODE.sampler].inputs.steps, 4)
  assert.equal(wf[VIDEO_NODE.saveVideo].inputs.filename_prefix.startsWith('dsh-video/'), true)
  assert.equal(mock.state.stats.upload, 0, '文生视频不该上传任何图')

  // 元数据 sidecar
  assert.ok(run.metadataPath && fs.existsSync(run.metadataPath))
  const meta = JSON.parse(fs.readFileSync(run.metadataPath, 'utf8'))
  assert.equal(meta.mode, 'text2video')
  assert.equal(meta.frames, 5)
  assert.equal(meta.fps, 8)
  assert.equal(meta.width, 320)
  assert.equal(meta.unet, 'Wan2.2-TI2V-5B-Q4_K_M.gguf')
  assert.equal(meta.outputFile, output)
  assert.ok(meta.workflow && Object.keys(meta.workflow).length === 11)
})

test('img2video 端到端：上传首帧、首帧进工作流、start_image 接上', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-i2v')
  const config = videoConfig(baseUrl)
  const first = writePng(path.join(cwd, 'first.png'), 96, 96)

  const run = await runVideoGeneration({
    args: { input_image: first, prompt: '长发被风吹动，镜头缓慢推近' },
    cwd,
    config
  })

  assert.equal(run.mode, 'img2video')
  assert.equal(run.modeInferred, true)
  assert.match(path.basename(run.outputPaths[0]), /^comfyui-.*\.mp4$/)
  assert.equal(mock.state.stats.upload, 1, '应上传一次首帧')

  const wf = mock.state.lastPrompt
  assert.equal(wf[VIDEO_NODE.loadImage].class_type, 'LoadImage')
  assert.equal(wf[VIDEO_NODE.loadImage].inputs.image, mock.state.lastUploadFilename)
  assert.deepEqual(wf[VIDEO_NODE.latent].inputs.start_image, [VIDEO_NODE.loadImage, 0])
})

test('端到端失败路径：ComfyUI 报执行错误时抛带 hint 的错，不产出半截文件', async () => {
  const { baseUrl } = await startMock({ failMode: 'execution_error' })
  const cwd = tempDir('e2e-err')
  const config = videoConfig(baseUrl)

  await assert.rejects(
    () => runVideoGeneration({ args: { prompt: 'x' }, cwd, config }),
    (error) => {
      assert.match(error.message, /CUDA out of memory/)
      assert.ok(error.hint && error.hint.length > 0, '失败必须带可操作的 hint')
      return true
    }
  )
  assert.deepEqual(fs.readdirSync(cwd), [], '失败时不该留下任何文件')
})

test('端到端：连不上 ComfyUI 时给出可读错误', async () => {
  const cwd = tempDir('e2e-unreachable')
  const config = videoConfig('http://127.0.0.1:1', { requestTimeoutMs: 500 })
  await assert.rejects(
    () => runVideoGeneration({ args: { prompt: 'x' }, cwd, config }),
    /连不上 ComfyUI|ECONNREFUSED|ComfyUI/
  )
})

/* ─────────────────────────── 4. 工具契约 ─────────────────────────── */

test('generate_video 的 schema：只用 DSH 支持的 JSON Schema 子集', () => {
  assert.equal(VIDEO_TOOL_NAME, 'generate_video')
  assert.equal(VIDEO_PARAMETERS_SCHEMA.type, 'object')
  assert.deepEqual([...VIDEO_PARAMETERS_SCHEMA.properties.mode.enum], ['text2video', 'img2video'])
  assert.deepEqual([...VIDEO_PARAMETERS_SCHEMA.required], [], '全部参数可选，必填性由运行时判断')
  assert.equal(VIDEO_PARAMETERS_SCHEMA.additionalProperties, false)

  // 范围只能写在 description 里：minimum/maximum/format 会被宿主 schema 校验拒绝
  const banned = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'format', 'pattern', 'multipleOf'])
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!banned.has(key), `${at}.${key} 不在 DSH 支持的 schema 子集里`)
      walk(value, `${at}.${key}`)
    }
  }
  walk(VIDEO_PARAMETERS_SCHEMA, 'parameters')
  walk(VIDEO_OUTPUT_SCHEMA, 'output')

  for (const key of ['path', 'mode', 'fps', 'frames', 'seconds', 'model', 'vae']) {
    assert.ok(VIDEO_OUTPUT_SCHEMA.required.includes(key), `输出 schema 必须声明 ${key}`)
  }
})

test('工具定义：name/parameters/output/execute 齐全，失败时抛带 ❌ 的中文文案', async () => {
  const tool = createGenerateVideoTool({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 500 })
  assert.equal(tool.name, 'generate_video')
  assert.equal(tool.parameters, VIDEO_PARAMETERS_SCHEMA)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.presentationMeta, 'function')

  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, fakeExec(tempDir('tool-fail'))),
    /❌ 出片失败（文生视频）/
  )
})

test('formatVideoResult / renderVideoResultText：首行状态 + 裸绝对路径单独一行', () => {
  const run = {
    request: sampleRequest({ mode: 'img2video' }),
    mode: 'img2video',
    modeInferred: false,
    outputPaths: ['D:/out/clip.mp4'],
    metadataPath: 'D:/out/clip.mp4.json',
    comfyRef: { filename: 'x.mp4', subfolder: '', type: 'output' },
    promptId: 'p1',
    comfyUrl: 'http://127.0.0.1:8188',
    durationMs: 12345,
    preset: samplePreset,
    notes: ['备注一条'],
    workflow: {}
  }
  const result = formatVideoResult(run)
  assert.equal(result.success, true)
  assert.equal(result.path, 'D:/out/clip.mp4')
  assert.equal(result.model, 'Wan2.2-TI2V-5B-Q4_K_M.gguf')
  assert.equal(result.vae, 'Wan2.2_VAE.safetensors')

  const lines = renderVideoResultText(result).split('\n')
  assert.match(lines[0], /^✅ 出片成功（图生视频）$/)
  const pathLine = lines.findIndex((line) => line.startsWith('视频：'))
  assert.ok(pathLine > 0, '路径行必须在首行之后')
  assert.equal(lines[pathLine], '视频：D:/out/clip.mp4', '路径要单独一行、直接可复制')
  assert.ok(result.text.includes('49 帧 / 24 fps'), '参数行要写清帧数与帧率')
  assert.ok(result.text.includes('元数据：D:/out/clip.mp4.json'))
  assert.ok(result.text.includes('备注一条'), 'notes 要出现在文案里')
})
