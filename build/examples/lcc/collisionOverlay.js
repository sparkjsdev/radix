// The collision debug overlay: under the scene's `model` (so in the file's
// frame), a wireframe of every loaded collision chunk in a color of its own,
// each chunk's box (bright once loaded), optionally the BVH's boxes at one
// depth (leaves above it included) for the chunk nearest the camera, and the
// walker's capsule and last ground hit. Lines are drawn after the splats,
// without a depth test by default (an x-ray view).
import * as THREE from "three";
import { BVH_NODE_BYTES, isLeaf, rightChild,                                } from "./collision.js";
                                                            

                                  
                
                 
                  
                                               
                    
                     
                  
 

const PALETTE = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ff924c", "#52a675", "#c77dff", "#4cc9f0", "#f15bb5"];

// The 12 edges of each box as line segment pairs
function boxLines(boxes            )               {
  const out = new Float32Array(boxes.length * 72);
  let at = 0;
  const corner = (b          , i        ) => [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const b of boxes) {
    for (const [i, j] of edges) {
      out.set(corner(b, i), at);
      out.set(corner(b, j), at + 3);
      at += 6;
    }
  }
  return out;
}

// The BVH's boxes at `depth`, and leaves above it
function bvhBoxes(chunk                , depth        )             {
  const { bvh } = chunk;
  const out             = [];
  const stack                     = [[0, 0]];
  while (stack.length > 0 && out.length < 100_000) {
    const [at, d] = stack.pop() ;
    if (at + BVH_NODE_BYTES > bvh.byteLength) {
      continue;
    }
    if (d === depth || isLeaf(bvh, at)) {
      out.push(Array.from({ length: 6 }, (_, k) => bvh.getFloat32(at + k * 4, true)));
      continue;
    }
    stack.push([rightChild(bvh, at), d + 1], [at + BVH_NODE_BYTES, d + 1]);
  }
  return out;
}

export class CollisionOverlay {
           group = new THREE.Group();
                   meshes = new Map                            ();
                   boxes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true }));
                   leaves = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#00e5ff", transparent: true }));
                   capsule = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#7CFC00", transparent: true }));
          stream                  ;
          boxesKey = "";
          leavesKey = "";

  constructor() {
    this.group.name = "collision overlay";
    this.group.add(this.boxes, this.leaves, this.capsule);
    for (const lines of [this.boxes, this.leaves, this.capsule]) {
      lines.renderOrder = 10;
      lines.frustumCulled = false;
    }
  }

  attach(stream                             ) {
    this.clear();
    this.stream = stream;
  }

          clear() {
    for (const lines of this.meshes.values()) {
      lines.geometry.dispose();
      (lines.material                  ).dispose();
      this.group.remove(lines);
    }
    this.meshes.clear();
    this.boxesKey = this.leavesKey = "";
    this.setLines(this.boxes, new Float32Array(0));
    this.setLines(this.leaves, new Float32Array(0));
    this.setLines(this.capsule, new Float32Array(0));
  }

          setLines(lines                    , positions              ) {
    lines.geometry.dispose();
    lines.geometry = new THREE.BufferGeometry();
    lines.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  }

  // Once per frame: the eye (file frame) picks the chunk whose BVH boxes show;
  // the walker's feet and capsule, when walking
  update(settings                 , eye      , walker                                                                       ) {
    const stream = this.stream;
    this.group.visible = stream !== undefined && (settings.mesh || settings.boxes || settings.leaves || walker !== undefined);
    if (!stream || !this.group.visible) {
      return;
    }
    const chunks = stream.set.chunks;
    // Wireframes of the loaded chunks
    for (const [id, lines] of this.meshes) {
      if (!chunks.has(id)) {
        lines.geometry.dispose();
        (lines.material                  ).dispose();
        this.group.remove(lines);
        this.meshes.delete(id);
      }
    }
    if (settings.mesh) {
      stream.entries.forEach((entry, i) => {
        const chunk = chunks.get(entry.id);
        if (chunk && !this.meshes.has(entry.id)) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(chunk.vertices, 3));
          geometry.setIndex(new THREE.BufferAttribute(chunk.faces, 1));
          const lines = new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color: PALETTE[i % PALETTE.length], transparent: true }));
          geometry.dispose();
          lines.renderOrder = 10;
          lines.frustumCulled = false;
          this.meshes.set(entry.id, lines);
          this.group.add(lines);
        }
      });
    }
    for (const lines of this.meshes.values()) {
      lines.visible = settings.mesh;
    }

    // Chunk boxes, rebuilt when what is loaded changes
    const key = settings.boxes ? stream.entries.map((entry) => entry.state).join() : "";
    if (key !== this.boxesKey) {
      this.boxesKey = key;
      this.setLines(this.boxes, settings.boxes ? boxLines(stream.entries.map((entry) => Array.from(entry.box))) : new Float32Array(0));
    }
    this.boxes.visible = settings.boxes;

    // BVH boxes of the nearest loaded chunk
    let nearest                            ;
    let best = Infinity;
    if (settings.leaves) {
      for (const chunk of chunks.values()) {
        const b = chunk.box;
        const d = Math.hypot(Math.max(b[0] - eye.x, 0, eye.x - b[3]), Math.max(b[1] - eye.y, 0, eye.y - b[4]), Math.max(b[2] - eye.z, 0, eye.z - b[5]));
        if (d < best) {
          best = d;
          nearest = chunk;
        }
      }
    }
    const leavesKey = nearest ? `${nearest.id}|${settings.leafDepth}` : "";
    if (leavesKey !== this.leavesKey) {
      this.leavesKey = leavesKey;
      this.setLines(this.leaves, nearest ? boxLines(bvhBoxes(nearest, Math.max(0, Math.round(settings.leafDepth)))) : new Float32Array(0));
    }
    this.leaves.visible = settings.leaves;

    // The walker: two rings and four lines of its capsule, a cross at the hit
    if (walker) {
      this.setLines(this.capsule, capsuleLines(walker));
    }
    this.capsule.visible = walker !== undefined;

    for (const lines of [...this.meshes.values(), this.boxes, this.leaves, this.capsule]) {
      const material = lines.material                           ;
      material.opacity = settings.opacity;
      material.depthTest = settings.depthTest;
      material.depthWrite = false;
    }
  }

  dispose() {
    this.clear();
  }
}

function capsuleLines({ feet, up, radius, height, hit }                                                                      )               {
  const u = new THREE.Vector3(up.x, up.y, up.z).normalize();
  const a = new THREE.Vector3(1, 0, 0);
  if (Math.abs(a.dot(u)) > 0.9) {
    a.set(0, 1, 0);
  }
  const s = a.clone().cross(u).normalize();
  const t = u.clone().cross(s).normalize();
  const base = new THREE.Vector3(feet.x, feet.y, feet.z);
  const out           = [];
  const point = (h        , angle        , r = radius) => base.clone().addScaledVector(u, h).addScaledVector(s, Math.cos(angle) * r).addScaledVector(t, Math.sin(angle) * r);
  const segments = 24;
  for (const h of [radius, height - radius]) {
    for (let i = 0; i < segments; i += 1) {
      out.push(...point(h, (i / segments) * Math.PI * 2).toArray(), ...point(h, ((i + 1) / segments) * Math.PI * 2).toArray());
    }
  }
  for (let i = 0; i < 4; i += 1) {
    out.push(...point(radius, (i / 4) * Math.PI * 2).toArray(), ...point(height - radius, (i / 4) * Math.PI * 2).toArray());
  }
  if (hit) {
    const c = new THREE.Vector3(hit.x, hit.y, hit.z);
    const r = radius * 0.6;
    out.push(...c.clone().addScaledVector(s, -r).toArray(), ...c.clone().addScaledVector(s, r).toArray());
    out.push(...c.clone().addScaledVector(t, -r).toArray(), ...c.clone().addScaledVector(t, r).toArray());
  }
  return new Float32Array(out);
}


//# sourceURL=examples/lcc/collisionOverlay.ts