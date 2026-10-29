// A link between a page open in someone's browser and an agent or script
// that cannot reach into it (/build/examples/xr/index.html paired with the Immersive Web
// Emulator, which must not navigate). The page polls GET /control/<page>
// for recordings/link/<page>/control.json and posts its stats, errors and
// results to POST /report/<page>, saved as recordings/link/<page>/report.json
// (the latest) and appended to report.log. Loopback only.
//
//   node scripts/dev-link.mjs [--port 8001]
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8001;
const root = path.resolve("recordings/link");

function pageDir(name) {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error(`Bad page name ${name}`);
  }
  return path.join(root, name);
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.end();
    return;
  }
  try {
    const [, kind, name] = (request.url ?? "").split("?")[0].split("/");
    const dir = pageDir(name ?? "");
    if (request.method === "GET" && kind === "control") {
      const text = await readFile(path.join(dir, "control.json"), "utf8").catch(() => "{}");
      response.setHeader("Content-Type", "application/json");
      response.end(text);
      return;
    }
    if (request.method === "POST" && kind === "report") {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      JSON.parse(text);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "report.json"), text);
      await appendFile(path.join(dir, "report.log"), `${text}\n`);
      response.end("ok");
      return;
    }
    response.statusCode = 404;
    response.end();
  } catch (error) {
    response.statusCode = 400;
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`dev-link on http://127.0.0.1:${port} (recordings/link/)`));
