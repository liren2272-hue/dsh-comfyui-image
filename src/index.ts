/**
 * 插件入口（宿主侧）。
 *
 * 挂载方式：DSH 的 Loader 读到本包后调用 `apply(ctx, config)`；
 * `inject = ['tools']` 保证 `ctx.reflect.get('tools')` 拿得到工具注册表。
 *
 * ⚠️ 血泪经验（跟 dsh-novel 一致，踩过）：插件里**不要 import 任何 `@deepseek-ai/*` 宿主包**。
 * link 安装时 Node 从物理路径往上找 node_modules，必然 ERR_MODULE_NOT_FOUND。
 * `tools.register()` 接受普通对象，所以完全不需要类型导入。
 */
import { resolveConfig } from './config.js'
import { logInfo, logWarn } from './log.js'
import { PLUGIN_VERSION } from './runner.js'
import { createGenerateImageTool, TOOL_NAME } from './tool.js'
import { createGenerateVideoTool, VIDEO_TOOL_NAME } from './video/tool.js'
import { createGenerateTalkingTool, TALKING_TOOL_NAME } from './talking/tool.js'
import { createGenerateAudioTool, AUDIO_TOOL_NAME } from './audio/tool.js'
import { createGenerateMusicTool, MUSIC_TOOL_NAME } from './music/tool.js'
import { createTranscribeTool, TRANSCRIBE_TOOL_NAME } from './transcribe/tool.js'

/** 插件名（同时是 loader entry 的默认 id）。 */
export const name = 'dsh-comfyui-image'

/** 依赖的工具注册表服务。 */
export const inject = ['tools']

/** 宿主上下文最小面。 */
interface HostContextLike {
  reflect?: { get?: (key: string, strict?: boolean) => unknown }
  get?: (key: string) => unknown
}

/** 取工具注册表；拿不到返回 undefined（插件不该因此把 DSH 拖垮）。 */
function getToolRegistry(ctx: HostContextLike): ToolRegistryLike | undefined {
  const candidates: unknown[] = []
  if (typeof ctx.reflect?.get === 'function') {
    candidates.push(ctx.reflect.get('tools', false))
    candidates.push(ctx.reflect.get('tools'))
  }
  if (typeof ctx.get === 'function') candidates.push(ctx.get('tools'))
  for (const candidate of candidates) {
    if (candidate && typeof (candidate as ToolRegistryLike).register === 'function') {
      return candidate as ToolRegistryLike
    }
  }
  return undefined
}

interface ToolRegistryLike {
  register: (definition: unknown) => unknown
}

/**
 * 插件主体。
 *
 * @param ctx    宿主上下文
 * @param config 插件配置（cordis.patch.yml 里 `config:` 的内容，可为空）
 */
export function apply(ctx: HostContextLike, config?: unknown): void {
  const tools = getToolRegistry(ctx)
  if (!tools) {
    logWarn('拿不到 tools 服务，generate_image / generate_video / generate_talking_video / generate_audio / generate_music / transcribe_audio 未注册（请在 profile 里确认插件依赖正常）。')
    return
  }

  tools.register(createGenerateImageTool(config))
  tools.register(createGenerateVideoTool(config))
  tools.register(createGenerateTalkingTool(config))
  tools.register(createGenerateAudioTool(config))
  tools.register(createGenerateMusicTool(config))
  tools.register(createTranscribeTool(config))

  // 启动时只打一行摘要：**不**在加载阶段发网络请求，避免拖慢 DSH 启动。
  const resolved = resolveConfig(config)
  logInfo(
    `v${PLUGIN_VERSION} 已就绪，注册工具 ${TOOL_NAME}（四种图片模式）+ ${VIDEO_TOOL_NAME}（文生视频/图生视频）+ ` +
      `${TALKING_TOOL_NAME}（台词→语音→口型）+ ${AUDIO_TOOL_NAME}（台词→语音 wav，仅音频）+ ` +
      `${MUSIC_TOOL_NAME}（无人声背景音乐）+ ${TRANSCRIBE_TOOL_NAME}（Whisper 语音识别）。` +
      `ComfyUI 地址：${resolved.baseUrl}` +
      (resolved.checkpoint ? `，底模：${resolved.checkpoint}` : '，底模：自动选择') +
      (resolved.videoModel ? `，视频模型：${resolved.videoModel}` : '，视频模型：自动选择') +
      `，TTS 引擎：${resolved.ttsEngine}`
  )
  if (resolved.baseUrl.includes('0.0.0.0')) {
    logWarn('baseUrl 里是 0.0.0.0，浏览器地址栏能用，但作为请求目标请改成 127.0.0.1。')
  }
}

/* ─────────────── 给本地测试用的再导出（不启动 DSH 也能单测） ─────────────── */
export { ComfyUIClient } from './comfy/client.js'
export { chooseCheckpoint, chooseRembgPlan, chooseSampler, declaredInputs, enumChoices, pickDeclaredKey } from './comfy/nodes.js'
export { buildWorkflow, buildText2Img, buildFluxText2Img, buildImg2Img, buildInpaint, buildRemoveBackground, filenamePrefixFor, applyCustomWorkflow } from './comfy/workflows.js'
export { DEFAULTS, CONFIG_FILE, readConfigFile, resolveConfig, suggestSizeForCheckpoint, writeConfigFile } from './config.js'
export { formatError, ImagePluginError } from './errors.js'
export { guessImageMime, planOutputFile, randomSeed, timestampSlug } from './files.js'
export { inferMode, normalizeRequest } from './params.js'
export { formatResult, renderResultText } from './result.js'
export { runGeneration, pickImageRef, PLUGIN_VERSION } from './runner.js'
export { createGenerateImageTool, PARAMETERS_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_NAME, resolveCwd } from './tool.js'
export type { GenerateImageArgs, GenerateMode, NormalizedRequest } from './types.js'

/* ── 视频（generate_video）── */
export { buildVideoWorkflow, videoFilenamePrefix, VIDEO_NODE } from './video/workflows.js'
export { estimateSeconds, inferVideoMode, MAX_FRAMES, normalizeVideoRequest, secondsToFrames } from './video/params.js'
export { resolveVideoPreset } from './video/presets.js'
export { pickVideoRef, reconcileWorkflow, runVideoGeneration } from './video/runner.js'
export { formatVideoResult, renderVideoResultText } from './video/result.js'
export {
  createGenerateVideoTool,
  VIDEO_OUTPUT_SCHEMA,
  VIDEO_PARAMETERS_SCHEMA,
  VIDEO_TOOL_DESCRIPTION,
  VIDEO_TOOL_NAME
} from './video/tool.js'
export type { GenerateVideoArgs, NormalizedVideoRequest, VideoMode } from './video/types.js'
export { videoExtensionOf, VIDEO_EXTS } from './files.js'

/* ── 说话视频（generate_talking_video）── */
export {
  buildInfiniteTalkWorkflow,
  DEFAULT_INFINITETALK_NEGATIVE,
  DEFAULT_INFINITETALK_PROMPT,
  INFINITETALK_MODELS
} from './talking/lipsync.js'
export { autoResolutionForFrames, framesForSeconds, inferTalkingMode, MAX_SCRIPT_CHARS, MAX_TALKING_SECONDS, normalizeTalkingRequest, TALKING_HD_MAX_FRAMES, TALKING_HD_SIZE, TALKING_LOWRES_SIZE, voiceLabelOf } from './talking/params.js'
export { lastMeaningfulLine, runProcess } from './talking/exec.js'
export {
  edgeTtsArgs,
  edgeTtsPlan,
  indexttsTtsPlan,
  normalizeWavPlan,
  parseDuration,
  parseSize,
  probeDurationPlan,
  probeSizePlan,
  punctuateScript
} from './talking/tts.js'
export { runTalkingGeneration, DEFAULT_PORTRAIT_PROMPT, DEFAULT_SPEAKING_PROMPT } from './talking/runner.js'
export { formatTalkingResult, renderTalkingResultText } from './talking/result.js'
export {
  createGenerateTalkingTool,
  TALKING_OUTPUT_SCHEMA,
  TALKING_PARAMETERS_SCHEMA,
  TALKING_TOOL_DESCRIPTION,
  TALKING_TOOL_NAME
} from './talking/tool.js'
export type { GenerateTalkingArgs, IndexTtsLang, NormalizedTalkingRequest, TalkingMode, TtsEngine } from './talking/types.js'
export { INDEXTTS_EMO_ORDER, INDEXTTS_LANGS, TALKING_MODES, TTS_ENGINES, isIndexTtsLang, isTalkingMode, isTtsEngine } from './talking/types.js'

/* ── 独立音频（generate_audio）── */
export { audioEdgeTtsPlan, audioIndexTtsPlan, audioNormalizeWavPlan, audioParseDuration, audioPunctuateScript, validateAudioScript } from './audio/tts.js'
export { normalizeAudioRequest, runAudioGeneration } from './audio/runner.js'
export { formatAudioResult, renderAudioResultText, renderAudioFailureText } from './audio/result.js'
export {
  createGenerateAudioTool,
  AUDIO_OUTPUT_SCHEMA,
  AUDIO_PARAMETERS_SCHEMA,
  AUDIO_TOOL_DESCRIPTION,
  AUDIO_TOOL_NAME
} from './audio/tool.js'
export type { AudioIndexTtsLang, AudioOutcome, AudioTtsEngine, GenerateAudioArgs, NormalizedAudioRequest } from './audio/types.js'
export { AUDIO_INDEXTTS_LANGS, AUDIO_TTS_ENGINES, MAX_AUDIO_SCRIPT_CHARS, isAudioIndexTtsLang, isAudioTtsEngine } from './audio/types.js'
export type { AudioToolResult } from './audio/result.js'

/* ── 背景音乐（generate_music / ACE-Step 1.5 AIO）── */
export { buildMusicWorkflow } from './music/workflows.js'
export { normalizeMusicRequest, pickMusicRef, runMusicGeneration } from './music/runner.js'
export { formatMusicResult, renderMusicFailureText, renderMusicResultText } from './music/result.js'
export {
  createGenerateMusicTool,
  MUSIC_OUTPUT_SCHEMA,
  MUSIC_PARAMETERS_SCHEMA,
  MUSIC_TOOL_DESCRIPTION,
  MUSIC_TOOL_NAME
} from './music/tool.js'
export type { GenerateMusicArgs, NormalizedMusicRequest } from './music/types.js'
export type { MusicToolResult } from './music/result.js'

/* ── 语音识别（transcribe_audio / Whisper）── */
export { buildWhisperPlan, normalizeTranscribeRequest, runTranscription } from './transcribe/runner.js'
export { formatTranscribeResult, renderTranscribeFailureText, renderTranscribeResultText } from './transcribe/result.js'
export {
  createTranscribeTool,
  TRANSCRIBE_OUTPUT_SCHEMA,
  TRANSCRIBE_PARAMETERS_SCHEMA,
  TRANSCRIBE_TOOL_DESCRIPTION,
  TRANSCRIBE_TOOL_NAME
} from './transcribe/tool.js'
export type { NormalizedTranscribeRequest, TranscribeArgs } from './transcribe/types.js'
export type { TranscribeToolResult } from './transcribe/result.js'