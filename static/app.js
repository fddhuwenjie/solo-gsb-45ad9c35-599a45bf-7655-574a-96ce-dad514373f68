/* 低空航线空域时窗审查台 — 原生 JS + SVG */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("board");

const state = { route: { waypoints: [], speeds: [], departureTime: "", corridorHalfWidth: 0.3, unitScale: 100 }, nfzs: [] };
let analysis = null;
let mode = "select";
let selection = { type: null, id: null };
let view = { x: 0, y: 0, w: 1000, h: 620 };
let drawing = [];          // 绘制禁飞区中的顶点
let hover = null;          // 鼠标世界坐标（绘制预览）
let drag = null;           // 当前拖动
let analyzeTimer = null, saveTimer = null;
let panelDirty = true;
let workspaceRev = 0;      // 当前工作区修订号（GET 响应头 / PUT 响应体维护）
let currentRelease = null; // 当前发布（GET /api/release）
let savedNfzs = [];        // 工作区已落库的禁飞区（已有发布时，页面的禁飞区编辑只存草稿）

// ----------------------------------------------------------- 工具
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
};
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const r2 = (v) => Math.round(v * 100) / 100;
const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function toWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: view.x + ((clientX - rect.left) / rect.width) * view.w,
    y: view.y + ((clientY - rect.top) / rect.height) * view.h,
  };
}
function screenScale() {
  const rect = svg.getBoundingClientRect();
  return view.w / rect.width; // 世界单位 / 像素
}

// ----------------------------------------------------------- API
// 变更类请求（自动保存、核准）经 opChain 串行：相邻操作按入队顺序完成，
// 后一个始终看到前一个返回的最新修订号
let opChain = Promise.resolve();
function enqueue(task) {
  const run = opChain.then(task);
  // 单个任务失败不中断后续任务；失败信息由任务内部自行提示
  opChain = run.then(() => {}, () => {});
  return run;
}
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}
async function apiRaw(path, opts) {
  return fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
}
function applyLoadedState(s) {
  Object.assign(state, s);
  if (!state.route) state.route = { waypoints: [], speeds: [], departureTime: "", corridorHalfWidth: 0.3, unitScale: 100 };
  state.route.waypoints ||= [];
  state.route.speeds ||= [];
  state.route.unitScale ||= 100;
  state.route.corridorHalfWidth ||= 0.3;
  state.nfzs ||= [];
}
async function loadState() {
  const res = await fetch("/api/state");
  workspaceRev = parseInt(res.headers.get("X-Workspace-Rev") || "0", 10) || 0;
  applyLoadedState(await res.json());
  savedNfzs = clone(state.nfzs);
}
function flushPendingSave() {
  // 核准/发布前协调：有待发的航线自动保存时，等它先落库，
  // 使随后的核准携带最新修订号；没有待发保存则排入队尾（核准本身绝不预存工作区，
  // 但仍要排在任何在途保存之后，以拿到它返回的最新修订号）
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    return enqueue(() => doSaveState());
  }
  return enqueue(() => Promise.resolve());
}
async function saveStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // FIFO 队列保证不会与在途保存并发：后一个始终拿到前一个返回的修订号
  return enqueue(() => doSaveState());
}
async function doSaveState() {
  // 已有发布时：航线编辑仍自动保存，但禁飞区变更只存草稿，
  // 落库的禁飞区必须是已核准的 savedNfzs，不得顺带写入草稿内容；
  // 并携带所见修订号：他页已变更（如别处刚核准）时不得静默覆盖
  const published = !!currentRelease;
  const payload = published ? { route: state.route, nfzs: savedNfzs } : state;
  const headers = published ? { "X-Expected-Workspace-Rev": String(workspaceRev) } : {};
  const res = await apiRaw("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const r = await res.json().catch(() => ({}));
  if (res.ok && r && typeof r.rev === "number") {
    workspaceRev = r.rev;
    if (!currentRelease) savedNfzs = clone(state.nfzs); // 未发布：整体落库，镜像同步
    return;
  }
  if (res.status === 409 && r.reason === "stale") {
    // 他页已变更：先取回最新工作区，合入他页已核准的禁飞区后带着本地航线重试一次；
    // 本地禁飞区草稿保留，不被服务器内容冲掉
    const fresh = await fetch("/api/state");
    const freshRev = parseInt(fresh.headers.get("X-Workspace-Rev") || "0", 10) || workspaceRev;
    const freshState = await fresh.json();
    const localRoute = clone(state.route);
    const localDraft = clone(state.nfzs);
    savedNfzs = clone(freshState.nfzs || []);
    workspaceRev = freshRev;
    const retry = await apiRaw("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Expected-Workspace-Rev": String(workspaceRev) },
      body: JSON.stringify({ route: localRoute, nfzs: savedNfzs }),
    });
    const rr = await retry.json().catch(() => ({}));
    if (retry.ok && rr && typeof rr.rev === "number") {
      workspaceRev = rr.rev;
      state.route = localRoute;
      state.nfzs = localDraft; // 草稿原样保留
      toast("检测到他页已更新，已合入他页已核准的禁飞区，本页航线已保存");
      renderPanel(); renderBoard(); runAnalyze(); renderNfzDraft();
      return;
    }
    // 重试仍失败：放弃本地未落库改动，以服务器为准，冲突原因不再静默
    applyLoadedState(freshState);
    workspaceRev = freshRev;
    savedNfzs = clone(state.nfzs);
    toast("工作区在他页持续变更，已载入最新内容，请重新编辑：" + (rr.error || r.error || "修订号冲突"));
    renderPanel(); fitView(); runAnalyze(); renderRelease(); renderNfzDraft();
    throw new Error(rr.error || r.error || "stale workspace");
  }
  throw new Error(r && r.error ? r.error : "工作区保存失败");
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueue(() => doSaveState().catch((e) => toast(e.message || "自动保存失败")));
  }, 500);
}
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalyze, 350);
}
async function runAnalyze() {
  $("#analyzeStatus").textContent = "审查中…";
  try {
    analysis = await api("/api/analyze", { method: "POST", body: JSON.stringify(state) });
  } catch (e) {
    analysis = { ok: false, errors: [{ message: "分析请求失败：" + e }], entries: [] };
  }
  $("#analyzeStatus").textContent = "";
  renderBoard();
  renderResults();
  renderDynamicPanel();
}

// ----------------------------------------------------------- SVG 渲染
function starPath(cx, cy, rOuter, rInner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${r2(cx + r * Math.cos(a))},${r2(cy + r * Math.sin(a))}`);
  }
  return "M" + pts.join("L") + "Z";
}

function renderBoard() {
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);

  // 网格
  const step = 100;
  const gx0 = Math.floor(view.x / step) * step;
  const gy0 = Math.floor(view.y / step) * step;
  for (let x = gx0; x <= view.x + view.w; x += step) {
    el("line", { x1: x, y1: view.y, x2: x, y2: view.y + view.h, class: "grid-line" }, svg);
  }
  for (let y = gy0; y <= view.y + view.h; y += step) {
    el("line", { x1: view.x, y1: y, x2: view.x + view.w, y2: y, class: "grid-line" }, svg);
  }
  // 背景事件层
  el("rect", {
    x: view.x - 5000, y: view.y - 5000, width: view.w + 10000, height: view.h + 10000,
    fill: "transparent", "data-action": "bg",
  }, svg);

  const wps = state.route.waypoints;
  const halfW = num(state.route.corridorHalfWidth, 0.3) * num(state.route.unitScale, 100);
  const conflictNfz = new Set((analysis?.entries || []).map((e) => e.nfzId));

  // 禁飞区
  for (const nz of state.nfzs) {
    const v = nz.vertices || [];
    if (v.length >= 2) {
      const isSel = selection.type === "nfz" && selection.id === nz.id;
      let cls = "nfz-poly " + (isSel ? "selected" : "ok");
      el("polygon", {
        points: v.map((p) => `${r2(p[0])},${r2(p[1])}`).join(" "),
        class: cls,
        fill: nz.enabled === false ? "rgba(150,160,180,.05)"
          : conflictNfz.has(nz.id) ? "rgba(255,77,109,.10)" : "rgba(255,255,255,.05)",
        stroke: nz.enabled === false ? "#5b6880" : conflictNfz.has(nz.id) ? "#ff4d6d"
          : isSel ? "#ffd166" : "#8fa3c2",
        "data-action": "nfz-pick", "data-id": nz.id,
      }, svg);
      const cx = v.reduce((s, p) => s + p[0], 0) / v.length;
      const cy = v.reduce((s, p) => s + p[1], 0) / v.length;
      el("text", { x: r2(cx), y: r2(cy - 4), "text-anchor": "middle", class: "nfz-label", text: nz.name }, svg);
      el("text", { x: r2(cx), y: r2(cy + 10), "text-anchor": "middle", class: "nfz-label",
        text: `${num(nz.minAlt)}–${num(nz.maxAlt)}m` }, svg);
      if (isSel) {
        const pr = Math.max(6, 7 * screenScale());
        v.forEach((p, i) => {
          el("circle", { cx: r2(p[0]), cy: r2(p[1]), r: r2(pr), class: "nfz-vertex",
            "data-action": "nfz-vertex", "data-id": nz.id, "data-i": i }, svg);
        });
      }
    }
  }

  // 航线扫掠走廊（半宽描边近似缓冲区）
  if (wps.length >= 2) {
    const pts = wps.map((w) => `${r2(num(w.x))},${r2(num(w.y))}`).join(" ");
    el("polyline", { points: pts, class: "route-corridor",
      "stroke-width": r2(halfW * 2), "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    el("polyline", { points: pts, class: "route-line" }, svg);
  }

  // 冲突区间（沿航段的红色粗线段）与见证位置
  for (const e of analysis?.entries || []) {
    const a = wps[e.segIndex], b = wps[e.segIndex + 1];
    if (!a || !b) continue;
    const xa = num(a.x) + (num(b.x) - num(a.x)) * e.enterFrac;
    const ya = num(a.y) + (num(b.y) - num(a.y)) * e.enterFrac;
    const xb = num(a.x) + (num(b.x) - num(a.x)) * e.exitFrac;
    const yb = num(a.y) + (num(b.y) - num(a.y)) * e.exitFrac;
    el("line", { x1: r2(xa), y1: r2(ya), x2: r2(xb), y2: r2(yb),
      class: "conflict-overlay", "stroke-width": r2(halfW * 2), "stroke-linecap": "butt" }, svg);
  }
  const first = analysis?.first;
  if (first) {
    const w = first.witness, r = Math.max(9, 11 * screenScale());
    el("circle", { cx: w.x, cy: w.y, r: r2(r * 1.7), class: "witness-ring" }, svg);
    el("path", { d: starPath(w.x, w.y, r, r * 0.45), class: "witness" }, svg);
    el("text", { x: r2(w.x + 14 * screenScale()), y: r2(w.y - 14 * screenScale()),
      class: "witness-label", text: `首个冲突 ${fmtTime(first.enterTime)}` }, svg);
  }

  // 航点
  const pr = Math.max(6, 7 * screenScale());
  wps.forEach((w, i) => {
    const isSel = selection.type === "wp" && selection.id === w.id;
    el("circle", { cx: r2(num(w.x)), cy: r2(num(w.y)), r: r2(pr),
      class: "wp-dot" + (isSel ? " selected" : ""),
      "data-action": "wp-drag", "data-id": w.id }, svg);
    el("text", { x: r2(num(w.x) + 10 * screenScale()), y: r2(num(w.y) - 10 * screenScale()),
      class: "wp-label", text: `${i + 1}. ${w.name || "WP"} ${num(w.alt)}m` }, svg);
  });

  // 绘制预览
  if (mode === "drawNfz" && drawing.length) {
    const pts = drawing.map((p) => `${r2(p[0])},${r2(p[1])}`);
    if (hover) pts.push(`${r2(hover.x)},${r2(hover.y)}`);
    if (pts.length >= 2) el("polyline", { points: pts.join(" "), class: "draw-preview" }, svg);
    drawing.forEach((p) => el("circle", { cx: p[0], cy: p[1], r: r2(pr), class: "nfz-vertex" }, svg));
  }
}

// ----------------------------------------------------------- 视图操作
function fitView() {
  const pts = [];
  state.route.waypoints.forEach((w) => pts.push([num(w.x), num(w.y)]));
  state.nfzs.forEach((n) => (n.vertices || []).forEach((p) => pts.push([num(p[0]), num(p[1])])));
  if (!pts.length) { view = { x: 0, y: 0, w: 1000, h: 620 }; renderBoard(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const pad = 90;
  view = { x: minX - pad, y: minY - pad, w: Math.max(maxX - minX + pad * 2, 200), h: Math.max(maxY - minY + pad * 2, 200) };
  renderBoard();
}

// ----------------------------------------------------------- 侧栏
function renderPanel() {
  panelDirty = false;
  const r = state.route;
  $("#depTime").value = r.departureTime || "";
  $("#corridorW").value = r.corridorHalfWidth ?? 0.3;
  $("#unitScale").value = r.unitScale ?? 100;

  // 航点卡片
  const wpBox = $("#wpList");
  wpBox.innerHTML = "";
  r.waypoints.forEach((w, i) => {
    const card = document.createElement("div");
    card.className = "wp-card" + (selection.type === "wp" && selection.id === w.id ? " selected" : "");
    card.innerHTML = `
      <div class="card-head">
        <b>${i + 1}.</b>
        <input data-f="name" value="${(w.name || "").replace(/"/g, "&quot;")}" style="flex:1;background:#0e1726;color:#d7e0ee;border:1px solid #31415c;border-radius:4px;padding:2px 6px;font-size:12px">
        <button class="del-btn" title="删除">✕</button>
      </div>
      <div class="form-row"><label>x / y</label>
        <input data-f="x" type="number" value="${w.x ?? 0}">
        <input data-f="y" type="number" value="${w.y ?? 0}">
      </div>
      <div class="form-row"><label>高度 m</label>
        <input data-f="alt" type="number" value="${w.alt ?? 0}">
      </div>`;
    card.querySelector(".del-btn").onclick = () => { deleteWaypoint(i); };
    card.querySelectorAll("input").forEach((inp) => {
      inp.oninput = () => {
        const f = inp.dataset.f;
        w[f] = f === "name" ? inp.value : num(inp.value, w[f] ?? 0);
        renderBoard(); scheduleAnalyze(); scheduleSave();
      };
      inp.onfocus = () => { selection = { type: "wp", id: w.id }; renderBoard(); markPanelDirty(); };
    });
    wpBox.appendChild(card);

    if (i < r.waypoints.length - 1) {
      const seg = document.createElement("div");
      seg.className = "seg-row";
      const spd = r.speeds[i] ?? 20;
      seg.innerHTML = `
        <span>→段${i + 1} 速度</span>
        <input type="number" step="1" value="${spd}">
        <span>km/h</span>
        <span class="seg-eta" data-seg="${i}"></span>`;
      const inp = seg.querySelector("input");
      inp.oninput = () => { r.speeds[i] = num(inp.value, 20); scheduleAnalyze(); scheduleSave(); };
      wpBox.appendChild(seg);
    }
  });

  // 禁飞区卡片
  const nfzBox = $("#nfzList");
  nfzBox.innerHTML = "";
  state.nfzs.forEach((nz, i) => {
    const card = document.createElement("div");
    card.className = "nfz-card" + (selection.type === "nfz" && selection.id === nz.id ? " selected" : "");
    card.innerHTML = `
      <div class="card-head">
        <input type="checkbox" ${nz.enabled !== false ? "checked" : ""} title="启用">
        <input data-f="name" value="${(nz.name || "").replace(/"/g, "&quot;")}" style="flex:1;background:#0e1726;color:#d7e0ee;border:1px solid #31415c;border-radius:4px;padding:2px 6px;font-size:12px">
        <button class="del-btn" title="删除">✕</button>
      </div>
      <div class="form-row"><label>高度层 m</label>
        <input data-f="minAlt" type="number" value="${nz.minAlt ?? 0}">
        <input data-f="maxAlt" type="number" value="${nz.maxAlt ?? 300}">
      </div>
      <div class="form-row"><label>生效起</label>
        <input data-f="startTime" type="datetime-local" step="60" value="${nz.startTime || ""}"></div>
      <div class="form-row"><label>生效止</label>
        <input data-f="endTime" type="datetime-local" step="60" value="${nz.endTime || ""}"></div>
      <div class="summary">${(nz.vertices || []).length} 个顶点${selection.type === "nfz" && selection.id === nz.id ? "（黄色顶点可在画布拖动）" : ""}</div>`;
    card.querySelector(".del-btn").onclick = () => { state.nfzs.splice(i, 1); afterNfzStructuralChange(); };
    card.querySelector('input[type="checkbox"]').onchange = (e) => {
      nz.enabled = e.target.checked; renderBoard(); scheduleAnalyze(); saveOrDraftNfz();
    };
    card.querySelectorAll('input:not([type="checkbox"])').forEach((inp) => {
      inp.oninput = () => {
        const f = inp.dataset.f;
        nz[f] = f === "name" || f === "startTime" || f === "endTime" ? inp.value : num(inp.value);
        renderBoard(); scheduleAnalyze(); saveOrDraftNfz();
      };
      inp.onfocus = () => { selection = { type: "nfz", id: nz.id }; renderBoard(); markPanelDirty(); };
    });
    nfzBox.appendChild(card);
  });

  renderDynamicPanel();
  renderNfzDraft();
}

// 仅刷新文本，不重建表单（避免输入失焦）
function renderDynamicPanel() {
  const r = state.route;
  const info = analysis?.route;
  $("#routeSummary").innerHTML = info
    ? `航段数 ${(r.waypoints.length - 1) || 0} ｜ 总航程 ${info.length} ｜ 总时长 ${info.durationMinutes ?? "—"} 分钟` : "";
  (document.querySelectorAll(".seg-eta") || []).forEach((span) => {
    const i = num(span.dataset.seg);
    const d = info?.distances?.[i], t = info?.times?.[i + 1];
    span.textContent = `${d != null ? d + "km" : ""} ETA ${fmtTime(t)}`;
  });
}

function markPanelDirty() { panelDirty = true; }
function refreshPanelIfDirty() { if (panelDirty) renderPanel(); }

function renderResults() {
  const box = $("#resultBox");
  if (!analysis) { box.innerHTML = ""; return; }
  let html = "";
  for (const er of analysis.errors || []) {
    html += `<div class="error-line">⚠ ${er.message}</div>`;
  }
  if (analysis.first) {
    const f = analysis.first;
    html += `<div class="result-bad result-first">
      <div class="big">🚫 首个冲突：${f.nfzName}</div>
      <div>航段 ${f.segIndex + 1} ｜ ${fmtTime(f.enterTime)} → ${fmtTime(f.exitTime)}（${f.durationMinutes ?? 0} 分钟）</div>
      <div>高度重叠 ${f.altLow}–${f.altHigh} m</div>
      <div>见证位置 (${f.witness.x}, ${f.witness.y})，高度 ${f.witness.alt} m</div>
    </div>`;
    html += (analysis.entries || []).map((e, i) => `
      <div class="entry-line ${i === 0 ? "first" : ""}">
        ${i === 0 ? "★ " : ""}${e.nfzName} · 航段${e.segIndex + 1} ·
        ${fmtTime(e.enterTime)}→${fmtTime(e.exitTime)} ·
        高度 ${e.altLow}–${e.altHigh}m · 见证 (${e.witness.x},${e.witness.y})
      </div>`).join("");
  } else if (!(analysis.errors || []).length) {
    html += `<div class="result-good">✅ 未发现平面 ∩ 高度 ∩ 时窗的三维冲突</div>`;
  }
  box.innerHTML = html;
}

// ----------------------------------------------------------- 结构变更
function afterStructuralChange() {
  renderBoard(); renderPanel(); scheduleAnalyze(); scheduleSave();
}
// 禁飞区结构变更：已有发布时只留草稿，不触发落库
function afterNfzStructuralChange() {
  renderBoard(); renderPanel(); scheduleAnalyze(); saveOrDraftNfz();
}
function deleteWaypoint(i) {
  const r = state.route;
  r.waypoints.splice(i, 1);
  if (i < r.speeds.length) r.speeds.splice(i, 1);
  if (selection.type === "wp") selection = { type: null, id: null };
  afterStructuralChange();
}
function appendWaypoint(w) {
  const r = state.route;
  r.waypoints.push(w);
  if (r.speeds.length < r.waypoints.length - 1) r.speeds.push(20);
  afterStructuralChange();
}

// ----------------------------------------------------------- 画布交互
svg.addEventListener("mousedown", (e) => {
  const t = e.target.closest("[data-action]");
  const action = t?.dataset.action;
  const w = toWorld(e.clientX, e.clientY);

  if (action === "wp-drag") {
    const id = t.dataset.id;
    const wp = state.route.waypoints.find((x) => x.id === id);
    selection = { type: "wp", id };
    drag = { kind: "wp", wp, startX: e.clientX, startY: e.clientY, moved: false };
    refreshPanelIfDirty(); renderBoard();
  } else if (action === "nfz-vertex") {
    const nz = state.nfzs.find((n) => n.id === t.dataset.id);
    drag = { kind: "vertex", nz, i: +t.dataset.i, startX: e.clientX, startY: e.clientY, moved: false };
  } else if (action === "nfz-pick") {
    selection = { type: "nfz", id: t.dataset.id };
    markPanelDirty(); renderBoard();
  } else {
    // 背景：开始平移
    drag = { kind: "pan", view: { ...view }, startX: e.clientX, startY: e.clientY };
  }
});

svg.addEventListener("mousemove", (e) => {
  const w = toWorld(e.clientX, e.clientY);
  hover = w;
  if (!drag) {
    if (mode === "drawNfz" && drawing.length) renderBoard();
    return;
  }
  const dxPx = e.clientX - drag.startX, dyPx = e.clientY - drag.startY;
  if (Math.abs(dxPx) + Math.abs(dyPx) > 3) drag.moved = true;

  if (drag.kind === "pan") {
    const rect = svg.getBoundingClientRect();
    view.x = drag.view.x - (dxPx / rect.width) * view.w;
    view.y = drag.view.y - (dyPx / rect.height) * view.h;
    renderBoard();
  } else if (drag.kind === "wp") {
    drag.wp.x = r2(w.x); drag.wp.y = r2(w.y);
    renderBoard();
  } else if (drag.kind === "vertex") {
    drag.nz.vertices[drag.i] = [r2(w.x), r2(w.y)];
    renderBoard();
  }
});

window.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const wasClick = !drag.moved;
  const d = drag;
  drag = null;
  if (wasClick && d.kind === "pan") {
    const w = toWorld(e.clientX, e.clientY);
    if (mode === "addWp") {
      appendWaypoint({ id: uid("w"), name: "WP", x: r2(w.x), y: r2(w.y), alt: 200 });
    } else if (mode === "drawNfz") {
      drawing.push([r2(w.x), r2(w.y)]);
      renderBoard();
    } else {
      selection = { type: null, id: null };
      markPanelDirty(); renderBoard();
    }
  } else if (d.kind === "wp") {
    if (d.moved) { scheduleAnalyze(); scheduleSave(); }
  } else if (d.kind === "vertex") {
    if (d.moved) { scheduleAnalyze(); saveOrDraftNfz(); }
  }
});

svg.addEventListener("dblclick", (e) => {
  if (mode === "drawNfz" && drawing.length >= 3) {
    // 双击的第一次 click 已落下同位置末点，去重
    if (typeof e.clientX === "number") {
      const w = toWorld(e.clientX, e.clientY);
      const last = drawing[drawing.length - 1];
      if (Math.hypot(last[0] - w.x, last[1] - w.y) < 5) drawing.pop();
    }
    const verts = drawing.map((p) => [r2(p[0]), r2(p[1])]);
    if (verts.length >= 3) {
      state.nfzs.push({
        id: uid("n"), name: `禁飞区-${state.nfzs.length + 1}`, vertices: verts,
        minAlt: 0, maxAlt: 300, startTime: "", endTime: "", enabled: true,
      });
      drawing = [];
      afterNfzStructuralChange();
    }
  }
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const w = toWorld(e.clientX, e.clientY);
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  view = {
    x: w.x - (w.x - view.x) * factor,
    y: w.y - (w.y - view.y) * factor,
    w: view.w * factor, h: view.h * factor,
  };
  renderBoard();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (drawing.length) { drawing = []; renderBoard(); }
    else { setMode("select"); }
  } else if (e.key === "Enter" && mode === "drawNfz" && drawing.length >= 3) {
    svg.dispatchEvent(new Event("dblclick"));
  }
});

// ----------------------------------------------------------- 顶部控件
function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  svg.style.cursor = m === "select" ? "default" : "crosshair";
  const hints = {
    select: "选择/拖动：拖动航点与禁飞区顶点重算；拖空白平移；滚轮缩放",
    addWp: "点击画布追加航点（Esc 结束）",
    drawNfz: "单击依次落点，双击或回车完成禁飞多边形（Esc 取消）",
  };
  $("#modeHint").textContent = hints[m];
  if (m !== "drawNfz") drawing = [];
  renderBoard();
}
document.querySelectorAll(".mode").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$("#btnFit").onclick = fitView;
$("#btnAnalyze").onclick = runAnalyze;

$("#depTime").oninput = (e) => { state.route.departureTime = e.target.value; scheduleAnalyze(); scheduleSave(); };
$("#corridorW").oninput = (e) => { state.route.corridorHalfWidth = num(e.target.value, 0.3); renderBoard(); scheduleAnalyze(); scheduleSave(); };
$("#unitScale").oninput = (e) => { state.route.unitScale = num(e.target.value, 100); renderBoard(); scheduleAnalyze(); scheduleSave(); };

$("#btnAddNfz").onclick = () => {
  const cx = view.x + view.w / 2, cy = view.y + view.h / 2, s = Math.min(view.w, view.h) / 8;
  state.nfzs.push({
    id: uid("n"), name: `禁飞区-${state.nfzs.length + 1}`,
    vertices: [[r2(cx - s), r2(cy - s)], [r2(cx + s), r2(cy - s)], [r2(cx + s), r2(cy + s)], [r2(cx - s), r2(cy + s)]],
    minAlt: 0, maxAlt: 300, startTime: "", endTime: "", enabled: true,
  });
  selection = { type: "nfz", id: state.nfzs[state.nfzs.length - 1].id };
  afterNfzStructuralChange();
};

// ----------------------------------------------------------- 发布
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadRelease() {
  try {
    const r = await api("/api/release");
    if (r && r.ok) {
      currentRelease = r.release;
      if (typeof r.workspaceRev === "number") workspaceRev = r.workspaceRev;
    }
  } catch (e) { /* 保持现状 */ }
  renderRelease();
  renderNfzDraft();
}

// err 非空时在发布卡片上方展示最近一次发布失败的原因与明细
function renderRelease(err) {
  const box = $("#releaseBox");
  let html = "";
  if (err) {
    html += `<div class="error-line">⚠ 发布失败：${esc(err.error || "未知原因")}</div>`;
    for (const e of err.errors || []) {
      html += `<div class="error-line">⚠ ${esc(e.message)}</div>`;
    }
    for (const e of err.entries || []) {
      html += `<div class="entry-line">✈ ${esc(e.nfzName)} · 航段${e.segIndex + 1} ·
        ${fmtTime(e.enterTime)}→${fmtTime(e.exitTime)} · 高度 ${e.altLow}–${e.altHigh}m</div>`;
    }
    if (err.details) {
      for (const [k, v] of Object.entries(err.details)) {
        const label = k === "workspaceRev" ? "工作区修订号" : "已发布号";
        html += `<div class="entry-line">${label}：读取时 ${v.expected} → 当前 ${v.actual}</div>`;
      }
    }
  }
  if (currentRelease) {
    const r = currentRelease;
    const route = (r.analysis && r.analysis.route) || {};
    html += `<div class="release-card">
      <div class="rel-head">#${r.seq} ｜ 来源：${esc(r.sourceVersionName)}（版本 ${r.sourceVersionId}）</div>
      <div class="summary">发布于 ${r.createdAt} ｜ 工作区修订 ${r.workspaceRev}</div>
      <div class="result-good" style="margin-top:6px">✅ 审查通过：无三维冲突
        ｜ 总航程 ${route.length ?? "—"} km ｜ 总时长 ${route.durationMinutes ?? "—"} 分钟</div>
    </div>`;
  } else {
    html += `<div class="summary">暂无发布</div>`;
  }
  box.innerHTML = html;
}

async function publishVersion(v) {
  // 先让在途航线自动保存落库（发布仍取当前工作区禁飞区），再在同一条串行队列里发布
  await flushPendingSave();
  return enqueue(async () => {
    let r;
    try {
      r = await api("/api/release", {
        method: "POST",
        body: JSON.stringify({
          versionId: v.id,
          workspaceRev,
          releaseSeq: currentRelease ? currentRelease.seq : 0,
        }),
      });
    } catch (e) {
      toast("发布请求失败：" + e);
      return;
    }
    if (r.ok) {
      currentRelease = r.release;
      renderRelease();
      renderNfzDraft(); // 进入“已有发布”状态：此后的禁飞区变更先存草稿
      toast(`已发布 #${r.release.seq}（来源：${r.release.sourceVersionName}）`);
    } else {
      if (r.reason === "stale") {
        // 已发布号/工作区已变化：先同步最新状态，再展示失败原因
        try {
          const cur = await api("/api/release");
          if (cur && cur.ok) {
            currentRelease = cur.release;
            if (typeof cur.workspaceRev === "number") workspaceRev = cur.workspaceRev;
          }
        } catch (e) { /* 忽略 */ }
      }
      renderRelease(r);
      toast("发布失败：" + (r.error || "未知原因"));
    }
  });
}

// ----------------------------------------------------------- 禁飞区草稿核准
// 已有发布时，禁飞区的增删/拖动/修改（含载入版本带来的变化）只存为页面草稿，
// 提交核准通过后才替换工作区禁飞区；尚未发布时沿用原自动保存。
function saveOrDraftNfz() {
  if (currentRelease) renderNfzDraft(); // 留作草稿，不落库
  else scheduleSave();
}
function nfzDraftDirty() {
  return !!currentRelease && JSON.stringify(state.nfzs) !== JSON.stringify(savedNfzs);
}

// err 非空时展示最近一次核准失败的原因与明细（草稿保留，可继续修改）
function renderNfzDraft(err) {
  const box = $("#nfzDraftBox");
  if (!box) return;
  if (!currentRelease) { box.innerHTML = ""; return; }
  let html = "";
  if (err) {
    html += `<div class="error-line">⚠ 核准未通过：${esc(err.error || "未知原因")}</div>`;
    for (const e of err.errors || []) {
      html += `<div class="error-line">⚠ ${esc(e.message)}</div>`;
    }
    for (const e of err.entries || []) {
      html += `<div class="entry-line">✈ ${esc(e.nfzName)} · 航段${e.segIndex + 1} ·
        ${fmtTime(e.enterTime)}→${fmtTime(e.exitTime)} · 高度 ${e.altLow}–${e.altHigh}m</div>`;
    }
    if (err.details) {
      for (const [k, v] of Object.entries(err.details)) {
        const label = k === "workspaceRev" ? "工作区修订号" : "已发布号";
        html += `<div class="entry-line">${label}：读取时 ${v.expected} → 当前 ${v.actual}</div>`;
      }
    }
  }
  if (nfzDraftDirty()) {
    html += `<div class="draft-card">
      <div class="draft-head">● 禁飞区草稿未核准</div>
      <div class="summary">变更仅暂存于本页，尚未落库；提交后将与发布 #${currentRelease.seq} 的航线组合审查，通过才替换工作区禁飞区。</div>
      <div class="draft-actions">
        <button id="btnNfzApprove">提交核准</button>
        <button id="btnNfzDiscard" class="minor">放弃草稿</button>
      </div>
    </div>`;
  } else {
    html += `<div class="summary">已有发布 #${currentRelease.seq} ｜ 工作区修订 ${workspaceRev}：此后的禁飞区变更先存为草稿，核准后生效。</div>`;
  }
  box.innerHTML = html;
  const approveBtn = $("#btnNfzApprove"), discardBtn = $("#btnNfzDiscard");
  if (approveBtn) approveBtn.onclick = submitNfzApproval;
  if (discardBtn) discardBtn.onclick = discardNfzDraft;
}

// 提交核准绝不预先 PUT 工作区：先等在途的航线自动保存落库（协调顺序与修订号），
// 再携带“所见”工作区修订号与发布号提交；被拒绝时展示原因与冲突/并发明细，
// 草稿原样保留。核准操作本身不改变工作区航线或发布快照——通过时由服务端
// 仅原子替换工作区禁飞区。
async function submitNfzApproval() {
  await flushPendingSave();
  return enqueue(() => doNfzApproval());
}

async function doNfzApproval() {
  const candidate = clone(state.nfzs);
  const seq = currentRelease ? currentRelease.seq : 0;
  let r;
  try {
    r = await api("/api/nfz-approval", {
      method: "POST",
      body: JSON.stringify({ nfzs: candidate, workspaceRev, releaseSeq: seq }),
    });
  } catch (e) {
    toast("核准请求失败：" + e);
    return;
  }
  if (r.ok) {
    workspaceRev = r.rev;
    savedNfzs = clone(candidate); // 草稿已成为工作区禁飞区（航线/发布快照未动）
    renderNfzDraft();
    toast(`禁飞区变更已核准（工作区修订 ${r.rev}）`);
    return;
  }
  if (r.reason === "stale") {
    // 工作区修订号/发布号已变化：同步最新号与他页已核准禁飞区（草稿保留），再展示明细
    try {
      const [sres, cur] = await Promise.all([fetch("/api/state"), api("/api/release")]);
      const srev = parseInt(sres.headers.get("X-Workspace-Rev") || "0", 10) || workspaceRev;
      const s = await sres.json();
      workspaceRev = srev;
      savedNfzs = clone(s.nfzs || []); // 已核准基线以服务器为准，本页草稿不覆盖
      if (cur && cur.ok) currentRelease = cur.release;
    } catch (e) { /* 仍展示下方失败明细 */ }
    renderRelease();
  }
  renderNfzDraft(r); // 草稿保留，可继续修改后重新提交
  toast("核准未通过：" + (r.error || "未知原因"));
}

function discardNfzDraft() {
  state.nfzs = clone(savedNfzs); // 还原为工作区已核准内容（无需落库，服务端本就是它）
  if (selection.type === "nfz") selection = { type: null, id: null };
  renderPanel(); renderBoard(); runAnalyze();
  toast("已放弃禁飞区草稿");
}

// ----------------------------------------------------------- 版本
async function loadVersions() {
  const list = await api("/api/versions");
  const box = $("#versionList");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="summary">暂无保存版本</div>'; return; }
  for (const v of list) {
    const item = document.createElement("div");
    item.className = "version-item";
    item.innerHTML = `<div class="vmeta"><div class="vname"></div><div class="vtime"></div></div>
      <button data-act="pub">发布</button><button data-act="load">载入</button><button data-act="del">删除</button>`;
    item.querySelector(".vname").textContent = v.name;
    item.querySelector(".vtime").textContent = v.createdAt;
    item.querySelector('[data-act="pub"]').onclick = () => publishVersion(v);
    item.querySelector('[data-act="load"]').onclick = async () => {
      if (!confirm(`载入版本「${v.name}」？当前未另存的内容将被覆盖。`)) return;
      const full = await api(`/api/versions/${v.id}`);
      Object.assign(state, full.state);
      selection = { type: null, id: null };
      await saveStateNow(); // 已有发布时仅落库航线，版本带来的禁飞区变化留作草稿
      renderPanel(); fitView(); runAnalyze();
      toast(currentRelease && nfzDraftDirty()
        ? `已载入版本 ${v.name}（禁飞区变化已存为草稿）` : "已载入版本 " + v.name);
    };
    item.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`删除版本「${v.name}」？`)) return;
      await api(`/api/versions/${v.id}`, { method: "DELETE" });
      loadVersions();
    };
    box.appendChild(item);
  }
}
$("#btnSaveVer").onclick = async () => {
  const name = $("#verName").value.trim();
  const r = await api("/api/versions", { method: "POST", body: JSON.stringify({ name, state }) });
  if (r.ok) { toast("已保存：" + r.name); $("#verName").value = ""; loadVersions(); }
};

// ----------------------------------------------------------- 启动
(async function init() {
  setMode("select");
  await loadState();
  renderPanel();
  fitView();
  loadVersions();
  loadRelease();
  runAnalyze();
})();
