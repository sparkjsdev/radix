// The three looks of the editor: the same behavior with a different skin
// (fxedit.css under body[data-theme]) and different motion and effects.
                                                    

                               
                                                                 
                    
                  
                                                                    
               
                                         
                 
                                                                
                  
 

                        
                  
                
                       
                                                                      
                          
                                          
                                                                          
                   
                   
 

export const THEMES                           = {
  neon: {
    name: "neon",
    label: "Neon Circuit",
    motion: { stiffness: 340, damping: 0.7, tilt: 0.012, squash: 3, stagger: 0.25 },
    wire: "bezier",
    burst: "sparks",
    overlay: false,
    colors: ["#39f3ff", "#ff3df2", "#b8ff3d", "#ffe53d"],
  },
  toybox: {
    name: "toybox",
    label: "Toybox",
    motion: { stiffness: 230, damping: 0.45, tilt: 0.025, squash: 6, stagger: 0.6 },
    wire: "rope",
    burst: "confetti",
    overlay: false,
    colors: ["#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff", "#c77dff"],
  },
  glass: {
    name: "glass",
    label: "Lab Glass",
    motion: { stiffness: 150, damping: 1, tilt: 0, squash: 0.8, stagger: 0.15 },
    wire: "bezier",
    burst: "ripple",
    overlay: true,
    colors: ["#9fd8ff", "#d3b8ff", "#b8ffe4"],
  },
};

export function themeByName(name                           )                    {
  return name && name in THEMES ? THEMES[name             ] : undefined;
}


//# sourceURL=examples/fxedit/themes.ts