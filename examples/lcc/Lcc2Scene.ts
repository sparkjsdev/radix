// An XGRIDS LCC2 scene (https://github.com/xgrids/LCC2Whitepaper, v0.0.3):
// its meta file (JSON, any name ending in .lcc2) describes an N-ary tree of
// boxes from `root`; each node's data names a row range [start, start +
// count) of one chunk file (root.splatFiles: .sog, .spz or .ply under
// data/3dgs/, one file per node in XGRIDS' exports, or several same-level
// nodes per file), and optionally a collision mesh (root.meshFiles, a .ply)
// and its BVH (root.bvhFiles, a .btree). The root holds no splats, only the
// environment chunk (data.env: background splats, drawn whole); a node at
// depth d holds level totalLevels - d, so the root's children are the
// coarsest level and leaves level 0. Inner nodes hold coarser data for their
// whole subtree, so drawing takes a cut through the tree (lcc2Select.ts).
// The old protocol (total_splats, lod_3dgs_info reversed, lod_level,
// root.files without ".sog", child_num) and trailing commas are read as
// PlayCanvas splat-transform's parseLcc2Meta reads them. The spawn point is
// in info/attrs.json. The tree is flattened into typed arrays in depth-first
// order (node 0 the root). Plain code with no imports but types, so workers
// and the Node checks share it.
import { readOptional, type LccSource, type LccSpawn } from "./LccScene.js";

export type Lcc2SplatType = ".sog" | ".spz" | ".ply";

interface RawNode {
  id?: string;
  boundingBox?: { min: number[]; max: number[] };
  childNum?: number;
  child_num?: number;
  child?: RawNode[] | Record<string, RawNode> | null;
  data?: {
    "3dgs"?: { name: number; start?: number; count?: number };
    mesh?: { name: number; vertex?: number; face?: number };
    bvh?: { name: number };
    env?: { name: number };
  };
  splatFiles?: string[];
  files?: string[];
  meshFiles?: string[];
  bvhFiles?: string[];
}

export interface Lcc2Meta {
  version?: string;
  name?: string;
  description?: string;
  totalSplats: number;
  lodSplats: number[];
  totalLevels: number;
  splatType?: string;
  fileType?: string;
  scale?: number[];
  env?: { type?: string; splatsCount?: number; boundingBox?: { min: number[]; max: number[] } };
  virtualLoD?: unknown;
  renderingHints?: Record<string, string>;
  root: RawNode;
  // Old protocol
  total_splats?: number;
  lod_3dgs_info?: number[];
  lod_level?: number;
}

// Commas before `}` or `]` outside strings dropped (some exporters write them)
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j += 1;
      }
      if (text[j] === "}" || text[j] === "]") {
        continue;
      }
    }
    out += c;
  }
  return out;
}

const childrenOf = (node: RawNode): RawNode[] => (node.child ? (Array.isArray(node.child) ? node.child : Object.values(node.child)) : []);

// The meta's text as the new protocol
export function parseLcc2Meta(text: string): Lcc2Meta {
  let meta: Lcc2Meta;
  try {
    meta = JSON.parse(text) as Lcc2Meta;
  } catch {
    meta = JSON.parse(stripTrailingCommas(text)) as Lcc2Meta;
  }
  if (meta.total_splats !== undefined && meta.lod_3dgs_info !== undefined && meta.lod_level !== undefined) {
    meta.totalSplats = meta.total_splats;
    meta.lodSplats = [...meta.lod_3dgs_info].reverse();
    meta.totalLevels = meta.lod_level;
    meta.root.splatFiles = (meta.root.files ?? []).map((file) => {
      const name = file.startsWith("/") ? file.slice(1) : file;
      return name.endsWith(".sog") ? name : `${name}.sog`;
    });
    const visit = (node: RawNode) => {
      node.childNum ??= node.child_num;
      childrenOf(node).forEach(visit);
    };
    visit(meta.root);
  }
  if (typeof meta.totalLevels !== "number" || !Array.isArray(meta.root?.splatFiles)) {
    throw new Error("Not an LCC2 meta (no totalLevels or root.splatFiles)");
  }
  meta.lodSplats ??= [];
  return meta;
}

export class Lcc2Scene {
  readonly source: LccSource;
  readonly meta: Lcc2Meta;
  // The meta's path among the files, or its URL (files are relative to it)
  readonly metaPath: string;
  readonly levels: number;
  readonly splatType: Lcc2SplatType;
  readonly splatFiles: string[];
  readonly meshFiles: string[];
  readonly bvhFiles: string[];
  // The environment's index in splatFiles, if any
  readonly envFile?: number;
  // Quality files have SH
  readonly sh: boolean;
  readonly spawn?: LccSpawn;

  // Per node, in depth-first order (node 0 the root)
  readonly nodes: number;
  readonly ids: string[];
  readonly parent: Int32Array;
  readonly depth: Uint8Array;
  // totalLevels - depth (the root's is totalLevels)
  readonly level: Int8Array;
  // Children of node n: children[firstChild[n] .. firstChild[n] + childCount[n])
  readonly firstChild: Int32Array;
  readonly childCount: Int32Array;
  readonly children: Int32Array;
  // min xyz, max xyz in the file's frame
  readonly bounds: Float32Array;
  // Splat range: file -1 for none (the root, nodes without data)
  readonly file: Int32Array;
  readonly start: Uint32Array;
  readonly count: Uint32Array;
  // Collision mesh and BVH file indices (-1 for none), with the meta's counts
  readonly mesh: Int32Array;
  readonly bvh: Int32Array;
  readonly meshVertices: Uint32Array;
  readonly meshFaces: Uint32Array;
  // Per splat file: its nodes (all of one level), its level and its splats
  readonly fileNodes: number[][];
  readonly fileLevel: Int8Array;
  readonly fileSplats: Uint32Array;

  private constructor(source: LccSource, metaPath: string, meta: Lcc2Meta, spawn?: LccSpawn) {
    this.source = source;
    this.metaPath = metaPath;
    this.meta = meta;
    this.spawn = spawn;
    this.levels = meta.totalLevels;
    const type = (meta.splatType ?? ".sog").toLowerCase();
    this.splatType = type === ".spz" || type === ".ply" ? type : ".sog";
    const root = meta.root;
    this.splatFiles = root.splatFiles ?? [];
    this.meshFiles = root.meshFiles ?? [];
    this.bvhFiles = root.bvhFiles ?? [];
    this.envFile = root.data?.env?.name;
    this.sh = (meta.fileType ?? "").toLowerCase() === "quality";

    const raw: { node: RawNode; parent: number; depth: number }[] = [];
    const childLists: number[][] = [];
    const visit = (node: RawNode, parent: number, depth: number) => {
      const index = raw.length;
      raw.push({ node, parent, depth });
      childLists.push([]);
      if (parent >= 0) {
        childLists[parent].push(index);
      }
      for (const child of childrenOf(node)) {
        visit(child, index, depth + 1);
      }
    };
    visit(root, -1, 0);

    const n = raw.length;
    this.nodes = n;
    this.ids = raw.map(({ node }, i) => node.id ?? String(i));
    this.parent = Int32Array.from(raw, ({ parent }) => parent);
    this.depth = Uint8Array.from(raw, ({ depth }) => depth);
    this.level = Int8Array.from(raw, ({ depth }) => meta.totalLevels - depth);
    this.firstChild = new Int32Array(n);
    this.childCount = new Int32Array(n);
    this.children = new Int32Array(Math.max(0, n - 1));
    let at = 0;
    childLists.forEach((list, i) => {
      this.firstChild[i] = at;
      this.childCount[i] = list.length;
      this.children.set(list, at);
      at += list.length;
    });
    this.bounds = new Float32Array(n * 6);
    this.file = new Int32Array(n).fill(-1);
    this.start = new Uint32Array(n);
    this.count = new Uint32Array(n);
    this.mesh = new Int32Array(n).fill(-1);
    this.bvh = new Int32Array(n).fill(-1);
    this.meshVertices = new Uint32Array(n);
    this.meshFaces = new Uint32Array(n);
    this.fileNodes = this.splatFiles.map(() => []);
    this.fileLevel = new Int8Array(this.splatFiles.length).fill(-1);
    this.fileSplats = new Uint32Array(this.splatFiles.length);
    raw.forEach(({ node }, i) => {
      const box = node.boundingBox;
      if (box) {
        this.bounds.set(box.min.slice(0, 3), i * 6);
        this.bounds.set(box.max.slice(0, 3), i * 6 + 3);
      }
      const splats = node.data?.["3dgs"];
      if (i > 0 && splats && splats.name !== this.envFile && splats.name >= 0 && splats.name < this.splatFiles.length && (splats.count ?? 0) > 0) {
        this.file[i] = splats.name;
        this.start[i] = splats.start ?? 0;
        this.count[i] = splats.count ?? 0;
        this.fileNodes[splats.name].push(i);
        this.fileLevel[splats.name] = this.level[i];
        this.fileSplats[splats.name] = Math.max(this.fileSplats[splats.name], this.start[i] + this.count[i]);
      }
      const mesh = node.data?.mesh;
      const bvh = node.data?.bvh;
      if (mesh && bvh && mesh.name >= 0 && mesh.name < this.meshFiles.length && bvh.name >= 0 && bvh.name < this.bvhFiles.length) {
        this.mesh[i] = mesh.name;
        this.bvh[i] = bvh.name;
        this.meshVertices[i] = mesh.vertex ?? 0;
        this.meshFaces[i] = mesh.face ?? 0;
      }
    });
  }

  // The scene's folder name, else the meta's name
  get name() {
    const path = this.source.kind === "url" ? decodeURIComponent(new URL(this.source.meta).pathname) : this.metaPath;
    return path.split("/").filter(Boolean).slice(-2, -1)[0] ?? this.meta.name ?? "lcc2";
  }

  // The root's box (the environment is outside it)
  get box(): { min: [number, number, number]; max: [number, number, number] } {
    const b = this.bounds;
    return { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] };
  }

  get hasCollision() {
    return this.mesh.some((m) => m >= 0);
  }

  isLeaf(node: number) {
    return this.childCount[node] === 0;
  }

  // A file the meta names (relative to the meta), as the source reads it
  path(name: string) {
    if (this.source.kind === "url") {
      return name;
    }
    const folder = this.metaPath.includes("/") ? this.metaPath.slice(0, this.metaPath.lastIndexOf("/") + 1) : "";
    return folder + name;
  }

  // A whole file named by the meta; dropped files fall back to its base name
  // (drops without the folders), as PlayCanvas's reader does
  async read(name: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await readOptional(this.source, this.path(name), signal)
      ?? (this.source.kind === "files" ? await readOptional(this.source, name.split("/").pop()!, signal) : undefined);
    if (!bytes) {
      throw new Error(`${name}: not found`);
    }
    return bytes;
  }

  static isMetaName(name: string) {
    return name.toLowerCase().endsWith(".lcc2");
  }

  static async open(source: LccSource): Promise<Lcc2Scene> {
    let text: string;
    let metaPath: string;
    if (source.kind === "url") {
      const response = await fetch(source.meta);
      if (!response.ok) {
        throw new Error(`${source.meta}: HTTP ${response.status}`);
      }
      text = await response.text();
      metaPath = source.meta;
    } else {
      const entry = source.files.filter(({ path }) => Lcc2Scene.isMetaName(path)).sort((a, b) => a.path.length - b.path.length)[0];
      if (!entry) {
        throw new Error("No .lcc2 meta file among the files");
      }
      text = await entry.file.text();
      metaPath = entry.path;
    }
    const meta = parseLcc2Meta(text);
    const scene = new Lcc2Scene(source, metaPath, meta);
    let spawn: LccSpawn | undefined;
    try {
      const attrs = await readOptional(source, scene.path("info/attrs.json"));
      const point = attrs && (JSON.parse(new TextDecoder().decode(attrs)) as { spawnPoint?: LccSpawn | null }).spawnPoint;
      spawn = point?.position && point.rotation ? point : undefined;
    } catch {
      spawn = undefined;
    }
    return spawn ? new Lcc2Scene(source, metaPath, meta, spawn) : scene;
  }
}
