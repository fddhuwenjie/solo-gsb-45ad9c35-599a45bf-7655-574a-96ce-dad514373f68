/* 航线冲突判定（纯函数，浏览器与 node 共用，便于回归测试）。
 *
 * 已发布后双页各改航线时，后保存页的条件 PUT 收到 409 stale。取回最新工作区后，
 * 按“服务器航线 / 本页编辑前所见航线（基准）/ 本页当前航线”三者关系判定处置：
 * - merge    服务器航线仍为本页编辑前所见（仅禁飞区在他页获核准）
 *            → 合入已核准禁飞区，以最新修订号条件重试本页航线（草稿不落库）；
 * - synced   服务器航线已与本页航线一致（他页保存了相同内容或本页已回退）
 *            → 无需重写，直接采用最新修订号与已核准禁飞区；
 * - conflict 双方都改了航线 → 不得换新号整份重试覆盖先保存页：
 *            暂停自动保存，保留本页航线与禁飞区草稿，展示双方航线供用户选择。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // 键序无关的稳定序列化：同一航线经不同页面/版本载入构造出的对象键序可能不同
  function stableStringify(v) {
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    }
    return JSON.stringify(v) || "null";
  }

  // 与页面 applyLoadedState 相同的默认键归一化：服务器原样存储的航线可能是
  // {"waypoints":[...]} 这样的部分形式，本页编辑基准则已补全默认键；
  // 比较前两侧统一补全，避免“仅禁飞区他页核准”被误判为航线冲突
  function normalizeRoute(r) {
    const out = (r && typeof r === "object") ? Object.assign({}, r) : {};
    if (!Array.isArray(out.waypoints)) out.waypoints = [];
    if (!Array.isArray(out.speeds)) out.speeds = [];
    if (!out.unitScale) out.unitScale = 100;
    if (!out.corridorHalfWidth) out.corridorHalfWidth = 0.3;
    return out;
  }

  function sameRoute(a, b) {
    return stableStringify(normalizeRoute(a)) === stableStringify(normalizeRoute(b));
  }

  function decideStaleSave(serverRoute, baseRoute, localRoute) {
    if (sameRoute(serverRoute, localRoute)) return "synced";
    if (sameRoute(serverRoute, baseRoute)) return "merge";
    return "conflict";
  }

  return { stableStringify, normalizeRoute, sameRoute, decideStaleSave };
});
