/**
 * 视频参数归一化层：把 Agent 给的松散参数，变成严格、可执行、有默认值的 `NormalizedVideoRequest`。
 *
 * 和图片的 params.ts 相比，这里多出两件 Wan 系特有的事，也是踩过坑的地方：
 *
 *   1. **帧数必须是 4n+1**。Wan 的 VAE 时间下采样率是 4，帧数不对齐时末尾几帧会糊，
 *      甚至让 `Wan22ImageToVideoLatent` 直接报 shape 错。调用方习惯按「秒」思考，
 *      所以「秒 → 帧」的换算与对齐全部收在这一层，而且**对齐过就必须写进 notes**——
 *      否则用户会疑惑「我要 2 秒，怎么出来 2.04 秒」。
 *   2. **尺寸必须是 32 的倍数**。1000x700 这种「看起来很正常」的尺寸会被 Wan 拒收
 *      或在 patch embedding 处报错，这里统一 round 到最近的 32 倍数并如实告知。
 *
 * 另一个刻意的选择：**超界一律报错，不静默夹断**。481 帧是 Wan2.2 TI2V-5B 在本机的
 * 显存上限，60 秒 @24fps 要 1441 帧，如果悄悄夹到 481，用户会拿到一段 20 秒的片子
 * 却以为是自己要的 60 秒——这是最坏的失败方式（等了半小时才发现）。所以先算「想要的帧数」，
 * 超了就抛错并说清上限，让调用方自己调小 seconds。
 */
import { argConflict } from '../errors.js';
import { isFile, planOutputFile, randomSeed, resolveUserPath, VIDEO_EXTS } from '../files.js';
import { isVideoMode } from './types.js';
/**
 * 单次生成的帧数上限。
 *
 * 481 = 4n+1 且是 Wan2.2 TI2V-5B 在 832x480 下不 OOM 的实测上限
 * （再往上 6GB 显存直接 CUDA out of memory，白等十几分钟）。
 */
export const MAX_FRAMES = 481;
/** 帧率允许范围。低于 4 看不出运动，高于 60 只会更贵。 */
const MIN_FPS = 4;
const MAX_FPS = 60;
/** 宽高允许范围（Wan 的 patch 尺寸 2x2，配合 32 倍数足够宽松）。 */
const MIN_SIZE = 64;
const MAX_SIZE = 2048;
/**
 * 兜底负向词。
 *
 * 配置里的 `videoNegativePrompt` 正常都有值，但**不能假设**：如果调用方给了一个
 * 被清空的配置，空负向词会让 Wan 出一堆糊、闪、多手的片子，而且完全不报错。
 * 所以这里再兜一层，保证 `negativePrompt.length > 0` 永远成立。
 */
const FALLBACK_NEGATIVE_PROMPT = '静态，静止，模糊，低清，噪点，过曝，闪烁，画面抖动，水印，字幕，畸形，多手多脚，比例失调';
/** img2video 没给 prompt 时的默认描述：只描述「怎么动」，不猜内容。 */
const DEFAULT_IMG2VIDEO_PROMPT = 'the subject moves naturally, steady camera';
/** 算出「想要的帧数」——**不夹断**，供超界判断用。 */
function framesWanted(seconds, fps) {
    return Math.max(5, Math.round((seconds * fps - 1) / 4) * 4 + 1);
}
/** 帧率兜底：非法 fps 不该让换算直接变成 NaN，按 24 算。 */
function safeFpsOf(fps) {
    return Number.isFinite(fps) && fps > 0 ? fps : 24;
}
/**
 * 秒数 → 帧数，并对齐到 4n+1。
 *
 * 公式：`frames = max(5, round((seconds * fps - 1) / 4) * 4 + 1)`，再夹到 `MAX_FRAMES`。
 * 举几个测试里钉死的例子：
 *   2s @24fps → 48 → 49；5s @24fps → 120 → 121；0.5s @8fps → 4 → 下限 5。
 *
 * 返回的 `actualSeconds` 是**真实时长**（frames / fps），不是调用方要的秒数——
 * 两者会差个零点几秒，元数据和结果文案都必须用真实值，否则「参数说 2 秒、片子 2.04 秒」
 * 对不上，回看时很难判断是谁错了。
 */
export function secondsToFrames(seconds, fps) {
    const safeFps = safeFpsOf(fps);
    const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 1 / safeFps;
    const frames = Math.min(MAX_FRAMES, framesWanted(safeSeconds, safeFps));
    return { frames, actualSeconds: frames / safeFps };
}
/**
 * 粗略估算一次视频生成要多久（秒）。
 *
 * 标定值：49 帧 / 30 步 / 832x480 ≈ **210 秒**（本机 6GB 显存实测，Wan2.2 TI2V-5B Q4_K_M）。
 *
 * 三个因子：
 *   - 帧数**超线性**（指数 1.6）：自注意力的计算量随 token 数超线性增长，
 *     121 帧不是 49 帧的 2.47 倍，而是约 4.2 倍；
 *   - 像素数线性；
 *   - 步数线性——**而且是严格的**线性，这一点很重要：
 *     30 步与 60 步必须满足 `est(60) === est(30) * 2`。
 *
 * 所以步数因子放在最后做乘除、**不参与 round**：如果先 round 再乘 2，
 * `round(2x)` 未必等于 `2 * round(x)`（x 带小数时必然翻车），
 * 测试里那条严格相等就会时红时绿。这里只在最后返回浮点，不做 round——
 * 这个函数对外只报量级（「约 3~4 分钟」），多几位小数没人看，但比例必须准。
 */
export function estimateSeconds(frames, steps, width, height) {
    const base = 210;
    const frameFactor = Math.pow(frames / 49, 1.6);
    const pixelFactor = (width * height) / (832 * 480);
    const per30 = base * frameFactor * pixelFactor;
    return (per30 * steps) / 30;
}
/**
 * 模式推断——只有一条规则：`input_image` 是非空字符串就是图生视频。
 *
 * 刻意不做「有 prompt 里提到图片就猜 i2v」这种聪明事：推断规则必须一眼可预测，
 * 猜错了的代价是白等十几分钟（还会用错节点图）。
 */
export function inferVideoMode(args) {
    const hasInput = typeof args.input_image === 'string' && args.input_image.trim() !== '';
    return hasInput ? 'img2video' : 'text2video';
}
/** 数值字段的统一入口：非数字就抛（消息里带字段名，方便 Agent 自己改）。 */
function requireNumber(value, name) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw argConflict(`${name} 必须是数字，收到的是 ${JSON.stringify(value)}。`, `${name} 请传纯数字（不要带单位、不要加引号），例如 ${name === 'width' || name === 'height' ? 832 : 2}。`);
    }
    return value;
}
/** 尺寸对齐到 32 的倍数，变了就如实说。 */
function alignTo32(value, notes, label) {
    if (value < MIN_SIZE || value > MAX_SIZE) {
        throw argConflict(`${label} 必须在 ${MIN_SIZE}~${MAX_SIZE} 之间，收到 ${value}。`);
    }
    const aligned = Math.round(value / 32) * 32;
    if (aligned !== value) {
        notes.push(`${label} 已从 ${value} 对齐到 32 的倍数：${aligned}（视频模型要求）`);
    }
    return aligned;
}
/**
 * 主入口：把 Agent 给的松散参数，变成严格、可执行、有默认值的请求。
 *
 * @throws ImagePluginError 模式不认识 / 参数冲突 / 超界 / 输入图不存在时抛出。
 */
export function normalizeVideoRequest(args, options) {
    const { cwd, config } = options;
    const notes = [];
    const trimmed = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
    // ── 1. 定模式：显式给了就必须合法，没给才推断 ─────────────────
    const explicit = args.mode;
    if (explicit !== undefined && !isVideoMode(explicit)) {
        throw argConflict(`不认识的视频 mode：${JSON.stringify(explicit)}`, 'V1 只支持 text2video（文生视频）与 img2video（图生视频）两种；不传则按有没有 input_image 自动推断。');
    }
    const modeInferred = explicit === undefined;
    const mode = explicit ?? inferVideoMode(args);
    // ── 2. 首帧：先 resolve 成绝对路径，再查存在性 ────────────────
    const rawInput = trimmed(args.input_image);
    const inputImage = rawInput !== '' ? resolveUserPath(rawInput, cwd) : undefined;
    if (mode === 'text2video' && inputImage !== undefined) {
        throw argConflict(`mode=text2video 不接受 input_image（收到 ${inputImage}）。`, '想拿这张图当首帧，请显式传 mode="img2video"；如果你要的就是纯文生视频，就不要传 input_image。');
    }
    if (mode === 'img2video' && inputImage === undefined) {
        throw argConflict('mode=img2video 需要 input_image，但没收到。', '请传 input_image="图片路径"（绝对路径，或相对当前工作目录）。');
    }
    if (inputImage !== undefined && !isFile(inputImage)) {
        throw argConflict(`input_image 指向的文件不存在：${inputImage}`, '请检查路径是否正确。');
    }
    // ── 3. 提示词 ────────────────────────────────────────────────
    const promptRaw = trimmed(args.prompt);
    if (mode === 'text2video' && promptRaw === '') {
        throw argConflict('mode=text2video 需要 prompt，但没收到。', '请用中文或英文描述画面与动作，例如 prompt="雨夜东京街头，长发女子缓缓回头，镜头缓慢推近"。');
    }
    if (mode === 'img2video' && promptRaw === '') {
        notes.push('没给 prompt：图生视频只描述「怎么动」即可，这里用了默认的「自然运动 + 稳定镜头」。');
    }
    const prompt = promptRaw !== '' ? promptRaw : DEFAULT_IMG2VIDEO_PROMPT;
    const negativeRaw = trimmed(args.negative_prompt);
    const negativePrompt = negativeRaw !== '' ? negativeRaw : trimmed(config.videoNegativePrompt) || FALLBACK_NEGATIVE_PROMPT;
    // ── 4. 尺寸：配置兜底 → 对齐 32 倍数 ─────────────────────────
    const widthArg = requireNumber(args.width, 'width');
    const heightArg = requireNumber(args.height, 'height');
    const width = alignTo32(Math.round(widthArg ?? config.videoWidth), notes, 'width');
    const height = alignTo32(Math.round(heightArg ?? config.videoHeight), notes, 'height');
    // ── 5. 时长 → 帧数：先判超界，再对齐 4n+1 ────────────────────
    const fpsRaw = requireNumber(args.fps, 'fps') ?? config.videoFps;
    const fps = Math.round(fpsRaw);
    if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) {
        throw argConflict(`fps 必须在 ${MIN_FPS}~${MAX_FPS} 之间，收到 ${JSON.stringify(args.fps)}。`, '24 是最通用的选择；想要「更电影感」可以 30，但帧数会同比变多、耗时线性上涨。');
    }
    const secondsRaw = requireNumber(args.seconds, 'seconds') ?? config.videoSeconds;
    if (!(secondsRaw > 0)) {
        throw argConflict(`seconds 必须大于 0，收到 ${JSON.stringify(args.seconds)}。`, '最短按 0.25 秒算（5 帧）。');
    }
    const seconds = secondsRaw;
    const wanted = framesWanted(seconds, fps);
    if (wanted > MAX_FRAMES) {
        throw argConflict(`视频太长：${seconds} 秒 @ ${fps} fps 需要 ${wanted} 帧，超过上限 ${MAX_FRAMES} 帧。`, `把 seconds 调小（${fps} fps 下 ${MAX_FRAMES} 帧约 ${(MAX_FRAMES / fps).toFixed(1)} 秒），` +
            '或把 fps 调低。Wan2.2 TI2V-5B 单次最多 481 帧，再长会 OOM。');
    }
    const { frames, actualSeconds } = secondsToFrames(seconds, fps);
    if (Math.abs(frames - seconds * fps) > 1e-9) {
        notes.push(`帧数已对齐到 4n+1：${seconds} 秒 @ ${fps} fps 约 ${Math.round(seconds * fps)} 帧 → ${frames} 帧` +
            `（真实时长 ${actualSeconds.toFixed(2)} 秒；Wan 的 VAE 时间下采样率是 4，不对齐末尾会糊）`);
    }
    // ── 6. 采样参数：显式 > 配置 > 预设默认 ──────────────────────
    const stepsRaw = requireNumber(args.steps, 'steps') ?? config.videoSteps;
    const steps = Math.round(stepsRaw);
    if (!Number.isFinite(steps) || steps < 1 || steps > 500) {
        throw argConflict(`steps 必须在 1~500 之间，收到 ${JSON.stringify(args.steps)}。`);
    }
    const cfgScale = requireNumber(args.cfg_scale, 'cfg_scale') ?? config.videoCfgScale;
    if (cfgScale < 0 || cfgScale > 100) {
        throw argConflict(`cfg_scale 必须在 0~100 之间，收到 ${cfgScale}。`);
    }
    const shift = requireNumber(args.shift, 'shift') ?? config.videoShift;
    if (shift < 0 || shift > 100) {
        throw argConflict(`shift 必须在 0~100 之间，收到 ${shift}。`);
    }
    const seedRaw = requireNumber(args.seed, 'seed');
    const seed = seedRaw !== undefined ? Math.round(seedRaw) : randomSeed();
    // 采样器与调度器**不开放给 Agent**：Wan 系对这两项很敏感，换错就出一堆糊片，
    // 所以只从配置取（GenerateVideoArgs 里也没有这两个键，别在这里读 args）。
    const samplerName = config.videoSamplerName;
    const scheduler = config.videoScheduler;
    const unet = trimmed(args.model);
    // ── 7. 输出位置：带 .mp4 当文件，否则当目录（绝不覆盖）───────
    const outputHint = trimmed(args.output_path);
    const planned = planOutputFile(outputHint !== '' ? outputHint : undefined, cwd, '.mp4', VIDEO_EXTS);
    const extra = args.extra_options && typeof args.extra_options === 'object' && !Array.isArray(args.extra_options)
        ? args.extra_options
        : {};
    const request = {
        mode,
        prompt,
        negativePrompt,
        width,
        height,
        frames,
        seconds,
        actualSeconds,
        fps,
        seed,
        steps,
        cfgScale,
        shift,
        samplerName,
        scheduler,
        unet,
        outputPath: planned.filePath,
        notes,
        extra
    };
    if (inputImage !== undefined)
        request.inputImage = inputImage;
    if (modeInferred) {
        notes.unshift(`模式未指定，按输入推断为 ${mode === 'img2video' ? '图生视频' : '文生视频'}。`);
    }
    return { request, modeInferred };
}
