window.__ModuleLoader__.load({
  id: "apitu",
  factory: (require) => {
    var React = require("react");
    var API = "/api/apitu";
    var inject = ["slots", "sidebarRightTabs"];
    var css = [
      ".apitu-panel{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:16px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#20252b);background:var(--dsw-alias-bg-base,#fff);font-size:13px;line-height:1.6;font-family:var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif)}",
      ".apitu-panel *{box-sizing:border-box}.apitu-panel h2,.apitu-panel h3,.apitu-panel p{margin:0}.apitu-panel h2{font-size:18px}.apitu-panel h3{font-size:14px}",
      ".apitu-muted{color:var(--dsw-alias-label-secondary,#687580);font-size:12px}.apitu-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.apitu-header{justify-content:space-between}",
      ".apitu-card{border:1px solid var(--dsw-alias-border-l3,#dce2e5);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}.apitu-panel label{display:flex;flex-direction:column;gap:4px}",
      ".apitu-panel input,.apitu-panel select,.apitu-panel textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l3,#ced6da);border-radius:6px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1,#f7f9fa);color:inherit;font:inherit}.apitu-panel textarea{resize:vertical;font-family:ui-monospace,monospace}",
      ".apitu-panel button{border:1px solid var(--dsw-alias-border-l3,#ced6da);border-radius:10px;padding:5px 10px;background:var(--dsw-alias-bg-layer-1,#f7f9fa);color:inherit;font:inherit;font-size:13px;cursor:pointer}.apitu-panel button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.apitu-panel button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #007aff);outline-offset:2px}.apitu-panel button:disabled{opacity:.5;cursor:default}.apitu-panel .apitu-primary{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ced6da));background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #007aff) 16%, transparent);color:var(--dsw-alias-label-primary)}",
      ".apitu-error{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-danger-fg,#be3434);border-left:3px solid currentColor;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#faf7f7)}",
      ".apitu-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;margin:0;font:12px/1.55 ui-monospace,monospace;padding:8px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,#f6f8fa)}.apitu-panel summary{cursor:pointer}.apitu-mode{display:flex;gap:8px;align-items:baseline}.apitu-mode strong{min-width:76px}.apitu-jobs{display:flex;flex-direction:column;gap:10px}.apitu-status{font-weight:600}.apitu-path{overflow-wrap:anywhere}"
    ].join("");

    async function request(query, body) {
      var response = await fetch(API + (query ? "?" + new URLSearchParams(query) : ""), body === undefined ? undefined : {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      var text = await response.text();
      var data;
      try { data = JSON.parse(text); }
      catch (_) { throw new Error("apitu 返回非 JSON 响应（HTTP " + response.status + "）\n" + text); }
      if (!response.ok || data.ok === false) throw new Error(data.error || ("apitu 请求失败（HTTP " + response.status + "）"));
      return data;
    }
    function message(error) { return error instanceof Error ? error.message : String(error); }
    function stringify(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
    function validCwd(value) {
      if (!value.trim() || !value.trim().startsWith("/")) throw new Error("请填写工作目录的绝对路径，例如 /Users/你的用户名/项目。不会使用 Host 进程目录替代。");
      return value.trim();
    }
    function sessionId(props) {
      var info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
      if (props && props.sessionId) return props.sessionId;
      return (info && info.tab && info.tab.sessionId) || "";
    }
    function Glyph(props) {
      var size = (props && props.size) || 24;
      return React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        React.createElement("rect", { x: 3.5, y: 4, width: 7, height: 6, rx: 1.4 }),
        React.createElement("rect", { x: 13.5, y: 4, width: 7, height: 6, rx: 1.4 }),
        React.createElement("rect", { x: 8, y: 14, width: 8, height: 6, rx: 1.4 }),
        React.createElement("path", { d: "M7 10v2h5m5-2v2h-5m0 .5V14" })
      );
    }
    function statusText(status) {
      return ({ queued: "排队中", running: "运行中", previewing: "预览中", completed: "完成", failed: "失败", cancelled: "已取消" })[status] || status || "未知状态";
    }
    function hostCwd(data) {
      return data && typeof data.cwd === "string" && data.cwd.startsWith("/") ? data.cwd : "";
    }
    function App(props) {
      var currentSessionId = props.sessionId;
      function scopedRequest(query, body) {
        if (!currentSessionId) return Promise.reject(new Error("请先打开一个当前会话；apitu 不使用 Host 默认策略。"));
        return request(Object.assign({ sessionId: currentSessionId }, query || {}), body === undefined ? undefined : Object.assign({}, body, { sessionId: currentSessionId }));
      }
      var state = React.useState(null), data = state[0], setData = state[1];
      var errorState = React.useState(""), error = errorState[0], setError = errorState[1];
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1];
      var cwdState = React.useState(""), cwd = cwdState[0], setCwd = cwdState[1];
      var pathState = React.useState(""), jsonPath = pathState[0], setJsonPath = pathState[1];
      var outputState = React.useState(""), outputPath = outputState[0], setOutputPath = outputState[1];
      var modeState = React.useState("roadmap"), mode = modeState[0], setMode = modeState[1];
      var serviceState = React.useState(""), serviceError = serviceState[0], setServiceError = serviceState[1];
      var argsState = React.useState('["help"]'), rawArgs = argsState[0], setRawArgs = argsState[1];
      var noticeState = React.useState(""), notice = noticeState[0], setNotice = noticeState[1];
      var stoppingState = React.useState(""), stopping = stoppingState[0], setStopping = stoppingState[1];
      var alive = React.useRef(false);
      var latest = React.useRef(0);
      var timer = React.useRef(null);
      var cwdTouched = React.useRef(false);
      var e = React.createElement;
      var shownCwd = cwdTouched.current ? cwd : (cwd || hostCwd(data));
      async function refresh() {
        var revision = ++latest.current;
        try {
          var value = await scopedRequest();
          if (!Array.isArray(value.jobs)) throw new Error("apitu 响应缺少任务列表，无法确认任务状态。");
          if (alive.current && revision === latest.current) { setData(value); setServiceError(""); }
          return value;
        } catch (failure) {
          if (alive.current && revision === latest.current) setServiceError(message(failure));
          return null;
        }
      }
      React.useEffect(function () {
        alive.current = true;
        function delay() { return typeof document !== "undefined" && document.hidden ? 15000 : 3000; }
        async function tick() {
          await refresh();
          if (alive.current) timer.current = setTimeout(tick, delay());
        }
        function onVisible() {
          if (!alive.current || (typeof document !== "undefined" && document.hidden)) return;
          clearTimeout(timer.current);
          tick();
        }
        tick();
        if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", onVisible);
        return function () {
          alive.current = false; latest.current++; clearTimeout(timer.current);
          if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("visibilitychange", onVisible);
        };
      }, []);
      async function run(action, args) {
        setError(""); setNotice("");
        try {
          var body = { action: action, cwd: validCwd(shownCwd) };
          if (args) body.args = args;
          setBusy(true);
          var value = await scopedRequest(null, body);
          if (!value.jobId) throw new Error("apitu 未返回任务编号，无法确认任务已创建。");
          if (alive.current) { setNotice("任务已提交：" + value.jobId + "。请查看下方实际运行结果。"); await refresh(); }
        } catch (failure) { if (alive.current) setError(message(failure)); }
        finally { if (alive.current) setBusy(false); }
      }
      function runRaw() {
        try {
          var args = JSON.parse(rawArgs);
          if (!Array.isArray(args) || !args.length || args.some(function (arg) { return typeof arg !== "string"; })) throw new Error("CLI 参数必须是非空字符串数组，例如 [\"help\"]。");
          return run("run", args);
        } catch (failure) { setError(message(failure)); }
      }
      function renderJson() {
        if (!jsonPath.trim()) { setError("请填写已有 JSON 文件路径。"); return; }
        var output = outputPath.trim() || (".apitu/" + Date.now() + "/diagram.html");
        return run("run", ["finalize", mode, jsonPath.trim(), output, "--json"]);
      }
      async function open(job) {
        setError("");
        try { await scopedRequest(null, { action: "open", jobId: job.id }); }
        catch (failure) { if (alive.current) setError(message(failure)); }
      }
      async function stopPreview(job) {
        setError(""); setStopping(job.id);
        try {
          await scopedRequest(null, { action: "stop-preview", jobId: job.id });
          if (alive.current) await refresh();
        } catch (failure) { if (alive.current) setError(message(failure)); }
        finally { if (alive.current) setStopping(""); }
      }
      var jobs = data?.jobs || [];
      return e("section", { className: "apitu-panel", "aria-label": "apitu" },
        e("header", { className: "apitu-row apitu-header" }, e("div", null, e("h2", null, "apitu"), e("p", { className: "apitu-muted" }, "本地六种交互图表")), e("button", { type: "button", onClick: refresh }, "刷新")),
        e("p", { className: "apitu-muted" }, "当前会话面板：与对话工具使用同一会话文件策略，并共享本会话任务历史。此处运行示例或渲染已有 JSON；自然语言请交给对话助手。"),
        e("p", { className: "apitu-muted apitu-path", role: "status" }, "会话：" + (currentSessionId || "未关联") + " · 生效文件策略：" + (data?.policy?.mode || "尚未取得")),
        serviceError ? e("div", { className: "apitu-error", role: "alert" }, "服务状态读取失败：" + serviceError) : null,
        error ? e("div", { className: "apitu-error", role: "alert" }, error) : null,
        notice ? e("p", { role: "status", className: "apitu-path" }, notice) : null,
        e("section", { className: "apitu-card" }, e("h3", null, "工作目录"),
          e("label", null, "绝对路径（必填）", e("input", { value: shownCwd, placeholder: "/Users/你的用户名/项目", "aria-label": "工作目录", onChange: function (event) { cwdTouched.current = true; setCwd(event.target.value); } })),
          e("p", { className: "apitu-muted" }, "相对 JSON 路径与 CLI 输出路径均相对此目录解析。请选择你自己的项目目录。"),
          e("button", { className: "apitu-primary", type: "button", disabled: busy, onClick: function () { return run("demo"); } }, "生成示例")
        ),
        e("details", { className: "apitu-card" }, e("summary", null, "六种图表模式"),
          [["roadmap", "路线图：功能与 API 双站点地图（缩放、筛选、点击、流动光点；不含旧 viewer 导出/主题）"], ["architecture", "架构图：系统分层、组件与关系"], ["workflow", "工作流：步骤、决策与分支"], ["sequence", "时序图：角色间的消息与调用顺序"], ["dataflow", "数据流：数据来源、处理与流向"], ["lifecycle", "生命周期：状态、事件与转换"]].map(function (item) { return e("div", { key: item[0], className: "apitu-mode" }, e("strong", null, item[0]), e("span", null, item[1])); })
        ),
        e("section", { className: "apitu-card" }, e("h3", null, "渲染并验证 JSON"),
          e("label", null, "图表模式", e("select", { value: mode, "aria-label": "图表模式", onChange: function (event) { setMode(event.target.value); } }, ["roadmap", "architecture", "workflow", "sequence", "dataflow", "lifecycle"].map(function (name) { return e("option", { key: name, value: name }, name); }))),
          e("label", null, "JSON 文件路径", e("input", { value: jsonPath, placeholder: "diagram.json", "aria-label": "JSON 文件路径", onChange: function (event) { setJsonPath(event.target.value); } })),
          e("label", null, "HTML 输出路径（可选）", e("input", { value: outputPath, placeholder: ".apitu/<时间戳>/diagram.html", "aria-label": "HTML 输出路径", onChange: function (event) { setOutputPath(event.target.value); } })),
          e("p", { className: "apitu-muted" }, "使用 finalize 完成渲染和自动验证。留空输出路径时创建带时间戳的新目录；以任务返回的实际产物路径为准。"),
          e("button", { type: "button", disabled: busy, onClick: renderJson }, "渲染已有文件")
        ),
        e("details", { className: "apitu-card" }, e("summary", null, "完整 CLI 参数"),
          e("p", { className: "apitu-muted" }, "参数按 JSON 字符串数组传入，不执行 shell。可运行帮助、验证及核心支持的其他命令。"),
          e("label", null, "参数数组", e("textarea", { rows: 4, value: rawArgs, "aria-label": "CLI 参数", onChange: function (event) { setRawArgs(event.target.value); } })),
          e("button", { type: "button", disabled: busy, onClick: runRaw }, "执行参数")
        ),
        e("section", { className: "apitu-jobs", "aria-label": "最近任务" }, e("h3", null, "最近任务"),
          !data ? e("p", { className: "apitu-muted" }, error ? "服务读取失败，尚未取得任务列表。" : "正在读取服务状态…") : null,
          data && !jobs.length ? e("p", { className: "apitu-muted" }, "暂无任务。生成一个示例，或在对话中调用 apitu。") : null,
          jobs.map(function (job) {
            var preview = job.result?.preview;
            var processStatus = preview?.processStatus || preview?.status;
            var previewLabel = ({ running: "运行中", stopping: "正在停止", stopped: "已停止", failed: "失败" })[processStatus] || "未知状态";
            var buildLabel = ({ verified: "已验证", checking: "检查中", "needs-fix": "需要修复", unavailable: "状态不可用", failed: "失败" })[preview?.buildStatus] || preview?.buildStatus || "尚未取得构建状态";
            var canOpen = job.result?.artifacts?.length && ((job.status === "completed" && job.result.ok === true) || preview?.lastVerified);
            return e("article", { key: job.id, className: "apitu-card" },
              e("div", { className: "apitu-row apitu-header" }, e("span", { className: "apitu-status" }, preview ? "预览进程：" + previewLabel : statusText(job.status)), canOpen ? e("button", { type: "button", onClick: function () { return open(job); } }, "打开 HTML") : null),
              preview ? e("section", { "aria-label": "实时预览", className: "apitu-path" },
                e("p", { role: "status" }, "实时预览：" + previewLabel + " · 构建：" + buildLabel),
                preview.lastVerified ? e("p", { className: "apitu-muted" }, "最近验证产物：" + stringify(preview.lastVerified) + (preview.buildStatus !== "verified" ? "（不是当前候选的验证结果）" : "")) : null,
                preview.url ? (processStatus === "running" && /^https?:\/\//.test(preview.url) ? e("a", { href: preview.url, target: "_blank", rel: "noopener noreferrer" }, preview.url) : e("p", { className: "apitu-muted" }, "预览地址：" + preview.url)) : null,
                processStatus === "running" ? e("button", { type: "button", disabled: !!stopping, onClick: function () { return stopPreview(job); } }, stopping === job.id ? "正在停止…" : "停止预览") : null,
                preview.error || preview.failure ? e("div", { className: "apitu-error", role: "alert" }, stringify(preview.error || preview.failure)) : null
              ) : null,
              e("div", { className: "apitu-muted apitu-path" }, "来源：" + (job.source === "tool" ? "对话工具" : "侧栏") + " · 会话：" + (job.sessionId || "未提供")),
              e("div", { className: "apitu-muted apitu-path" }, job.id),
              job.cwd ? e("div", { className: "apitu-muted apitu-path" }, "目录：" + job.cwd) : null,
              job.args ? e("pre", null, stringify(job.args)) : null,
              job.error ? e("div", { className: "apitu-error", role: "alert" }, stringify(job.error)) : null,
              job.result != null ? e("details", { open: true }, e("summary", null, "输出与验证结果"), e("pre", null, stringify(job.result))) : null
            );
          })
        ),
        data ? e("footer", { className: "apitu-muted apitu-path" }, "插件 " + (data.version || "未提供版本") + " · 核心 " + (data.coreVersion || "未提供版本"), data.skillRoot ? e("div", null, "技能：" + data.skillRoot) : null) : null
      );
    }
    function apply(ctx) {
      var style = document.getElementById("apitu-style");
      if (!style) { style = document.createElement("style"); style.id = "apitu-style"; document.head.appendChild(style); }
      style.textContent = css;
      function Pane(props) { var id = sessionId(props); return React.createElement(App, { key: id, sessionId: id }); }
      ctx.effect(function () { return ctx.sidebarRightTabs.register({ id: "apitu", kind: "apitu", priority: "extension", title: function () { return "apitu"; }, guide: [{ id: "open", order: 65, title: function () { return "apitu"; }, description: function () { return "六种交互图表"; }, icon: Glyph }] }); }, "apitu.type");
      ctx.effect(function () { return ctx.slots.inject("sidebar.right.pane.tab", function () { return ctx.slots.register({ name: "sidebar.right.pane.tab", key: "apitu" }, Pane); }); }, "apitu.body");
      ctx.effect(function () { return ctx.slots.inject("sidebar.right.pane.tab.title", function () { return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "apitu" }, function () { return React.createElement("span", null, "apitu"); }); }); }, "apitu.title");
    }
    return { inject: inject, apply: apply };
  }
});
