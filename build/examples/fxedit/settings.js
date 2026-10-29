// Editor settings, saved in localStorage ("radix-fxedit"): the theme, motion
// (per theme, so each look keeps its tuning), flow speed, sound, layout.
import { THEMES,                                   } from "./themes.js";

                                 
                   
                                                  
                   
                                          
                                   
                    
                 
                 
                                                  
                
                                                                         
                                          
                 
                       
                       
                      
 

const KEY = "radix-fxedit";

export function defaultSettings()                 {
  return {
    theme: "glass",
    instant: false,
    motion: {
      neon: { ...THEMES.neon.motion },
      toybox: { ...THEMES.toybox.motion },
      glass: { ...THEMES.glass.motion },
    },
    flowSpeed: 0.7,
    muted: true,
    volume: 0.5,
    split: 0.56,
    hiDpi: false,
    hiDpiScenes: true,
    layerSpacing: 48,
    nodeSpacing: 22,
  };
}

export function loadSettings()                 {
  const settings = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}")                           ;
    const { motion, ...rest } = saved;
    Object.assign(settings, rest);
    for (const name of Object.keys(settings.motion)               ) {
      Object.assign(settings.motion[name], motion?.[name]);
    }
    if (!(settings.theme in THEMES)) {
      settings.theme = "glass";
    }
  } catch {
    // Unreadable settings: the defaults
  }
  return settings;
}

export function saveSettings(settings                ) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or full storage: settings last for this page only
  }
}


//# sourceURL=examples/fxedit/settings.ts