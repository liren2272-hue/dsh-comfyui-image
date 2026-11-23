export function renderMusicResultText(result) {
    const lines = [];
    lines.push('✅ 音乐生成成功');
    lines.push('');
    lines.push(`音乐：${result.path}`);
    if (result.metadata_path)
        lines.push(`元数据：${result.metadata_path}`);
    lines.push('');
    lines.push(`风格：${result.tags}`);
    lines.push('参数：纯器乐 BGM（无人声歌词）');
    lines.push(`参数：时长 ${result.duration} 秒 · ${result.bpm} BPM · 调式 ${result.key} · ` +
        `语言 ${result.language} · 格式 ${result.format} · seed=${result.seed}`);
    lines.push(`耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`);
    lines.push(`ComfyUI：${result.comfy_url}（prompt_id=${result.prompt_id}）`);
    if (result.notes.length > 0) {
        lines.push('');
        lines.push('备注：');
        for (const note of result.notes)
            lines.push(`  - ${note}`);
    }
    lines.push('');
    lines.push('提示：这个工具只生成无人声 BGM；想换风格就改 tags，想复现同一段就用同一个 seed。');
    return lines.join('\n');
}
/** MusicRunResult → 工具返回值。 */
export function formatMusicResult(run) {
    const primary = run.outputPaths[0] ?? '';
    const value = {
        text: '',
        path: primary,
        files: [...run.outputPaths],
        tags: run.request.tags,
        duration: run.request.duration,
        seed: run.request.seed,
        bpm: run.request.bpm,
        key: run.request.key,
        language: run.request.language,
        format: run.request.format,
        duration_ms: run.durationMs,
        success: true,
        notes: run.notes,
        comfy_url: run.comfyUrl,
        prompt_id: run.promptId
    };
    if (run.metadataPath)
        value.metadata_path = run.metadataPath;
    value.text = renderMusicResultText(value);
    return value;
}
/** 失败时给模型看的文本：首行 + 原始 message + 可选「怎么办」。 */
export function renderMusicFailureText(error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error && typeof error === 'object' && 'hint' in error ? String(error.hint ?? '') : '';
    const lines = ['❌ 音乐生成失败', '', message];
    if (hint) {
        lines.push('');
        lines.push(`建议：${hint}`);
    }
    return lines.join('\n');
}
