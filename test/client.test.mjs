import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const settle = () => new Promise(setImmediate);
function mount(initial = { ok: true, version: "1", coreVersion: "2", jobs: [] }, paneProps = { sessionId: "session" }) {
  let plugin, pane, tree, cursor = 0;
  const hooks = [], effects = [], cleanup = [], calls = [], timers = new Map(), registered = [];
  let handler = async (_url, options) => options ? { ok: true, jobId: "new-job" } : initial;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity).filter((x) => x != null) }; },
    useState(seed) { const id = cursor++; if (!(id in hooks)) hooks[id] = seed; return [hooks[id], (value) => { hooks[id] = value; }]; },
    useRef(seed) { const id = cursor++; return hooks[id] ||= { current: seed }; },
    useEffect(fn) { const id = cursor++; if (!(id in hooks)) { hooks[id] = true; effects.push(fn); } },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) { assert.equal(definition.id, "apitu"); plugin = definition.factory((id) => { assert.equal(id, "react"); return React; }); } } },
    document: { getElementById() { return null; }, createElement() { return {}; }, head: { appendChild() {} } },
    fetch: async (url, options) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      const value = await handler(url, options);
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), { status: value.ok === false ? 400 : 200 });
    },
    URLSearchParams, Error, Date,
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const services = {
    effect(fn) { return fn(); },
    sidebarRightTabs: { register(value) { registered.push(value); return () => {}; } },
    slots: { inject(_name, fn) { return fn(); }, register(options, component) { registered.push(options); if (options.name === "sidebar.right.pane.tab") pane = component; return () => {}; } },
  };
  plugin.apply(new Proxy(services, { get(target, key) { if (!(key in target)) throw new Error("Undeclared service: " + key); return target[key]; } }));
  const app = pane(paneProps);
  function render() { cursor = 0; tree = app.type(app.props); while (effects.length) cleanup.push(effects.shift()()); }
  function all(predicate, node = tree, result = []) {
    if (!node || typeof node !== "object") return result;
    if (predicate(node)) result.push(node);
    for (const child of node.children || []) all(predicate, child, result);
    return result;
  }
  function text(node = tree) { return typeof node === "string" ? node : (node?.children || []).map(text).join(" "); }
  render();
  return {
    plugin, registered, calls, render, all, text,
    setHandler(fn) { handler = fn; },
    async flush() { await settle(); render(); },
    input(label, value) { const field = all((node) => node.props["aria-label"] === label)[0]; assert.ok(field, label); field.props.onChange({ target: { value } }); render(); },
    async click(label) { const button = all((node) => node.type === "button" && text(node) === label)[0]; assert.ok(button, label); await button.props.onClick(); await settle(); render(); },
    async poll() { const fn = timers.values().next().value; assert.ok(fn); timers.clear(); await fn(); render(); },
    unmount() { cleanup.forEach((fn) => fn?.()); },
  };
}

test("registers a unique right-sidebar kind, both keyed slots and declared services", async () => {
  const c = mount(); await c.flush();
  assert.deepEqual(Array.from(c.plugin.inject), ["slots", "sidebarRightTabs"]);
  assert.equal(c.registered[0].kind, "apitu");
  assert.deepEqual(c.registered.slice(1).map((x) => [x.name, x.key]), [["sidebar.right.pane.tab", "apitu"], ["sidebar.right.pane.tab.title", "apitu"]]);
  for (const mode of ["roadmap", "architecture", "workflow", "sequence", "dataflow", "lifecycle"]) assert.ok(c.text().includes(mode));
  assert.deepEqual(c.all((node) => node.type === "option").map((node) => node.props.value), ["roadmap", "architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
  assert.equal(c.all((node) => node.props["aria-label"] === "图表模式")[0].props.value, "roadmap");
  assert.match(c.text(), /暂无任务/);
  c.unmount();
});

test("prefills the trusted session cwd from Host without posting", async () => {
  const c = mount({ ok: true, cwd: "/tmp/session-work", jobs: [] }); await c.flush();
  assert.equal(c.all((node) => node.props["aria-label"] === "工作目录")[0].props.value, "/tmp/session-work");
  assert.equal(c.calls.filter((x) => x.body).length, 0);
  await c.click("生成示例");
  assert.deepEqual(c.calls.find((x) => x.body).body, { sessionId: "session", action: "demo", cwd: "/tmp/session-work" });
  c.unmount();
});

test("demo refuses missing or relative cwd and submits an absolute cwd", async () => {
  const c = mount(); await c.flush();
  await c.click("生成示例");
  assert.equal(c.calls.filter((x) => x.body).length, 0);
  assert.match(c.text(), /绝对路径/);
  c.input("工作目录", "project"); await c.click("生成示例");
  assert.equal(c.calls.filter((x) => x.body).length, 0);
  c.input("工作目录", "/tmp/my project"); await c.click("生成示例");
  assert.deepEqual(c.calls.find((x) => x.body).body, { sessionId: "session", action: "demo", cwd: "/tmp/my project" });
  assert.match(c.text(), /任务已提交/);
  c.unmount();
});

test("render uses finalize mode and passes literal input/output paths without shell parsing", async () => {
  const c = mount(); await c.flush();
  c.input("工作目录", "/tmp/work"); c.input("图表模式", "sequence");
  c.input("JSON 文件路径", "input with spaces.json"); c.input("HTML 输出路径", "out folder/diagram.html");
  await c.click("渲染已有文件");
  assert.deepEqual(c.calls.find((x) => x.body).body, { sessionId: "session", action: "run", cwd: "/tmp/work", args: ["finalize", "sequence", "input with spaces.json", "out folder/diagram.html", "--json"] });
  c.unmount();
});

test("the default roadmap mode submits a literal finalize request without changing the selector", async () => {
  const c = mount(); await c.flush();
  c.input("工作目录", "/tmp/work");
  c.input("JSON 文件路径", "roadmap input.json"); c.input("HTML 输出路径", "roadmap output.html");
  await c.click("渲染已有文件");
  assert.deepEqual(c.calls.find((x) => x.body).body, { sessionId: "session", action: "run", cwd: "/tmp/work", args: ["finalize", "roadmap", "roadmap input.json", "roadmap output.html", "--json"] });
  c.unmount();
});

test("missing input and invalid raw arguments fail visibly without posting", async () => {
  const c = mount(); await c.flush(); c.input("工作目录", "/tmp/work");
  await c.click("渲染已有文件"); assert.match(c.text(), /填写已有 JSON/);
  c.input("CLI 参数", "[7]"); await c.click("执行参数"); assert.match(c.text(), /字符串数组/);
  assert.equal(c.calls.filter((x) => x.body).length, 0);
  c.input("CLI 参数", '["help"]'); await c.click("执行参数");
  assert.deepEqual(c.calls.find((x) => x.body).body.args, ["help"]);
  c.unmount();
});

test("action failures survive successful background status refresh", async () => {
  const c = mount(); await c.flush(); c.input("工作目录", "/tmp/work");
  c.setHandler(async (_url, options) => options ? { ok: false, error: "schema invalid: nodes missing" } : { ok: true, jobs: [] });
  await c.click("生成示例"); assert.match(c.text(), /schema invalid: nodes missing/);
  await c.poll(); assert.match(c.text(), /schema invalid: nodes missing/);
  assert.doesNotMatch(c.text(), /任务已提交/);
  c.unmount();
});

test("HTTP non-JSON failures and invalid list responses are not empty success states", async () => {
  const c = mount(); await c.flush();
  c.setHandler(async () => new Response("upstream unavailable", { status: 503 }));
  await c.poll(); assert.match(c.text(), /HTTP 503/); assert.match(c.text(), /upstream unavailable/);
  c.setHandler(async () => ({ ok: true }));
  await c.poll(); assert.match(c.text(), /缺少任务列表/);
  c.unmount();
});

test("only a successful job with HTML artifacts exposes open; output and failures remain visible", async () => {
  const c = mount({ ok: true, jobs: [
    { id: "bad", status: "failed", error: "validation failed", result: { ok: false, exitCode: 1, stderr: "bad schema" } },
    { id: "help", status: "completed", result: { ok: true, stdout: "help output", artifacts: [] } },
    { id: "ok", status: "completed", result: { ok: true, stdout: "validated", artifacts: ["/tmp/a.html"] } },
  ] }); await c.flush();
  assert.equal(c.all((node) => node.type === "button" && c.text(node) === "打开 HTML").length, 1);
  assert.match(c.text(), /validation failed/); assert.match(c.text(), /bad schema/); assert.match(c.text(), /help output/);
  await c.click("打开 HTML");
  assert.deepEqual(c.calls.find((x) => x.body).body, { sessionId: "session", action: "open", jobId: "ok" });
  c.unmount();
});

test("a missing job id never displays submitted success", async () => {
  const c = mount(); await c.flush(); c.input("工作目录", "/tmp/work");
  c.setHandler(async () => ({ ok: true })); await c.click("生成示例");
  assert.match(c.text(), /未返回任务编号/); assert.doesNotMatch(c.text(), /任务已提交/);
  c.unmount();
});

test("running preview exposes an explicit link and stops through the Host API without cwd", async () => {
  const job = { id: "preview-job", status: "previewing", result: { ok: true, artifacts: ["/tmp/viewer.html"], preview: {
    id: "preview-1", url: "http://127.0.0.1:4200/", status: "running", buildStatus: "verified", lastVerified: { generation: 1, path: "/tmp/viewer.html" }, stdout: "Listening", stderr: "",
  } } };
  const c = mount({ ok: true, jobs: [job] }); await c.flush();
  assert.match(c.text(), /六种交互图表/); assert.doesNotMatch(c.text(), /交互原型/);
  assert.equal(c.registered[0].guide[0].description(), "六种交互图表");
  assert.doesNotMatch(c.text(), /预览启动任务已完成/); assert.match(c.text(), /预览进程：运行中/); assert.match(c.text(), /实时预览：运行中/);
  const link = c.all((node) => node.type === "a")[0];
  assert.equal(link.props.href, job.result.preview.url); assert.equal(link.props.target, "_blank");
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.equal(c.calls.some((call) => call.body), false, "Reading a preview must not automatically open or start anything");
  assert.equal(c.all((node) => node.type === "button" && c.text(node) === "打开 HTML").length, 1);
  let finish;
  c.setHandler(async (_url, options) => {
    if (options) return new Promise((resolve) => { finish = () => {
      job.result.preview.status = "stopped"; resolve({ ok: true });
    }; });
    return { ok: true, jobs: [job] };
  });
  const stopped = c.click("停止预览"); await c.flush();
  assert.equal(c.all((node) => node.type === "button" && c.text(node) === "正在停止…")[0].props.disabled, true);
  finish(); await stopped;
  assert.deepEqual(c.calls.find((call) => call.body).body, { sessionId: "session", action: "stop-preview", jobId: "preview-job" });
  assert.match(c.text(), /实时预览：已停止/);
  assert.equal(c.all((node) => node.type === "button" && /停止预览/.test(c.text(node))).length, 0);
  assert.equal(c.all((node) => node.type === "a").length, 0, "Stopped URL is retained as text, not a live link");
  c.unmount();
});

test("stopped and failed preview states remain visible without stop controls", async () => {
  const c = mount({ ok: true, jobs: [
    { id: "stopped", status: "completed", result: { ok: true, preview: { status: "stopped", url: "http://127.0.0.1:4200/" } } },
    { id: "failed", status: "completed", result: { ok: true, preview: { status: "failed", error: "Preview process exited", stderr: "EADDRINUSE" } } },
  ] }); await c.flush();
  assert.match(c.text(), /实时预览：已停止/); assert.match(c.text(), /实时预览：失败/);
  assert.match(c.text(), /Preview process exited/); assert.match(c.text(), /EADDRINUSE/);
  assert.equal(c.all((node) => node.props.role === "alert").length, 1);
  assert.equal(c.all((node) => node.type === "button" && c.text(node) === "停止预览").length, 0);
  c.unmount();
});

test("a stop failure stays visible across polling and does not falsely show stopped", async () => {
  const initial = { ok: true, jobs: [{ id: "running", status: "completed", result: { ok: true, preview: {
    status: "running", url: "http://127.0.0.1:4200/",
  } } }] };
  const c = mount(initial); await c.flush();
  c.setHandler(async (_url, options) => options ? { ok: false, error: "Unable to stop preview" } : initial);
  await c.click("停止预览"); await c.poll();
  assert.match(c.text(), /Unable to stop preview/); assert.match(c.text(), /实时预览：运行中/);
  assert.doesNotMatch(c.text(), /实时预览：已停止/);
  assert.equal(c.all((node) => node.type === "button" && c.text(node) === "停止预览")[0].props.disabled, false);
  c.unmount();
});

test("current-session identity scopes every request and displays the trusted policy", async () => {
  const c = mount({ ok: true, policy: { mode: "read-only" }, jobs: [] }, { useTabInfo: () => ({ tab: { sessionId: "trusted-tab" } }) });
  await c.flush();
  assert.ok(c.calls.every(call => new URL(call.url, "http://local").searchParams.get("sessionId") === "trusted-tab"));
  assert.match(c.text(), /当前会话面板/);
  assert.match(c.text(), /会话：trusted-tab/);
  assert.match(c.text(), /生效文件策略：read-only/);
  c.input("工作目录", "/tmp/work"); await c.click("生成示例");
  assert.equal(c.calls.find(call => call.body).body.sessionId, "trusted-tab");
  c.unmount();
});

test("a panel without a current session fails visibly and never sends an unscoped request", async () => {
  const c = mount(undefined, {}); await c.flush();
  assert.match(c.text(), /不使用 Host 默认策略/);
  assert.match(c.text(), /会话：未关联/);
  c.input("工作目录", "/tmp/work"); await c.click("生成示例");
  assert.equal(c.calls.length, 0);
  assert.doesNotMatch(c.text(), /任务已提交/);
  c.unmount();
});

test("process readiness is distinct from a failed build and last verified artifact", async () => {
  const c = mount({ ok: true, jobs: [{ id: "repaired", source: "tool", sessionId: "session", status: "previewing", error: "Invalid JSON", result: { ok: false, artifacts: ["/tmp/previous.html"], preview: {
    status: "running", processStatus: "running", buildStatus: "needs-fix", failure: { message: "Invalid JSON" }, lastVerified: { generation: 1, path: "/tmp/previous.html" },
  } } }] }); await c.flush();
  assert.match(c.text(), /预览进程：运行中/);
  assert.match(c.text(), /构建：需要修复/);
  assert.match(c.text(), /不是当前候选的验证结果/);
  assert.match(c.text(), /来源：对话工具/);
  assert.match(c.text(), /Invalid JSON/);
  assert.doesNotMatch(c.text(), /预览启动任务已完成/);
  assert.equal(c.all(node => node.type === "button" && c.text(node) === "打开 HTML").length, 1);
  c.unmount();
});
