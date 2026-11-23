/**
 * 归一化 + 校验（纯函数，不碰网络/文件系统，便于离线单测）。
 *
 * 这一层只做三件事：
 *   1. 把参数填成确定值（默认值来自配置）；
 *   2. 把互相冲突的组合**直接拒绝**，不猜（猜错要等 15 分钟才发现）；
 *   3. 把「时长」换算成 Wan2.2 唯一接受的帧数公式 4n+1。
 */
import { argConflict } from '../errors.js';
import { secondsToFrames, MAX_FRAMES } from '../video/params.js';
import { INDEXTTS_EMO_ORDER, isIndexTtsLang, isTalkingMode, isTtsEngine } from './types.js';
/** 台词上限：再长就不是「一句话出片」，而是长视频工程了。 */
export const MAX_SCRIPT_CHARS = 600;
/** 视频时长上限（秒）：121 帧约 14 分钟，再长就不该在对话里等。 */
export const MAX_TALKING_SECONDS = 20;
/**
 * 按输入猜模式：给了视频 → 直接对口型；给了图 → 图生视频再对口型；都没有 → 从文字造人像。
 */
export function inferTalkingMode(args) {
    if (typeof args.input_video === 'string' && args.input_video.trim() !== '')
        return 'video2talking';
    if (typeof args.input_image === 'string' && args.input_image.trim() !== '')
        return 'image2talking';
    return 'text2talking';
}
/**
 * 把「秒」换成合法帧数：Wan 系要求帧数 4n+1（VAE 时间下采样率 4），
 * 且语音略长于画面时尾巴会被补静止帧，所以宁可多一帧也别少。
 * 返回值同时给出实际秒数，回写进结果里，避免用户对不上账。
 */
export function framesForSeconds(seconds, fps) {
    const notes = [];
    const clamped = Math.min(Math.max(seconds, 0.25), MAX_TALKING_SECONDS);
    if (clamped !== seconds) {
        notes.push(`时长已夹到 ${clamped} 秒（允许范围 0.25~${MAX_TALKING_SECONDS}）。`);
    }
    const planned = secondsToFrames(clamped, fps);
    if (planned.frames > MAX_FRAMES) {
        throw argConflict(`按 ${fps}fps 算出 ${planned.frames} 帧，超过上限 ${MAX_FRAMES} 帧。`, `把 seconds 降到 ${Math.floor((MAX_FRAMES - 1) / fps)} 秒以内，或把 fps 降到 ${Math.floor((MAX_FRAMES - 1) / clamped)} 以下。`);
    }
    return { frames: planned.frames, seconds: planned.actualSeconds, notes };
}
/**
 * 自动分级分辨率：帧数越多，端到端 InfiniteTalk 耗时超线性上涨。
 * 本机 6GB 显存实测：832x480 下 41 帧≈7 分钟、77 帧≈卡死近 2 小时、121 帧≈超时 2 小时；
 * 降到 512x320 后 77 帧≈3 分钟、121 帧≈12.5 分钟都能出片，口型清晰度无损。
 * 因此短台词（≤60 帧）保持 832x480 高清；长台词（>60 帧）自动降到 512x320 保出片。
 * 用户显式传了 width 或 height 时完全尊重，不自动改。
 */
export const TALKING_HD_MAX_FRAMES = 60;
export const TALKING_HD_SIZE = { width: 832, height: 480 };
export const TALKING_LOWRES_SIZE = { width: 512, height: 320 };
export function autoResolutionForFrames(frames, current, explicit) {
    // 显式指定任一维 → 完全尊重（另一维已在 normalizeTalkingRequest 对齐）
    if (explicit.width !== undefined || explicit.height !== undefined) {
        return { width: current.width, height: current.height };
    }
    if (frames > TALKING_HD_MAX_FRAMES) {
        return {
            width: TALKING_LOWRES_SIZE.width,
            height: TALKING_LOWRES_SIZE.height,
            note: `台词较长（${frames} 帧），分辨率自动从 ${current.width}x${current.height} 降到 512x320 以保证按时出片；想用高清请显式传 width/height。`
        };
    }
    return { width: current.width, height: current.height };
}
/**
 * 校验并规整 IndexTTS 的 8 维情绪向量。
 *
 * 顺序固定为 happy/angry/sad/afraid/disgusted/melancholic/surprised/calm，
 * 每一维 0~1；全 0 等价于「不带情绪」，这时直接丢掉不传，让模型自己判断语气。
 */
export function normalizeEmoVector(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value)) {
        throw argConflict(`emo_vector 必须是 8 个 0~1 的数字组成的数组，收到 ${JSON.stringify(value)}。`, `顺序固定：${INDEXTTS_EMO_ORDER.join(' / ')}。`);
    }
    if (value.length !== INDEXTTS_EMO_ORDER.length) {
        throw argConflict(`emo_vector 必须是 ${INDEXTTS_EMO_ORDER.length} 维，收到 ${value.length} 维。`, `顺序固定：${INDEXTTS_EMO_ORDER.join(' / ')}。`);
    }
    const vector = value.map((item, index) => {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) {
            throw argConflict(`emo_vector 第 ${index + 1} 维（${INDEXTTS_EMO_ORDER[index]}）必须是 0~1 的数字，收到 ${JSON.stringify(item)}。`);
        }
        return item;
    });
    return vector.every((item) => item === 0) ? undefined : vector;
}
/** 情绪强度 emo_alpha：0~1，越大越像 emo_vector 描述的情绪。 */
function pickEmoAlpha(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw argConflict(`emo_alpha 必须是 0~1 的数字，收到 ${JSON.stringify(value)}。`, '例如 0.8 表示八成按指定情绪说。');
    }
    return value;
}
/** 时长系数 duration_factor：>0，1 是原速。 */
function pickDurationFactor(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 3) {
        throw argConflict(`duration_factor 必须是 (0, 3] 的数字，收到 ${JSON.stringify(value)}。`, '1 是原速；1.2 会明显更慢更长。');
    }
    return value;
}
/** 归一化。所有冲突在这里抛错，且错误带「怎么办」的 hint。 */
export function normalizeTalkingRequest(args, config) {
    const notes = [];
    // ── 模式 ──────────────────────────────────────────────────────────────
    const inferred = args.mode === undefined || args.mode === null;
    let mode;
    if (inferred) {
        mode = inferTalkingMode(args);
        notes.push(`模式未指定，按输入推断为 ${mode}。`);
    }
    else if (isTalkingMode(args.mode)) {
        mode = args.mode;
    }
    else {
        throw argConflict(`不认识的 mode：${JSON.stringify(args.mode)}。`, '只能是 text2talking / image2talking / video2talking。');
    }
    // 冲突检查：显式指定模式时不允许「货不对板」，否则必然是用户/模型传错了。
    if (mode === 'video2talking' && (args.input_video === undefined || args.input_video === '')) {
        throw argConflict('mode=video2talking 需要 input_video（要改口型的那段视频）。', '只给图请用 image2talking；什么都没有用 text2talking。');
    }
    if (mode === 'image2talking' && (args.input_image === undefined || args.input_image === '')) {
        throw argConflict('mode=image2talking 需要 input_image（作为首帧的人像图）。', '没有图就用 text2talking，会先造一张正面人像。');
    }
    if (mode === 'text2talking' && args.input_video) {
        throw argConflict('mode=text2talking 不接受 input_video。', '要对已有视频改口型，请用 video2talking。');
    }
    // ── 台词 ──────────────────────────────────────────────────────────────
    const script = typeof args.script === 'string' ? args.script.trim() : '';
    if (script === '') {
        throw argConflict('script 不能为空：这个工具必须有台词才能合成语音。', '例如 script="大家好，今天聊个小事。"；只要画面不要声音请用 generate_video。');
    }
    if (script.length > MAX_SCRIPT_CHARS) {
        throw argConflict(`script 有 ${script.length} 字，超过 ${MAX_SCRIPT_CHARS} 字上限。`, '口型链路按秒计费（1 秒 ≈ 2.8 分钟），一次说太长时间上不划算；请拆成多段分别生成再拼接。');
    }
    // ── TTS ───────────────────────────────────────────────────────────────
    // 配置里这些键是字符串（配置文件手写可能写错），这里做一次收口：
    // 认不出来就回落到安全默认值，而不是把非法值透传给 CLI。
    let tts = isTtsEngine(config.ttsEngine) ? config.ttsEngine : 'indextts';
    if (args.tts !== undefined && args.tts !== null) {
        if (!isTtsEngine(args.tts))
            throw argConflict(`不认识的 tts：${JSON.stringify(args.tts)}。`, '只能是 indextts 或 edge。');
        tts = args.tts;
    }
    const edgeVoice = typeof args.edge_voice === 'string' && args.edge_voice.trim() !== '' ? args.edge_voice.trim() : config.edgeVoice;
    const rate = typeof args.rate === 'string' && args.rate.trim() !== '' ? args.rate.trim() : config.edgeRate;
    // ── IndexTTS：音色来自参考音频，情绪来自 emo_vector / emo_audio_prompt ──
    const spkAudioPrompt = typeof args.spk_audio_prompt === 'string' && args.spk_audio_prompt.trim() !== ''
        ? args.spk_audio_prompt.trim()
        : config.ttsSpkAudioPrompt;
    const emoVector = normalizeEmoVector(args.emo_vector);
    const emoAlpha = pickEmoAlpha(args.emo_alpha);
    const emoAudioPrompt = typeof args.emo_audio_prompt === 'string' && args.emo_audio_prompt.trim() !== ''
        ? args.emo_audio_prompt.trim()
        : undefined;
    const durationFactor = pickDurationFactor(args.duration_factor);
    let lang = 'ZH';
    if (args.lang !== undefined && args.lang !== null) {
        if (!isIndexTtsLang(args.lang)) {
            throw argConflict(`不认识的 lang：${JSON.stringify(args.lang)}。`, 'IndexTTS 只支持 ZH / EN。');
        }
        lang = args.lang;
    }
    if (tts === 'indextts') {
        if (spkAudioPrompt.trim() === '') {
            throw argConflict('tts=indextts 需要 spk_audio_prompt（一段 3~15 秒的参考音频）：IndexTTS 的音色完全由它决定。', '要么在参数里传 spk_audio_prompt，要么在配置里设 ttsSpkAudioPrompt；不想克隆音色就用 tts=edge。');
        }
        if (emoVector && emoAudioPrompt) {
            throw argConflict('emo_vector 与 emo_audio_prompt 只能二选一。', 'emo_vector 是手工指定 8 维情绪；emo_audio_prompt 是拿另一段音频的情绪来模仿。');
        }
        if (emoAlpha !== undefined && !emoVector && !emoAudioPrompt) {
            notes.push('给了 emo_alpha 但没给 emo_vector / emo_audio_prompt，情绪强度无处施加，已忽略。');
        }
    }
    else if (args.spk_audio_prompt || args.emo_vector || args.emo_alpha !== undefined || args.emo_audio_prompt) {
        notes.push('tts=edge 时 spk_audio_prompt / emo_vector / emo_alpha / emo_audio_prompt 不生效（那是 IndexTTS 的参数）。');
    }
    // ── 画面 ──────────────────────────────────────────────────────────────
    const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim() : '';
    const negativePrompt = typeof args.negative_prompt === 'string' && args.negative_prompt.trim() !== '' ? args.negative_prompt.trim() : undefined;
    const fps = Math.round(args.fps ?? config.videoFps);
    if (!Number.isFinite(fps) || fps < 4 || fps > 60) {
        throw argConflict(`fps 必须在 4~60 之间，收到 ${JSON.stringify(args.fps)}。`);
    }
    const align = (value, fallback, field) => {
        const raw = value ?? fallback;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 64 || raw > 2048) {
            throw argConflict(`${field} 必须是 64~2048 的数字，收到 ${JSON.stringify(value)}。`);
        }
        const aligned = Math.round(raw / 32) * 32;
        if (aligned !== raw)
            notes.push(`${field} ${raw} 已对齐到 32 的倍数 ${aligned}（视频模型要求）。`);
        return aligned;
    };
    const width = align(args.width, config.videoWidth, 'width');
    const height = align(args.height, config.videoHeight, 'height');
    let seconds;
    if (args.seconds !== undefined && args.seconds !== null) {
        if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds)) {
            throw argConflict(`seconds 必须是数字，收到 ${JSON.stringify(args.seconds)}。`);
        }
        if (args.seconds <= 0)
            throw argConflict('seconds 必须大于 0。');
        seconds = args.seconds;
    }
    const seed = typeof args.seed === 'number' && Number.isInteger(args.seed) && args.seed >= 0 ? args.seed : Math.floor(Math.random() * 2 ** 31);
    const outputPath = typeof args.output_path === 'string' && args.output_path.trim() !== '' ? args.output_path.trim() : undefined;
    return {
        mode,
        modeInferred: inferred,
        script,
        tts,
        spkAudioPrompt,
        ...(emoVector ? { emoVector } : {}),
        ...(emoAlpha !== undefined ? { emoAlpha } : {}),
        ...(emoAudioPrompt ? { emoAudioPrompt } : {}),
        lang,
        ...(durationFactor !== undefined ? { durationFactor } : {}),
        edgeVoice,
        rate,
        inputImage: mode === 'image2talking' || mode === 'text2talking' ? args.input_image : undefined,
        inputVideo: mode === 'video2talking' ? args.input_video : undefined,
        prompt,
        negativePrompt,
        seconds,
        fps,
        width,
        height,
        seed,
        outputPath,
        notes
    };
}
/** 音色的对外显示名（结果与元数据里都用它，便于复现）。 */
export function voiceLabelOf(request) {
    if (request.tts === 'edge')
        return `edge-tts · ${request.edgeVoice} · ${request.rate}`;
    const parts = [`IndexTTS-2 克隆音色 · ${request.spkAudioPrompt}`];
    if (request.emoVector) {
        const named = request.emoVector
            .map((weight, index) => ({ name: INDEXTTS_EMO_ORDER[index], weight }))
            .filter((item) => item.weight > 0)
            .map((item) => `${item.name} ${item.weight}`);
        if (named.length > 0)
            parts.push(`情绪 ${named.join(' / ')}`);
    }
    else if (request.emoAudioPrompt) {
        parts.push(`情绪取自 ${request.emoAudioPrompt}`);
    }
    if (request.emoAlpha !== undefined)
        parts.push(`emo_alpha ${request.emoAlpha}`);
    if (request.lang !== 'ZH')
        parts.push(`lang ${request.lang}`);
    return parts.join(' · ');
}
