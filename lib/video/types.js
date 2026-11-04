/**
 * 视频模式共享类型。
 *
 * 和图片模式的 types.ts 一样分两层：
 *   - `GenerateVideoArgs`         = 对外契约（Agent 看到的参数）
 *   - `NormalizedVideoRequest`    = 对内契约（默认值填好、帧数已对齐、路径已解析）
 */

/** V1 暴露的两种视频模式。 */
                                                  

/** 顺序即「模式推断」的判定顺序。 */
export const VIDEO_MODES                       = ['text2video', 'img2video']

export function isVideoMode(value         )                     {
  return typeof value === 'string' && (VIDEO_MODES                     ).includes(value)
}

/** 统一的对外参数层（generate_video 的全部旋钮）。 */
                                    
                                                    
                  
                   
                 
                          
                          
                              
                      
                                     
                  
                  
              
                                     
                
                                     
                 
                                        
               
                                 
                
                               
                    
                                            
                
                              
                      
                                      
                
                                                  
                                         
 

/** 归一化后的视频请求。 */
                                         
                 
                
                        
                                
                     
               
                
                        
                
                           
                 
                                    
                       
             
              
               
                  
               
                     
                   
                               
              
                    
                 
                                
 
