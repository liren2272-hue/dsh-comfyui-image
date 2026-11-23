/**
 * ACE-Step 1.5 AIO 音乐工作流构建层（**纯函数**：不碰网络、不碰文件系统）。
 *
 * 本机 ComfyUI 0.43 原生节点，用 CheckpointLoaderSimple 加载**单文件 AIO**
 * （不是 split 的 UNETLoader / DualCLIPLoader）：
 *
 *   1 CheckpointLoaderSimple(ckpt) ──► clip / model / vae
 *   2 TextEncodeAceStepAudio1.5(tags, lyrics="", seed, bpm, duration, ...)
 *   3 ModelSamplingAuraFlow(model, shift=3)
 *   4 EmptyAceStep1.5LatentAudio(seconds, batch_size=1)
 *   5 ConditioningZeroOut(节点2) ──► 负向 conditioning
 *   6 KSampler(model=3, pos=2, neg=5, latent=4, denoise=1)
 *   7 VAEDecodeAudio(samples=6, vae=1)
 *   8 SaveAudioAdvanced(audio=7, format)  ← 产出节点
 *
 * 三个已逐字核对过的点：
 *   1. TextEncodeAceStepAudio1.5 的真实输入名是 `cfg_scale`（不是 cfg）；
 *   2. seed 同时喂节点 2 和节点 6，duration 同时喂节点 2 和节点 4；
 *   3. 纯器乐靠 `lyrics: ""`，负向 conditioning 走 ConditioningZeroOut。
 */
import type { ComfyWorkflow, ResolvedConfig } from '../types.js'
import type { NormalizedMusicRequest } from './types.js'

/** 节点 id 常量：调试时对着 ComfyUI 的节点图看很方便。 */
export const MUSIC_NODE = {
  checkpoint: '1',
  textEncode: '2',
  sampling: '3',
  latent: '4',
  negative: '5',
  sampler: '6',
  decode: '7',
  saveAudio: '8'
} as const

export interface MusicWorkflowFacts {
  request: NormalizedMusicRequest
  /** 采样相关默认值（steps / cfg / sampler / scheduler / checkpoint）从这里读。 */
  config: ResolvedConfig
  /** SaveAudioAdvanced 的 filename_prefix；不传用 'comfyui_music'。 */
  filenamePrefix?: string
}

export interface BuiltMusicWorkflow {
  workflow: ComfyWorkflow
  /** 产出节点 id（SaveAudioAdvanced），取结果时优先从这个节点找。 */
  outputNodeId: string
}

/** 一套 ACE-Step 1.5 AIO 纯 BGM 工作流。 */
export function buildMusicWorkflow(facts: MusicWorkflowFacts): BuiltMusicWorkflow {
  const { request, config } = facts
  const workflow: ComfyWorkflow = {}
  const { tags, lyrics, seed, bpm, duration, key, language, format } = request

  workflow[MUSIC_NODE.checkpoint] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: config.musicCheckpoint },
    _meta: { title: '加载 ACE-Step 1.5 AIO 单文件 checkpoint' }
  }

  workflow[MUSIC_NODE.textEncode] = {
    class_type: 'TextEncodeAceStepAudio1.5',
    inputs: {
      clip: [MUSIC_NODE.checkpoint, 1],
      tags,
      lyrics,
      seed,
      bpm,
      duration,
      timesignature: '4',
      language,
      keyscale: key,
      generate_audio_codes: true,
      cfg_scale: 2.0,
      temperature: 0.85,
      top_p: 0.9,
      top_k: 0,
      min_p: 0.0
    },
    _meta: { title: 'ACE-Step 文本编码（纯器乐，lyrics 为空）' }
  }

  workflow[MUSIC_NODE.sampling] = {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { model: [MUSIC_NODE.checkpoint, 0], shift: 3 },
    _meta: { title: 'ModelSamplingAuraFlow (shift=3)' }
  }

  workflow[MUSIC_NODE.latent] = {
    class_type: 'EmptyAceStep1.5LatentAudio',
    inputs: { seconds: duration, batch_size: 1 },
    _meta: { title: `音频 latent（${duration} 秒）` }
  }

  workflow[MUSIC_NODE.negative] = {
    class_type: 'ConditioningZeroOut',
    inputs: { conditioning: [MUSIC_NODE.textEncode, 0] },
    _meta: { title: '负向 conditioning（清零）' }
  }

  workflow[MUSIC_NODE.sampler] = {
    class_type: 'KSampler',
    inputs: {
      model: [MUSIC_NODE.sampling, 0],
      seed,
      steps: config.musicSteps,
      cfg: config.musicCfg,
      sampler_name: config.musicSampler,
      scheduler: config.musicScheduler,
      positive: [MUSIC_NODE.textEncode, 0],
      negative: [MUSIC_NODE.negative, 0],
      latent_image: [MUSIC_NODE.latent, 0],
      denoise: 1
    },
    _meta: { title: 'KSampler' }
  }

  workflow[MUSIC_NODE.decode] = {
    class_type: 'VAEDecodeAudio',
    inputs: { samples: [MUSIC_NODE.sampler, 0], vae: [MUSIC_NODE.checkpoint, 2] },
    _meta: { title: 'VAE 解码音频' }
  }

  workflow[MUSIC_NODE.saveAudio] = {
    class_type: 'SaveAudioAdvanced',
    inputs: {
      audio: [MUSIC_NODE.decode, 0],
      filename_prefix: facts.filenamePrefix ?? 'comfyui_music',
      // 归一化的 format 默认就取 config.musicFormat；用户在 args 里显式覆盖时这里跟着变，
      // 免得「参数说 mp3、落盘却是 flac」。
      format
    },
    _meta: { title: `保存音频（${format}）` }
  }

  return { workflow, outputNodeId: MUSIC_NODE.saveAudio }
}
