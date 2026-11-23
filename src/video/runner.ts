/**
 * 视频执行引擎：把一次 generate_video 调用从头跑到尾。
 *
 * 与 runner.ts（图片）的区别只有三处，其余刻意保持一致：
 *   1. 探测的是「unet + clip + vae 三件套」，不是单个 checkpoint；
 *   2. 提交前会用 /object_info 剪一遍工作流（Wan 节点版本差异比 SD 大得多）；
 *   3. 轮询超时用 `videoTimeoutMs`——视频动辄十几分钟，图片那套 5 分钟默认值不够用。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ComfyWorkflow, ResolvedConfig } from '../types.js'
import { guessImageMime, humanBytes, isFile, planOutputFile, readImageBytes, timestampSlug, videoExtensionOf, VIDEO_EXTS } from '../files.js'
import { ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'
import {
  ComfyUIClient,
  describeHistoryError,
  type ComfyHistoryEntry,
  type ComfyNodeInfo
} from '../comfy/client.js'
import { declaredInputs, enumChoices, fillInputs, specDefault } from '../comfy/nodes.js'
import { normalizeVideoRequest } from './params.js'
import { resolveVideoPreset, type VideoPreset } from './presets.js'
import { buildVideoWorkflow, videoFilenamePrefix, VIDEO_NODE } from './workflows.js'
import type { GenerateVideoArgs, NormalizedVideoRequest, VideoMode } from './types.js'

/** 跑一次视频生成所需的全部输入。 */
export interface VideoRunOptions {
  args: GenerateVideoArgs
  cwd: string
  config: ResolvedConfig
  signal?: AbortSignal
  client?: ComfyUIClient
}

export interface VideoRunResult {
  request: NormalizedVideoRequest
  mode: VideoMode
  modeInferred: boolean
  outputPaths: string[]
  metadataPath?: string
  comfyRef: { filename: string; subfolder: string; type: string }
  promptId: string
  comfyUrl: string
  durationMs: number
  preset: VideoPreset
  notes: string[]
  workflow: ComfyWorkflow
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      cleanup()
      reject(new ImagePluginError('已取消：调用方中止了本次视频生成。', 'ComfyUI 那边的任务可能还在跑完。'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * 从历史记录里找产出的视频文件。
 *
 * ComfyUI 不同节点的键名不一样：原生 `SaveVideo` 给的是 `images`（是的，它也塞在 images 里），
 * VideoHelperSuite 给的是 `gifs` / `videos`，音频节点给 `audio`。四个都扫一遍最稳。
 */
export function pickVideoRef(
  entry: ComfyHistoryEntry,
  preferredNodeId?: string
): { filename: string; subfolder: string; type: string } | undefined {
  const keys = ['videos', 'gifs', 'images', 'audio']
  const outputs = entry.outputs ?? {}
  const scan = (node: Record<string, unknown> | undefined) => {
    if (!node) return undefined
    for (const key of keys) {
      const list = node[key]
      if (Array.isArray(list) && list.length > 0) {
        const last = list[list.length - 1] as { filename?: unknown; subfolder?: unknown; type?: unknown }
        if (typeof last?.filename === 'string') {
          return {
            filename: last.filename,
            subfolder: typeof last.subfolder === 'string' ? last.subfolder : '',
            type: typeof last.type === 'string' ? last.type : 'output'
          }
        }
      }
    }
    return undefined
  }

  const preferred = scan(outputs[preferredNodeId ?? ''] as Record<string, unknown> | undefined)
  if (preferred) return preferred
  for (const node of Object.values(outputs)) {
    const found = scan(node as Record<string, unknown>)
    if (found) return found
  }
  return undefined
}

/**
 * 文件名类输入：它们的「枚举候选」其实是 ComfyUI 扫 input/output 目录得到的**文件名列表**，
 * 会随上传/删除随时变化 —— 绝不能当成「能力枚举」去纠偏。
 *
 * 2026-10-29 真机踩到的坑：`/object_info` 有 60 秒缓存，先探测模型三件套、再上传首帧，
 * 拿到的工作流纠偏用的是**上传前**的文件名列表，把 `i2v_source.png` 判成非法值 →
 * 静默替换成候选里的第一个文件（`clover_guide.png`）→ 出片是「用别人的图做首帧」，
 * 而且不报错：白等 194 秒，拿到的其实是文生视频。所以这里对文件名输入一律不动。
 */
const OPAQUE_FILENAME_INPUTS = new Set(['image', 'video', 'audio', 'file'])

/**
 * 按 /object_info 收拾工作流：
 *   - 节点没声明的输入直接删掉（否则 /prompt 报 "Required input is missing" 或直接拒收）；
 *   - 枚举输入的值不在候选里就纠偏（比如某个版本的 SaveVideo 不认 format=auto）。
 */
export function reconcileWorkflow(workflow: ComfyWorkflow, info: Record<string, ComfyNodeInfo>): ComfyWorkflow {
  const next: ComfyWorkflow = {}
  for (const [id, node] of Object.entries(workflow)) {
    const nodeInfo = info[node.class_type]
    if (!nodeInfo) {
      next[id] = node
      continue
    }
    const kept = fillInputs(nodeInfo, node.inputs)
    const declared = declaredInputs(nodeInfo)
    for (const [key, value] of Object.entries(kept)) {
      if (OPAQUE_FILENAME_INPUTS.has(key)) continue
      const choices = enumChoices(declared[key])
      if (!choices || typeof value !== 'string') continue
      if (choices.includes(value)) continue
      const fallback = specDefault(declared[key])
      const replacement =
        typeof fallback === 'string' && choices.includes(fallback) ? fallback : choices[0]
      if (replacement !== undefined) {
        logDebug(`节点 ${node.class_type}.${key} 的枚举值 ${value} 不被接受，改用 ${replacement}`)
        kept[key] = replacement
      }
    }
    next[id] = { ...node, inputs: kept }
  }
  return next
}

/** 主流程。 */
export async function runVideoGeneration(options: VideoRunOptions): Promise<VideoRunResult> {
  const { args, cwd, config, signal } = options
  const startedAt = Date.now()

  // ── 1. 参数归一化 ──
  const { request, modeInferred } = normalizeVideoRequest(args, { cwd, config })
  const notes = [...request.notes]
  logDebug('归一化后的视频请求', {
    mode: request.mode,
    frames: request.frames,
    fps: request.fps,
    size: `${request.width}x${request.height}`,
    output: request.outputPath
  })

  const client =
    options.client ?? new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })

  // 早一步健康检查：连不上就别浪费时间
  await client.systemStats(signal)

  // ── 2. 探测模型三件套 ──
  const resolution = await resolveVideoPreset(client, config, request.unet, signal)
  const preset = resolution.preset
  notes.push(...resolution.notes)
  // 预设里的默认值只在调用方没显式给时兜底（normalize 已用同一份配置，这里主要保证一致）
  if (!request.unet && request.steps === config.videoSteps) {
    notes.push(`视频管线：${preset.label}｜unet=${preset.unet}｜vae=${preset.vae}`);
  }

  // ── 3. 上传首帧（仅 img2video）──
  let uploadedInput: string | undefined
  if (request.mode === 'img2video' && request.inputImage) {
    const bytes = readImageBytes(request.inputImage, 'input_image')
    const uploaded = await client.uploadImage(
      { filename: path.basename(request.inputImage), bytes, mime: guessImageMime(request.inputImage) },
      signal
    )
    uploadedInput = uploaded.name
    logDebug('已上传首帧', { local: request.inputImage, comfy: uploaded })
  }
  if (request.mode === 'img2video' && !uploadedInput) {
    throw new ImagePluginError('图生视频缺少首帧图片。', '请传 input_image。')
  }

  // ── 4. 构建工作流并纠偏 ──
  const prefix = videoFilenamePrefix(request, timestampSlug())
  const built = buildVideoWorkflow({
    request,
    preset,
    ...(uploadedInput ? { uploadedInput } : {}),
    filenamePrefix: prefix
  })
  // 注意 maxAgeMs=0：必须拿**上传之后**的 /object_info 快照，
  // 否则 LoadImage 的文件名列表里还没有刚上传的首帧（详见 OPAQUE_FILENAME_INPUTS 的注释）。
  const workflow = reconcileWorkflow(built.workflow, await client.objectInfo(signal, 0))

  // ── 5. 提交 ──
  const clientId = `dsh-comfyui-video-${Date.now().toString(36)}`
  const { promptId } = await client.queuePrompt(workflow, clientId, signal)
  logDebug('视频任务已提交', { promptId, timeoutMs: config.videoTimeoutMs })

  // ── 6. 轮询（视频慢，超时用 videoTimeoutMs）──
  const deadline = Date.now() + config.videoTimeoutMs
  let entry: ComfyHistoryEntry | undefined
  for (;;) {
    if (signal?.aborted) {
      throw new ImagePluginError('已取消：调用方中止了本次视频生成。', 'ComfyUI 那边的任务可能还在跑完。')
    }
    if (Date.now() > deadline) {
      await client.interrupt(signal)
      throw new ImagePluginError(
        `等待 ComfyUI 生成视频超时（等了 ${Math.round(config.videoTimeoutMs / 1000)} 秒，prompt_id=${promptId}）。`,
        `已尝试取消该任务。视频比图片慢得多（121 帧约 14 分钟），可以在 ~/.dsh-comfyui-image/config.json ` +
          '里把 videoTimeoutMs 调大，或把 seconds 调小。'
      )
    }
    entry = await client.historyEntry(promptId, signal)
    if (entry) break
    await sleep(config.pollIntervalMs, signal)
  }

  const statusStr = entry.status?.status_str
  if (statusStr === 'error' || statusStr === 'cancelled') {
    throw describeHistoryError(entry, promptId)
  }

  const comfyRef = pickVideoRef(entry, built.outputNodeId)
  if (!comfyRef) {
    throw new ImagePluginError(
      `ComfyUI 报告任务已结束（状态 ${statusStr ?? '未知'}），但没有产出视频文件（prompt_id=${promptId}）。`,
      '常见原因：工作流末端没接 SaveVideo；或 ComfyUI 版本太老、SaveVideo 需要额外的编码器。' +
        `可以打开 ${config.baseUrl} 在队列里找到这个 prompt_id 看节点图。`
    )
  }

  // ── 7. 取回并落盘 ──
  const bytes = await client.viewImage(comfyRef, signal)
  if (bytes.length === 0) {
    throw new ImagePluginError(
      `下载到的视频是 0 字节（${comfyRef.filename}）。`,
      'ComfyUI 那边可能刚写完文件就被读了，重跑一次通常就好；也可以去 ComfyUI 的 output 目录里直接拿。'
    )
  }
  const extension = videoExtensionOf(comfyRef.filename)
  const planned = planOutputFile(request.outputPath, cwd, extension, VIDEO_EXTS)
  const finalFile = planned.filePath
  fs.mkdirSync(path.dirname(finalFile), { recursive: true })
  fs.writeFileSync(finalFile, bytes)
  logDebug(`已写入 ${finalFile}（${humanBytes(bytes.length)}）`)

  const durationMs = Date.now() - startedAt

  // ── 8. 元数据 sidecar ──
  let metadataPath: string | undefined
  if (config.writeMetadata) {
    metadataPath = `${finalFile}.json`
    const metadata = {
      plugin: 'dsh-comfyui-image',
      createdAt: new Date().toISOString(),
      mode: request.mode,
      modeInferred,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      seed: request.seed,
      width: request.width,
      height: request.height,
      frames: request.frames,
      fps: request.fps,
      seconds: request.actualSeconds,
      steps: request.steps,
      cfgScale: request.cfgScale,
      shift: request.shift,
      preset: preset.id,
      unet: preset.unet,
      clip: preset.clip,
      vae: preset.vae,
      inputImage: request.inputImage,
      comfy: { url: config.baseUrl, promptId, file: comfyRef, filenamePrefix: prefix },
      durationMs,
      outputFile: finalFile,
      notes,
      extra: request.extra,
      workflow
    }
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  }

  return {
    request,
    mode: request.mode,
    modeInferred,
    outputPaths: [finalFile],
    ...(metadataPath ? { metadataPath } : {}),
    comfyRef,
    promptId,
    comfyUrl: config.baseUrl,
    durationMs,
    preset,
    notes,
    workflow
  }
}

/** 校验输出路径确实可写（测试与诊断用）。 */
export function assertWritableTarget(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!isFile(filePath) && !fs.existsSync(dir)) {
    throw new ImagePluginError(`输出目录不存在：${dir}`, '请先创建目录，或换一个 output_path。')
  }
}

export { VIDEO_NODE }
