/**
 * 「独立音频生成」工具（generate_audio）的类型与常量。
 *
 * 这条链只做一件事：台词（文本）→ 语音 wav，不碰 ComfyUI 画面、不碰 InfiniteTalk 口型。
 * 避免只为了配音跑完整 video2talking 链路（图生视频 + 对口型），浪费几分钟 GPU 时间。
 *
 * 两个引擎（复用 talking/tts.ts 的命令规划器）：
 *   - indextts：IndexTTS-2 克隆音色，spk_audio_prompt 定音色 + emo_* 调情绪；
 *   - edge：现成音色，edge_voice + rate 两个旋钮。
 */
export const AUDIO_TTS_ENGINES = ['indextts', 'edge'];
export function isAudioTtsEngine(value) {
    return typeof value === 'string' && AUDIO_TTS_ENGINES.includes(value);
}
export const AUDIO_INDEXTTS_LANGS = ['ZH', 'EN'];
export function isAudioIndexTtsLang(value) {
    return typeof value === 'string' && AUDIO_INDEXTTS_LANGS.includes(value);
}
/** 台词上限：600 字，与 talking 层保持一致。 */
export const MAX_AUDIO_SCRIPT_CHARS = 600;
