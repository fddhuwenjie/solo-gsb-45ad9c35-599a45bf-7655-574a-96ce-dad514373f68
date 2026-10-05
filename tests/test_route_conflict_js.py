# -*- coding: utf-8 -*-
"""航线冲突处置决策（static/route_conflict.js）的双页交错回归。

判定逻辑是浏览器与 node 共用的纯函数；本测试通过 node 执行，覆盖：
- 双方都改了航线 → conflict（后保存页不得换新号整份重试覆盖先保存页）；
- 服务器航线仍为本页编辑前所见（仅禁飞区他页获核准）→ merge（合入已核准
  禁飞区后条件重试本页航线）；
- 服务器航线已与本页航线一致 → synced（无需重写，直接同步）；
- 航线等价比较与对象键序无关（不同页面/版本载入构造出的对象键序可不同）。

环境无 node 时跳过（页面运行不依赖本测试）。
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS_FILE = ROOT / "static" / "route_conflict.js"

JS_CHECK = r"""
"use strict";
const assert = require("assert");
const { decideStaleSave, sameRoute } = require(process.argv[2]);

// 双页交错场景：同一基础航线出发，A 页先保存航线，B 页后保存收到 409
const Rt0 = { waypoints: [{ id: "w1", name: "A", x: 0, y: 0, alt: 100 }] };
const routeA = { waypoints: [{ id: "w1", name: "A页航线", x: 10, y: 0, alt: 100 }] };
const routeB = { waypoints: [{ id: "w1", name: "B页航线", x: 99, y: 0, alt: 100 }] };

// 双方都改了航线 → 冲突：不得自动整份重试覆盖先保存页，须展示双方航线供选择
assert.strictEqual(decideStaleSave(routeA, Rt0, routeB), "conflict");
// 仅禁飞区在他页获核准（服务器航线仍为本页编辑前所见）→ 合入已核准禁飞区重试
assert.strictEqual(decideStaleSave(Rt0, Rt0, routeB), "merge");
// 服务器已包含本页航线（他页保存了相同内容或本页已回退到一致）→ 直接同步
assert.strictEqual(decideStaleSave(routeB, Rt0, routeB), "synced");
// 三处都未改动（如仅修订号被禁飞区核准推进）→ 视为已同步，不多写一次
assert.strictEqual(decideStaleSave(Rt0, Rt0, Rt0), "synced");

// 航线等价比较与键序无关
assert.ok(sameRoute({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }));
assert.ok(!sameRoute({ a: 1 }, { a: 2 }));
assert.ok(!sameRoute(routeA, routeB));
assert.ok(sameRoute(null, undefined) === sameRoute({}, undefined)); // 缺省按空对象
// 服务器原样存储的部分形式 ≡ 本页补全默认键后的同一航线（不得误判为冲突）
assert.ok(sameRoute({ waypoints: [] }, { waypoints: [], speeds: [], unitScale: 100, corridorHalfWidth: 0.3 }));
assert.strictEqual(
  decideStaleSave({ waypoints: [] }, { waypoints: [], speeds: [], unitScale: 100, corridorHalfWidth: 0.3 }, routeB),
  "merge", "仅禁飞区他页核准（航线原样未动）时必须合入重试而非冲突");
console.log("route_conflict js checks ok");
"""


@unittest.skipUnless(shutil.which("node"), "需要 node 执行 JS 决策逻辑回归")
class RouteConflictJsTests(unittest.TestCase):
    def test_decide_stale_save(self):
        self.assertTrue(JS_FILE.exists(), f"缺少 {JS_FILE}")
        with tempfile.TemporaryDirectory() as tmp:
            script = os.path.join(tmp, "route_conflict_check.js")
            with open(script, "w", encoding="utf-8") as f:
                f.write(JS_CHECK)
            proc = subprocess.run(
                ["node", script, str(JS_FILE)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("ok", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
