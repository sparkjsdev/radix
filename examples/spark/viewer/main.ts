// Spark's viewer: drop, choose or paste a splat file, fly around it and save it
// as SPZ. Spark also reads .splat, .ksplat and SOGS .zip files, Radix only PLY,
// SPZ, RAD and RDX.
//   ?url=  a splat file URL to open, none by default
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer, loadSplatFile, writeSplats, type ArrayData, type ShPalette } from "@sparkjsdev/radix";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, fileOf, releaseFile } from "../js/files.js";

const page = examplePage("viewer", { note: "no .splat / .ksplat / .zip / .sog; no spherical harmonics" });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 1);

const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "fly" } });

// Most captures are stored upside down: half a turn about x
const holder = new THREE.Object3D();
holder.quaternion.set(1, 0, 0, 0);
scene.add(holder);

const splats = new SplatRenderer({ renderer });
scene.add(splats);

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = element("start");
const drop = element("drop");
const save = element<HTMLButtonElement>("save");
const fileInput = element<HTMLInputElement>("file");
const urlInput = element<HTMLInputElement>("url");

let shown: { data: ArrayData; shPalette?: ShPalette; name: string } | undefined;

// The previous file's arrays are freed once nothing draws it
async function load(source: string | File) {
  const name = typeof source === "string" ? source.split("/").pop()!.split("?")[0] : source.name;
  start.hidden = true;
  const { splats: data, shPalette } = await loadSplatFile(source, { name, onProgress: page.progress(name) });
  const file = fileOf(renderer, data, shPalette);
  const release = () => releaseFile(file);
  splats.collection = new SplatCollection([{ ...fileObject(file, { matrixWorld: holder.matrixWorld }), release }]);
  shown = { data, shPalette, name };
  save.hidden = false;
  page.status("");
}

for (const target of [start, renderer.domElement]) {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  target.addEventListener("dragleave", () => drop.classList.remove("over"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer?.files[0];
    if (file) {
      load(file).catch(page.fail);
    }
  });
}

fileInput.onchange = () => fileInput.files?.[0] && load(fileInput.files[0]).catch(page.fail);

urlInput.form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = new URL(location.href);
  url.searchParams.set("url", urlInput.value);
  history.pushState(null, "", url);
  load(urlInput.value).catch(page.fail);
});

save.addEventListener("click", async () => {
  if (!shown) {
    return;
  }
  const bytes = await writeSplats(shown.data, "spz", { version: 3, shPalette: shown.shPalette });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([bytes])), download: `${shown.name.split(".")[0]}.spz` });
  link.click();
  URL.revokeObjectURL(link.href);
});

const url = new URLSearchParams(location.search).get("url");
if (url) {
  await load(url);
}
page.ready(renderer);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
