/**
 * IndexTTS-2 的推理命令（走仓库根下的 dsh_indextts_infer.py 包装脚本）。
 *
 * cwd 必须是 IndexTTS 仓库根：包装脚本默认的 --model_dir / --cfg_path 都是相对路径
 * （checkpoints/...），换到别的目录跑会找不到权重。
 * 产物路径是我们自己指定的 --output，不需要「取目录里最新 wav」那套猜测。
 */
export function indexttsTtsPlan(options) {
    const args = [
        'dsh_indextts_infer.py',
        '--spk_audio_prompt',
        options.spkAudioPrompt,
        '--text',
        options.text,
        '--output',
        options.outFile
    ];
    if (options.lang)
        args.push('--lang', options.lang);
    if (options.emoVector && options.emoVector.length > 0) {
        args.push('--emo_vector', options.emoVector.join(','));
    }
    if (options.emoAlpha !== undefined)
        args.push('--emo_alpha', String(options.emoAlpha));
    if (options.emoAudioPrompt)
        args.push('--emo_audio_prompt', options.emoAudioPrompt);
    if (options.durationFactor !== undefined)
        args.push('--duration_factor', String(options.durationFactor));
    if (options.cfgPath)
        args.push('--cfg_path', options.cfgPath);
    if (options.modelDir)
        args.push('--model_dir', options.modelDir);
    // --device 传 cuda:0 / cpu 这类字符串（IndexTTS 是 torch.device，不是裸序号）。
    if (options.device)
        args.push('--device', options.device);
    return { command: options.python, cwd: options.indexttsDir, args };
}
/**
 * edge-tts 用 `python -m edge_tts` 调，不用 Scripts\edge-tts.exe：
 * venv 被移动过之后 .exe 里内嵌的 shebang 绝对路径会失效（我们踩过），-m 永远安全。
 * --text 直接传字符串而不是写临时文件：台词上限 600 字，命令行长度完全够。
 */
export function edgeTtsPlan(options) {
    return {
        command: options.python,
        // --rate 必须用 `=` 形式：语速值以 `-` 开头（如 `-4%`），
        // 写成 `--rate -4%` 会被 argparse 当成「--rate 缺少参数」（我们真机踩过）。
        args: edgeTtsArgs(options)
    };
}
/**
 * 组装 edge-tts 的命令行参数。
 * --rate / --pitch / --volume 一律用 `=` 形式：它们的值都以 `+` 或 `-` 开头，
 * 写成 `--rate -4%` 会被 argparse 当成「--rate 缺少参数」（我们真机踩过）。
 * pitch / volume 是可选的——不给就不传，行为与老版本完全一致。
 */
export function edgeTtsArgs(options) {
    const args = ['-m', 'edge_tts', '--voice', options.voice, `--rate=${options.rate}`];
    if (options.pitch)
        args.push(`--pitch=${options.pitch}`);
    if (options.volume)
        args.push(`--volume=${options.volume}`);
    args.push('--text', options.text, '--write-media', options.outFile);
    return args;
}
/** ffmpeg 归一到 16kHz 单声道（InfiniteTalk 的 wav2vec2 音频编码器就是按这个采的）。 */
export function normalizeWavPlan(ffmpeg, input, output) {
    return {
        command: ffmpeg,
        args: ['-y', '-v', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', output]
    };
}
/** ffprobe 取时长（秒）。 */
export function probeDurationPlan(ffprobe, input) {
    return {
        command: ffprobe,
        args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input]
    };
}
/** 解析 ffprobe 的时间输出。 */
export function parseDuration(stdout) {
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
}
/** ffprobe 的宽高（视频/图片都能用）。 */
export function probeSizePlan(ffprobe, input) {
    return {
        command: ffprobe,
        args: ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', input]
    };
}
export function parseSize(stdout) {
    const match = /^\s*(\d+)x(\d+)\s*$/m.exec(stdout);
    if (!match)
        return undefined;
    const width = Number.parseInt(match[1] ?? '', 10);
    const height = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return undefined;
    return { width, height };
}
/** 台词结尾补个句号：TTS 对没有句末标点的句子容易把尾音吞掉。 */
export function punctuateScript(script) {
    const trimmed = script.trim();
    if (trimmed === '')
        return trimmed;
    return /[。！？.!?…，,、；;：:」』）)】]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}
