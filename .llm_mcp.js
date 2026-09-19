



















const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = process.env.MCP_SERVERS_FILE || path.join(os.homedir(), '.mcp_servers.json');

function loadServers() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return j.servers || j;
  } catch (e) { return {}; }
}

function sanitizeSchema(s) {
  
  if (!s || typeof s !== 'object') return s || {};
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  const out = {};
  for (const k of Object.keys(s)) {
    if (k === '$schema' || k === '$id' || k === '$ref' || k === 'definitions' || k === '$defs') continue;
    const v = s[k];
    if (v && typeof v === 'object') out[k] = sanitizeSchema(v);
    else out[k] = v;
  }
  return out;
}


function connectStdio(server) {
  const child = spawn(server.command, server.args || [], {
    env: { ...process.env, ...(server.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  let stderrTail = '';
  const pending = new Map();
  const timers = new Map();
  let nextId = 0;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-2000); });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        clearTimeout(timers.get(msg.id)); timers.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  child.on('error', err => { for (const p of pending.values()) p.reject(err); pending.clear(); });
  child.on('close', () => { for (const p of pending.values()) p.reject(new Error('MCP 进程退出: ' + stderrTail.slice(-300))); pending.clear(); });

  return {
    request(method, params, timeout = 90000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        timers.set(id, setTimeout(() => {
          pending.delete(id); timers.delete(id);
          reject(new Error('MCP 请求超时: ' + method));
        }, timeout));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    },
    close() { try { child.kill(); } catch (e) {} }
  };
}


function expandEnv(s) {
  return String(s).replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '');
}
function parseSSE(text, targetId) {
  
  const events = String(text).split(/\r?\n\r?\n/);
  for (const ev of events) {
    let data = '';
    for (const line of ev.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    let j; try { j = JSON.parse(data); } catch (e) { continue; }
    if (j.id === targetId) return j;
  }
  throw new Error('SSE 响应中未找到 id=' + targetId);
}

function connectHTTP(server) {
  const url = server.url;
  const baseHeaders = {};
  for (const [k, v] of Object.entries(server.headers || {})) baseHeaders[k] = expandEnv(v);
  let sessionId = null;
  let nextId = 0;

  async function rpc(method, params, timeout = 90000) {
    const id = ++nextId;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...baseHeaders
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
      signal: AbortSignal.timeout(timeout)
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300));
    const ctype = res.headers.get('content-type') || '';
    let msg;
    if (ctype.includes('text/event-stream')) msg = parseSSE(text, id);
    else { try { msg = JSON.parse(text); } catch (e) { throw new Error('HTTP 响应不是 JSON: ' + text.slice(0, 200)); } }
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    if (msg.id !== id) throw new Error('HTTP 响应 id 不匹配');
    return msg.result;
  }

  return {
    request: rpc,
    notify(method, params) {
      
      const headers = { 'Content-Type': 'application/json', ...baseHeaders };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {} })
      }).catch(() => {});
    },
    close() {}
  };
}

function connect(server) {
  return server.url ? connectHTTP(server) : connectStdio(server);
}

async function withServer(name, server, fn) {
  const c = connect(server);
  try {
    let ok = false;
    for (const v of ['2025-06-18', '2024-11-05']) {
      try {
        await c.request('initialize', {
          protocolVersion: v,
          capabilities: {},
          clientInfo: { name: 'termux-llm', version: '1.0.0' }
        });
        ok = true; break;
      } catch (e) {  }
    }
    if (!ok) throw new Error('initialize 失败 (协议协商不兼容)');
    c.notify('notifications/initialized');
    return await fn(c);
  } finally {
    c.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const servers = loadServers();
  const names = Object.keys(servers);

  if (cmd === 'servers') {
    console.log(names.length ? names.join('\n') : '(未配置服务器: ' + CONFIG + ')');
    return;
  }
  if (names.length === 0) {
    if (cmd === 'list') { console.log('[]'); return; }
    console.error('未配置 MCP 服务器: ' + CONFIG); process.exit(1);
  }

  if (cmd === 'list') {
    const all = [];
    for (const name of names) {
      try {
        const r = await withServer(name, servers[name], c => c.request('tools/list'));
        for (const t of (r.tools || [])) {
          all.push({
            type: 'function',
            function: {
              name: t.name,
              description: t.description || ('MCP 工具 [' + name + '] ' + t.name),
              parameters: sanitizeSchema(t.inputSchema) || { type: 'object', properties: {} }
            }
          });
        }
      } catch (e) {
        console.error('[mcp] 服务器 ' + name + ' 工具列表失败: ' + e.message);
      }
    }
    console.log(JSON.stringify(all));
  } else if (cmd === 'call') {
    const toolName = args[1];
    let cargs = {};
    try { cargs = args[2] ? JSON.parse(args[2]) : {}; } catch (e) { console.error('参数 JSON 无效: ' + args[2]); process.exit(1); }
    for (const name of names) {
      try {
        const r = await withServer(name, servers[name], c => c.request('tools/list'));
        const hit = (r.tools || []).find(t => t.name === toolName);
        if (!hit) continue;
        const res = await withServer(name, servers[name], c =>
          c.request('tools/call', { name: toolName, arguments: cargs }));
        const texts = (res.content || []).map(x =>
          x.type === 'text' ? x.text
          : x.type === 'image' ? '[图片结果: ' + (x.data ? (x.data.length + ' B base64') : '') + ']'
          : x.type === 'resource' ? (x.resource ? JSON.stringify(x.resource) : '')
          : JSON.stringify(x)
        ).filter(Boolean).join('\n');
        console.log(texts || '(工具无文本输出)');
        return;
      } catch (e) {
        console.error('[mcp] 服务器 ' + name + ' 调用 ' + toolName + ' 失败: ' + e.message);
      }
    }
    console.error('未找到工具: ' + toolName); process.exit(1);
  } else {
    console.error('用法: node ~/.llm_mcp.js list|servers|call <工具> <JSON>');
    process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
