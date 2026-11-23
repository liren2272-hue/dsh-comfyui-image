/**
 * 配置解析。
 *
 * 优先级（**高的赢**）：
 *   1. 插件配置   —— profile 的 cordis.patch.yml 里那条 entry 的 `config:`（宿主注入的 `apply(ctx, config)`）
 *   2. 配置文件   —— `~/.dsh-comfyui-image/config.json`（不用重启 DSH、不用改 profile，最方便）
 *   3. 环境变量   —— `COMFYUI_URL` 等（适合容器 / 临时覆盖）
 *   4. 内置默认值 —— 本文件 DEFAULTS
 *
 * 为什么把「插件配置」放最高：DSH 的配置树是运维/宿主的权威来源，
 * 摆了 config 就该它说了算；配置文件是给「只想改个地址、不想动 YAML」的用户准备的便利层。
 *
 * 不依赖任何第三方 schema 库：Cordis 在插件没有导出 `Config` schema 时
 * 会把原始配置对象**原样**交给 `apply`（见 @deepseek-ai/cordis 的 resolveConfig 文档），
 * 所以这里手写校验就够了，也避免了 link 安装下的依赖解析问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logDebug, logWarn } from './log.js';
/** 插件 id，同时用作配置目录名。 */
export const PLUGIN_ID = 'dsh-comfyui-image';
/** ComfyUI 默认地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
/** 配置文件位置；测试可以用 `DSH_COMFYUI_IMAGE_CONFIG` 指到临时目录。 */
export const CONFIG_FILE = process.env.DSH_COMFYUI_IMAGE_CONFIG || path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json');
/** 内置默认值。 */
export const DEFAULTS = {
    baseUrl: DEFAULT_BASE_URL,
    negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry',
    steps: 20,
    cfgScale: 7,
    samplerName: 'euler',
    scheduler: 'normal',
    width: 1024,
    height: 1024,
    strength: 0.6,
    inpaintGrowMask: 6,
    timeoutMs: 300_000,
    pollIntervalMs: 700,
    requestTimeoutMs: 30_000,
    saveToComfyUI: true,
    writeMetadata: true,
    /* ────────── 视频（Wan2.2 TI2V）默认值 ────────── */
    /**
     * Wan2.2 官方中文负向词。别换成 SD 的英文负向串：
     * 视频模型对这些「静态 / 字幕 / JPEG 残留」类词敏感，英文那串基本不起作用。
     */
    videoNegativePrompt: '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，' +
        'JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，' +
        '形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走',
    /** 832x480 是 Wan2.2 5B 在 6GB 显存上跑得动的甜点尺寸（对齐到 32 的倍数）。 */
    videoWidth: 832,
    videoHeight: 480,
    videoFps: 24,
    /** 默认 2 秒（49 帧）：3060 上约 3.5 分钟，不至于让人等到怀疑人生。 */
    videoSeconds: 2,
    videoSteps: 30,
    videoCfgScale: 5,
    videoShift: 8,
    videoSamplerName: 'euler',
    videoScheduler: 'simple',
    /** 视频慢：默认给 30 分钟，是图片超时的 6 倍。 */
    videoTimeoutMs: 1_800_000,
    // ── 说话视频（generate_talking_video）────────────────────────────────
    /** 默认用 IndexTTS 克隆参考音频的音色；换成 edge 就走现成音色。 */
    ttsEngine: 'indextts',
    /** IndexTTS 的默认参考音频：音色完全由它决定，换一个文件就是换一个人。 */
    ttsSpkAudioPrompt: 'D:/Tools/IndexTTS/ref_audio_voice.wav',
    /** edge-tts 的默认音色与语速。 */
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    edgeRate: '-4%',
    /** IndexTTS 仓库根与它的 venv python（edge-tts 也装在这个 venv 里；MuseTalk 删除后统一用这个）。 */
    indexttsDir: 'D:/Tools/IndexTTS',
    indexttsPython: 'D:/Tools/IndexTTS/.venv/Scripts/python.exe',
    /** ffmpeg 目录与两个可执行文件命令（语音归一到 16k 用）。 */
    ffmpegBin: 'C:/FFmpeg/bin',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    /** 口型整条链路的超时：语音 + InfiniteTalk 端到端生成，30 分钟起步（81 帧/4 步约 21 分钟）。 */
    talkingTimeoutMs: 1_800_000,
    // ── 音乐生成（generate_music / ACE-Step 1.5 AIO）────────────────────
    /** ACE-Step 1.5 turbo AIO 单文件：9.33GiB，本机 RTX3060 6GB 跑得动，纯器乐 lyrics 留空。 */
    musicCheckpoint: 'ace_step_1.5_turbo_aio.safetensors',
    /** 音乐生成慢，默认给 15 分钟。 */
    musicTimeoutMs: 900_000,
    /** 音频封装格式：flac（无损）/ mp3 / opus。 */
    musicFormat: 'flac',
    /** ACE-Step turbo 是蒸馏模型，官方模板 8 步就够。 */
    musicSteps: 8,
    /** ACE-Step 的 KSampler CFG 官方模板是 1；文本编码器的 cfg_scale 另在工具里固定 2.0。 */
    musicCfg: 1,
    musicSampler: 'euler',
    musicScheduler: 'simple',
    musicBpm: 120,
    musicKeyScale: 'C major',
    musicLanguage: 'zh',
    /** 单次生成最长秒数（0~2000 是节点上限，这里给用户留 300 秒的实用上限）。 */
    musicMaxDuration: 300,
    // ── 语音识别（transcribe_audio / Whisper）───────────────────────────
    /** 复用 IndexTTS 的 venv：whisper 20250625 + torch 2.8+cu128 已装好。 */
    transcribePython: 'D:/Tools/IndexTTS/.venv/Scripts/python.exe',
    /** large-v3 是 whisper 系列最强，本机 6GB 跑得动；权重缓存在 ~/.cache/whisper。 */
    transcribeModel: 'large-v3',
    /** CUDA 优先，脚本内失败自动回退 cpu。 */
    transcribeDevice: 'cuda',
    /** 长音频转写耗时，默认 10 分钟。 */
    transcribeTimeoutMs: 600_000
};
/** 环境变量名 → 插件配置键。 */
const ENV_KEYS = {
    COMFYUI_URL: 'baseUrl',
    COMFYUI_BASE_URL: 'baseUrl',
    COMFYUI_CHECKPOINT: 'checkpoint',
    COMFYUI_STEPS: 'steps',
    COMFYUI_CFG_SCALE: 'cfgScale',
    COMFYUI_SAMPLER: 'samplerName',
    COMFYUI_SCHEDULER: 'scheduler',
    COMFYUI_TIMEOUT_MS: 'timeoutMs',
    COMFYUI_REMBG_NODE: 'rembgNode',
    COMFYUI_VIDEO_MODEL: 'videoModel',
    COMFYUI_VIDEO_WIDTH: 'videoWidth',
    COMFYUI_VIDEO_HEIGHT: 'videoHeight',
    COMFYUI_VIDEO_FPS: 'videoFps',
    COMFYUI_VIDEO_TIMEOUT_MS: 'videoTimeoutMs',
    COMFYUI_TTS_ENGINE: 'ttsEngine',
    COMFYUI_INDEXTTS_DIR: 'indexttsDir',
    COMFYUI_INDEXTTS_PYTHON: 'indexttsPython',
    COMFYUI_INDEXTTS_SPK_AUDIO_PROMPT: 'ttsSpkAudioPrompt',
    COMFYUI_FFMPEG_BIN: 'ffmpegBin',
    COMFYUI_TALKING_TIMEOUT_MS: 'talkingTimeoutMs',
    COMFYUI_MUSIC_CHECKPOINT: 'musicCheckpoint',
    COMFYUI_MUSIC_TIMEOUT_MS: 'musicTimeoutMs',
    COMFYUI_TRANSCRIBE_PYTHON: 'transcribePython',
    COMFYUI_TRANSCRIBE_MODEL: 'transcribeModel',
    COMFYUI_TRANSCRIBE_DEVICE: 'transcribeDevice',
    COMFYUI_TRANSCRIBE_TIMEOUT_MS: 'transcribeTimeoutMs',
    DSH_COMFYUI_IMAGE_OUTPUT: 'outputDir'
};
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 读配置文件；坏了就当没有，绝不因为这个把插件搞挂。 */
export function readConfigFile() {
    try {
        if (!fs.existsSync(CONFIG_FILE))
            return {};
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
    }
    catch (error) {
        logWarn(`配置文件读不了，已忽略：${CONFIG_FILE}（${error instanceof Error ? error.message : String(error)}）`);
        return {};
    }
}
/** 把一份补丁合并进配置文件（留给以后的面板/CLI 用）。 */
export function writeConfigFile(patch) {
    const next = { ...readConfigFile(), ...patch };
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
/** 从环境变量里抽配置。 */
export function configFromEnv(env = process.env) {
    const out = {};
    for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
        const value = env[envKey];
        if (value !== undefined && value !== '')
            out[configKey] = value;
    }
    return out;
}
function pickString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '')
            return candidate.trim();
    }
    return undefined;
}
function pickNumber(min, max, ...candidates) {
    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? Number(candidate) : candidate;
        if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
            return value;
        }
    }
    return undefined;
}
function pickBoolean(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'boolean')
            return candidate;
        if (typeof candidate === 'string') {
            if (candidate === '1' || candidate.toLowerCase() === 'true')
                return true;
            if (candidate === '0' || candidate.toLowerCase() === 'false')
                return false;
        }
    }
    return undefined;
}
/**
 * 合并四层来源，产出可直接使用的配置。
 * 非法值（负数步数、非数字超时…）会被**丢掉并退回默认**，同时 debug 日志里留痕。
 */
export function resolveConfig(pluginConfig, env = process.env) {
    const fromPlugin = isPlainObject(pluginConfig) ? pluginConfig : {};
    const fromFile = readConfigFile();
    const fromEnv = configFromEnv(env);
    if (pluginConfig !== undefined && !isPlainObject(pluginConfig)) {
        logWarn('插件配置不是对象，已忽略（只认 JSON 对象）。');
    }
    const s = (...keys) => [
        ...keys.map((key) => fromPlugin[key]),
        ...keys.map((key) => fromFile[key]),
        ...keys.map((key) => fromEnv[key])
    ];
    const baseUrl = pickString(...s('baseUrl')) ?? DEFAULTS.baseUrl;
    const resolved = {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        negativePrompt: pickString(...s('negativePrompt')) ?? DEFAULTS.negativePrompt,
        steps: Math.round(pickNumber(1, 500, ...s('steps')) ?? DEFAULTS.steps),
        cfgScale: pickNumber(0, 100, ...s('cfgScale')) ?? DEFAULTS.cfgScale,
        samplerName: pickString(...s('samplerName')) ?? DEFAULTS.samplerName,
        scheduler: pickString(...s('scheduler')) ?? DEFAULTS.scheduler,
        width: Math.round(pickNumber(64, 8192, ...s('width')) ?? DEFAULTS.width),
        height: Math.round(pickNumber(64, 8192, ...s('height')) ?? DEFAULTS.height),
        strength: pickNumber(0, 1, ...s('strength')) ?? DEFAULTS.strength,
        inpaintGrowMask: Math.round(pickNumber(0, 256, ...s('inpaintGrowMask')) ?? DEFAULTS.inpaintGrowMask),
        timeoutMs: Math.round(pickNumber(1_000, 3_600_000, ...s('timeoutMs')) ?? DEFAULTS.timeoutMs),
        pollIntervalMs: Math.round(pickNumber(100, 10_000, ...s('pollIntervalMs')) ?? DEFAULTS.pollIntervalMs),
        requestTimeoutMs: Math.round(pickNumber(1_000, 600_000, ...s('requestTimeoutMs')) ?? DEFAULTS.requestTimeoutMs),
        saveToComfyUI: pickBoolean(...s('saveToComfyUI')) ?? DEFAULTS.saveToComfyUI,
        writeMetadata: pickBoolean(...s('writeMetadata')) ?? DEFAULTS.writeMetadata,
        /* 视频 */
        videoNegativePrompt: pickString(...s('videoNegativePrompt')) ?? DEFAULTS.videoNegativePrompt,
        videoWidth: Math.round(pickNumber(64, 2048, ...s('videoWidth')) ?? DEFAULTS.videoWidth),
        videoHeight: Math.round(pickNumber(64, 2048, ...s('videoHeight')) ?? DEFAULTS.videoHeight),
        videoFps: Math.round(pickNumber(4, 60, ...s('videoFps')) ?? DEFAULTS.videoFps),
        videoSeconds: pickNumber(0.25, 60, ...s('videoSeconds')) ?? DEFAULTS.videoSeconds,
        videoSteps: Math.round(pickNumber(1, 500, ...s('videoSteps')) ?? DEFAULTS.videoSteps),
        videoCfgScale: pickNumber(0, 100, ...s('videoCfgScale')) ?? DEFAULTS.videoCfgScale,
        videoShift: pickNumber(0, 100, ...s('videoShift')) ?? DEFAULTS.videoShift,
        videoSamplerName: pickString(...s('videoSamplerName')) ?? DEFAULTS.videoSamplerName,
        videoScheduler: pickString(...s('videoScheduler')) ?? DEFAULTS.videoScheduler,
        videoTimeoutMs: Math.round(pickNumber(10_000, 7_200_000, ...s('videoTimeoutMs')) ?? DEFAULTS.videoTimeoutMs),
        /* 说话视频 */
        ttsEngine: pickString(...s('ttsEngine')) ?? DEFAULTS.ttsEngine,
        ttsSpkAudioPrompt: pickString(...s('ttsSpkAudioPrompt')) ?? DEFAULTS.ttsSpkAudioPrompt,
        edgeVoice: pickString(...s('edgeVoice')) ?? DEFAULTS.edgeVoice,
        edgeRate: pickString(...s('edgeRate')) ?? DEFAULTS.edgeRate,
        indexttsDir: pickString(...s('indexttsDir')) ?? DEFAULTS.indexttsDir,
        indexttsPython: pickString(...s('indexttsPython')) ?? DEFAULTS.indexttsPython,
        ffmpegBin: pickString(...s('ffmpegBin')) ?? DEFAULTS.ffmpegBin,
        ffmpeg: pickString(...s('ffmpeg')) ?? DEFAULTS.ffmpeg,
        ffprobe: pickString(...s('ffprobe')) ?? DEFAULTS.ffprobe,
        talkingTimeoutMs: Math.round(pickNumber(10_000, 7_200_000, ...s('talkingTimeoutMs')) ?? DEFAULTS.talkingTimeoutMs),
        /* 音乐生成 */
        musicCheckpoint: pickString(...s('musicCheckpoint')) ?? DEFAULTS.musicCheckpoint,
        musicTimeoutMs: Math.round(pickNumber(10_000, 7_200_000, ...s('musicTimeoutMs')) ?? DEFAULTS.musicTimeoutMs),
        musicFormat: pickString(...s('musicFormat')) ?? DEFAULTS.musicFormat,
        musicSteps: Math.round(pickNumber(1, 500, ...s('musicSteps')) ?? DEFAULTS.musicSteps),
        musicCfg: pickNumber(0, 100, ...s('musicCfg')) ?? DEFAULTS.musicCfg,
        musicSampler: pickString(...s('musicSampler')) ?? DEFAULTS.musicSampler,
        musicScheduler: pickString(...s('musicScheduler')) ?? DEFAULTS.musicScheduler,
        musicBpm: Math.round(pickNumber(10, 300, ...s('musicBpm')) ?? DEFAULTS.musicBpm),
        musicKeyScale: pickString(...s('musicKeyScale')) ?? DEFAULTS.musicKeyScale,
        musicLanguage: pickString(...s('musicLanguage')) ?? DEFAULTS.musicLanguage,
        musicMaxDuration: Math.round(pickNumber(1, 2000, ...s('musicMaxDuration')) ?? DEFAULTS.musicMaxDuration),
        /* 语音识别 */
        transcribePython: pickString(...s('transcribePython')) ?? DEFAULTS.transcribePython,
        transcribeModel: pickString(...s('transcribeModel')) ?? DEFAULTS.transcribeModel,
        transcribeDevice: pickString(...s('transcribeDevice')) ?? DEFAULTS.transcribeDevice,
        transcribeTimeoutMs: Math.round(pickNumber(10_000, 7_200_000, ...s('transcribeTimeoutMs')) ?? DEFAULTS.transcribeTimeoutMs)
    };
    const outputDir = pickString(...s('outputDir'));
    if (outputDir !== undefined)
        resolved.outputDir = outputDir;
    const checkpoint = pickString(...s('checkpoint'));
    if (checkpoint !== undefined)
        resolved.checkpoint = checkpoint;
    const rembgNode = pickString(...s('rembgNode'));
    if (rembgNode !== undefined)
        resolved.rembgNode = rembgNode;
    // 视频模型三件套：留空表示「让 presets 层按名字自动挑」，只有明确写了才校验是否存在
    const videoModel = pickString(...s('videoModel'));
    if (videoModel !== undefined)
        resolved.videoModel = videoModel;
    const videoClip = pickString(...s('videoClip'));
    if (videoClip !== undefined)
        resolved.videoClip = videoClip;
    const videoVae = pickString(...s('videoVae'));
    if (videoVae !== undefined)
        resolved.videoVae = videoVae;
    logDebug('配置已解析', {
        baseUrl: resolved.baseUrl,
        configFile: CONFIG_FILE,
        fileExists: fs.existsSync(CONFIG_FILE),
        sources: { plugin: Object.keys(fromPlugin), file: Object.keys(fromFile), env: Object.keys(fromEnv) }
    });
    return resolved;
}
/**
 * 按底模名字挑默认尺寸。
 *
 * SD1.5 系最舒服是 512，SDXL 系是 1024。
 * 用户没指定 width/height 时按名字**轻量**挑一个默认值——
 * 规则很直白、写在这里，不做任何更深的猜测。
 */
export function suggestSizeForCheckpoint(checkpoint, config) {
    const name = checkpoint.toLowerCase();
    const looksLikeLegacy = /(^|[^a-z0-9])(sd[_ ]?1[._-]?5|sd15|v1-5|sd_v1)/.test(name) && !name.includes('xl');
    if (looksLikeLegacy)
        return { width: 512, height: 512 };
    return { width: config.width, height: config.height };
}
