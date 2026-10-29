// A kind of fractal: its parameters (each one a uniform the writer reads),
// the writer that bakes its samples, and the look it wants.
import * as THREE from "three";
import { TSL,                                   } from "@sparkjsdev/radix";
                                       

const { uniform } = TSL;

                        
                
              
              
                
                 
 

                                                              

                       
             
                
                 
                                
                                    
                                             
                               
                                                        
                                                     
                                                                   
                       
                                                       
                  
 

// What every writer reads besides its kind's parameters
export function makeBakeUniforms() {
  return {
    seed: uniform(0, "uint"),
    // Samples in the bake
    count: uniform(1),
    // 0: rays from all around the fractal, 1: from the camera (eye, basis
    // and frustum tangents, display units)
    fromCamera: uniform(0),
    eye: uniform(new THREE.Vector3()),
    forward: uniform(new THREE.Vector3(0, 0, -1)),
    right: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    tanX: uniform(1),
    tanY: uniform(1),
    lightDir: uniform(new THREE.Vector3(0, 1, 0)),
    // Splat size relative to the sample spacing
    coverage: uniform(1),
    // Sphere-tracing steps per ray
    maxSteps: uniform(200),
  };
}
                                                               

export function paramUniforms(params                       ) {
  return Object.fromEntries(Object.entries(params).map(([key, param]) => [key, uniform(param.value)]))                           ;
}


//# sourceURL=examples/fractals/kind.ts