// SOG images: WebP bytes into ImageBitmaps (decoded off the main thread),
// and their exact RGBA bytes. A 2D canvas would premultiply alpha (SOG keeps
// data there: the quaternion mode, 252 to 255), so the bytes are read back
// through WebGL2, which uploads an ImageBitmap made without premultiplying
// or color conversion as it is.

                         
                                
                
                 
 

export function decodeBitmap(bytes                         )                       {
  return createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

let gl                                    ;
let texture                      = null;
let framebuffer                          = null;

export function readPixels(bitmap             )         {
  if (!gl) {
    const context = new OffscreenCanvas(1, 1).getContext("webgl2");
    if (!context) {
      throw new Error("Reading SOG images needs WebGL2");
    }
    gl = context;
    texture = gl.createTexture();
    framebuffer = gl.createFramebuffer();
  }

  const { width, height } = bitmap;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const rgba = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  // Drop the image's storage until the next one
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return { rgba, width, height };
}

export async function decodePixels(bytes                         )                  {
  const bitmap = await decodeBitmap(bytes);
  try {
    return readPixels(bitmap);
  } finally {
    bitmap.close();
  }
}


//# sourceURL=examples/sogs/webp.ts