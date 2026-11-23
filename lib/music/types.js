/**
 * 音乐生成（generate_music / ACE-Step 1.5 AIO）共享类型。
 *
 * 和 video/types.ts 一样分两层：
 *   - `GenerateMusicArgs`      = 对外契约（Agent 看到的参数）
 *   - `NormalizedMusicRequest` = 对内契约（默认值填好、路径已解析、纯 BGM 已锁定）
 *
 * 纯 BGM 硬约束：`lyrics` 在归一化层就被钉死为空字符串，下游工作流只管照抄，
 * 任何路径都不允许往里塞人声歌词。
 */
/** 顺序即 schema enum 的顺序。 */
export const MUSIC_FORMATS = ['flac', 'mp3', 'opus'];
export function isMusicFormat(value) {
    return typeof value === 'string' && MUSIC_FORMATS.includes(value);
}
