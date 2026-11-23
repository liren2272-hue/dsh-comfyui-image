/**
 * 「语音识别（Whisper ASR）」工具（comfyui_transcribe_audio）的类型定义。
 *
 * 这条链只做一件事：本地音频文件 → 转写文本（可选词级时间戳），
 * 用 openai-whisper（Python venv）跑，不走 ComfyUI、不碰 InfiniteTalk。
 *
 * 约定：
 *   - 工具输入参数全部可选（schema 的 required 只能是 []），默认值写在 description 里；
 *   - `audio_path` 虽然语义上必填，但 schema 层仍放进 properties 而非 required，
 *     缺失/空值在 normalizeTranscribeRequest 里报带 hint 的 ImagePluginError。
 */
export const TRANSCRIBE_TASKS = ['transcribe', 'translate'];
export function isTranscribeTask(value) {
    return typeof value === 'string' && TRANSCRIBE_TASKS.includes(value);
}
