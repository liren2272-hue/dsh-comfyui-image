/** 节点 id 常量：调试时对着 ComfyUI 的节点图看很方便。 */
export const VIDEO_NODE = {
    unet: '1',
    clip: '2',
    vae: '3',
    loadImage: '4',
    positive: '5',
    negative: '6',
    sampling: '7',
    latent: '8',
    sampler: '9',
    decode: '10',
    createVideo: '11',
    saveVideo: '12'
};
/** 一套 Wan2.2 视频工作流。 */
export function buildVideoWorkflow(facts) {
    const { request, preset } = facts;
    const workflow = {};
    workflow[VIDEO_NODE.unet] = {
        class_type: preset.loader,
        inputs: { unet_name: preset.unet },
        _meta: { title: '加载视频模型（unet）' }
    };
    workflow[VIDEO_NODE.sampling] = {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: request.shift, model: [VIDEO_NODE.unet, 0] },
        _meta: { title: `ModelSamplingSD3 (shift=${request.shift})` }
    };
    workflow[VIDEO_NODE.clip] = {
        class_type: 'CLIPLoader',
        inputs: { clip_name: preset.clip, type: 'wan', device: 'default' },
        _meta: { title: '加载 umt5 文本编码器' }
    };
    workflow[VIDEO_NODE.positive] = {
        class_type: 'CLIPTextEncode',
        inputs: { text: request.prompt, clip: [VIDEO_NODE.clip, 0] },
        _meta: { title: '正向提示词' }
    };
    workflow[VIDEO_NODE.negative] = {
        class_type: 'CLIPTextEncode',
        inputs: { text: request.negativePrompt, clip: [VIDEO_NODE.clip, 0] },
        _meta: { title: '负向提示词' }
    };
    workflow[VIDEO_NODE.vae] = {
        class_type: 'VAELoader',
        inputs: { vae_name: preset.vae },
        _meta: { title: '加载视频 VAE' }
    };
    // ── 首帧：只有 img2video 才有 ──
    const latentInputs = {
        vae: [VIDEO_NODE.vae, 0],
        width: request.width,
        height: request.height,
        length: request.frames,
        batch_size: 1
    };
    if (request.mode === 'img2video') {
        workflow[VIDEO_NODE.loadImage] = {
            class_type: 'LoadImage',
            inputs: { image: facts.uploadedInput ?? '' },
            _meta: { title: '首帧图片' }
        };
        latentInputs.start_image = [VIDEO_NODE.loadImage, 0];
    }
    workflow[VIDEO_NODE.latent] = {
        class_type: 'Wan22ImageToVideoLatent',
        inputs: latentInputs,
        _meta: { title: `视频 latent（${request.frames} 帧 @ ${request.width}x${request.height}）` }
    };
    workflow[VIDEO_NODE.sampler] = {
        class_type: 'KSampler',
        inputs: {
            seed: request.seed,
            steps: request.steps,
            cfg: request.cfgScale,
            sampler_name: request.samplerName,
            scheduler: request.scheduler,
            denoise: 1.0,
            model: [VIDEO_NODE.sampling, 0],
            positive: [VIDEO_NODE.positive, 0],
            negative: [VIDEO_NODE.negative, 0],
            latent_image: [VIDEO_NODE.latent, 0]
        },
        _meta: { title: 'KSampler' }
    };
    workflow[VIDEO_NODE.decode] = {
        class_type: 'VAEDecode',
        inputs: { samples: [VIDEO_NODE.sampler, 0], vae: [VIDEO_NODE.vae, 0] },
        _meta: { title: 'VAE 解码' }
    };
    workflow[VIDEO_NODE.createVideo] = {
        class_type: 'CreateVideo',
        inputs: { images: [VIDEO_NODE.decode, 0], fps: request.fps },
        _meta: { title: `合成视频（${request.fps} fps）` }
    };
    workflow[VIDEO_NODE.saveVideo] = {
        class_type: 'SaveVideo',
        inputs: {
            video: [VIDEO_NODE.createVideo, 0],
            filename_prefix: facts.filenamePrefix,
            format: 'auto',
            codec: 'auto'
        },
        _meta: { title: '保存视频' }
    };
    return { workflow, outputNodeId: VIDEO_NODE.saveVideo };
}
/** 交给 SaveVideo 的文件名前缀（ComfyUI output 目录下的子目录/名字）。 */
export function videoFilenamePrefix(request, stamp) {
    return `dsh-video/${request.mode}-${stamp}`;
}
