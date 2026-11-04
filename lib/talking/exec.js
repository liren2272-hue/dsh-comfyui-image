/**
 * 子进程执行：把「拼好的命令行」跑起来，收齐 stdout / stderr，再连同退出码一起交回。
 *
 * 为什么不用 `execFile` / `exec`：
 *   1. 这两个 API 在超时后自己 kill，但拿不到「是不是我杀的」这个信息，也没法追加自定义说明；
 *   2. `exec` 走 shell，Windows 上参数里带空格/中文时会被再解释一遍，`--text` 传台词必炸；
 *   3. 我们需要在超时、调用方取消、进程起不来这三种情况下都能**统一**返回一个
 *      `{ code, stdout, stderr }`，让上层的 `assertExit` 决定报什么错——而不是这里抛、那里抛。
 *
 * 踩过的坑：
 *   - **失败也 resolve，不 reject**。`spawn` 的 `'error'`（比如 ENOENT：python.exe 路径配错）
 *     如果直接 reject，上层每个调用点都要写两套错误处理；统一塞进 stderr、把 code 置 null，
 *     上层只认「code !== 0 就是失败」一条规则，错误信息自然带出真实原因。
 *   - **'error' 之后 'close' 还会来**（Node 的 ChildProcess 就是这么设计的），
 *     不做重入保护会二次 resolve（虽然 Promise 忽略，但定时器/监听器就漏了）。
 *   - **定时器必须 clear**，否则一次 10 分钟超时的任务跑完后，进程还会被这个 timer 吊着不退出。
 *   - **别假设 child 有 pid / killed**。单测里的假 spawn 只给了 stdout / stderr / kill / on，
 *     真进程才有的属性一律不碰。
 *   - Windows 上 `spawn` 会闪黑窗，`windowsHide: true` 必须给。
 */
import { spawn as nodeSpawn } from 'node:child_process'
                                               

/** 传给 spawn 的选项里我们真正会用到的几个。 */
                                   
              
                         
                       
 

/**
 * 子进程的最小形状：只声明我们真的会用到的东西。
 *
 * 故意不写成 `ChildProcess`：单测里的假 spawn 给的是裸 `EventEmitter` + 两个流，
 * 没有 pid、没有 killed，用 `ChildProcess` 会逼着测试去造假属性。
 */
                                   
                             
                             
                                                     
                                                                    
 

/**
 * 可注入的 spawn。第三个参数是可选的，所以「只接两个参数的假实现」也能直接传进来。
 */
                            
                                                                                 
 

                          
                                
                   
 

                            
                                               
                     
                
                
 

/** 要跑的一条命令。与 `tts.ts` 里的 `CommandPlan` 兼容，可以直接展开。 */
                          
                 
                
              
                         
                                    
                    
                                
                      
 

/** 默认的 spawn：包一层，把 Node 的 `ChildProcess` 收敛到上面那个最小形状。 */
const defaultSpawn            = (command, args, options) =>
  nodeSpawn(command, args, options ?? {})                               

/** 把一堆 chunk 拼成一个字符串（Node 的流给的是 Buffer，但假 spawn 可能给别的）。 */
function toText(chunks          )         {
  return Buffer.concat(chunks).toString('utf8')
}

/** 往已有文本末尾追加一行说明，顺手保证不会粘在上一行屁股上。 */
function appendLine(current        , line        )         {
  if (current === '') return `${line}\n`
  return current.endsWith('\n') ? `${current}${line}\n` : `${current}\n${line}\n`
}

/**
 * 跑一条命令，收齐输出。
 *
 * 永远不会 reject：超时 / 取消 / 起不来都通过 `code === null` + stderr 说明表达，
 * 由上层 `assertExit` 统一翻成带 hint 的插件错误。
 */
export async function runProcess(plan         , deps          = {})                     {
  const spawn = deps.spawn ?? defaultSpawn
  const outChunks           = []
  const errChunks           = []

  return new Promise           ((resolve) => {
    let settled = false
    let timer                            
    let onAbort                          
    const signal = plan.signal

    /** 收尾：只允许走一次，顺手把定时器与 abort 监听摘干净。 */
    const finish = (code               , extraStderr         )       => {
      if (settled) return
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
        onAbort = undefined
      }
      const stderr = extraStderr === undefined ? toText(errChunks) : appendLine(toText(errChunks), extraStderr)
      resolve({ code, stdout: toText(outChunks), stderr })
    }

    // 起进程本身也可能同步抛（参数非法等），别让它变成未捕获异常。
    let child                  
    try {
      const options                   = { windowsHide: true }
      if (plan.cwd !== undefined) options.cwd = plan.cwd
      if (plan.env !== undefined) options.env = plan.env
      child = spawn(plan.command, plan.args, options)
    } catch (error) {
      finish(null, `[启动失败] ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    child.stdout?.on('data', (chunk         ) => {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })
    child.stderr?.on('data', (chunk         ) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    })

    // 进程起不来（ENOENT / EACCES）：记下原因就收尾，让上层报「退出码 null」。
    child.on('error', (error         ) => {
      const message = error instanceof Error ? error.message : String(error)
      finish(null, `[启动失败] ${message}`)
    })

    // 'close' 只来一次，但 error 之后还会再来一次，所以必须靠 settled 挡住。
    child.on('close', (code         ) => {
      finish(typeof code === 'number' ? code : null)
    })

    // 超时：先杀，再以 code = null 收尾。这里不等 'close'——kill 不一定成功，
    // 等下去可能永远不回来（假 spawn 的 kill 就是空实现）。
    if (typeof plan.timeoutMs === 'number' && plan.timeoutMs > 0) {
      const ms = plan.timeoutMs
      timer = setTimeout(() => {
        timer = undefined
        try {
          child.kill()
        } catch {
          // 进程可能已经自己退了，杀不掉不算错。
        }
        finish(null, `[超时] 命令超过 ${ms} 毫秒未结束，已终止。`)
      }, ms)
      // 不能 unref：单测里的假 spawn 没有任何真实 handle，unref 之后事件循环立刻空掉，
      // 进程直接退出，超时回调永远不触发（表现为「await 卡死」）。正常结束靠 finish 里的 clearTimeout。
    }

    // 调用方取消：已经 abort 的立刻杀；还没 abort 的挂上监听（once，避免重复触发）。
    if (signal) {
      const killForAbort = ()       => {
        try {
          child.kill()
        } catch {
          // 同上。
        }
        finish(null, '[取消] 调用方已中止，命令被终止。')
      }
      if (signal.aborted) {
        killForAbort()
        return
      }
      onAbort = killForAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 这些前缀是工具自己打的噪声，不是「失败原因」。 */
const NOISE_PREFIXES = ['WARNING', 'INFO', 'DEBUG']         

/**
 * 取 stderr 里最有信息量的那一行：跳过空行与 WARNING / INFO / DEBUG 开头的噪声行，
 * 返回最后一行的 trim 结果。
 *
 * 为什么取最后一行而不是第一行：python 的 traceback 把真正的异常类型与消息放在最后，
 * 第一行往往只是 `Traceback (most recent call last):`。
 *
 * 判定就是 `trim()` 之后 `startsWith`（大小写不敏感），不去猜 `[WARNING]` 这种包装——
 * 猜错了反而会把真正的错误行当噪声丢掉。
 */
export function lastMeaningfulLine(text        , fallback = '')         {
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (line === '') continue
    const upper = line.toUpperCase()
    if (NOISE_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    return line
  }
  return fallback
}
