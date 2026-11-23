/**
 * generate_audio（台词 → 语音 wav，仅音频）的测试。
 *
 * 分三层，与 talking.test.mjs 对齐：
 *   1. **纯函数层**：脚本校验、标点、命令拼装、参数归一 —— 秒级，无副作用；
 *   2. **编排层**：用假 spawn 把「python 合成语音 / ffmpeg 转码 / ffprobe 量时长」整条链跑一遍，
 *      验证「每一步真的用了上一步的产物」，以及 IndexTTS 的「按 --output 落盘再取回」这条易错路径；
 *   3. **契约层**：工具 schema 只用 DSH 支持的子集，成功文案带 ✅、失败文案带 ❌。
 *
 * 为什么必须用假 spawn：真跑一次 IndexTTS 要 2~4 分钟、edge 要联网，
 * 而这条链最贵的 bug 恰恰是「参数传错但跑得通」（比如把 --pitch 拼成空格形式、传了空音量）。
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AUDIO_INDEXTTS_LANGS,
  AUDIO_OUTPUT_SCHEMA,
  AUDIO_PARAMETERS_SCHEMA,
  AUDIO_TOOL_DESCRIPTION,
  AUDIO_TOOL_NAME,
  AUDIO_TTS_ENGINES,
  audioEdgeTtsPlan,
  audioIndexTtsPlan,
  audioNormalizeWavPlan,
  audioParseDuration,
  audioPunctuateScript,
  createGenerateAudioTool,
  formatAudioResult,
  isAudioIndexTtsLang,
  isAudioTtsEngine,
  MAX_AUDIO_SCRIPT_CHARS,
  normalizeAudioRequest,
  renderAudioFailureText,
  renderAudioResultText,
  runAudioGeneration,
  validateAudioScript
} from '../lib/index.js'
import { tempDir, testConfig } from './helpers.mjs'

/* ─────────────────────────── 纯函数层 ─────────────────────────── */

test('AUDIO_TTS_ENGINES / AUDIO_INDEXTTS_LANGS / 枚举守卫：只认设计过的值', () => {
  assert.deepEqual([...AUDIO_TTS_ENGINES], ['indextts', 'edge'])
  assert.deepEqual([...AUDIO_INDEXTTS_LANGS], ['ZH', 'EN'])
  assert.equal(isAudioTtsEngine('edge'), true)
  assert.equal(isAudioTtsEngine('indextts'), true)
  assert.equal(isAudioTtsEngine('gpt-sovits'), false)
  assert.equal(isAudioTtsEngine('EDGE'), false)
  assert.equal(isAudioIndexTtsLang('EN'), true)
  assert.equal(isAudioIndexTtsLang('en'), false)
  assert.equal(MAX_AUDIO_SCRIPT_CHARS, 600)
})

test('validateAudioScript：空台词 / 超长台词必须拦住，正常台词放行', () => {
  const empty = validateAudioScript('   ')
  assert.equal(empty.ok, false)
  assert.match(empty.message, /不能为空/)
  assert.match(empty.hint, /这是谁家的小孩/)

  const long = validateAudioScript('啊'.repeat(MAX_AUDIO_SCRIPT_CHARS + 1))
  assert.equal(long.ok, false)
  assert.match(long.message, /超过 600 字上限/)
  assert.match(long.hint, /拆成多段/)

  assert.deepEqual(validateAudioScript('这是谁家的小孩？'), { ok: true })
  // 边界：正好 600 字要放行（不能把上限写成 599）。
  assert.deepEqual(validateAudioScript('啊'.repeat(MAX_AUDIO_SCRIPT_CHARS)), { ok: true })
})

test('audioPunctuateScript：句末没标点补句号，有标点不动', () => {
  assert.equal(audioPunctuateScript('这是谁家的小孩'), '这是谁家的小孩。')
  assert.equal(audioPunctuateScript('这是谁家的小孩？'), '这是谁家的小孩？')
  assert.equal(audioPunctuateScript('这是谁家的小孩！'), '这是谁家的小孩！')
})

test('audioIndexTtsPlan：把参考音频/文本/输出与情绪旋钮都拼进命令', () => {
  const plan = audioIndexTtsPlan({
    python: 'D:/Tools/IndexTTS/.venv/Scripts/python.exe',
    indexttsDir: 'D:/Tools/IndexTTS',
    spkAudioPrompt: 'D:/ref/voice.wav',
    text: '这是谁家的小孩。',
    outFile: 'C:/tmp/raw/indextts.wav',
    lang: 'ZH',
    emoVector: [0, 0.8, 0, 0, 0, 0, 0.2, 0],
    emoAlpha: 0.9,
    durationFactor: 1.2,
    device: 'cuda:0'
  })
  assert.equal(plan.command, 'D:/Tools/IndexTTS/.venv/Scripts/python.exe')
  // cwd 必须是仓库根：包装脚本默认 --model_dir / --cfg_path 都是相对路径。
  assert.equal(plan.cwd, 'D:/Tools/IndexTTS')
  assert.equal(plan.args[0], 'dsh_indextts_infer.py')
  assert.equal(argValue(plan.args, '--spk_audio_prompt'), 'D:/ref/voice.wav')
  assert.equal(argValue(plan.args, '--text'), '这是谁家的小孩。')
  assert.equal(argValue(plan.args, '--output'), 'C:/tmp/raw/indextts.wav')
  assert.equal(argValue(plan.args, '--lang'), 'ZH')
  // 8 维向量按固定顺序逗号拼接，维度不能被吃掉。
  assert.equal(argValue(plan.args, '--emo_vector'), '0,0.8,0,0,0,0,0.2,0')
  assert.equal(argValue(plan.args, '--emo_alpha'), '0.9')
  assert.equal(argValue(plan.args, '--duration_factor'), '1.2')
  // IndexTTS 的 --device 是 torch.device 字符串，不是裸序号。
  assert.equal(argValue(plan.args, '--device'), 'cuda:0')
})

test('audioIndexTtsPlan：不给旋钮就一个都不传（不能传空串）', () => {
  const plan = audioIndexTtsPlan({
    python: 'py',
    indexttsDir: 'D:/Tools/IndexTTS',
    spkAudioPrompt: 'D:/ref/voice.wav',
    text: '嗨。',
    outFile: 'C:/tmp/raw/indextts.wav'
  })
  for (const flag of ['--emo_vector', '--emo_alpha', '--emo_audio_prompt', '--duration_factor', '--lang', '--device']) {
    assert.equal(plan.args.includes(flag), false, `不该传 ${flag}，实际 args=${JSON.stringify(plan.args)}`)
  }
})

test('audioEdgeTtsPlan：pitch/volume 用 = 形式，不给就一个都不传', () => {
  const withKnobs = audioEdgeTtsPlan({
    python: 'py',
    text: '这是谁家的小孩。',
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+45%',
    pitch: '+40Hz',
    volume: '+30%',
    outFile: 'C:/tmp/edge.mp3'
  })
  // 值以 +/- 开头，必须拼成 --pitch=+40Hz，空格形式会被 argparse 判为缺参数。
  assert.ok(withKnobs.args.includes('--pitch=+40Hz'), `实际 args=${JSON.stringify(withKnobs.args)}`)
  assert.ok(withKnobs.args.includes('--volume=+30%'), `实际 args=${JSON.stringify(withKnobs.args)}`)
  assert.ok(withKnobs.args.includes('--rate=+45%'))
  assert.equal(argValue(withKnobs.args, '--voice'), 'zh-CN-XiaoyiNeural')
  assert.equal(argValue(withKnobs.args, '--write-media'), 'C:/tmp/edge.mp3')

  const bare = audioEdgeTtsPlan({
    python: 'py',
    text: '这是谁家的小孩。',
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '-4%',
    outFile: 'C:/tmp/edge.mp3'
  })
  assert.equal(bare.args.filter((a) => a.startsWith('--pitch')).length, 0)
  assert.equal(bare.args.filter((a) => a.startsWith('--volume')).length, 0)
})

test('audioNormalizeWavPlan / audioParseDuration：归一命令与时长解析', () => {
  const plan = audioNormalizeWavPlan('ffmpeg', 'in.mp3', 'out.wav')
  assert.equal(plan.command, 'ffmpeg')
  assert.ok(plan.args.includes('-ar'))
  assert.ok(plan.args.includes('16000'))
  assert.equal(plan.args[plan.args.length - 1], 'out.wav')
  assert.equal(audioParseDuration('2.5\n'), 2.5)
  assert.equal(audioParseDuration('N/A\n'), undefined)
  assert.equal(audioParseDuration(''), undefined)
})

test('normalizeAudioRequest：默认值 / 覆写 / 冲突备注 / 未知引擎', () => {
  const config = audioConfig()

  const defaults = normalizeAudioRequest({ script: '这是谁家的小孩' }, config)
  assert.equal(defaults.script, '这是谁家的小孩')
  assert.equal(defaults.tts, 'indextts')
  assert.equal(defaults.spkAudioPrompt, config.ttsSpkAudioPrompt)
  assert.equal(defaults.lang, 'ZH')
  assert.equal(defaults.emoVector, undefined)
  assert.equal(defaults.emoAlpha, undefined)
  assert.equal(defaults.edgeVoice, config.edgeVoice)
  assert.equal(defaults.rate, config.edgeRate)
  assert.deepEqual(defaults.notes, [])

  const overridden = normalizeAudioRequest(
    { script: '嗨', tts: 'edge', edge_voice: ' zh-CN-YunjianNeural ', rate: '+30%', edge_pitch: '+40Hz', edge_volume: '+30%' },
    config
  )
  assert.equal(overridden.tts, 'edge')
  assert.equal(overridden.edgeVoice, 'zh-CN-YunjianNeural')
  assert.equal(overridden.rate, '+30%')
  assert.equal(overridden.edgePitch, '+40Hz')
  assert.equal(overridden.edgeVolume, '+30%')

  // edge 下给 IndexTTS 的参数要明确提示不生效，不能假装生效。
  const conflicted = normalizeAudioRequest({ script: '嗨', tts: 'edge', spk_audio_prompt: 'D:/x.wav' }, config)
  assert.equal(conflicted.notes.length, 1)
  assert.match(conflicted.notes[0], /spk_audio_prompt \/ emo_vector/)

  // 空串 = 压根不传该参数，不是 +0Hz/+0%。
  const blanks = normalizeAudioRequest({ script: '嗨', tts: 'edge', edge_pitch: '  ', edge_volume: '' }, config)
  assert.equal(blanks.edgePitch, '')
  assert.equal(blanks.edgeVolume, '')

  assert.throws(() => normalizeAudioRequest({ script: '嗨', tts: 'gpt-sovits' }, config), /不认识的 tts/)
  assert.throws(() => normalizeAudioRequest({ script: '   ' }, config), /不能为空/)

  // 情绪向量：全 0 视为「不带情绪」，不给 alpha 时不该凭空造一个 0 强度。
  const flat = normalizeAudioRequest({ script: '嗨', emo_vector: [0, 0, 0, 0, 0, 0, 0, 0] }, config)
  assert.equal(flat.emoVector, undefined)

  // 非法向量/超范围档位一律拒绝，不能静默当成默认值。
  assert.throws(() => normalizeAudioRequest({ script: '嗨', emo_vector: [1, 2] }, config), /8 维/)
  assert.throws(() => normalizeAudioRequest({ script: '嗨', emo_vector: [0, 0, 0, 0, 0, 0, 0, 1.5] }, config), /0~1/)
  assert.throws(() => normalizeAudioRequest({ script: '嗨', emo_alpha: 2 }, config), /emo_alpha/)
  assert.throws(() => normalizeAudioRequest({ script: '嗨', duration_factor: 0 }, config), /duration_factor/)
  // 上界也要测：只测下界会漏掉「>3 照单全收」这类回归（audio 与 talking 曾各写一份、口径不一致）。
  assert.throws(() => normalizeAudioRequest({ script: '嗨', duration_factor: 5 }, config), /\(0, 3\]/)
  assert.throws(() => normalizeAudioRequest({ script: '嗨', emo_alpha: -0.1 }, config), /emo_alpha/)
  // 情绪来源只能二选一，同时给必须报错而不是挑一个用。
  assert.throws(
    () => normalizeAudioRequest({ script: '嗨', emo_vector: [0, 1, 0, 0, 0, 0, 0, 0], emo_audio_prompt: 'D:/x.wav' }, config),
    /二选一/
  )
  // 边界值本身是合法的：3 与 0.001 都要过。
  assert.equal(normalizeAudioRequest({ script: '嗨', duration_factor: 3 }, config).durationFactor, 3)
  assert.equal(normalizeAudioRequest({ script: '嗨', duration_factor: 0.001 }, config).durationFactor, 0.001)
})

/* ─────────────────────────── 编排层（假 spawn） ─────────────────────────── */

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

/** 造一条「语音 → ffmpeg 归一 → ffprobe 量时长」的完整假链路。 */
function setupAudio(options = {}) {
  const workRoot = tempDir('dsh-audio')
  const outDir = path.join(workRoot, 'out')
  fs.mkdirSync(outDir, { recursive: true })

  const seen = { indexArgs: null, edgeArgs: null, ffmpegIn: null, wavBytes: 0, jobs: [] }
  const spawn = fakeSpawn((command, args) => {
    if (command === 'ffprobe') {
      return { stdout: options.duration ?? '2.5\n' }
    }
    if (command === 'ffmpeg') {
      // normalizeWavPlan 的 args 形如 ['-y','-v','error','-i',输入,...,输出]，输入永远跟在 -i 后面。
      seen.ffmpegIn = argValue(args, '-i')
      fs.writeFileSync(args[args.length - 1], Buffer.from('RIFF'))
      return {}
    }
    if (args[0] === 'dsh_indextts_infer.py') {
      seen.indexArgs = args
      seen.jobs.push('dsh_indextts_infer.py')
      if (options.indexNoOutput) return {}
      // 包装脚本按 --output 落盘，不再有「取目录里最新 wav」的猜测。
      const outFile = argValue(args, '--output')
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, Buffer.from('wav'))
      seen.wavBytes = 3
      return {}
    }
    if (`${args[0]} ${args[1]}` === '-m edge_tts') {
      seen.edgeArgs = args
      seen.jobs.push('-m edge_tts')
      if (options.edgeNoOutput) return {}
      fs.writeFileSync(argValue(args, '--write-media'), Buffer.from('mp3'))
      return {}
    }
    return {}
  })

  return { workRoot, outDir, seen, spawn, config: audioConfig(options.config) }
}

test('runAudioGeneration（indextts）：假链跑通，产物落指定路径并写元数据', async () => {
  const chain = setupAudio()
  const target = path.join(chain.outDir, 'index.wav')

  const run = await runAudioGeneration({
    args: { script: '这是谁家的小孩？', tts: 'indextts', emo_vector: [0, 0.6, 0, 0, 0, 0, 0, 0.2], output_path: target },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })

  assert.equal(run.audioSeconds, 2.5)
  assert.deepEqual(run.outputPaths, [target])
  assert.equal(fs.existsSync(target), true)
  assert.ok(run.audioPath.startsWith(os.tmpdir()), `audioPath=${run.audioPath}`)
  assert.match(path.basename(path.dirname(run.audioPath)), /^dsh-audio-/)
  assert.equal(run.metadataPath, `${target}.json`)
  const meta = JSON.parse(fs.readFileSync(run.metadataPath, 'utf8'))
  assert.equal(meta.tool, 'comfyui_generate_audio')
  assert.equal(meta.outputFile, target)
  assert.equal(meta.tts.engine, 'indextts')
  // 元数据要把「音色从哪来、情绪怎么给」原样记下来，否则日后无法复现同一条配音。
  assert.equal(meta.tts.spkAudioPrompt, chain.config.ttsSpkAudioPrompt)
  assert.equal(meta.tts.lang, 'ZH')
  assert.deepEqual(meta.tts.emoVector, [0, 0.6, 0, 0, 0, 0, 0, 0.2])
  // 没给的旋钮不许凭空写进元数据（emoAlpha / emoAudioPrompt / durationFactor 都没传）。
  assert.equal('emoAlpha' in meta.tts, false)
  assert.equal('emoAudioPrompt' in meta.tts, false)
  assert.equal('durationFactor' in meta.tts, false)
  assert.equal(meta.audio.seconds, 2.5)
  // 三段链一步不少：indextts 合成 → ffmpeg 归一 → ffprobe 量时长。
  assert.deepEqual(chain.seen.jobs, ['dsh_indextts_infer.py'])

  // 参考音频必须是配置里那一段（音色全靠它）。
  assert.equal(argValue(chain.seen.indexArgs, '--spk_audio_prompt'), chain.config.ttsSpkAudioPrompt)
  // 归一必须拿上一步的产物当输入，不能凭空喂原文件。
  assert.match(chain.seen.ffmpegIn, /indextts\.wav$/)
  assert.match(run.voiceLabel, /^IndexTTS-2 克隆音色 · .+ · 情绪 angry 0\.6 \/ calm 0\.2$/)
})

test('runAudioGeneration（edge）：mp3 经 ffmpeg 归一成 wav，旋钮进命令', async () => {
  const chain = setupAudio()
  const target = path.join(chain.outDir, 'edge.wav')

  const run = await runAudioGeneration({
    args: {
      script: '这是谁家的小孩？',
      tts: 'edge',
      edge_voice: 'zh-CN-XiaoyiNeural',
      rate: '+45%',
      edge_pitch: '+40Hz',
      edge_volume: '+30%',
      output_path: target
    },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })

  assert.equal(run.audioSeconds, 2.5)
  assert.equal(fs.existsSync(target), true)
  assert.equal(argValue(chain.seen.edgeArgs, '--voice'), 'zh-CN-XiaoyiNeural')
  assert.ok(chain.seen.edgeArgs.includes('--rate=+45%'))
  assert.ok(chain.seen.edgeArgs.includes('--pitch=+40Hz'))
  assert.ok(chain.seen.edgeArgs.includes('--volume=+30%'))
  // 归一吃的是 edge 产出的 mp3。
  assert.match(chain.seen.ffmpegIn, /edge\.mp3$/)
  assert.match(run.voiceLabel, /^edge-tts · zh-CN-XiaoyiNeural · \+45% · \+40Hz · \+30%$/)
})

test('runAudioGeneration（edge，不给旋钮）：标签里不多写空旋钮', async () => {
  const chain = setupAudio()
  const run = await runAudioGeneration({
    args: { script: '嗨。', tts: 'edge', output_path: path.join(chain.outDir, 'bare.wav') },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })
  assert.equal(chain.seen.edgeArgs.filter((a) => a.startsWith('--pitch')).length, 0)
  assert.equal(chain.seen.edgeArgs.filter((a) => a.startsWith('--volume')).length, 0)
  assert.match(run.voiceLabel, /^edge-tts · .+ · .+$/)
  assert.doesNotMatch(run.voiceLabel, /· ·/)
})

test('runAudioGeneration：TTS 非零退出 → 明确报错，把 stderr 末行带出来', async () => {
  const chain = setupAudio()
  const spawn = fakeSpawn((command, args) => {
    if (command === 'ffprobe') return { stdout: '2.0\n' }
    if (command === 'ffmpeg') {
      fs.writeFileSync(args[args.length - 1], Buffer.from('wav'))
      return {}
    }
    if (args[0] === 'dsh_indextts_infer.py') {
      return { code: 1, stderr: 'Traceback...\nRuntimeError: 模型目录不完整\n' }
    }
    return {}
  })
  await assert.rejects(
    runAudioGeneration({
      args: { script: '你好。', output_path: path.join(chain.outDir, 'x.wav') },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn }
    }),
    /模型目录不完整/
  )
})

test('runAudioGeneration：正常退出但没产出 wav / mp3 → 不假装成功', async () => {
  const indexChain = setupAudio({ indexNoOutput: true })
  await assert.rejects(
    runAudioGeneration({
      args: { script: '你好。', tts: 'indextts', output_path: path.join(indexChain.outDir, 'nope.wav') },
      cwd: indexChain.outDir,
      config: indexChain.config,
      deps: { spawn: indexChain.spawn }
    }),
    /没有产出 wav/
  )

  const edgeChain = setupAudio({ edgeNoOutput: true })
  await assert.rejects(
    runAudioGeneration({
      args: { script: '你好。', tts: 'edge', output_path: path.join(edgeChain.outDir, 'nope.wav') },
      cwd: edgeChain.outDir,
      config: edgeChain.config,
      deps: { spawn: edgeChain.spawn }
    }),
    /没有产出文件/
  )
})

test('runAudioGeneration：量不出时长 → 报错，不写出 0 秒音频', async () => {
  const chain = setupAudio({ duration: 'N/A\n' })
  const target = path.join(chain.outDir, 'zero.wav')
  await assert.rejects(
    runAudioGeneration({
      args: { script: '你好。', output_path: target },
      cwd: chain.outDir,
      config: chain.config,
      deps: { spawn: chain.spawn }
    }),
    /量不出语音时长/
  )
  assert.equal(fs.existsSync(target), false)
})

test('runAudioGeneration：目标已存在 → 加 -1 后缀，绝不覆盖', async () => {
  const chain = setupAudio()
  const target = path.join(chain.outDir, 'taken.wav')
  fs.writeFileSync(target, Buffer.from('OLD'))
  const before = fs.readFileSync(target)

  const run = await runAudioGeneration({
    args: { script: '你好。', output_path: target },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })

  assert.deepEqual(run.outputPaths, [path.join(chain.outDir, 'taken-1.wav')])
  assert.equal(fs.existsSync(path.join(chain.outDir, 'taken-1.wav')), true)
  assert.deepEqual(fs.readFileSync(target), before)
})

test('runAudioGeneration：writeMetadata=false → 不写 sidecar', async () => {
  const chain = setupAudio({ config: { writeMetadata: false } })
  const target = path.join(chain.outDir, 'nomata.wav')
  const run = await runAudioGeneration({
    args: { script: '你好。', output_path: target },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })
  assert.equal(run.metadataPath, undefined)
  assert.equal(fs.existsSync(`${target}.json`), false)
})

test('runAudioGeneration：不给 output_path → 落到 cwd 的 comfyui-audio-*.wav', async () => {
  const chain = setupAudio()
  const run = await runAudioGeneration({
    args: { script: '你好。' },
    cwd: chain.outDir,
    config: chain.config,
    deps: { spawn: chain.spawn }
  })
  assert.equal(path.dirname(run.outputPaths[0]), chain.outDir)
  assert.match(path.basename(run.outputPaths[0]), /^comfyui-audio-\d+-[a-z0-9]+\.wav$/)
  assert.equal(fs.existsSync(run.outputPaths[0]), true)
})

/* ─────────────────────────── 契约层 ─────────────────────────── */

test('AUDIO_PARAMETERS_SCHEMA：只用 DSH 支持的子集', () => {
  assert.deepEqual(AUDIO_PARAMETERS_SCHEMA.required, ['script'])
  assert.equal(AUDIO_PARAMETERS_SCHEMA.additionalProperties, false)
  assert.deepEqual(AUDIO_PARAMETERS_SCHEMA.properties.tts.enum, ['indextts', 'edge'])
  assert.deepEqual([...AUDIO_PARAMETERS_SCHEMA.properties.lang.enum], [...AUDIO_INDEXTTS_LANGS])
  // 情绪向量必须是 8 维数字数组；维度只能写在 description（schema 子集里没有 minItems/maxItems）。
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.emo_vector.type, 'array')
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.emo_vector.items.type, 'number')
  assert.match(AUDIO_PARAMETERS_SCHEMA.properties.emo_vector.description, /8 维/)
  assert.match(AUDIO_PARAMETERS_SCHEMA.properties.spk_audio_prompt.description, /音色完全由它决定/)
  // gender/pitch/speed 是 Spark-TTS 的概念，必须彻底消失。
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.gender, undefined)
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.pitch, undefined)
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.speed, undefined)
  // 旋钮必须写进 schema，否则宿主会以 additionalProperties=false 拒掉。
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.edge_pitch.type, 'string')
  assert.equal(AUDIO_PARAMETERS_SCHEMA.properties.edge_volume.type, 'string')
  assert.match(AUDIO_PARAMETERS_SCHEMA.properties.edge_pitch.description, /\+40Hz/)
  assert.match(AUDIO_PARAMETERS_SCHEMA.properties.edge_volume.description, /\+30%/)
  // 范围只写在 description（DSH 会拒掉 minimum/maximum/format 这些关键字）。
  const offenders = []
  walkSchema(AUDIO_PARAMETERS_SCHEMA, '', offenders)
  assert.deepEqual(offenders, [], `不该出现的 schema 关键字：${JSON.stringify(offenders)}`)
})

test('AUDIO_OUTPUT_SCHEMA：required 齐全且不含 DSH 不支持的关键字', () => {
  assert.deepEqual(AUDIO_OUTPUT_SCHEMA.required, [
    'text',
    'path',
    'files',
    'script',
    'voice',
    'tts',
    'audio_seconds',
    'duration_ms',
    'success',
    'notes'
  ])
  assert.equal(AUDIO_OUTPUT_SCHEMA.additionalProperties, false)
  const offenders = []
  walkSchema(AUDIO_OUTPUT_SCHEMA, '', offenders)
  assert.deepEqual(offenders, [])
})

test('createGenerateAudioTool：工具名/描述/output 渲染与 presentationMeta', () => {
  const tool = createGenerateAudioTool()
  assert.equal(tool.name, AUDIO_TOOL_NAME)
  assert.equal(AUDIO_TOOL_NAME, 'comfyui_generate_audio')
  assert.match(AUDIO_TOOL_DESCRIPTION, /不碰 ComfyUI 画面/)
  assert.match(AUDIO_TOOL_DESCRIPTION, /edge_pitch/)
  assert.deepEqual(tool.parameters, AUDIO_PARAMETERS_SCHEMA)

  const value = {
    text: '✅ 音频生成成功',
    path: 'D:/x/a.wav',
    files: ['D:/x/a.wav'],
    script: '这是谁家的小孩？',
    voice: 'edge-tts · zh-CN-XiaoyiNeural · +45%',
    tts: 'edge',
    audio_seconds: 1.234,
    duration_ms: 2500,
    success: true,
    notes: []
  }
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: '✅ 音频生成成功' }])
  assert.deepEqual(tool.output.presentationMeta({}, value), {
    kind: 'audio-generation',
    path: 'D:/x/a.wav',
    voice: 'edge-tts · zh-CN-XiaoyiNeural · +45%',
    seconds: 1.234
  })
  // 防御：没有结果时不炸。
  assert.deepEqual(tool.output.render({}, undefined), [{ type: 'text', text: '' }])
})

test('formatAudioResult / 文案渲染：首行 ✅、路径独占一行、时长三位小数', () => {
  const result = formatAudioResult({
    request: { script: '这是谁家的小孩？', tts: 'edge' },
    outputPaths: ['D:/x/a.wav'],
    metadataPath: 'D:/x/a.wav.json',
    audioSeconds: 1.2345,
    voiceLabel: 'edge-tts · zh-CN-XiaoyiNeural · +45%',
    durationMs: 2500,
    notes: ['备注一']
  })

  assert.equal(result.success, true)
  assert.equal(result.path, 'D:/x/a.wav')
  assert.deepEqual(result.files, ['D:/x/a.wav'])
  assert.equal(result.audio_seconds, 1.234)
  assert.equal(result.metadata_path, 'D:/x/a.wav.json')

  const lines = result.text.split('\n')
  assert.equal(lines[0], '✅ 音频生成成功')
  assert.ok(lines.includes('音频：D:/x/a.wav'), `实际文案=${result.text}`)
  assert.ok(lines.includes('元数据：D:/x/a.wav.json'))
  assert.ok(lines.includes('台词：这是谁家的小孩？'))
  assert.ok(lines.includes('音色：edge-tts · zh-CN-XiaoyiNeural · +45%（edge）'))
  assert.ok(lines.includes('参数：语音 1.23 秒'))
  assert.ok(lines.includes('耗时：2.5 秒'))
  assert.ok(lines.includes('  - 备注一'))
  assert.match(result.text, /generate_talking_video/)

  assert.equal(renderAudioResultText(result), result.text)
})

test('renderAudioFailureText：带 ❌ 与 hint', () => {
  const error = new Error('IndexTTS 合成语音失败（退出码 1）：模型目录不完整')
  error.hint = '检查 indexttsPython 是否存在。'
  const text = renderAudioFailureText(error)
  assert.equal(text.split('\n')[0], '❌ 音频生成失败')
  assert.match(text, /模型目录不完整/)
  assert.match(text, /检查 indexttsPython 是否存在/)

  // 没有 hint 也不能炸，也不能留一个空的 hint 段。
  const bare = renderAudioFailureText(new Error('炸了'))
  assert.equal(bare, '❌ 音频生成失败\n\n炸了')
  assert.equal(renderAudioFailureText('字符串错误'), '❌ 音频生成失败\n\n字符串错误')
})

/* ─────────────────────────── 工具函数 ─────────────────────────── */

/** 与 testConfig() 同源，但裁成 runAudioGeneration 需要的那一层。 */
function audioConfig(overrides = {}) {
  const base = testConfig()
  return {
    ttsEngine: base.ttsEngine,
    ttsSpkAudioPrompt: base.ttsSpkAudioPrompt,
    edgeVoice: base.edgeVoice,
    edgeRate: base.edgeRate,
    indexttsPython: base.indexttsPython,
    indexttsDir: base.indexttsDir,
    ffmpeg: base.ffmpeg,
    ffprobe: base.ffprobe,
    talkingTimeoutMs: base.talkingTimeoutMs,
    writeMetadata: base.writeMetadata,
    ...overrides
  }
}

/** 递归找出 DSH schema 子集之外的键（范围/格式类会被宿主直接拒）。 */
const BANNED_SCHEMA_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'format', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf']

function walkSchema(node, at, offenders) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, `${at}[${index}]`, offenders))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (BANNED_SCHEMA_KEYS.includes(key)) offenders.push(`${at}.${key}`)
    walkSchema(value, at === '' ? key : `${at}.${key}`, offenders)
  }
}