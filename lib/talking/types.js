/**
 * 「说话视频」工具（generate_talking_video）的类型与常量。
 *
 * 这条链把三件事串起来，任何一环都可以单独替换：
 *   ① 台词（文本）→ 语音 wav   —— TTS：IndexTTS-2（参考音频克隆音色 + 情绪控制）或 edge-tts（现成音色）
 *   ② 画面（图 / 视频 / 文字）→ 一段无声的「对着镜头说话」视频 —— 复用 Wan2.2 图生视频
 *   ③ 语音 + 视频 → 口型对得上的成片 —— MuseTalk 1.5 只重绘嘴部
 *
 * 为什么单独做一个工具而不是给 generate_video 加参数：
 *   generate_video 的契约是「画面怎么动」，这里的契约是「说什么、谁的声音、嘴对不对」，
 *   参数集和失败原因完全不同；混在一起会让模型把 script 塞进 prompt 里。
 */

/** 三种输入形态。 */
                                                                            

/** 全部模式（顺序即文档顺序）。 */
export const TALKING_MODES                         = ['text2talking', 'image2talking', 'video2talking']

export function isTalkingMode(value         )                       {
  return typeof value === 'string' && (TALKING_MODES                     ).includes(value)
}

/** TTS 引擎。 */
                                           

export const TTS_ENGINES                       = ['indextts', 'edge']

export function isTtsEngine(value         )                     {
  return typeof value === 'string' && (TTS_ENGINES                     ).includes(value)
}

/** IndexTTS 的合成语言（它只支持这两个，传别的会被 argparse 拒绝）。 */
                                      

export const INDEXTTS_LANGS                          = ['ZH', 'EN']

export function isIndexTtsLang(value         )                        {
  return typeof value === 'string' && (INDEXTTS_LANGS                     ).includes(value)
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
]         

                                                                 

/** 工具入参（与 tool.ts 的 schema 一一对应）。 */
                                      
                    
                 
                 
                                         
                           
                                                  
                       
                                        
                    
                                 
                           
                            
                     
                            
                          
                     
               
                      
                      
                 
                          
                  
              
                
                 
               
                      
                                         
 

/** 归一化后的请求（所有默认值已填、冲突已校验）。 */
                                           
                   
                       
                
                
                                      
                        
                                         
                      
                   
                         
                    
                         
                   
              
                     
                     
                                             
                
                         
                               
                  
             
               
                
              
                     
                 
 

/** 一次运行的结果。 */
                                 
              
                 
                       
                   
                       
                      
                      
                
             
               
                
                
                
                    
              
                   
                       
                 
                    
                   
                   
 
