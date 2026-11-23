/**
 * 「语音识别（Whisper ASR）」编排器：本地音频 → 转写文本。
 *
 * 做法：把一段调用 openai-whisper 官方 API 的 Python 脚本写到 mkdtempSync 的临时目录，
 * 再用 runProcess 起配置里的 Python（装了 whisper + torch 的 venv）执行它。
 * 参数用「单个 JSON 字符串」传给脚本的 argv[1]，避免 Windows 上引号/空格被二次解释。
 * 结果由 stdout 里 `__DSH_ASR_RESULT__` 前缀行取回；cuda 失败由脚本内部 try/except 回退 cpu。
 *
 * 不碰 ComfyUI、不碰 InfiniteTalk、不依赖 index.ts / config.ts 之外的共享状态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImagePluginError } from '../errors.js';
import { ensureDir, isFile, resolveUserPath } from '../files.js';
import { logDebug } from '../log.js';
import { runProcess } from '../talking/exec.js';
import { isTranscribeTask } from './types.js';
/** 结果行前缀（Python 脚本打印，runner 据此从 stdout 里捞 JSON）。 */
export const ASR_RESULT_PREFIX = '__DSH_ASR_RESULT__';
/**
 * 临时 Python 脚本。放在 mkdtemp 目录里，跑完不删（失败时便于排查，stdout/stderr 也不含脚本全文）。
 * 参数通过 argv[1] 的单个 JSON 字符串传入：[audio, model, language, device, task, initial_prompt, word_ts]。
 */
const WHISPER_PYTHON_SCRIPT = `# -*- coding: utf-8 -*-
import sys, json, whisper

# Windows 控制台默认 GBK，转写文本里偶有生僻字会 UnicodeEncodeError；强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

audio, model, language, device, task, initial_prompt, word_ts = json.loads(sys.argv[1])

kw = {}
if language and language != 'auto': kw['language'] = language
if task and task != 'transcribe': kw['task'] = task
if initial_prompt: kw['initial_prompt'] = initial_prompt
if word_ts: kw['word_timestamps'] = True

def transcribe_with(dev):
    m = whisper.load_model(model, device=dev)
    return m.transcribe(audio, **kw)

used_device = device
try:
    r = transcribe_with(device)
except Exception as exc:
    if device != 'cpu':
        sys.stderr.write('cuda/指定设备失败，回退 cpu：' + str(exc) + '\\n')
        used_device = 'cpu'
        r = transcribe_with('cpu')
    else:
        raise

out = {
    'text': r.get('text', '').strip(),
    'language': r.get('language'),
    'device_used': used_device,
    'segments': []
}
for s in r.get('segments', []):
    seg = {'start': round(s['start'], 2), 'end': round(s['end'], 2), 'text': s['text'].strip()}
    if word_ts:
        seg['words'] = [{'word': w['word'], 'start': round(w['start'], 2), 'end': round(w['end'], 2)} for w in s.get('words', [])]
    out['segments'].append(seg)

print('__DSH_ASR_RESULT__' + json.dumps(out, ensure_ascii=False))
`;
/** 工作目录：脚本与中间产物都放这里。 */
function makeWorkDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-transcribe-${Date.now()}-`));
}
/** 把 stderr 压成一行，用于错误信息（取最后一行，traceback 的真因在末尾）。 */
function lastMeaningfulLine(text, fallback = '') {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('WARNING') && !line.startsWith('INFO'));
    return lines.length > 0 ? lines[lines.length - 1] : fallback;
}
/** 非零退出码一律转成带 hint 的插件错误。 */
function assertExit(result, what, hint) {
    if (result.code === 0)
        return;
    throw new ImagePluginError(`${what}失败（退出码 ${result.code ?? 'null'}）：${lastMeaningfulLine(result.stderr, '没有输出')}`, hint);
}
/** 解析 Python 脚本打印的结果行；找不到就报带 hint 的错。 */
function parseWhisperOutput(stdout) {
    const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item.startsWith(ASR_RESULT_PREFIX));
    if (!line) {
        throw new ImagePluginError('Whisper 脚本正常退出，但 stdout 里没有结果行。', '检查 transcribePython 指向的 venv 是否装了 openai-whisper；可设 DSH_COMFYUI_KEEP_WORK=1 保留临时脚本目录，手动跑一遍看报错。');
    }
    let parsed;
    try {
        parsed = JSON.parse(line.slice(ASR_RESULT_PREFIX.length));
    }
    catch (error) {
        throw new ImagePluginError(`Whisper 结果行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, '结果行全文：' + line.slice(0, 500));
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new ImagePluginError('Whisper 结果行解析后不是对象。', '结果行全文：' + line.slice(0, 500));
    }
    const value = parsed;
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    const language = typeof value.language === 'string' ? value.language : '';
    const deviceUsed = typeof value.device_used === 'string' ? value.device_used : '';
    const segments = Array.isArray(value.segments)
        ? value.segments.map((item) => {
            const seg = (item && typeof item === 'object' ? item : {});
            const out = {
                start: typeof seg.start === 'number' ? seg.start : 0,
                end: typeof seg.end === 'number' ? seg.end : 0,
                text: typeof seg.text === 'string' ? seg.text.trim() : ''
            };
            if (Array.isArray(seg.words)) {
                out.words = seg.words.map((wordItem) => {
                    const w = (wordItem && typeof wordItem === 'object' ? wordItem : {});
                    return {
                        word: typeof w.word === 'string' ? w.word : '',
                        start: typeof w.start === 'number' ? w.start : 0,
                        end: typeof w.end === 'number' ? w.end : 0
                    };
                });
            }
            return out;
        })
        : [];
    return { text, language, deviceUsed, segments };
}
/** 写转写文本到用户指定路径；不给就在返回里给文本（不落盘）。 */
function writeTranscript(text, outputPath, cwd) {
    const resolved = resolveUserPath(outputPath, cwd);
    ensureDir(path.dirname(resolved));
    let target = resolved;
    if (fs.existsSync(target)) {
        const base = path.basename(resolved, path.extname(resolved));
        const dir = path.dirname(resolved);
        for (let i = 1; i < 1000; i += 1) {
            const candidate = path.join(dir, `${base}-${i}${path.extname(resolved)}`);
            if (!fs.existsSync(candidate)) {
                target = candidate;
                break;
            }
        }
    }
    fs.writeFileSync(target, `${text}\n`, 'utf8');
    return target;
}
/** 规划一次 whisper 子进程调用（纯函数，便于离线单测）。 */
export function buildWhisperPlan(options) {
    return {
        command: options.python,
        args: [options.scriptPath, options.payload],
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {})
    };
}
/** 生成脚本 + JSON 参数（把 buildWhisperPlan 的入参准备好）。 */
export function createWhisperPlan(options) {
    const scriptPath = path.join(options.workDir, 'whisper_asr.py');
    fs.writeFileSync(scriptPath, WHISPER_PYTHON_SCRIPT, 'utf8');
    const payload = JSON.stringify([
        options.request.audioPath,
        options.request.model,
        options.request.language,
        options.request.device,
        options.request.task,
        options.request.initialPrompt,
        options.request.wordTimestamps
    ]);
    return {
        args: [scriptPath, payload],
        workDir: options.workDir,
        scriptPath
    };
}
/** 归一化 + 校验（纯函数，不碰网络/文件系统，便于离线单测）。 */
export function normalizeTranscribeRequest(args, config, cwd = process.cwd()) {
    const notes = [];
    // ── audio_path（语义必填，但 schema 的 required 只能是 []，所以在这里校验） ──
    const rawAudio = typeof args.audio_path === 'string' ? args.audio_path.trim() : '';
    if (rawAudio === '') {
        throw new ImagePluginError('audio_path 不能为空：语音识别必须给一个本地音频文件。', '例如 audio_path="D:/recordings/meeting.mp3"；支持 mp3/wav/m4a/webm/flac/ogg。');
    }
    const audioPath = resolveUserPath(rawAudio, cwd);
    if (!isFile(audioPath)) {
        throw new ImagePluginError(`音频文件不存在或不是文件：${audioPath}`, '确认路径写对了、且用的是绝对路径或相对于当前工作目录的路径；也别把目录当音频文件传。');
    }
    const ext = path.extname(audioPath).toLowerCase();
    const known = ['.mp3', '.wav', '.m4a', '.webm', '.flac', '.ogg'];
    if (ext && !known.includes(ext)) {
        notes.push(`音频扩展名 ${ext} 不在常见列表（mp3/wav/m4a/webm/flac/ogg），仍交给 Whisper 处理。`);
    }
    // ── model / device / language / task ──
    const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : config.transcribeModel;
    const device = typeof args.device === 'string' && args.device.trim() !== '' ? args.device.trim() : config.transcribeDevice;
    if (device !== 'cuda' && device !== 'cpu' && !/^cuda:\d+$/.test(device)) {
        notes.push(`device=${device} 不是标准值（cuda / cpu / cuda:N），直接交给 whisper.load_model；失败时脚本会尝试回退 cpu。`);
    }
    let language = typeof args.language === 'string' ? args.language.trim() : '';
    if (language.toLowerCase() === 'auto')
        language = '';
    if (language === '')
        notes.push('未指定 language，Whisper 会自动识别音频语言。');
    let task = 'transcribe';
    if (args.task !== undefined && args.task !== null) {
        if (!isTranscribeTask(args.task)) {
            throw new ImagePluginError(`不认识的 task：${JSON.stringify(args.task)}。`, '只能是 transcribe 或 translate。');
        }
        task = args.task;
    }
    const initialPrompt = typeof args.initial_prompt === 'string' ? args.initial_prompt.trim() : '';
    const wordTimestamps = args.word_timestamps === true;
    let outputPath;
    if (typeof args.output_path === 'string' && args.output_path.trim() !== '') {
        outputPath = args.output_path.trim();
    }
    return {
        audioPath,
        model,
        language,
        device,
        task,
        ...(outputPath ? { outputPath } : {}),
        initialPrompt,
        wordTimestamps,
        notes
    };
}
/** 主入口：归一化 → 写脚本 → 跑 whisper → 解析 stdout → 可选落盘。 */
export async function runTranscription(options) {
    const startedAt = Date.now();
    const { config } = options;
    const deps = options.deps ?? {};
    const request = normalizeTranscribeRequest(options.args, config, options.cwd);
    const notes = [...request.notes];
    const workDir = makeWorkDir();
    try {
        const plan = createWhisperPlan({
            python: config.transcribePython,
            workDir,
            request,
            timeoutMs: config.transcribeTimeoutMs,
            signal: options.signal
        });
        logDebug('Whisper 转写', {
            cwd: workDir,
            audioPath: request.audioPath,
            model: request.model,
            device: request.device,
            task: request.task
        });
        const runPlan = buildWhisperPlan({
            python: config.transcribePython,
            scriptPath: plan.scriptPath,
            payload: plan.args[1] ?? '[]',
            cwd: workDir,
            timeoutMs: config.transcribeTimeoutMs,
            signal: options.signal
        });
        const result = await runProcess(runPlan, deps);
        assertExit(result, 'Whisper 语音识别', `检查 transcribePython 是否存在（当前 ${config.transcribePython}）、该 venv 是否装了 openai-whisper 与 torch、模型 ${request.model} 能否下载/读取（权重缓存在 C:/Users/15940/.cache/whisper）；显存不足时脚本会自动回退 cpu。`);
        const parsed = parseWhisperOutput(result.stdout);
        if (parsed.deviceUsed && parsed.deviceUsed !== request.device) {
            notes.push(`设备 ${request.device} 失败，已在脚本内回退到 ${parsed.deviceUsed}。`);
        }
        if (parsed.text === '') {
            notes.push('Whisper 返回的转写文本为空（可能是静音音频）。');
        }
        let outputPath;
        if (request.outputPath) {
            outputPath = writeTranscript(parsed.text, request.outputPath, options.cwd);
            notes.push(`转写文本已写入 ${outputPath}`);
        }
        return {
            request,
            text: parsed.text,
            language: parsed.language,
            segments: parsed.segments,
            ...(outputPath ? { outputPath } : {}),
            durationMs: Date.now() - startedAt,
            notes
        };
    }
    catch (error) {
        const keep = process.env.DSH_COMFYUI_KEEP_WORK === '1' ? '（设了 DSH_COMFYUI_KEEP_WORK=1，可去这里排查）' : '';
        if (error instanceof ImagePluginError) {
            throw new ImagePluginError(error.message, `${error.hint ? `${error.hint} ` : ''}临时脚本目录：${workDir}${keep}`);
        }
        throw error;
    }
}
