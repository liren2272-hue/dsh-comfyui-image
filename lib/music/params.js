/**
 * 音乐参数归一化层：把 Agent 给的松散参数，变成严格、可执行、有默认值的 `NormalizedMusicRequest`。
 *
 * 和 video/params.ts 一样的原则：**超界一律报错，不静默夹断**。
 * 音乐单次可以跑几分钟，悄悄把 300 秒夹成 60 秒是最坏的失败方式。
 *
 * 纯 BGM 在这里就锁死：`lyrics` 恒为空字符串，不接收任何外部歌词输入。
 */
import { argConflict } from '../errors.js';
import { planOutputFile } from '../files.js';
import { isMusicFormat } from './types.js';
/** 音频扩展名集合，交给 planOutputFile 判断「传的是文件还是目录」。 */
export const MUSIC_EXTS = new Set(['.flac', '.mp3', '.opus', '.wav', '.ogg', '.m4a']);
/** 默认时长（秒）。 */
export const DEFAULT_MUSIC_DURATION = 60;
/** 默认种子：固定 0，方便复现（和图片的随机种子不同，音乐这里按契约走 0）。 */
export const DEFAULT_MUSIC_SEED = 0;
const MIN_DURATION = 1;
const MIN_BPM = 10;
const MAX_BPM = 300;
function looksLikeOptions(value) {
    return !!value && typeof value === 'object' && 'config' in value && 'cwd' in value;
}
/** 数值字段的统一入口：非数字就抛（消息里带字段名，方便 Agent 自己改）。 */
function requireNumber(value, name) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw argConflict(`${name} 必须是数字，收到的是 ${JSON.stringify(value)}。`, `${name} 请传纯数字（不要带单位、不要加引号），例如 ${name === 'duration' ? 60 : 120}。`);
    }
    return value;
}
function trimmed(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}
/**
 * 主入口。
 *
 * @param args   Agent 给的松散参数
 * @param config ResolvedConfig（也可传 `{ cwd, config }`，兼容 video 的调用风格）
 * @param cwdArg 第二种兼容形状下可省略的工作目录；都没有时用 process.cwd()
 */
export function normalizeMusicRequest(args, configOrOptions, cwdArg) {
    const options = looksLikeOptions(configOrOptions)
        ? configOrOptions
        : { cwd: cwdArg ?? process.cwd(), config: configOrOptions };
    const { config, cwd } = options;
    const notes = [];
    // ── 1. 风格描述（必填）──────────────────────────────────────
    const tags = trimmed(args.tags);
    if (tags === '') {
        throw argConflict('tags 不能为空：音乐生成需要至少一段风格描述。', '请传 tags，例如 "lofi chill beats, soft piano, ambient" 或 "宁静的钢琴曲，轻柔，适合阅读"。');
    }
    // ── 2. 时长 ─────────────────────────────────────────────────
    const maxDuration = Number.isFinite(config.musicMaxDuration) && config.musicMaxDuration > 0 ? config.musicMaxDuration : 300;
    const duration = requireNumber(args.duration, 'duration') ?? DEFAULT_MUSIC_DURATION;
    if (!Number.isFinite(duration) || duration < MIN_DURATION || duration > maxDuration) {
        throw argConflict(`duration 必须在 ${MIN_DURATION}~${maxDuration} 秒之间，收到 ${JSON.stringify(args.duration)}。`, '按秒传纯数字，例如 60。太长会显著拉长生成时间。');
    }
    // ── 3. 种子（整数，默认 0）──────────────────────────────────
    const seedRaw = requireNumber(args.seed, 'seed') ?? DEFAULT_MUSIC_SEED;
    if (!Number.isInteger(seedRaw)) {
        throw argConflict(`seed 必须是整数，收到 ${seedRaw}。`, '传一个整数，例如 0 / 42 / 12345。');
    }
    const seed = seedRaw;
    // ── 4. BPM ──────────────────────────────────────────────────
    const bpmRaw = requireNumber(args.bpm, 'bpm') ?? config.musicBpm;
    if (!Number.isFinite(bpmRaw) || bpmRaw < MIN_BPM || bpmRaw > MAX_BPM) {
        throw argConflict(`bpm 必须在 ${MIN_BPM}~${MAX_BPM} 之间，收到 ${JSON.stringify(args.bpm)}。`, '常见值：60（慢）、90（lofi）、120（流行）、140（电子）。');
    }
    const bpm = Math.round(bpmRaw);
    if (bpm !== bpmRaw)
        notes.push(`bpm 已从 ${bpmRaw} 取整为 ${bpm}。`);
    // ── 5. 调式 / 语言 ──────────────────────────────────────────
    const key = trimmed(args.key) || trimmed(config.musicKeyScale) || 'C major';
    const language = trimmed(args.language) || trimmed(config.musicLanguage) || 'zh';
    // ── 6. 格式 ─────────────────────────────────────────────────
    const formatRaw = trimmed(args.format) || trimmed(config.musicFormat) || 'flac';
    if (!isMusicFormat(formatRaw)) {
        throw argConflict(`format 只能是 flac / mp3 / opus，收到 ${JSON.stringify(args.format)}。`, 'flac 无损（默认），mp3 通用，opus 体积小。');
    }
    const format = formatRaw;
    // ── 7. 输出位置（绝不覆盖）─────────────────────────────────
    const outputHint = trimmed(args.output_path);
    const planned = planOutputFile(outputHint !== '' ? outputHint : undefined, cwd, `.${format}`, MUSIC_EXTS);
    notes.push('纯器乐 BGM：lyrics 固定为空字符串，不会生成人声歌词。');
    return {
        tags,
        lyrics: '',
        duration,
        seed,
        bpm,
        key,
        language,
        format,
        outputPath: planned.filePath,
        notes
    };
}
