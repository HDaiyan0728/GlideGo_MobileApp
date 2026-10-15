/*
 * Maestro Web GUI
 * Maestro Excel Data Driven Framework
 * Copyright 2026 Md. Mohai Minul Islam
 * Licensed under Apache License 2.0
 *
 * Layout:
 *   webgui.js        (this file)  — HTTP routes
 *   lib/state.js                  — shared busy/child flags
 *   lib/runner.js                 — flows + reports + maestro runs + SSE
 *   lib/excel.js                  — all Excel read/write logic
 *   lib/flows-io.js               — YAML read/save/dup/rename/delete
 *   index.html, styles.css, app.js — UI (served from project root)
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { exec } = require("child_process");

const state   = require("./lib/state");
const runner  = require("./lib/runner");
const excel   = require("./lib/excel");
const flowIo  = require("./lib/flows-io");
const history = require("./lib/history");
const suites  = require("./lib/suites");

// Friendly address: browsers send *.localhost to this computer automatically,
// so no hosts-file change is needed. Change the name here if you like.
const HOST_NAME = "x-maestro.localhost";

const PROJECT_DIR = __dirname;
const REPORTS_DIR = runner.REPORTS_DIR;
const PORT        = 4545;

const INDEX_PATH  = path.join(PROJECT_DIR, "index.html");
const STYLES_PATH = path.join(PROJECT_DIR, "styles.css");
const APPJS_PATH  = path.join(PROJECT_DIR, "app.js");

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks)
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", HOST_NAME].includes(host)) {
    res.writeHead(403); return res.end("Forbidden host");
  }
  const u = new URL(req.url, "http://localhost:" + PORT);
  const p = u.pathname;

  /* ----- Static UI ----- */
  if (req.method === "GET" && p === "/")           return sendFile(res, INDEX_PATH,  "text/html; charset=utf-8");
  if (req.method === "GET" && p === "/styles.css") return sendFile(res, STYLES_PATH, "text/css; charset=utf-8");
  if (req.method === "GET" && p === "/app.js")     return sendFile(res, APPJS_PATH,  "application/javascript; charset=utf-8");
  if (req.method === "GET" && /^\/ui\/[a-z0-9-]+\.js$/.test(p))
    return sendFile(res, path.join(PROJECT_DIR, p), "application/javascript; charset=utf-8");
  if (req.method === "GET" && p === "/app.config.json")
    return sendFile(res, path.join(PROJECT_DIR, "app.config.json"), "application/json; charset=utf-8");

  /* ----- Suites ----- */
  if (req.method === "GET" && p === "/api/suites") return json(res, 200, suites.list());
  if (req.method === "POST" && (p === "/api/suites/save" || p === "/api/suites/delete")) {
    readBody(req).then(body => {
      try {
        const parsed = JSON.parse(body);
        if (p.endsWith("save")) suites.save(parsed, new Set(runner.listFlowPaths()));
        else suites.remove(String(parsed.name || ""));
        json(res, 200, { ok: true, suites: suites.list() });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  /* ----- Run history (dashboard) ----- */
  if (req.method === "GET" && p === "/api/history") return json(res, 200, history.list());

  /* ----- Prepared test data of one sheet (preview) ----- */
  if (req.method === "GET" && p === "/api/data") {
    const ex = String(u.searchParams.get("excel") || ""), sh = String(u.searchParams.get("sheet") || "");
    if (!/^[\w-]+$/.test(ex) || !/^[\w-]+$/.test(sh)) return json(res, 400, { error: "bad name" });
    return fs.readFile(path.join(PROJECT_DIR, "JsonData", ex, sh + ".json"), "utf8", (err, txt) => {
      if (err) return json(res, 404, { error: "No data yet. Run Prepare Data." });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(txt);
    });
  }

  /* ----- Project info ----- */
  if (req.method === "GET" && p === "/api/project") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(PROJECT_DIR);
  }

  /* ----- Flows / reports ----- */
  if (req.method === "GET" && p === "/api/flows") {
    try { return json(res, 200, runner.listFlows()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "GET" && p === "/api/reports") {
    try { return json(res, 200, runner.listReports()); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  /* ----- SSE ----- */
  if (req.method === "GET" && p === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(": connected\n\n");
    runner.addSseClient(res);
    req.on("close", () => runner.removeSseClient(res));
    return;
  }

  /* ----- Prepare data ----- */
  if (req.method === "POST" && p === "/api/setup") {
    if (state.busy) return json(res, 409, { ok: false, error: "busy" });
    state.busy = true;
    state.stopRequested = false;
    runner.broadcast("\n=== Prepare Data ===\n");
    runner.runSetup()
      .then(code => {
        runner.broadcast("\n[SETUP DONE] exit code: " + code + "\n");
        json(res, 200, { ok: code === 0 });
      })
      .catch(e => json(res, 500, { ok: false, error: e.message }))
      .finally(() => state.reset());
    return;
  }

  /* ----- Run flows ----- */
  if (req.method === "POST" && p === "/api/run") {
    readBody(req).then(body => {
      let jobs, stopOnFail;
      try {
        const parsed = JSON.parse(body);
        const valid  = new Set(runner.listFlowPaths());
        // items: [{ flow, rows }]. Plain "flows": [paths] still accepted.
        let items = Array.isArray(parsed.items) ? parsed.items
                  : (parsed.flows || []).map(f => ({ flow: f, rows: "" }));
        items = items.filter(it => it && valid.has(it.flow))
                     .map(it => ({ flow: it.flow, rows: String(it.rows || "") }));
        if (!items.length) return json(res, 400, { ok: false, error: "no valid flows" });
        jobs = runner.buildJobs(items);        // validates row selections
        stopOnFail = !!parsed.stopOnFail;
        var meta = { suite: parsed.suite ? String(parsed.suite).slice(0, 60) : null };
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message || "bad request" });
      }
      if (state.busy) return json(res, 409, { ok: false, error: "busy" });

      state.busy = true;
      state.stopRequested = false;

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, started: true, total: jobs.length }));

      runner.runFlows(jobs, stopOnFail, meta);
    }).catch(() => json(res, 400, { ok: false, error: "bad request" }));
    return;
  }

  /* ----- Stop ----- */
  if (req.method === "POST" && p === "/api/stop") {
    if (state.busy) {
      state.stopRequested = true;
      runner.broadcast("\n[STOP] Stopping test run...\n");
      if (state.currentChild) runner.killTree(state.currentChild);
    }
    return json(res, 200, { ok: true });
  }

  /* ----- Flow file I/O ----- */
  if (req.method === "GET" && p === "/api/flow/read") {
    try {
      const rel = u.searchParams.get("path");
      return json(res, 200, { path: rel, content: flowIo.readFlow(rel) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (req.method === "POST" && p === "/api/flow/save") {
    readBody(req).then(body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running." });
        const parsed = JSON.parse(body);
        flowIo.saveFlow(parsed.path, parsed.content);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && p === "/api/flow/duplicate") {
    readBody(req).then(body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running." });
        const parsed = JSON.parse(body);
        flowIo.duplicateFlow(parsed.from, parsed.to);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && p === "/api/flow/delete") {
    readBody(req).then(body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running." });
        const parsed = JSON.parse(body);
        flowIo.deleteFlow(parsed.path);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && p === "/api/flow/rename") {
    readBody(req).then(body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running." });
        const parsed = JSON.parse(body);
        flowIo.renameFlow(parsed.from, parsed.to);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  /* ----- Open a project folder in Explorer ----- */
  if (req.method === "POST" && p === "/api/open-folder") {
    readBody(req).then(body => {
      try {
        const parsed = JSON.parse(body);
        const kind = String(parsed.kind || "");
        const map = {
          reports:  path.join(PROJECT_DIR, "Reports"),
          testdata: path.join(PROJECT_DIR, "TestData"),
          backups:  path.join(PROJECT_DIR, "ExcelBackups"),
          flowbackups: path.join(PROJECT_DIR, "FlowBackups"),
          project:  PROJECT_DIR
        };
        const target = map[kind];
        if (!target) return json(res, 400, { error: "Unknown folder" });
        fs.mkdirSync(target, { recursive: true });
        exec('explorer.exe "' + target + '"', () => {});
        json(res, 200, { ok: true, path: target });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  /* ----- Excel ----- */
  if (req.method === "GET" && p === "/api/excel/files") {
    try { return json(res, 200, { files: excel.scanExcel(), lib: excel.excelLib(), root: excel.EXCEL_ROOT }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (req.method === "GET" && p === "/api/excel/read") {
    (async () => {
      try {
        const file = excel.resolveExcel(u.searchParams.get("file"));
        json(res, 200, { sheets: await excel.readExcel(file) });
      } catch (e) { json(res, 400, { error: e.message }); }
    })();
    return;
  }

  if (req.method === "POST" && p === "/api/excel/save") {
    readBody(req).then(async body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running. Wait for it to finish." });
        const parsed = JSON.parse(body);
        const file   = excel.resolveExcel(parsed.file);
        const edits  = (parsed.edits || []).filter(e =>
          e && typeof e.sheet === "string" && Number.isInteger(e.r) && Number.isInteger(e.c) &&
          e.r >= 0 && e.c >= 0 && e.r < 100000 && e.c < 1000 && typeof e.v === "string");
        const ops    = (parsed.ops || []).filter(o =>
          o && typeof o.sheet === "string" &&
          ["insertRow","deleteRow","insertCol","deleteCol"].includes(o.op) &&
          Number.isInteger(o.at) && o.at >= 0);
        if (!edits.length && !ops.length)
          return json(res, 400, { error: "No changes to save" });
        state.busy = true;
        try { await excel.applyExcelChanges(file, ops, edits); }
        finally { state.busy = false; }
        json(res, 200, { ok: true, saved: edits.length, ops: ops.length });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && p === "/api/excel/newfile") {
    readBody(req).then(async body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running. Wait for it to finish." });
        const parsed = JSON.parse(body);
        const sheet  = excel.checkSheetName(parsed.sheet || "Sheet1", []);
        const target = excel.resolveNewExcel(parsed.folder, parsed.name);
        state.busy = true;
        try { await excel.createExcel(target.dir, target.full, sheet, excel.parseHeaders(parsed.headers)); }
        finally { state.busy = false; }
        json(res, 200, {
          ok: true,
          path: path.relative(PROJECT_DIR, target.full).split(path.sep).join("/")
        });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  if (req.method === "POST" && p === "/api/excel/newsheet") {
    readBody(req).then(async body => {
      try {
        if (state.busy) return json(res, 409, { error: "Another task is running. Wait for it to finish." });
        const parsed = JSON.parse(body);
        const file   = excel.resolveExcel(parsed.file);
        state.busy = true;
        try { await excel.addSheetToExcel(file, parsed.name, excel.parseHeaders(parsed.headers)); }
        finally { state.busy = false; }
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    }).catch(() => json(res, 400, { error: "bad request" }));
    return;
  }

  /* ----- Failure screenshots from the last run ----- */
  if (req.method === "GET" && p.startsWith("/runs/")) {
    const rel = p.slice("/runs/".length).split("/").map(decodeURIComponent).join(path.sep);
    const filePath = path.resolve(runner.RUNS_DIR, rel);
    if (!filePath.startsWith(runner.RUNS_DIR + path.sep) || !/\.png$/i.test(filePath)) {
      res.writeHead(403); return res.end();
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(data);
    });
    return;
  }

  /* ----- Reports ----- */
  if (req.method === "GET" && p.startsWith("/reports/")) {
    const rel = decodeURIComponent(p.slice("/reports/".length));
    const filePath = path.resolve(REPORTS_DIR, rel);
    if (!filePath.startsWith(REPORTS_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        ".html": "text/html; charset=utf-8",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".css":  "text/css",
        ".js":   "application/javascript",
        ".json": "application/json"
      };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log("Port " + PORT + " is already in use. Is the GUI already running?");
    console.log("Open http://localhost:" + PORT + " in your browser.");
  } else {
    console.log("Server error: " + e.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("=================================================");
  console.log(" X-Maestro Flow Runner: http://" + HOST_NAME + ":" + PORT);
  console.log(" (also works as     http://localhost:" + PORT + ")");
  console.log("=================================================");
  console.log(" Excel library: " + (excel.excelLib() || "NOT FOUND (run: npm install exceljs)"));
  console.log(" Excel root  : TestData/");
  console.log(" Keep this window open while using the GUI.");
  console.log(" Press Ctrl+C to stop.");
  console.log("");
  exec('start "" http://' + HOST_NAME + ':' + PORT);
});