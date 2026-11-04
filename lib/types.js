/**
 * 全插件共享的类型定义。
 *
 * 设计原则（对应需求书第五节「统一抽象参数层」）：
 *   - `GenerateImageArgs`   = **对外**契约，就是 Agent 看到的那些参数，尽量少、尽量好懂。
 *   - `NormalizedRequest`   = **对内**契约，默认值全部填好、模式已确定、路径已解析，
 *                            后面所有模块（工作流构建 / 执行 / 落盘）只认它。
 *   两层分开的好处：以后要改 ComfyUI 细节，只动工作流模块；要加对外参数，只动 args + params。
 */

/** V1 对 Agent 暴露的四种操作模式。 */
                                                                                   

/** 顺序即「模式推断」的判定顺序，别随意改。 */
export const GENERATE_MODES                          = [
  'text2img',
  'img2img',
  'inpaint',
  'remove_background'
]

export function isGenerateMode(value         )                        {
  return typeof value === 'string' && (GENERATE_MODES                     ).includes(value)
}

/**
 * 统一的对外参数层。
 *
 * 刻意**不**把 ComfyUI 的底层参数原样倒出来；只保留真正需要调的旋钮，
 * 其余（batch_size、vae、clip skip、节点 id……）由插件自己决定。
 *
 * `style_reference` / `character_reference` / `extra_options` 属于**预留位**：
 * V1 会接收并存进元数据，但不会真的改变生成结果（详见 README 的「一致性」一节）。
 */
                                    
                                                               
                     
                                                                    
                 
                           
                          
                                                             
                      
                                             
                     
                                                  
                
                             
                 
                                                
               
                                  
                      
                     
                          
                     
                              
                                                         
                   
                    
                
                        
                    
                                                              
                
                            
                       
                            
                    
                                                          
                                         
 

/**
 * 归一化后的请求：默认值已填、模式已定、路径已解析。
 * 所有下游模块只依赖这个结构。
 */
                                    
                    
                
                        
                                       
                     
                    
                         
                             
                            
               
                
     
                                          
                                                          
     
                        
                         
              
                  
               
                  
     
                                   
                                                      
                          
     
                        
                      
                          
                            
                                 
                    
                     
                   
                                
                    
                                                      
                 
                   
                                
 

/** ComfyUI API 格式工作流中的一个节点。 */
                            
                    
                                          
                                 
                            
 

/** ComfyUI API 格式工作流：节点 id → 节点。 */
                                                     

/** ComfyUI `/history` 里描述一张产出图片的结构。 */
                                
                  
                   
              
 

/** 一次生成的成功结果。 */
                                    
                                  
                       
                                   
                       
                                            
                           
                               
                  
                          
                  
                         
                    
                          
                            
 

/** 插件配置：全部可选，来源见 config.ts。 */
                                    
                  
                    
                     
                         
                
                   
                      
                    
                
                 
                   
                          
                    
                         
                           
                    
                         
                         

                                             
                                                    
                     
                             
                    
                                     
                   
                              
                     
                      
                   
                       
                     
                        
                     
                           
                         
                         

                                         
                                                
                    
                                 
                            
                    
                   
                                 
                      
                         
                                                 
                      
                         
                                                         
                    
                 
                  
                           
 

/**
 * 解析完毕、可以放心使用的配置。
 *
 * 刻意**显式**列出每个键，而不是写 `Required<Omit<PluginConfigInput, ...>>`：
 * 那种映射类型一旦源接口带索引签名，TS 会把所有具名属性塌进索引签名，
 * 于是 `config.width` 就变成 `unknown` 了（踩过，编译器会直接报出来）。
 */
                                 
                 
                    
                     
                        
               
                  
                     
                   
               
                
                  
                         
                   
                        
                          
                    
                        
                        

                                             
                     
                    
                   
                             
                    
                     
                  
                      
                    
                       
                    
                          
                        
                        

                                         
                   
                           
                   
                  
                     
                        
                     
                        
                   
                
                 
                          
 
