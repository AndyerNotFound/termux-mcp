const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { spawnSync } = require("child_process");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const server = new Server({ name: "termux", version: "2.0.0" }, { capabilities: { tools: {} } });

const BASE = "/storage/emulated/0/Download/Termux/";

function abs(p) {
  if (!p) return p;
  return p.startsWith("/") ? p : path.join(BASE, p);
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "shell",
      description: "执行任意 shell 命令。可多命令组合，支持管道。注意：termux-api 命令（notification/clipboard 等）会卡死，需避开。",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的shell命令" } },
        required: ["command"]
      }
    },
    {
      name: "check_environment",
      description: "检测某个工具是否已安装",
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string", description: "工具名如 python, ffmpeg, git" } },
        required: ["tool"]
      }
    },
    {
      name: "file",
      description: "文件操作。动作：list, read_file, create_file, create_dir, delete, copy, move, append, head, tail, search, replace, extract_lines, info, hash, compress, extract, find, chmod, wc。相对路径基于 /storage/emulated/0/Download/Termux/。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list","read_file","create_file","create_dir","delete","copy","move","append","head","tail","search","replace","extract_lines","info","hash","compress","extract","find","chmod","wc"] },
          target: { type: "string", description: "目标路径" },
          dest: { type: "string", description: "目标路径（copy/move/extract用）" },
          content: { type: "string", description: "文件内容（create_file/append用）" },
          searchPattern: { type: "string", description: "搜索模式" },
          replaceWith: { type: "string", description: "替换文本" },
          useRegex: { type: "boolean", default: false },
          lines: { type: "number", default: 10 },
          algorithm: { type: "string", enum: ["md5","sha1","sha256"], default: "md5" },
          pattern: { type: "string", description: "文件名通配符（find用）" },
          mode: { type: "string", description: "权限如755（chmod用）" }
        },
        required: ["action","target"]
      }
    }
  ]
}));

async function handleFile(args) {
  const t = abs(args.target);
  const d = args.dest ? abs(args.dest) : undefined;
  try {
    switch (args.action) {
      case "list": {
        const e = fs.readdirSync(t, { withFileTypes: true });
        return JSON.stringify(e.map(x => {
          const s = fs.statSync(path.join(t, x.name));
          return { name: x.name, dir: x.isDirectory(), size: s.size, mtime: s.mtime };
        }), null, 2);
      }
      case "read_file":
        return fs.readFileSync(t, "utf-8");
      case "create_file": {
        const dir = path.dirname(t);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(t, args.content || "");
        return "Created: " + t;
      }
      case "create_dir":
        fs.mkdirSync(t, { recursive: true });
        return "Created: " + t;
      case "delete":
        fs.rmSync(t, { recursive: true, force: true });
        return "Deleted: " + t;
      case "copy":
        if (!d) return "Error: dest required";
        fs.statSync(t).isDirectory() ? fs.cpSync(t, d, { recursive: true }) : fs.copyFileSync(t, d);
        return "Copied: " + t + " -> " + d;
      case "move":
        if (!d) return "Error: dest required";
        fs.renameSync(t, d);
        return "Moved: " + t + " -> " + d;
      case "append":
        fs.appendFileSync(t, args.content || "");
        return "Appended: " + t;
      case "head":
        return fs.readFileSync(t, "utf-8").split("\n").slice(0, args.lines || 10).join("\n");
      case "tail":
        return fs.readFileSync(t, "utf-8").split("\n").slice(-(args.lines || 10)).join("\n");
      case "hash":
        return crypto.createHash(args.algorithm || "md5").update(fs.readFileSync(t)).digest("hex");
      case "find":
        const out = [];
        (function walk(dir) {
          for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            if (fs.statSync(fp).isDirectory()) walk(fp);
            else if (f.match((args.pattern || "*").replace(/\*/g, ".*"))) out.push(fp);
          }
        })(t);
        return out.join("\n") || "(none)";
      case "chmod":
        fs.chmodSync(t, parseInt(args.mode || "644", 8));
        return "Chmod " + args.mode + ": " + t;
      case "wc":
        const data = fs.readFileSync(t, "utf-8");
        return "Lines:" + data.split("\n").length + " Words:" + data.split(/\s+/).filter(Boolean).length + " Bytes:" + fs.statSync(t).size;
      case "compress":
        const bn = t.replace(/\/$/, "").split("/").pop();
        const df = d || (t + ".tar.gz");
        spawnSync("tar", ["-czf", df, "-C", path.dirname(t), bn]);
        return "Compressed: " + df;
      case "extract":
        const args2 = d ? ["-xzf", t, "-C", d] : ["-xzf", t];
        spawnSync("tar", args2);
        return "Extracted: " + t;
      case "info":
        const s = fs.statSync(t);
        return JSON.stringify({ path: t, type: s.isDirectory() ? "dir" : "file", size: s.size, mode: s.mode.toString(8), modified: s.mtime }, null, 2);
      case "search":
        const re = args.useRegex ? new RegExp(args.searchPattern, "g") : new RegExp(escRe(args.searchPattern), "g");
        const m = [];
        fs.readFileSync(t, "utf-8").split("\n").forEach((l, i) => { if (re.test(l)) m.push({ line: i + 1, text: l }); });
        return JSON.stringify(m, null, 2);
      case "replace":
        const re2 = args.useRegex ? new RegExp(args.searchPattern, "g") : new RegExp(escRe(args.searchPattern), "g");
        const old = fs.readFileSync(t, "utf-8");
        fs.writeFileSync(t, old.replace(re2, args.replaceWith));
        return "Replaced. " + (old.length - fs.readFileSync(t, "utf-8").length) + " chars changed.";
      case "extract_lines":
        const re3 = args.useRegex ? new RegExp(args.searchPattern) : new RegExp(escRe(args.searchPattern));
        return fs.readFileSync(t, "utf-8").split("\n").filter(l => re3.test(l)).join("\n") || "(none)";
      default:
        return "Unknown action: " + args.action;
    }
  } catch (e) {
    return "Error: " + e.message;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "shell") {
      const cmd = args?.command;
      if (!cmd) return { content: [{ type: "text", text: "Error: command required" }], isError: true };
      const r = spawnSync("sh", ["-c", cmd], { encoding: "utf-8", timeout: 120000 });
      return { content: [{ type: "text", text: r.stdout || r.stderr || "(ok)" }] };
    }
    if (name === "check_environment") {
      const tn = args?.tool;
      if (!tn) return { content: [{ type: "text", text: "Error: tool name required" }], isError: true };
      const ok = spawnSync("sh", ["-c", "command -v \"" + tn + "\" >/dev/null 2>&1"], {}).status === 0;
      if (ok) return { content: [{ type: "text", text: "✅ " + tn + " is installed." }] };
      const suggestions = { python: "pkg install python", ffmpeg: "pkg install ffmpeg", git: "pkg install git", node: "pkg install nodejs", npm: "pkg install nodejs", adb: "pkg install android-tools" };
      return { content: [{ type: "text", text: "❌ " + tn + " not found.\n建议: " + (suggestions[tn] || ("pkg install " + tn)) }], isError: true };
    }
    if (name === "file") {
      return { content: [{ type: "text", text: await handleFile(args || {}) }] };
    }
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
});

const app = express();
const PORT = 3001;
const sessions = {};

app.get("/sse", async (req, res) => {
  console.error("SSE hit, sid=" + req.query.sessionId);
  const t = new SSEServerTransport("/messages", res);
  sessions[t.sessionId] = t;
  try {
    console.error("before connect");
    await server.connect(t);
    console.error("after connect OK");
  } catch (e) {
    console.error("connect ERROR:", e.message);
    try { res.status(500).end("ERR: " + e.message); } catch(_) {}
    return;
  }
  res.on("close", () => { delete sessions[t.sessionId]; });
});

app.post("/messages", async (req, res) => {
  const t = sessions[req.query.sessionId];
  if (!t) { res.status(404).send("Session not found"); return; }
  await t.handlePostMessage(req, res);
});

app.listen(PORT, "127.0.0.1", () => {
  console.error("✅ the Termux MCP Server started at: http://127.0.0.1:" + PORT + "/sse");
});
