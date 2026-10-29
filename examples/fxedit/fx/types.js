// Node definitions: a TSL building block plus the metadata an editor needs
// (typed ports with defaults and UI ranges, options, attribution). A graph
// (graph.ts) wires nodes by id; buildGraphModifier (graphModifier.ts)
// builds it into a Radix SplatModifier.
                                                            

// Port types. color is a vec3 shown with a color picker; a bool param is a
// float uniform (above 0.5: true).
                                                                             

                                                

                           
                 
                 
                                                                             
                                                              
                     
                  
               
               
                
                 
 

// Choices that change the program (enums, loop counts); part of the key
                            
                           
                     
               
               
 

// effect: whole effects ported as one node (macro nodes); group: instances
// of a graph's groups and their boundary nodes (graph.ts)
                                                                                               

                             
               
              
                  
 

                               
                                                                            
                    
                                         
                   
                                    
                 
                                                         
                
                                                                            
                                                 
                                          
                                                                        
                                                     
                                                                      
                                        
 

                          
                                      
             
                
                                             
                       
                         
                                   
                                    
                                      
                   
                 
                    
                  
                                                                    
                   
                                                                      
                   
                      
                                                                                     
 

// Components of a port type's values (bool is one)
export const PORT_COMPONENTS                           = { float: 1, bool: 1, vec2: 2, vec3: 3, color: 3, vec4: 4 };


//# sourceURL=examples/fxedit/fx/types.ts