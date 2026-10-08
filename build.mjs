import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { MAX, validate } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "tetris.html");
const DOOM_OUT = path.join(HERE, "doom.html");
const DOOM_URL = "https://mrdoob.github.io/three-doom/";

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function flatten(html) {
  return html.replace(/\n+/g, "").replace(/>\s+</g, "><").trim();
}

function stub(payload) {
  // The ledger cap is 4096 bytes. The stored document is a deflate-raw
  // payload the browser inflates, then runs. Base64 cannot contain "<",
  // so the wrapper's own </html> stays the last tag the validator sees.
  const b64 = zlib.deflateRawSync(Buffer.from(payload), { level: 9 }).toString("base64");
  return (
    "<!doctype html><html><head><meta charset=utf-8>" +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    "<title>Tetris</title><style>body{margin:0;background:#12151c;color:#eee}</style></head><body><script>" +
    `const z="${b64}";` +
    "if(globalThis.DecompressionStream)new Response(new Blob([Uint8Array.from(atob(z),c=>c.charCodeAt(0))])" +
    '.stream().pipeThrough(new DecompressionStream("deflate-raw"))).text().then(t=>(0,eval)(t));' +
    'else document.body.textContent="Cannot unpack this boot blob"' +
    "</script></body></html>"
  );
}

export async function build() {
  const shell = fs.readFileSync(path.join(HERE, "shell.html"), "utf8");
  const game = fs.readFileSync(path.join(HERE, "game.js"), "utf8");
  if (!shell.includes("<style>") || !shell.includes("<body>")) {
    throw new Error("shell.html is missing its style or body");
  }
  if (game.includes("</")) throw new Error("game.js contains a closing tag");
  const css = minifyCss(shell.match(/<style>([\s\S]*?)<\/style>/)[1]);
  const body = flatten(shell.match(/<body>([\s\S]*?)<script>/)[1]);
  if (css.includes('"') || css.includes("</")) throw new Error("css cannot contain quotes or closing tags");
  const js = (await esbuild.transform(game, { minify: true, target: "es2020" })).code.trim();
  const payload =
    `document.head.insertAdjacentHTML("beforeend","<style>${css}</style>");` +
    `document.body.innerHTML=${JSON.stringify(body)};` +
    js;
  const doc = stub(payload);
  const buf = Buffer.from(doc);
  const verdict = validate(buf);
  if (verdict !== "ok") throw new Error(`AppLoader rejected the document (${verdict}, ${buf.length} bytes)`);
  if (buf.length > MAX) throw new Error(`document is ${buf.length} bytes; the ledger cap is ${MAX}`);
  fs.writeFileSync(OUT, buf);
  return { path: OUT, bytes: buf.length, max: MAX, payload };
}

export function buildDoom() {
  const doc =
    "<!doctype html><html><head><meta charset=utf-8>" +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    `<meta http-equiv=refresh content="0;url=${DOOM_URL}">` +
    "<title>Doom</title></head><body>" +
    `<script>location.replace(${JSON.stringify(DOOM_URL)})</script>` +
    "</body></html>";
  const buf = Buffer.from(doc);
  const verdict = validate(buf);
  if (verdict !== "ok") throw new Error(`AppLoader rejected the document (${verdict}, ${buf.length} bytes)`);
  fs.writeFileSync(DOOM_OUT, buf);
  return { path: DOOM_OUT, bytes: buf.length, max: MAX, url: DOOM_URL };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const which = process.argv[2] || "tetris";
  if (which === "tetris") {
    const result = await build();
    process.stdout.write(`${result.bytes} / ${result.max} bytes\n${result.path}\n`);
  } else if (which === "doom") {
    const result = buildDoom();
    process.stdout.write(`${result.bytes} / ${result.max} bytes\n${result.path}\n`);
  } else {
    throw new Error(`unknown bootloader ${which}`);
  }
}
