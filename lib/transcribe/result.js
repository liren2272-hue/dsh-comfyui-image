/** 给人看的成功文案（也是工具返回的 text 字段）。 */
export function renderTranscribeResultText(result) {
    const lines = [];
    lines.push(`✅ 语音识别成功`);
    lines.push('');
    lines.push(result.transcript || '（转写文本为空）');
    if (result.output_path) {
        lines.push('');
        lines.push(`文本文件：${result.output_path}`);
    }
    lines.push('');
    lines.push(`音频：${result.audio_path}`);
    lines.push(`参数：模型 ${result.model} · 设备 ${result.device} · 任务 ${result.task} · 语言 ${result.language || '自动识别'}`);
    lines.push(`耗时：${(result.duration_ms / 1000).toFixed(1)} 秒`);
    if (result.segments.length > 0) {
        lines.push('');
        lines.push(`分段：共 ${result.segments.length} 段`);
    }
    if (result.notes.length > 0) {
        lines.push('');
        lines.push('备注：');
        for (const note of result.notes)
            lines.push(`  - ${note}`);
    }
    return lines.join('\n');
}
/** 把 runner 的运行结果格式化成工具返回对象。 */
export function formatTranscribeResult(run) {
    const value = {
        text: '',
        transcript: run.text,
        language: run.language,
        segments: run.segments,
        audio_path: run.request.audioPath,
        model: run.request.model,
        device: run.request.device,
        task: run.request.task,
        output_path: run.outputPath ?? '',
        duration_ms: run.durationMs,
        success: true,
        notes: run.notes
    };
    value.text = renderTranscribeResultText(value);
    return value;
}
/** 失败文案：❌ 开头，带异常信息与下一步 hint。 */
export function renderTranscribeFailureText(error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error && typeof error === 'object' && 'hint' in error ? String(error.hint ?? '') : '';
    const lines = [`❌ 语音识别失败`, '', message];
    if (hint) {
        lines.push('');
        lines.push(hint);
    }
    return lines.join('\n');
}
