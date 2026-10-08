// Falling-block game. Each piece is 8 digits, x y x y x y x y, in a 4x4.
// Rotation is clockwise inside that box. The square is not rotated.
const Tetris = (() => {
  const W = 10;
  const H = 20;
  const S = 16;
  const P = "01112131102011211001112100011121200111211020011100101121";
  const COL = ["#000", "#0cd", "#fd4", "#b6f", "#47f", "#f93", "#6d5", "#f55"];
  const SCORE = [0, 100, 300, 500, 800];

  function shape(id) {
    const o = id * 8;
    const s = [];
    for (let i = 0; i < 8; i += 2) s.push([+P[o + i], +P[o + i + 1]]);
    return s;
  }

  function cells(id, rot, ox, oy) {
    let s = shape(id);
    if (id !== 1) for (let t = 0; t < (rot & 3); t++) s = s.map(([x, y]) => [3 - y, x]);
    return s.map(([x, y]) => [x + ox, y + oy]);
  }

  function fits(board, cs) {
    for (const [x, y] of cs) {
      if (x < 0 || x >= W || y >= H) return false;
      if (y >= 0 && board[y * W + x]) return false;
    }
    return true;
  }

  function blank(rng = Math.random) {
    return { board: Array(W * H).fill(0), bag: [], id: 0, rot: 0, x: 3, y: 0, score: 0, lines: 0, alive: true, rng };
  }

  function ensure(s) {
    if (s.bag.length) return;
    const bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 6; i > 0; i--) {
      const j = (s.rng() * (i + 1)) | 0;
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
    s.bag = bag;
  }

  function spawn(s) {
    ensure(s);
    s.id = s.bag.pop();
    s.rot = 0;
    s.x = 3;
    s.y = 0;
    s.alive = fits(s.board, cells(s.id, 0, s.x, s.y));
    return s.alive;
  }

  function create(rng) {
    const s = blank(rng);
    spawn(s);
    return s;
  }

  function clear(s) {
    const keep = [];
    let n = 0;
    for (let y = 0; y < H; y++) {
      let full = true;
      for (let x = 0; x < W; x++) if (!s.board[y * W + x]) full = false;
      if (full) n++;
      else for (let x = 0; x < W; x++) keep.push(s.board[y * W + x]);
    }
    s.board = Array(W * H - keep.length).fill(0).concat(keep);
    return n;
  }

  function lock(s) {
    if (!s.alive) return 0;
    for (const [x, y] of cells(s.id, s.rot, s.x, s.y)) if (y >= 0) s.board[y * W + x] = s.id + 1;
    const n = clear(s);
    if (n) {
      s.score += SCORE[n] * (1 + ((s.lines / 10) | 0));
      s.lines += n;
    }
    spawn(s);
    return n;
  }

  function shift(s, dx) {
    if (!s.alive || !fits(s.board, cells(s.id, s.rot, s.x + dx, s.y))) return false;
    s.x += dx;
    return true;
  }

  function rotate(s, dir) {
    if (!s.alive) return false;
    const nr = (s.rot + dir + 4) & 3;
    for (const dy of [0, -1, 1, -2]) {
      for (const dx of [0, -1, 1, -2, 2]) {
        if (fits(s.board, cells(s.id, nr, s.x + dx, s.y + dy))) {
          s.rot = nr;
          s.x += dx;
          s.y += dy;
          return true;
        }
      }
    }
    return false;
  }

  function down(s, manual) {
    if (!s.alive) return false;
    if (fits(s.board, cells(s.id, s.rot, s.x, s.y + 1))) {
      s.y++;
      if (manual) s.score++;
      return true;
    }
    lock(s);
    return false;
  }

  function drop(s) {
    if (!s.alive) return;
    while (fits(s.board, cells(s.id, s.rot, s.x, s.y + 1))) {
      s.y++;
      s.score += 2;
    }
    lock(s);
  }

  function boot() {
    const $ = (id) => document.getElementById(id);
    const c = $("c");
    const g = c.getContext("2d");
    const sc = $("sc");
    const ln = $("ln");
    const lv = $("lv");
    const over = $("over");
    const fs = $("fs");
    let s = create();
    let timer = 0;
    Tetris.current = s;

    function paint(x, y, id) {
      if (y < 0) return;
      g.fillStyle = COL[id];
      g.fillRect(x * S + 1, y * S + 1, S - 2, S - 2);
    }

    function draw() {
      g.fillStyle = "#000";
      g.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < W * H; i++) if (s.board[i]) paint(i % W, (i / W) | 0, s.board[i]);
      if (s.alive) {
        let gy = s.y;
        while (fits(s.board, cells(s.id, s.rot, s.x, gy + 1))) gy++;
        g.globalAlpha = 0.28;
        if (gy !== s.y) for (const [x, y] of cells(s.id, s.rot, s.x, gy)) paint(x, y, s.id + 1);
        g.globalAlpha = 1;
        for (const [x, y] of cells(s.id, s.rot, s.x, s.y)) paint(x, y, s.id + 1);
      }
      sc.textContent = String(s.score);
      ln.textContent = String(s.lines);
      lv.textContent = String(1 + ((s.lines / 10) | 0));
      over.hidden = s.alive;
      if (!s.alive) fs.textContent = String(s.score);
    }

    function pace() {
      clearInterval(timer);
      const ms = Math.max(80, 700 - ((s.lines / 10) | 0) * 55);
      timer = setInterval(() => {
        if (!s.alive) return;
        const before = s.lines;
        down(s, false);
        if (!s.alive) clearInterval(timer);
        else if (s.lines !== before) pace();
        draw();
      }, ms);
    }

    function start() {
      s = create();
      Tetris.current = s;
      over.hidden = true;
      pace();
      draw();
    }

    function act(fn) {
      if (!s.alive) return;
      fn();
      draw();
    }

    function hold(el, fn) {
      let t = 0;
      const stop = () => clearInterval(t);
      el.onpointerdown = (e) => {
        e.preventDefault();
        act(fn);
        t = setInterval(() => act(fn), 110);
      };
      el.onpointerup = stop;
      el.onpointercancel = stop;
      el.onpointerleave = stop;
    }

    hold($("L"), () => shift(s, -1));
    hold($("R"), () => shift(s, 1));
    hold($("D"), () => down(s, true));
    $("U").onpointerdown = (e) => {
      e.preventDefault();
      act(() => rotate(s, 1));
    };
    $("H").onpointerdown = (e) => {
      e.preventDefault();
      act(() => drop(s));
    };
    $("ag").onpointerdown = (e) => {
      e.preventDefault();
      start();
    };

    addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowLeft") act(() => shift(s, -1));
      else if (k === "ArrowRight") act(() => shift(s, 1));
      else if (k === "ArrowDown") act(() => down(s, true));
      else if (k === "ArrowUp") act(() => rotate(s, 1));
      else if (k === " ") act(() => drop(s));
      else return;
      e.preventDefault();
    });

    let ax = 0;
    let ay = 0;
    let pid = 0;
    c.onpointerdown = (e) => {
      ax = e.clientX;
      ay = e.clientY;
      pid = e.pointerId;
    };
    c.onpointerup = (e) => {
      if (e.pointerId !== pid) return;
      pid = 0;
      const dx = e.clientX - ax;
      const dy = e.clientY - ay;
      if (dx * dx + dy * dy < 400) act(() => rotate(s, 1));
      else if (Math.abs(dx) > Math.abs(dy)) act(() => shift(s, dx > 0 ? 1 : -1));
      else if (dy > 24) act(() => drop(s));
    };

    Tetris.restart = start;
    start();
  }

  return { W, H, cells, fits, blank, create, spawn, clear, lock, shift, rotate, down, drop, boot, current: null, restart: null };
})();

globalThis.Tetris = Tetris;
if (typeof document !== "undefined") Tetris.boot();
