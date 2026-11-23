/**
 * 「说话视频」编排器（InfiniteTalk 端到端音频驱动口型版）。
 *
 * 链路顺序：
 *   台词 → 语音(TTS) → 首帧图片 → InfiniteTalk(静帧 + 音频 → 带口型视频) → 成片
 *
 * 与旧的 MuseTalk 方案的本质区别：
 *   旧方案是「先生成无声视频 → 256px 嘴部区域重建再贴回」，嘴部边缘有贴片感/模糊；
 *   新方案是端到端生成，嘴随画面一起出来，没有局部贴回，边缘自然清晰。
 *   因此旧链路里的 makeBaseVideo（无声视频）这一步被砍掉，直接拿首帧喂 InfiniteTalk。
 *
 * 每个阶段都有「必须存在产物」的检查点，因为 TTS / ComfyUI 都可能「零退出但没产出」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImagePluginError } from '../errors.js';
import { ensureDir, humanBytes, isFile, planOutputFile, resolveUserPath, timestampSlug, VIDEO_EXTS } from '../files.js';
import { logDebug } from '../log.js';
import { runGeneration } from '../runner.js';
import { ComfyUIClient, describeHistoryError } from '../comfy/client.js';
import { pickVideoRef, reconcileWorkflow } from '../video/runner.js';
import { lastMeaningfulLine, runProcess } from './exec.js';
import { buildInfiniteTalkWorkflow, INFINITETALK_MODELS } from './lipsync.js';
import { autoResolutionForFrames, framesForSeconds, normalizeTalkingRequest, voiceLabelOf } from './params.js';
import { edgeTtsPlan, indexttsTtsPlan, normalizeWavPlan, parseDuration, parseSize, probeDurationPlan, probeSizePlan, punctuateScript } from './tts.js';
/** 文字模式下先造一张「正脸对着镜头」的人像。写死的角度约束是口型链路的命门。 */
export const DEFAULT_PORTRAIT_PROMPT = 'close-up portrait photo, a young Chinese woman facing the camera directly, looking at the viewer, ' +
    'mouth slightly open as if speaking, soft even lighting, plain neutral background, 50mm lens, sharp focus';
/** InfiniteTalk 的场景提示词：只让它自然说话，不换场景。 */
export const DEFAULT_SPEAKING_PROMPT = 'the person speaks to the camera, lips and jaw moving naturally, subtle head movement, ' +
    'steady camera, locked framing, same background, no scene change';
function makeWorkDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-talking-${timestampSlug()}-`));
}
/** 取目录里最新的 .wav（仅调试用）。 */
export function newestWav(dir) {
    if (!fs.existsSync(dir))
        return undefined;
    const candidates = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.wav'))
        .map((name) => {
        const full = path.join(dir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
    })
        .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.full;
}
function assertExit(result, what, hint) {
    if (result.code === 0)
        return;
    throw new ImagePluginError(`${what}失败（退出码 ${result.code ?? 'null'}）：${lastMeaningfulLine(result.stderr, '没有输出')}`, hint);
}
/** ① 语音：按配置选引擎，统一归一到 16k 单声道 wav，并量出真实时长。 */
async function synthSpeech(request, config, workDir, signal, deps) {
    const notes = [];
    const text = punctuateScript(request.script);
    const rawDir = path.join(workDir, 'tts');
    ensureDir(rawDir);
    let rawFile;
    if (request.tts === 'indextts') {
        const outWav = path.join(rawDir, 'indextts.wav');
        const plan = indexttsTtsPlan({
            python: config.indexttsPython,
            indexttsDir: config.indexttsDir,
            spkAudioPrompt: request.spkAudioPrompt,
            text,
            outFile: outWav,
            lang: request.lang,
            ...(request.emoVector ? { emoVector: request.emoVector } : {}),
            ...(request.emoAlpha !== undefined ? { emoAlpha: request.emoAlpha } : {}),
            ...(request.emoAudioPrompt ? { emoAudioPrompt: request.emoAudioPrompt } : {}),
            ...(request.durationFactor !== undefined ? { durationFactor: request.durationFactor } : {}),
            device: 'cuda:0'
        });
        logDebug('IndexTTS 合成语音', { cwd: plan.cwd, text, spkAudioPrompt: request.spkAudioPrompt });
        const result = await runProcess({ ...plan, timeoutMs: Math.min(config.talkingTimeoutMs, 15 * 60 * 1000), ...(signal ? { signal } : {}) }, deps.spawn ? { spawn: deps.spawn } : {});
        assertExit(result, 'IndexTTS 合成语音', `检查 indexttsPython 是否存在（当前 ${config.indexttsPython}）、indexttsDir 是否是 IndexTTS 仓库根（当前 ${config.indexttsDir}）、参考音频是否存在（当前 ${request.spkAudioPrompt}）。`);
        if (!isFile(outWav)) {
            throw new ImagePluginError('IndexTTS 正常退出但没有产出 wav。', `去看 ${rawDir} 里有没有文件；常见原因是参考音频太短/太吵，或 checkpoints 没下全。`);
        }
        rawFile = outWav;
    }
    else {
        const mp3 = path.join(rawDir, 'edge.mp3');
        // edge-tts 已迁到 IndexTTS 的 venv（MuseTalk 整体删除后不再有 musetalkPython）。
        const plan = edgeTtsPlan({ python: config.indexttsPython, text, voice: request.edgeVoice, rate: request.rate, outFile: mp3 });
        const result = await runProcess({ ...plan, timeoutMs: Math.min(config.talkingTimeoutMs, 5 * 60 * 1000), ...(signal ? { signal } : {}) }, deps.spawn ? { spawn: deps.spawn } : {});
        assertExit(result, 'edge-tts 合成语音', `edge-tts 装在 indexttsPython（当前 ${config.indexttsPython}）里；没装就跑 venv\\Scripts\\python.exe -m pip install edge-tts。`);
        if (!isFile(mp3)) {
            throw new ImagePluginError('edge-tts 正常退出但没有产出文件。', `检查 ${mp3} 是否可写；网络不通时 edge-tts 会静默失败。`);
        }
        rawFile = mp3;
    }
    // InfiniteTalk 的 wav2vec2 音频编码器按 16k 采样，喂 44.1k 会让口型对不齐。
    const wavPath = path.join(workDir, 'speech16k.wav');
    const normalize = await runProcess({ ...normalizeWavPlan(config.ffmpeg, rawFile, wavPath), timeoutMs: 120_000, ...(signal ? { signal } : {}) }, deps.spawn ? { spawn: deps.spawn } : {});
    assertExit(normalize, 'ffmpeg 转换语音格式', '检查 ffmpegBin 配置（当前 ' + config.ffmpegBin + '）是否含 ffmpeg.exe。');
    if (!isFile(wavPath))
        throw new ImagePluginError('ffmpeg 没有产出 16k wav。', '语音源文件可能已损坏，删掉重跑一次。');
    const probe = await runProcess({ ...probeDurationPlan(config.ffprobe, wavPath), timeoutMs: 60_000, ...(signal ? { signal } : {}) }, deps.spawn ? { spawn: deps.spawn } : {});
    const seconds = parseDuration(probe.stdout);
    if (!seconds) {
        throw new ImagePluginError('量不出语音时长。', 'ffprobe 可能不在 ffmpegBin 目录里（需要 ffmpeg.exe 与 ffprobe.exe 两个）。');
    }
    logDebug(`语音 ${seconds.toFixed(2)} 秒（${humanBytes(fs.statSync(wavPath).size)}）`);
    notes.push(`语音 ${seconds.toFixed(2)} 秒，音色 ${voiceLabelOf(request)}。`);
    return { wavPath, seconds, notes };
}
/** ② 首帧：拿到一张「对着镜头说话」的图片，直接喂 InfiniteTalk。 */
async function makeFirstFrame(request, config, workDir, signal, deps) {
    const notes = [];
    if (request.mode === 'video2talking') {
        // 老用户可能传视频。InfiniteTalk I2V 只吃静帧，这里抽第一帧；
        // 原视频的动态会丢失（嘴型由 InfiniteTalk 重新端到端生成），在 notes 里说清楚。
        const source = resolveUserPath(request.inputVideo ?? '', os.homedir());
        if (!isFile(source)) {
            throw new ImagePluginError(`找不到 input_video：${request.inputVideo}`, '传绝对路径或相对当前工作目录的路径，且文件必须存在。');
        }
        const framePath = path.join(workDir, 'keyframe.png');
        const args = [
            '-y',
            '-v',
            'error',
            '-i',
            source,
            '-frames:v',
            '1',
            '-vf',
            `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2`,
            framePath
        ];
        const result = await runProcess({ command: config.ffmpeg, args, timeoutMs: 120_000, ...(signal ? { signal } : {}) }, deps.spawn ? { spawn: deps.spawn } : {});
        assertExit(result, '从视频抽取首帧', '检查 ffmpegBin 配置（当前 ' + config.ffmpegBin + '）是否含 ffmpeg.exe。');
        if (!isFile(framePath)) {
            throw new ImagePluginError('抽帧没有产出图片。', '源视频可能没有可解码的帧，换一个视频试试。');
        }
        notes.push('已从源视频抽取首帧；口型由 InfiniteTalk 端到端重新生成（源视频原有动作不会保留）。');
        return { imagePath: framePath, baseVideoPath: source, notes };
    }
    if (request.mode === 'image2talking') {
        const imagePath = resolveUserPath(request.inputImage ?? '', os.homedir());
        if (!isFile(imagePath)) {
            throw new ImagePluginError(`找不到 input_image：${request.inputImage}`, '图生口型需要一张真实存在的图片；没有图请用 text2talking。');
        }
        return { imagePath, notes };
    }
    // text2talking：先出一张正脸人像当首帧
    const prompt = request.prompt === '' ? DEFAULT_PORTRAIT_PROMPT : `${DEFAULT_PORTRAIT_PROMPT}, ${request.prompt}`;
    const imageArgs = {
        mode: 'text2img',
        prompt,
        width: request.width,
        height: request.height,
        seed: request.seed,
        output_path: path.join(workDir, 'keyframe.png')
    };
    const runImage = deps.runImage ?? runGeneration;
    const image = await runImage({ args: imageArgs, cwd: workDir, config, ...(signal ? { signal } : {}) });
    const imagePath = image.outputPaths[0];
    if (!imagePath || !isFile(imagePath)) {
        throw new ImagePluginError('文字模式的关键帧没有生成成功。', '先确认 ComfyUI 在跑、SDXL 底模可用。');
    }
    notes.push('已用文生图造了一张正脸人像作为首帧。');
    return { imagePath, notes };
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted)
        return reject(new ImagePluginError('已取消：调用方中止了本次生成。'));
    const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        reject(new ImagePluginError('已取消：调用方中止了本次生成。'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
});
function guessMime(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.png')
        return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg')
        return 'image/jpeg';
    if (ext === '.webp')
        return 'image/webp';
    if (ext === '.wav')
        return 'audio/wav';
    return 'application/octet-stream';
}
/** ③ InfiniteTalk：首帧 + 音频 → ComfyUI 端到端生成带口型视频。 */
async function runInfiniteTalk(firstFrame, audioWav, frames, slug, workDir, request, config, signal, deps) {
    const notes = [];
    const client = deps.client ?? new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
    await client.systemStats(signal);
    // 先上传，再取 object_info（60s 缓存会让刚上传的文件名被误判非法，见 video/runner.ts 注释）。
    const imageUpload = await client.uploadImage({ filename: path.basename(firstFrame), bytes: fs.readFileSync(firstFrame), mime: guessMime(firstFrame), overwrite: true }, signal);
    const audioUpload = await client.uploadImage({ filename: `${slug}_audio.wav`, bytes: fs.readFileSync(audioWav), mime: 'audio/wav', overwrite: true }, signal);
    logDebug('已上传 InfiniteTalk 素材', { image: imageUpload.name, audio: audioUpload.name });
    const built = buildInfiniteTalkWorkflow({
        imageName: imageUpload.name,
        audioName: audioUpload.name,
        frames,
        fps: request.fps,
        width: request.width,
        height: request.height,
        seed: request.seed,
        filenamePrefix: slug,
        ...(request.prompt ? { prompt: `${DEFAULT_SPEAKING_PROMPT}, ${request.prompt}` } : {})
    });
    const workflow = reconcileWorkflow(built, await client.objectInfo(signal, 0));
    const clientId = `dsh-comfyui-talking-${Date.now().toString(36)}`;
    const { promptId } = await client.queuePrompt(workflow, clientId, signal);
    logDebug('InfiniteTalk 任务已提交', { promptId, frames, timeoutMs: config.talkingTimeoutMs });
    const deadline = Date.now() + config.talkingTimeoutMs;
    let entry;
    for (;;) {
        if (signal?.aborted) {
            throw new ImagePluginError('已取消：调用方中止了本次生成。', 'ComfyUI 那边的任务可能还在跑完。');
        }
        if (Date.now() > deadline) {
            await client.interrupt(signal);
            throw new ImagePluginError(`等待 InfiniteTalk 生成超时（等了 ${Math.round(config.talkingTimeoutMs / 1000)} 秒，prompt_id=${promptId}）。`, '已尝试取消该任务。InfiniteTalk 很慢（81 帧 / 4 步在 6GB 显存上约 21 分钟），可以在配置里调大 talkingTimeoutMs，或把 seconds 调小。');
        }
        entry = await client.historyEntry(promptId, signal);
        if (entry)
            break;
        await sleep(config.pollIntervalMs, signal);
    }
    const statusStr = entry.status?.status_str;
    if (statusStr === 'error' || statusStr === 'cancelled') {
        throw describeHistoryError(entry, promptId);
    }
    // VHS_VideoCombine 是节点 14，优先从它取；找不到再扫其它输出节点。
    const comfyRef = pickVideoRef(entry, '14');
    if (!comfyRef) {
        throw new ImagePluginError(`ComfyUI 报告任务已结束（状态 ${statusStr ?? '未知'}），但没有产出视频文件（prompt_id=${promptId}）。`, `常见原因：InfiniteTalk 模型没装齐，或显存不足。打开 ${config.baseUrl} 在队列里找到这个 prompt_id 看节点图。`);
    }
    const bytes = await client.viewImage(comfyRef, signal);
    if (bytes.length === 0) {
        throw new ImagePluginError(`下载到的视频是 0 字节（${comfyRef.filename}）。`, 'ComfyUI 那边可能刚写完文件就被读了，重跑一次通常就好；也可以去 ComfyUI 的 output 目录里直接拿。');
    }
    const outputPath = path.join(workDir, 'infinitetalk.mp4');
    fs.writeFileSync(outputPath, bytes);
    notes.push(`InfiniteTalk 端到端生成完成（${humanBytes(bytes.length)}，${frames} 帧）——无局部贴回，口型边缘自然。`);
    return { outputPath, promptId, workflow, notes };
}
export async function runTalkingGeneration(options) {
    const startedAt = Date.now();
    const { config } = options;
    const deps = options.deps ?? {};
    const request = normalizeTalkingRequest(options.args, config);
    const notes = [...request.notes];
    const slug = `dsh_talk_${timestampSlug()}`;
    const workDir = makeWorkDir();
    try {
        // ① 语音
        const speech = await synthSpeech(request, config, workDir, options.signal, deps);
        notes.push(...speech.notes);
        // ② 帧数（由语音时长决定，先留 0.3 秒余量）
        const planned = framesForSeconds(Math.min(speech.seconds + 0.3, 20), request.fps);
        notes.push(...planned.notes);
        // 自动分级分辨率：帧数多时降到 512x320 才不会在本机 6GB 上超时。
        // 必须在首帧之前决定——首帧缩放与 InfiniteTalk 采样都用 request 的宽高。
        const tier = autoResolutionForFrames(planned.frames, { width: request.width, height: request.height }, { width: options.args.width, height: options.args.height });
        request.width = tier.width;
        request.height = tier.height;
        if (tier.note)
            notes.push(tier.note);
        // 首帧
        const first = await makeFirstFrame(request, config, workDir, options.signal, deps);
        notes.push(...first.notes);
        // ③ InfiniteTalk 端到端口型
        const lip = await runInfiniteTalk(first.imagePath, speech.wavPath, planned.frames, slug, workDir, request, config, options.signal, deps);
        notes.push(...lip.notes);
        // ④ 落盘（最终成片由用户指定位置）
        const target = planOutputFile(request.outputPath, options.cwd, '.mp4', VIDEO_EXTS);
        ensureDir(path.dirname(target.filePath));
        fs.copyFileSync(lip.outputPath, target.filePath);
        const size = fs.statSync(target.filePath).size;
        logDebug(`成片已写入 ${target.filePath}（${humanBytes(size)}）`);
        const durationMs = Date.now() - startedAt;
        const voiceLabel = voiceLabelOf(request);
        // ⑤ 元数据 sidecar
        let metadataPath;
        if (config.writeMetadata) {
            metadataPath = `${target.filePath}.json`;
            fs.writeFileSync(metadataPath, `${JSON.stringify({
                plugin: 'dsh-comfyui-image',
                createdAt: new Date().toISOString(),
                mode: request.mode,
                modeInferred: request.modeInferred,
                script: request.script,
                tts: {
                    engine: request.tts,
                    label: voiceLabel,
                    spkAudioPrompt: request.tts === 'indextts' ? request.spkAudioPrompt : null,
                    lang: request.tts === 'indextts' ? request.lang : null,
                    emoVector: request.emoVector ?? null,
                    emoAlpha: request.emoAlpha ?? null,
                    emoAudioPrompt: request.emoAudioPrompt ?? null,
                    durationFactor: request.durationFactor ?? null,
                    voice: request.edgeVoice,
                    rate: request.rate
                },
                audio: { file: speech.wavPath, seconds: Number(speech.seconds.toFixed(3)) },
                firstFrame: { file: first.imagePath },
                baseVideo: first.baseVideoPath ? { file: first.baseVideoPath } : null,
                lipsync: {
                    engine: 'infinitetalk',
                    models: {
                        main: INFINITETALK_MODELS.mainModel,
                        patch: INFINITETALK_MODELS.patchModel,
                        lora: INFINITETALK_MODELS.lora,
                        wav2vec2: INFINITETALK_MODELS.wav2vec2
                    }
                },
                video: { width: request.width, height: request.height, fps: request.fps, frames: planned.frames },
                seed: request.seed,
                prompt: request.prompt,
                comfy: { url: config.baseUrl, promptId: lip.promptId ?? null },
                durationMs,
                outputFile: target.filePath,
                notes,
                extra: options.args.extra_options ?? {},
                workflow: lip.workflow
            }, null, 2)}\n`, 'utf8');
        }
        return {
            request,
            mode: request.mode,
            modeInferred: request.modeInferred,
            outputPaths: [target.filePath],
            ...(metadataPath ? { metadataPath } : {}),
            audioPath: speech.wavPath,
            baseVideoPath: first.baseVideoPath ?? first.imagePath,
            audioSeconds: speech.seconds,
            videoSeconds: planned.seconds,
            frames: planned.frames,
            fps: request.fps,
            width: request.width,
            height: request.height,
            voiceLabel,
            ...(lip.promptId ? { promptId: lip.promptId } : {}),
            comfyUrl: config.baseUrl,
            durationMs,
            notes
        };
    }
    catch (error) {
        const keep = process.env.DSH_COMFYUI_KEEP_WORK === '1' ? '（按 DSH_COMFYUI_KEEP_WORK=1 保留）' : '';
        if (error instanceof ImagePluginError) {
            throw new ImagePluginError(error.message, `${error.hint ? `${error.hint} ` : ''}中间产物在 ${workDir}${keep}`);
        }
        throw error;
    }
}
/** 供 tool 层复用：把探到的尺寸补进请求（图片尺寸与配置不一致时以图为准）。 */
export async function probeVideoSize(input, config, deps = {}) {
    if (!isFile(input))
        return undefined;
    const result = await runProcess(probeSizePlan(config.ffprobe, input), deps.spawn ? { spawn: deps.spawn } : {});
    if (result.code !== 0)
        return undefined;
    return parseSize(result.stdout);
}
