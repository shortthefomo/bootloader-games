import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build, buildDoom } from "./build.mjs";
import { MAX, validate } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let failed = 0;

function assert(cond, message) {
  if (!cond) {
    failed++;
    process.stderr.write("FAIL " + message + "\n");
  }
}

function eq(actual, expected, message) {
  assert(Object.is(actual, expected), `${message}: got ${actual}, expected ${expected}`);
}

function loadGame() {
  const context = { Math, Array, String, Set, clearInterval, setInterval };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(HERE, "game.js"), "utf8"), context);
  return context.Tetris;
}

function picture(cells) {
  const rows = ["....", "....", "....", "...."];
  for (const [x, y] of cells) {
    if (y >= 0 && y < 4 && x >= 0 && x < 4) {
      rows[y] = rows[y].slice(0, x) + "#" + rows[y].slice(x + 1);
    }
  }
  return rows.join("\n");
}

function unique(cells) {
  return new Set(cells.map(([x, y]) => `${x},${y}`)).size;
}

function testValidator() {
  const ok = [
    "<!DOCTYPE html><html></html>",
    "<!doctype html><html></html>",
    "<!DoCtYpE html><html></html>",
    "<html></html>",
    '<html lang="en"></html>',
    "  \n\t<html></html>\n\n  ",
    "<html></html >",
    "\uFEFF<html></html>",
  ];
  for (const doc of ok) eq(validate(doc), "ok", `accept ${JSON.stringify(doc)}`);

  eq(validate("<!doctypehtml><html></html>"), "noDoctype", "doctype needs whitespace");
  eq(validate("<htmlish></htmlish>"), "noDoctype", "tag name must end");
  eq(validate("<!DOCTYPE html>"), "noHtmlElement", "doctype alone");
  eq(validate("<html>"), "unclosed", "no end tag");
  eq(validate("<html></html"), "unclosed", "end tag missing bracket");
  eq(validate("<html></html>trailing"), "trailingGarbage", "trailing text");
  eq(validate("<head></head><html></html>"), "noDoctype", "must open with doctype or html");
  eq(validate("<html>\u0001</html>"), "badControlChar", "control char");
  eq(validate(""), "empty", "empty");
  eq(validate("x".repeat(MAX + 1)), "tooLarge", "over cap");

  const head = "<!DOCTYPE html><html><body>";
  const tail = "</body></html>";
  const fit = head + "x".repeat(MAX - head.length - tail.length) + tail;
  eq(fit.length, MAX, "boundary length");
  eq(validate(fit), "ok", "exactly 4096");
}

function testPieces(T) {
  const base = [
    "....\n####\n....\n....",
    ".##.\n.##.\n....\n....",
    ".#..\n###.\n....\n....",
    "#...\n###.\n....\n....",
    "..#.\n###.\n....\n....",
    ".##.\n##..\n....\n....",
    "##..\n.##.\n....\n....",
  ];
  for (let id = 0; id < 7; id++) {
    const drawn = picture(T.cells(id, 0, 0, 0));
    assert(drawn === base[id], `shape ${id}\n${drawn}`);
    for (let rot = 0; rot < 4; rot++) {
      const cs = T.cells(id, rot, 0, 0);
      eq(unique(cs), 4, `piece ${id} rot ${rot} has 4 cells`);
      assert(T.fits(Array(200).fill(0), T.cells(id, rot, 3, 0)), `piece ${id} rot ${rot} fits at spawn`);
    }
  }
  const o0 = T.cells(1, 0, 0, 0).map(String).sort().join(";");
  const o1 = T.cells(1, 1, 0, 0).map(String).sort().join(";");
  eq(o0, o1, "square does not move when rotated");
}

function testPlay(T) {
  const rng = () => 0;
  const fresh = T.create(rng);
  assert(fresh.alive, "spawn on an empty board");
  eq(fresh.x, 3, "spawn column");

  const wall = T.create(rng);
  let moved = 0;
  while (T.shift(wall, -1)) moved++;
  assert(moved > 0, "piece can move left");
  assert(!T.shift(wall, -1), "left wall holds");
  for (const [x] of T.cells(wall.id, wall.rot, wall.x, wall.y)) assert(x >= 0, "no cell past the left wall");

  const dropped = T.create(rng);
  const id = dropped.id;
  T.drop(dropped);
  assert(dropped.score >= 2, "hard drop scores");
  let resting = 0;
  for (let i = 0; i < 200; i++) if (dropped.board[i] === id + 1) resting++;
  eq(resting, 4, "locked piece has 4 cells");
  assert(dropped.alive, "next piece spawns after a lock");

  const line = T.blank(rng);
  line.bag = [0];
  T.spawn(line);
  eq(line.id, 0, "forced I");
  for (let x = 0; x < 10; x++) if (x < 3 || x > 6) line.board[19 * 10 + x] = 3;
  T.drop(line);
  eq(line.lines, 1, "completed line counts");
  eq(line.score, 136, "18 rows at 2 plus a single");
  for (let x = 0; x < 10; x++) eq(line.board[19 * 10 + x], 0, `bottom row cleared at ${x}`);

  const stack = T.blank(rng);
  stack.board[18 * 10 + 4] = 2;
  for (let x = 0; x < 10; x++) stack.board[19 * 10 + x] = 1;
  eq(T.clear(stack), 1, "one full row");
  eq(stack.board[19 * 10 + 4], 2, "the cell above falls");

  const both = T.blank(rng);
  both.board[17 * 10 + 1] = 4;
  for (let y = 18; y < 20; y++) for (let x = 0; x < 10; x++) both.board[y * 10 + x] = 1;
  eq(T.clear(both), 2, "two full rows");
  eq(both.board[19 * 10 + 1], 4, "a cell falls two rows");

  const blocked = T.blank(rng);
  blocked.bag = [0];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 10; x++) blocked.board[y * 10 + x] = 1;
  assert(!T.spawn(blocked), "spawn in a full ceiling ends the game");

  const edge = T.create(rng);
  edge.x = 8;
  T.rotate(edge, 1);
  if (edge.rot !== 0) {
    for (const [x, y] of T.cells(edge.id, edge.rot, edge.x, edge.y)) {
      assert(x >= 0 && x < 10 && y < 20, `kicked cell stays on the board (${x},${y})`);
    }
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function browserCheck(html) {
  if (!fs.existsSync(CHROME)) {
    process.stdout.write("browser: Chrome is not installed, UI was not exercised\n");
    return;
  }
  const server = await listen((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    });
    res.end(html);
  });
  const webPort = server.address().port;
  const debugPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tetris-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${dir}`,
    `http://127.0.0.1:${webPort}/`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let debugLog = "";
  const take = (chunk) => {
    debugLog += chunk.toString();
  };
  chrome.stdout.on("data", take);
  chrome.stderr.on("data", take);
  try {
    for (let i = 0; i < 150 && !debugLog.includes("DevTools listening"); i++) await sleep(100);
    assert(debugLog.includes("DevTools listening"), "Chrome debug port did not open: " + debugLog.slice(0, 400));
    if (!debugLog.includes("DevTools listening")) return;

    let targets = [];
    for (let i = 0; i < 50 && targets.length === 0; i++) {
      const listed = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      targets = (await listed.json()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!targets.length) await sleep(100);
    }
    assert(targets.length > 0, "Chrome opened no page");
    if (!targets.length) return;

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send("Runtime.enable");
    await send("Page.enable");
    let unpacked = false;
    for (let i = 0; i < 50; i++) {
      const ready = await send("Runtime.evaluate", {
        expression: "typeof Tetris==='object'&&!!Tetris.current",
        returnByValue: true,
      });
      if (ready.result?.value === true) {
        unpacked = true;
        break;
      }
      await sleep(100);
    }
    assert(unpacked, "boot blob unpacked into a running game");

    const boot = await send("Runtime.evaluate", {
      expression: `(() => {
        if (!globalThis.Tetris || !Tetris.current) return { ok: false, reason: "no game" };
        const s = Tetris.current;
        const x0 = s.x;
        dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
        const x1 = Tetris.current.x;
        dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
        const rotated = Tetris.current.rot !== 0 || Tetris.current.id === 1;
        dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
        const px = document.getElementById("c").getContext("2d").getImageData(0, 0, 160, 320).data;
        let ink = 0;
        for (let i = 0; i < px.length; i += 16) if (px[i] + px[i + 1] + px[i + 2] > 40) ink++;
        document.getElementById("L").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" }));
        document.getElementById("L").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch" }));
        return {
          ok: true,
          x0, x1, rotated,
          score: document.getElementById("sc").textContent,
          lines: document.getElementById("ln").textContent,
          ink,
          alive: Tetris.current.alive,
          title: document.title,
          buttons: ["L", "R", "U", "D", "H", "ag"].every((id) => document.getElementById(id)),
        };
      })()`,
      returnByValue: true,
    });
    if (boot.exceptionDetails) {
      assert(false, "page threw: " + JSON.stringify(boot.exceptionDetails));
    } else {
      const v = boot.result.value;
      assert(v.ok, v.reason || "game boot");
      assert(v.x1 === v.x0 - 1, `left key moves the piece (${v.x0} -> ${v.x1})`);
      assert(v.rotated, "up rotates, or the piece is the square");
      assert(Number(v.score) > 0, `hard drop scores, got ${v.score}`);
      assert(v.ink > 20, `canvas has painted cells (${v.ink})`);
      assert(v.alive, "game still running after one drop");
      assert(v.buttons, "controls are in the page");
      eq(v.title, "Tetris", "title");
    }

    async function shot(name, width, height, mobile) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      const png = await send("Page.captureScreenshot", { format: "png" });
      const file = path.join(os.tmpdir(), name);
      fs.writeFileSync(file, Buffer.from(png.data, "base64"));
      return file;
    }
    const desktop = await shot("tetris-desktop.png", 1100, 800, false);
    const mobile = await shot("tetris-mobile.png", 390, 844, true);
    process.stdout.write(`browser screenshots ${desktop} ${mobile}\n`);

    const ended = await send("Runtime.evaluate", {
      expression: `(() => {
        const s = Tetris.current;
        s.y = 8;
        s.board.fill(0);
        for (let i = 0; i < 20; i++) s.board[i] = 1;
        dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
        const dead = !Tetris.current.alive && document.getElementById("over").hidden === false;
        document.getElementById("ag").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch" }));
        return { dead, alive: Tetris.current.alive, hidden: document.getElementById("over").hidden };
      })()`,
      returnByValue: true,
    });
    if (ended.exceptionDetails) {
      assert(false, "restart threw: " + JSON.stringify(ended.exceptionDetails));
    } else {
      assert(ended.result.value.dead, "a full board ends the game and shows the overlay");
      assert(ended.result.value.alive && ended.result.value.hidden, "Again starts a new game");
    }
    ws.close();
  } finally {
    chrome.kill();
    server.close();
    await sleep(400);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function browserRedirect(html, url) {
  if (!fs.existsSync(CHROME)) {
    process.stdout.write("browser: Chrome is not installed, redirect was not exercised\n");
    return;
  }
  const server = await listen((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    });
    res.end(html);
  });
  const webPort = server.address().port;
  const debugPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doom-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${dir}`,
    `http://127.0.0.1:${webPort}/`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let debugLog = "";
  const take = (chunk) => {
    debugLog += chunk.toString();
  };
  chrome.stdout.on("data", take);
  chrome.stderr.on("data", take);
  try {
    for (let i = 0; i < 150 && !debugLog.includes("DevTools listening"); i++) await sleep(100);
    assert(debugLog.includes("DevTools listening"), "Chrome debug port did not open: " + debugLog.slice(0, 400));
    if (!debugLog.includes("DevTools listening")) return;

    let targets = [];
    for (let i = 0; i < 50 && targets.length === 0; i++) {
      const listed = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      targets = (await listed.json()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (!targets.length) await sleep(100);
    }
    assert(targets.length > 0, "Chrome opened no page");
    if (!targets.length) return;

    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Runtime.enable");
    let landed = "";
    for (let i = 0; i < 50; i++) {
      const ready = await send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      landed = ready.result?.value || "";
      if (landed.startsWith(url)) break;
      await sleep(100);
    }
    eq(landed.startsWith(url), true, `redirect lands on ${url}, got ${landed}`);
    ws.close();
  } finally {
    chrome.kill();
    server.close();
    await sleep(400);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const doom = buildDoom();
process.stdout.write(`doom ${doom.bytes} / ${doom.max}\n`);
const doomHtml = fs.readFileSync(doom.path);
eq(validate(doomHtml), "ok", "doom document");
assert(doomHtml.includes(doom.url), "doom url is in the document");
await browserRedirect(doomHtml, doom.url);

const built = await build();
process.stdout.write(`built ${built.bytes} / ${built.max}\n`);
assert(built.bytes <= MAX, "under the cap");
const html = fs.readFileSync(built.path);
eq(validate(html), "ok", "built document");
assert(html.subarray(0, 15).toString() === "<!doctype html>", "opens with a doctype");
const packed = html.toString().match(/const z="([^"]+)"/);
assert(packed, "payload is present");
const inflated = zlib.inflateRawSync(Buffer.from(packed[1], "base64")).toString("utf8");
assert(inflated.includes("insertAdjacentHTML") && inflated.includes("Tetris"), "payload inflates to the game");

testValidator();
testPieces(loadGame());
testPlay(loadGame());
await browserCheck(html);

if (failed) {
  process.stderr.write(`${failed} failed\n`);
  process.exit(1);
}
process.stdout.write("ok\n");
