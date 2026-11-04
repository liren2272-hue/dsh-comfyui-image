/**
 * MuseTalk 1.5（口型重绘）的三件套：推理用的 yaml、命令行参数、成片路径。
 *
 * 本文件只做「字符串怎么拼」，不起进程、不碰文件——拼错了能在单测里立刻发现，
 * 不用等 10 分钟 GPU 跑完才知道参数写歪了。
 *
 * 两个必须知道的坑（都不是我们写错，是官方脚本的固有行为）：
 *
 *   1. **`scripts/inference.py` 拼 ffmpeg 命令时没加引号**。
 *      它内部直接写成 `-i {video_path}`，路径里只要有空格（`C:\Program Files\...`
 *      或者用户名带空格），ffmpeg 收到的就是被拆开的多个参数，表现为「读到 0 帧」
 *      或者干脆报 `No such file or directory`。所以素材必须先拷进
 *      `<musetalkDir>/inputs/` 这种无空格目录再跑（编排层 runner.ts 就是这么做的）。
 *
 *   2. **成片落在 `results/<version>/` 下，不是 `result_dir` 直下**。
 *      官方在 `result_dir` 后面又拼了一层版本目录（`results/v15/xxx.mp4`），
 *      所以「跑完去 result_dir 里找 xxx.mp4」永远找不到——必须用
 *      `musetalkResultPath()` 拼出真实路径，别自己 `path.join(resultDir, name)`。
 */
export interface MusetalkYamlOptions {
  /** 无声说话视频的绝对路径（最好是 inputs/ 下的无空格副本）。 */
  videoPath: string
  /** 16kHz 单声道 wav 的绝对路径。 */
  audioPath: string
  /** 成片文件名（只写名字，不要带目录——目录由 --result_dir 决定）。 */
  resultName: string
}

/**
 * 生成 MuseTalk 的推理配置 yaml。
 *
 * 结构必须是一层 `task_talk:` 再缩进两空格的三行——官方 `inference.py` 是
 * `for task_id in inference_config:` 遍历顶层键，每个键下面必须有 video_path /
 * audio_path，`result_name` 可选（不给就用 `--output_vid_name`）。
 * 顶层键名本身随意（`task_0` 也行），但 yaml 必须是 `task_talk:\n` 开头，
 * 单测按这个前缀断言，别的键名会被当成「结构变了」。
 *
 * 路径里的反斜杠一律换成 `/`：yaml 里反斜杠是转义符，`D:\Tools` 这种裸写会让
 * 解析器把 `\T` 当非法转义，或者被读成制表符，最后报「视频不存在」。
 */
export function buildMusetalkYaml(options: MusetalkYamlOptions): string {
  const slash = (value: string): string => value.replace(/\\/g, '/')
  return (
    'task_talk:\n' +
    `  video_path: ${slash(options.videoPath)}\n` +
    `  audio_path: ${slash(options.audioPath)}\n` +
    `  result_name: ${slash(options.resultName)}\n`
  )
}

export interface MusetalkArgsOptions {
  /** 推理配置的相对路径（相对 musetalkDir，官方按 cwd 解析）。 */
  configPath: string
  unetModelPath: string
  unetConfigPath: string
  whisperDir: string
  /** 结果目录，相对 musetalkDir（官方默认 `./results`）。 */
  resultDir: string
  /** ffmpeg 所在目录；MuseTalk 内部会自己拼 `ffmpeg` 可执行文件名。 */
  ffmpegPath: string
  /** 是否用 float16 推理；默认 true（6GB 显存上不开会 OOM）。 */
  useFloat16?: boolean
}

/**
 * 组装 `python -m scripts.inference` 的参数。
 *
 * 一律用 `--flag value` 两项形式而不是 `--flag=value`：MuseTalk 用 argparse，
 * 两种都认，但 `--flag value` 更好读，单测也是按 `indexOf('--version') + 1` 取值的。
 *
 * `--use_float16` 是 `action='store_true'`，所以它**不带值**——写成
 * `--use_float16 true` 会让 argparse 把 `true` 当成下一个位置参数，直接报错。
 */
export function buildMusetalkArgs(options: MusetalkArgsOptions): string[] {
  const useFloat16 = options.useFloat16 ?? true
  const args = [
    '-m',
    'scripts.inference',
    '--inference_config',
    options.configPath,
    '--result_dir',
    options.resultDir,
    '--unet_model_path',
    options.unetModelPath,
    '--unet_config',
    options.unetConfigPath,
    '--whisper_dir',
    options.whisperDir,
    '--ffmpeg_path',
    options.ffmpegPath,
    '--version',
    'v15',
    // jaw 只重绘下颌+嘴部区域，比 default 更贴脸，边缘接缝也更小。
    '--parsing_mode',
    'jaw'
  ]
  if (useFloat16) args.push('--use_float16')
  return args
}

/**
 * 成片的真实路径：`<resultDir>/<version>/<name>`。
 *
 * 不用 `path.join`：Windows 上它会产出反斜杠，而调用点要把这个相对路径
 * 拼进 `path.join(musetalkDir, ...)` 之外的地方（日志、错误提示），
 * 反斜杠混着正斜杠很难看；更要紧的是单测按正斜杠断言。
 *
 * `resultDir` 的尾斜杠/反斜杠要先削掉，否则会拼出 `results//v15/a.mp4`。
 */
export function musetalkResultPath(resultDir: string, version: string, name: string): string {
  const clean = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const parts = [clean(resultDir), clean(version), clean(name)].filter((part) => part !== '')
  return parts.join('/')
}
