/**
 * 「说话视频」工具（generate_talking_video）的类型与常量。
 *
 * 这条链把两件事串起来：
 *   ① 台词（文本）→ 语音 wav   —— TTS：IndexTTS-2（参考音频克隆音色 + 情绪控制）或 edge-tts（现成音色）
 *   ② 首帧画面（图 / 视频首帧 / 文生图） + 语音 → 口型对得上的成片 —— InfiniteTalk 端到端生成
 *
 * 旧的 MuseTalk 方案是「先出无声视频 → 局部重绘嘴部再贴回」，嘴部边缘有贴片感；
 * 新方案端到端生成，嘴随画面整体出来，边缘自然清晰。
 *
 * 为什么单独做一个工具而不是给 generate_video 加参数：
 *   generate_video 的契约是「画面怎么动」，这里的契约是「说什么、谁的声音、嘴对不对」，
 *   参数集和失败原因完全不同；混在一起会让模型把 script 塞进 prompt 里。
 */
/** 全部模式（顺序即文档顺序）。 */
export const TALKING_MODES = ['text2talking', 'image2talking', 'video2talking'];
export function isTalkingMode(value) {
    return typeof value === 'string' && TALKING_MODES.includes(value);
}
export const TTS_ENGINES = ['indextts', 'edge'];
export function isTtsEngine(value) {
    return typeof value === 'string' && TTS_ENGINES.includes(value);
}
export const INDEXTTS_LANGS = ['ZH', 'EN'];
export function isIndexTtsLang(value) {
    return typeof value === 'string' && INDEXTTS_LANGS.includes(value);
}
/**
 * IndexTTS 的情绪向量维度顺序（**顺序不能改**，权重就是按这个顺序吃的）。
 * 8 维、每维 0~1；全 0 等价于「不带情绪」。
 */
export const INDEXTTS_EMO_ORDER = [
    'happy',
    'angry',
    'sad',
    'afraid',
    'disgusted',
    'melancholic',
    'surprised',
    'calm'
];
