/**
 * 音乐执行引擎：把一次 generate_music 调用从头跑到尾（ACE-Step 1.5 AIO）。
 *
 * 主流程和 video/runner.ts 刻意保持一致：
 *   ComfyUIClient → systemStats → buildMusicWorkflow → reconcileWorkflow →
 *   queuePrompt → 轮询 historyEntry → describeHistoryError → pickMusicRef →
 *   viewImage → planOutputFile → writeFileSync → metadata sidecar。
 *
 * 不同点：超时用 config.musicTimeoutMs；产出是音频（SaveAudioAdvanced 的 audio 键）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { humanBytes, planOutputFile } from '../files.js';
import { ImagePluginError } from '../errors.js';
import { logDebug, logInfo } from '../log.js';
import { ComfyUIClient, describeHistoryError } from '../comfy/client.js';
// reconcileWorkflow 在 video/runner.ts 已导出，直接复用（它对枚举输入做纠偏，
// filename 类输入一律不动——见那里的 OPAQUE_FILENAME_INPUTS 注释）。
import { reconcileWorkflow } from '../video/runner.js';
import { normalizeMusicRequest, MUSIC_EXTS } from './params.js';
import { buildMusicWorkflow } from './workflows.js';
/**
 * 可取消的 sleep。
 *
 * 注：video/runner.ts 里的同名函数是模块私有（未 export），所以这里放一份等价实现，
 * 不然 TS strict 下 import 会报「没有导出成员」。行为与 video 版一致。
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        function cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
        function onAbort() {
            cleanup();
            reject(new ImagePluginError('已取消：调用方中止了本次音乐生成。', 'ComfyUI 那边的任务可能还在跑完。'));
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort);
    });
}
/**
 * 从历史记录里找产出的音频文件。
 *
 * SaveAudioAdvanced 把结果放在 `audio` 键（值形如 {filename, subfolder, type}），
 * 但不同版本/自定义工作流也可能塞在 `gifs` / `images` 里，所以照抄 pickVideoRef 的
 * 扫描策略，只是把 `audio` 提到最优先。
 */
export function pickMusicRef(entry, preferredNodeId) {
    const keys = ['audio', 'gifs', 'images'];
    const outputs = entry.outputs ?? {};
    const scan = (node) => {
        if (!node)
            return undefined;
        for (const key of keys) {
            const list = node[key];
            // audio 键可能是单个对象，也可能是数组
            const candidates = Array.isArray(list) ? list : list ? [list] : [];
            for (const candidate of candidates) {
                const item = candidate;
                if (typeof item?.filename === 'string') {
                    return {
                        filename: item.filename,
                        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
                        type: typeof item.type === 'string' ? item.type : 'output'
                    };
                }
            }
        }
        return undefined;
    };
    const preferred = scan(outputs[preferredNodeId ?? '']);
    if (preferred)
        return preferred;
    for (const node of Object.values(outputs)) {
        const found = scan(node);
        if (found)
            return found;
    }
    return undefined;
}
/** 主流程。 */
export async function runMusicGeneration(options) {
    const { args, cwd, config, signal } = options;
    const startedAt = Date.now();
    // ── 1. 参数归一化 ──
    const request = normalizeMusicRequest(args, config, cwd);
    const notes = [...request.notes];
    logDebug('归一化后的音乐请求', {
        tags: request.tags,
        duration: request.duration,
        seed: request.seed,
        bpm: request.bpm,
        format: request.format,
        output: request.outputPath
    });
    const client = options.client ?? new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
    // 早一步健康检查：连不上就别浪费时间
    await client.systemStats(signal);
    // ── 2. 构建工作流并纠偏 ──
    const built = buildMusicWorkflow({
        request,
        config,
        filenamePrefix: 'comfyui_music'
    });
    // maxAgeMs=0：必须拿最新的 /object_info 快照做枚举纠偏。
    const info = await client.objectInfo(signal, 0);
    const workflow = reconcileWorkflow(built.workflow, info);
    // ── 3. 提交 ──
    const clientId = `dsh-comfyui-music-${Date.now().toString(36)}`;
    const { promptId } = await client.queuePrompt(workflow, clientId, signal);
    logInfo(`音乐任务已提交（prompt_id=${promptId}，tags="${request.tags}"，${request.duration} 秒）`);
    logDebug('音乐任务已提交', { promptId, timeoutMs: config.musicTimeoutMs });
    // ── 4. 轮询（超时用 musicTimeoutMs）──
    const deadline = Date.now() + config.musicTimeoutMs;
    let entry;
    for (;;) {
        if (signal?.aborted) {
            throw new ImagePluginError('已取消：调用方中止了本次音乐生成。', 'ComfyUI 那边的任务可能还在跑完。');
        }
        if (Date.now() > deadline) {
            await client.interrupt(signal);
            throw new ImagePluginError(`等待 ComfyUI 生成音乐超时（等了 ${Math.round(config.musicTimeoutMs / 1000)} 秒，prompt_id=${promptId}）。`, '已尝试取消该任务。可以在 ~/.dsh-comfyui-image/config.json 里把 musicTimeoutMs 调大，' +
                '或把 duration / steps 调小。');
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
    const comfyRef = pickMusicRef(entry, built.outputNodeId);
    if (!comfyRef) {
        throw new ImagePluginError(`ComfyUI 报告任务已结束（状态 ${statusStr ?? '未知'}），但没有产出音频文件（prompt_id=${promptId}）。`, '常见原因：工作流末端没接 SaveAudioAdvanced；或 ComfyUI 版本太老、不支持 ACE-Step 节点。' +
            `可以打开 ${config.baseUrl} 在队列里找到这个 prompt_id 看节点图。`);
    }
    // ── 5. 取回并落盘 ──
    const bytes = await client.viewImage(comfyRef, signal);
    if (bytes.length === 0) {
        throw new ImagePluginError(`下载到的音频是 0 字节（${comfyRef.filename}）。`, 'ComfyUI 那边可能刚写完文件就被读了，重跑一次通常就好；也可以去 ComfyUI 的 output 目录里直接拿。');
    }
    const extension = path.extname(comfyRef.filename).toLowerCase();
    const ext = MUSIC_EXTS.has(extension) ? extension : `.${request.format}`;
    const planned = planOutputFile(request.outputPath, cwd, ext, MUSIC_EXTS);
    const finalFile = planned.filePath;
    fs.mkdirSync(path.dirname(finalFile), { recursive: true });
    fs.writeFileSync(finalFile, bytes);
    logDebug(`已写入 ${finalFile}（${humanBytes(bytes.length)}）`);
    const durationMs = Date.now() - startedAt;
    // ── 6. 元数据 sidecar ──
    let metadataPath;
    if (config.writeMetadata) {
        metadataPath = `${finalFile}.json`;
        const metadata = {
            plugin: 'dsh-comfyui-image',
            tool: 'comfyui_generate_music',
            createdAt: new Date().toISOString(),
            prompt: request.tags,
            tags: request.tags,
            lyrics: request.lyrics,
            duration: request.duration,
            duration_ms: durationMs,
            seed: request.seed,
            bpm: request.bpm,
            key: request.key,
            language: request.language,
            format: request.format,
            checkpoint: config.musicCheckpoint,
            steps: config.musicSteps,
            cfg: config.musicCfg,
            sampler: config.musicSampler,
            scheduler: config.musicScheduler,
            comfy: { url: config.baseUrl, promptId, file: comfyRef },
            outputFile: finalFile,
            notes,
            workflow
        };
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    }
    return {
        request,
        outputPaths: [finalFile],
        ...(metadataPath ? { metadataPath } : {}),
        comfyRef,
        promptId,
        comfyUrl: config.baseUrl,
        durationMs,
        notes,
        workflow
    };
}
// 兼容：params.ts 里的 normalizeMusicRequest 也从这里 re-export（任务契约允许放在 runner）。
export { normalizeMusicRequest };
