/**
 * 视频预设：把「本机 ComfyUI 到底能跑哪套视频模型」问清楚，翻译成工作流能直接用的事实。
 *
 * 图片模式只有 CheckpointLoaderSimple 一个入口，视频模式不是：Wan 系要
 * diffusion 模型（unet）＋文本编码器（umt5）＋专用 VAE 三件套分开放。
 * 所以这一层负责：
 *   1. 列出本机可用的 unet / clip / vae（从 /object_info 的枚举里取，不猜路径）；
 *   2. 优先用配置里指定的，没指定就按名字挑一套 Wan2.2 TI2V 组合；
 *   3. 缺节点 / 缺模型时提前报错，并说清楚该装什么。
 */
                                                 
import { ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'
                                                                      
import { declaredInputs, enumChoices, requiredInputs } from '../comfy/nodes.js'

/** 一套可以直接交给工作流构建器的视频预设。 */
                              
                    
            
                 
               
                                                                                
                                         
                                             
              
                                          
              
                               
             
             
               
               
                  
               
                
                     
                   
                        
 

                                        
                     
                 
                         
                                                                              
 

/** 视频模式必需的节点：缺任何一个都跑不起来，提前说清楚。 */
const REQUIRED_NODES                                                     = [
  {
    classType: 'Wan22ImageToVideoLatent',
    hint: '这个节点是 ComfyUI 0.3.60+ 自带的（comfy_extras/nodes_wan.py）。请把 ComfyUI 升级到较新版本。'
  },
  {
    classType: 'ModelSamplingSD3',
    hint: 'ModelSamplingSD3 是 ComfyUI 核心节点（comfy_extras/nodes_model_advanced.py）。请升级 ComfyUI。'
  },
  {
    classType: 'SaveVideo',
    hint: 'CreateVideo / SaveVideo 是 ComfyUI 0.3.30+ 新增的原生视频节点。请升级 ComfyUI（不需要装第三方节点）。'
  },
  { classType: 'CreateVideo', hint: '请把 ComfyUI 升级到 0.3.30+（原生视频节点随主程序提供）。' }
]

/** 按名字优先级在候选列表里挑一个。 */
function pickByName(candidates                   , patterns                   )                     {
  for (const pattern of patterns) {
    const hit = candidates.find((name) => pattern.test(name))
    if (hit) return hit
  }
  return undefined
}

function listOf(info                           , key        )           {
  const declared = declaredInputs(info)
  return enumChoices(declared[key]) ?? enumChoices(requiredInputs(info)[key]) ?? []
}

function describeList(list                   , limit = 8)         {
  if (list.length === 0) return '（空）'
  const head = list.slice(0, limit).join('、')
  return list.length > limit ? `${head} 等 ${list.length} 个` : head
}

/**
 * 解析视频预设。
 *
 * @throws ImagePluginError 节点缺失 / 模型缺失 / 配置指定的文件不存在。
 */
export async function resolveVideoPreset(
  client               ,
  config                ,
  preferredUnet        ,
  signal              
)                                 {
  const info = await client.objectInfo(signal)
  const notes           = []

  // ── 1. 先确认节点齐不齐（缺节点的报错必须比「工作流被拒绝」好懂）──
  for (const node of REQUIRED_NODES) {
    if (!info[node.classType]) {
      throw new ImagePluginError(
        `ComfyUI 里没有节点 \`${node.classType}\`，视频模式跑不了。`,
        node.hint
      )
    }
  }
  for (const node of ['KSampler', 'CLIPTextEncode', 'VAEDecode', 'CLIPLoader', 'VAELoader']) {
    if (!info[node]) {
      throw new ImagePluginError(
        `ComfyUI 里没有节点 \`${node}\`。`,
        '这些是 ComfyUI 核心节点，缺它们通常说明 baseUrl 指向的不是 ComfyUI 服务。'
      )
    }
  }

  // ── 2. 摸清本机有哪些模型 ──
  const ggufLoader = info['UnetLoaderGGUF'] ? 'UnetLoaderGGUF' : undefined
  const safetensorsLoader = info['UNETLoader'] ? 'UNETLoader' : undefined
  const ggufUnets = ggufLoader ? listOf(info[ggufLoader], 'unet_name') : []
  const safeUnets = safetensorsLoader ? listOf(info[safetensorsLoader], 'unet_name') : []
  const clipList = listOf(info['CLIPLoader'], 'clip_name')
  const vaeList = listOf(info['VAELoader'], 'vae_name')

  let loader                                  = ggufLoader ? 'UnetLoaderGGUF' : 'UNETLoader'
  if (!ggufLoader && !safetensorsLoader) {
    throw new ImagePluginError(
      'ComfyUI 里既没有 UnetLoaderGGUF 也没有 UNETLoader，加载不了 Wan 视频模型。',
      '如果你下的是 GGUF 量化模型，请装 ComfyUI-GGUF 自定义节点（https://github.com/city96/ComfyUI-GGUF）；' +
        '如果是 .safetensors 模型，UNETLoader 是自带的，不该缺——请检查 ComfyUI 版本。'
    )
  }
  const unetList = loader === 'UnetLoaderGGUF' ? ggufUnets : safeUnets

  // ── 3. 定 unet：显式指定 > 配置 > 按名字挑 ──
  const wanted = preferredUnet || config.videoModel || ''
  let unet        
  if (wanted) {
    // 显式指定的模型可能挂在另一种加载器下（比如用户写了 safetensors 名），先跨列表找一次
    if (unetList.includes(wanted)) {
      unet = wanted
    } else if (ggufUnets.includes(wanted)) {
      unet = wanted
      loader = 'UnetLoaderGGUF'
    } else if (safeUnets.includes(wanted)) {
      unet = wanted
      loader = 'UNETLoader'
    } else {
      throw new ImagePluginError(
        `指定的视频模型不存在：${wanted}`,
        `本机 ComfyUI 的 diffusion 模型（unet）有：${describeList([...ggufUnets, ...safeUnets])}。` +
          '请把它改名成其中之一，或清空配置让插件自动挑。'
      )
    }
  } else {
    const picked = pickByName(unetList, [
      /wan2?[._-]?2.*ti2v.*5b/i,
      /ti2v.*5b/i,
      /wan2?[._-]?2.*5b/i,
      /wan.*5b/i
    ])
    if (!picked) {
      throw new ImagePluginError(
        `本机没有可用的 Wan 视频模型（unet 列表：${describeList(unetList)}）。`,
        '视频模式当前内置的是 Wan2.2 TI2V-5B 管线，需要下载 ' +
          'Wan2.2-TI2V-5B-Q4_K_M.gguf（约 3.2GB）放进 models/diffusion_models，' +
          'Wan2.2_VAE.safetensors（约 1.3GB）放进 models/vae，' +
          'umt5_xxl_fp8_e4m3fn_scaled.safetensors 放进 models/text_encoders。' +
          '也可以在生成视频时用 model 参数指定已有模型。'
      )
    }
    unet = picked
    notes.push(`自动选用视频模型：${unet}（可用 model 参数指定其它）。`)
  }

  // ── 4. 定 clip / vae ──
  const clipWanted = config.videoClip ?? ''
  let clip        
  if (clipWanted) {
    if (!clipList.includes(clipWanted)) {
      throw new ImagePluginError(
        `配置的视频文本编码器不存在：${clipWanted}`,
        `本机可用的 text_encoders 有：${describeList(clipList)}。`
      )
    }
    clip = clipWanted
  } else {
    const picked = pickByName(clipList, [/umt5.*xxl/i, /umt5/i, /t5.*xxl/i])
    if (!picked) {
      throw new ImagePluginError(
        `本机没有 Wan 需要的文本编码器 umt5（text_encoders：${describeList(clipList)}）。`,
        '请下载 umt5_xxl_fp8_e4m3fn_scaled.safetensors（约 6.7GB）放进 models/text_encoders。'
      )
    }
    clip = picked
  }

  const vaeWanted = config.videoVae ?? ''
  let vae        
  if (vaeWanted) {
    if (!vaeList.includes(vaeWanted)) {
      throw new ImagePluginError(
        `配置的视频 VAE 不存在：${vaeWanted}`,
        `本机可用的 vae 有：${describeList(vaeList)}。`
      )
    }
    vae = vaeWanted
  } else {
    const picked = pickByName(vaeList, [/wan2[._-]?2.*vae/i, /wan.*2[._-]?2.*vae/i, /wan.*vae/i])
    if (!picked) {
      throw new ImagePluginError(
        `本机没有 Wan 的 VAE（vae 列表：${describeList(vaeList)}）。`,
        '请下载 Wan2.2_VAE.safetensors（约 1.3GB）放进 models/vae。' +
          '注意 Wan2.2 必须用它自己的 VAE，Wan2.1 的 VAE 不兼容。'
      )
    }
    vae = picked
  }

  const preset              = {
    id: loader === 'UnetLoaderGGUF' ? 'wan-ti2v-gguf' : 'wan-ti2v-safetensors',
    label: 'Wan2.2 TI2V（文生视频 / 图生视频通用）',
    loader,
    unet,
    clip,
    vae,
    fps: config.videoFps,
    shift: config.videoShift,
    steps: config.videoSteps,
    cfgScale: config.videoCfgScale,
    width: config.videoWidth,
    height: config.videoHeight,
    samplerName: config.videoSamplerName,
    scheduler: config.videoScheduler,
    negativePrompt: config.videoNegativePrompt
  }
  logDebug('视频预设已解析', preset)

  return { preset, notes, available: { loader, unet: unetList, clip: clipList, vae: vaeList } }
}
