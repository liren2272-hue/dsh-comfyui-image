/**
 * InfiniteTalk（端到端音频驱动口型）工作流的构造器。
 *
 * 新方案与旧的 MuseTalk 有本质区别：
 *   - MuseTalk 是「先生成无声视频 → 局部 256px 重绘再贴回」，嘴部边缘有贴片感/模糊；
 *   - InfiniteTalk 是「一张静帧 + 一段语音 → 端到端生成带口型视频」，没有局部贴回，
 *     嘴随画面整体生成，边缘自然。
 *
 * 这里只做「工作流长什么样」的纯数据拼装：不起进程、不上传、不轮询，拼错了能在
 * 单测里立刻发现，不用等 21 分钟 GPU 跑完才知道参数写歪了。
 *
 * 模板来自本机实拍成功的 14 节点链（WanVideoWrapper GGUF Q3_K_S 主模型 +
 * InfiniteTalk Single Q4_K_M patch + lightx2v 4 步 LoRA + sdpa attention），
 * 6GB 显存 RTX 3060 Laptop 实测 81 帧 / 4 步约 21 分钟出片。
 *
 * 三个必须知道的坑：
 *   1. GGUF 主模型不支持 LoRA merge —— WanVideoLoraSelect.merge_loras 必须 false。
 *   2. T5 文本编码器必须是反量化后的 bf16 版本（umt5_xxl_bf16_dequant.safetensors），
 *      fp8 scaled 版会被 WanVideoTextEncodeCached 直接拒绝。
 *   3. num_frames 必须满足 4n+1（Wan 系 VAE 时间下采样率 4），由编排层按语音时长算好后传入。
 */
import type { ComfyNode, ComfyWorkflow } from '../types.js'

/** 本机实测可用的模型文件名（都在 ComfyUI 的 models/ 对应子目录里）。 */
export const INFINITETALK_MODELS = {
  /** diffusion_models/ 主模型 */
  mainModel: 'wan2.1-i2v-14b-480p-Q3_K_S.gguf',
  /** diffusion_models/ InfiniteTalk patch（与主模型同目录，按文件名分别选） */
  patchModel: 'Wan2_1-InfiniteTalk_Single_Q4_K_M.gguf',
  /** loras/ lightx2v 4 步蒸馏 LoRA */
  lora: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank16_bf16.safetensors',
  /** models/wav2vec2/ 音频编码器 */
  wav2vec2: 'wav2vec2-chinese-base_fp16.safetensors',
  /** models/vae/ */
  vae: 'wan_2.1_vae.safetensors',
  /** models/text_encoders/ 反量化 bf16 版 T5（fp8 scaled 会被拒绝） */
  textEncoder: 'umt5_xxl_bf16_dequant.safetensors'
} as const

/** 默认正向/负向提示词：说话场景要的是干净口型，不要花哨运镜。 */
export const DEFAULT_INFINITETALK_PROMPT =
  'A person talking to the camera, natural facial expression, clear lipsync, high quality, realistic'
export const DEFAULT_INFINITETALK_NEGATIVE =
  'blurry, low quality, distorted face, watermark, text, deformed mouth'

export interface InfiniteTalkWorkflowOptions {
  /** 上传到 ComfyUI input 目录后的首帧图片文件名（LoadImage.image）。 */
  imageName: string
  /** 上传到 ComfyUI input 目录后的语音文件名（LoadAudio.audio）。 */
  audioName: string
  /** 生成帧数，必须 4n+1（由编排层 framesForSeconds 算好）。 */
  frames: number
  /** 帧率，默认 25（与实拍模板一致）。 */
  fps?: number
  /** 画面宽，默认 832。 */
  width?: number
  /** 画面高，默认 480。 */
  height?: number
  /** 采样随机种子。 */
  seed?: number
  /** VHS_VideoCombine 输出文件名前缀；成片落 ComfyUI output 目录。 */
  filenamePrefix?: string
  /** 正向提示词。 */
  prompt?: string
  /** 负向提示词。 */
  negativePrompt?: string
}

const node = (class_type: string, inputs: Record<string, unknown>, metaTitle: string): ComfyNode => ({
  class_type,
  inputs,
  _meta: { title: metaTitle }
})

/**
 * 构造 14 节点 InfiniteTalk API 工作流。
 *
 * 节点编号与实拍模板保持一致，便于对照排查；输入引用用 `["<id>", <slot>]` 形式。
 * 编排层提交前会过一遍 reconcileWorkflow（用 object_info 剪输入、纠枚举），
 * 且必须先上传图片/音频再取 object_info（60s 缓存会把刚上传的文件名误判非法）。
 */
export function buildInfiniteTalkWorkflow(options: InfiniteTalkWorkflowOptions): ComfyWorkflow {
  const fps = options.fps ?? 25
  const width = options.width ?? 832
  const height = options.height ?? 480
  const seed = options.seed ?? 42
  const prompt = options.prompt ?? DEFAULT_INFINITETALK_PROMPT
  const negative = options.negativePrompt ?? DEFAULT_INFINITETALK_NEGATIVE
  const prefix = options.filenamePrefix ?? 'dsh_talking'

  // motion_frame=9 是 InfiniteTalk 官方示例值：每次只驱动 9 帧嘴部运动，其余靠 i2v 延展。
  // steps=4 + cfg=1.0 + shift=11 是 lightx2v 蒸馏 LoRA 的推荐配置（实拍已验证）。
  return {
    '1': node('LoadImage', { image: options.imageName }, '首帧图片'),
    '2': node('LoadAudio', { audio: options.audioName }, '语音'),
    '3': node('MultiTalkModelLoader', { model: INFINITETALK_MODELS.patchModel }, 'InfiniteTalk patch'),
    '4': node(
      'Wav2VecModelLoader',
      {
        model: INFINITETALK_MODELS.wav2vec2,
        base_precision: 'fp16',
        load_device: 'main_device'
      },
      '音频编码器'
    ),
    '5': node(
      'WanVideoVAELoader',
      {
        model_name: INFINITETALK_MODELS.vae,
        precision: 'fp16',
        use_cpu_cache: false,
        verbose: false
      },
      'VAE'
    ),
    '6': node(
      'WanVideoBlockSwap',
      {
        blocks_to_swap: 30,
        offload_img_emb: false,
        offload_txt_emb: false,
        use_non_blocking: false,
        vace_blocks_to_swap: 0,
        prefetch_blocks: 0,
        block_swap_debug: false
      },
      '分块换出（6GB 显存关键）'
    ),
    '7': node(
      'WanVideoLoraSelect',
      {
        lora: INFINITETALK_MODELS.lora,
        strength: 1,
        low_mem_load: true,
        merge_loras: false
      },
      'lightx2v 4步 LoRA（GGUF 不可 merge）'
    ),
    '8': node(
      'WanVideoModelLoader',
      {
        model: INFINITETALK_MODELS.mainModel,
        base_precision: 'fp16_fast',
        quantization: 'disabled',
        load_device: 'offload_device',
        attention_mode: 'sdpa',
        block_swap_args: ['6', 0],
        lora: ['7', 0],
        multitalk_model: ['3', 0],
        rms_norm_function: 'default'
      },
      'Wan2.1 I2V 14B GGUF 主模型'
    ),
    '9': node(
      'WanVideoTextEncodeCached',
      {
        model_name: INFINITETALK_MODELS.textEncoder,
        precision: 'bf16',
        positive_prompt: prompt,
        negative_prompt: negative,
        quantization: 'disabled',
        use_disk_cache: true,
        device: 'gpu'
      },
      'T5 文本编码（反量化 bf16）'
    ),
    '10': node(
      'MultiTalkWav2VecEmbeds',
      {
        wav2vec_model: ['4', 0],
        audio_1: ['2', 0],
        normalize_loudness: false,
        num_frames: options.frames,
        fps,
        audio_scale: 1,
        audio_cfg_scale: 1,
        multi_audio_type: 'para'
      },
      '音频嵌入'
    ),
    '11': node(
      'WanVideoImageToVideoMultiTalk',
      {
        vae: ['5', 0],
        width,
        height,
        frame_window_size: options.frames,
        motion_frame: 9,
        force_offload: false,
        colormatch: 'disabled',
        start_image: ['1', 0],
        mode: 'infinitetalk',
        output_path: ''
      },
      '图生视频（端到端口型）'
    ),
    '12': node(
      'WanVideoSampler',
      {
        model: ['8', 0],
        image_embeds: ['11', 0],
        steps: 4,
        cfg: 1,
        shift: 11,
        seed,
        force_offload: true,
        scheduler: 'dpm++',
        riflex_freq_index: 0,
        text_embeds: ['9', 0],
        multitalk_embeds: ['10', 0],
        rope_function: 'comfy',
        start_step: 0,
        end_step: -1,
        add_noise_to_samples: false
      },
      '采样（4步蒸馏）'
    ),
    '13': node(
      'WanVideoDecode',
      {
        vae: ['5', 0],
        samples: ['12', 0],
        enable_vae_tiling: false,
        tile_x: 272,
        tile_y: 272,
        tile_stride_x: 144,
        tile_stride_y: 128
      },
      'VAE 解码'
    ),
    '14': node(
      'VHS_VideoCombine',
      {
        images: ['13', 0],
        frame_rate: fps,
        loop_count: 0,
        filename_prefix: prefix,
        format: 'video/h264-mp4',
        pingpong: false,
        save_output: true,
        audio: ['10', 1]
      },
      '合成 MP4（带音频）'
    )
  }
}
