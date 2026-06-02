/**
 * GoodAgent LSP Manager — lightweight LSP client over JSON-RPC stdio
 * Supports: goToDefinition, findReferences, hover, documentSymbol
 * Language servers: auto-detected by file extension
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { getWorkspace } from "./core/state.mjs";

const LANG_SERVERS = {
  ".ts":  { command: "typescript-language-server", args: ["--stdio"], lang: "typescript" },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"], lang: "typescriptreact" },
  ".js":  { command: "typescript-language-server", args: ["--stdio"], lang: "javascript" },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"], lang: "javascriptreact" },
};

class LspManager {
  constructor() { this.servers = new Map(); } // lang → { proc, conn, ready, openedFiles }

  getLang(filePath) {
    const ext = extname(filePath).toLowerCase();
    return LANG_SERVERS[ext] || null;
  }

  async getServer(filePath) {
    const cfg = this.getLang(filePath);
    if (!cfg) throw new Error(`No LSP server configured for ${extname(filePath)} files. Supported: ${Object.keys(LANG_SERVERS).join(", ")}`);
    if (this.servers.has(cfg.lang)) return this.servers.get(cfg.lang);
    const server = await this.startServer(cfg);
    this.servers.set(cfg.lang, server);
    return server;
  }

  async startServer(cfg) {
    // Use the user-chosen workspace, NOT the launch dir — language
    // servers resolve project-local config (tsconfig.json, etc.)
    // relative to the cwd they are spawned in.
    const cwd = getWorkspace();
    const proc = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "pipe"], cwd, windowsHide: true, shell: true });
    const server = { proc, reqId: 0, pending: new Map(), openedFiles: new Set(), ready: false };

    // Line-based JSON-RPC reader
    let buf = "";
    let contentLen = -1;
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      while (true) {
        if (contentLen === -1) {
          const m = buf.match(/Content-Length: (\d+)\r\n\r\n/);
          if (!m) break;
          contentLen = parseInt(m[1], 10);
          buf = buf.slice(m.index + m[0].length);
        }
        if (buf.length < contentLen) break;
        const body = buf.slice(0, contentLen);
        buf = buf.slice(contentLen);
        contentLen = -1;
        try {
          const msg = JSON.parse(body);
          if (msg.id !== undefined && server.pending.has(msg.id)) {
            server.pending.get(msg.id)(msg);
            server.pending.delete(msg.id);
          }
        } catch { /* ignored */ }
      }
    });

    proc.stderr?.on("data", () => {}); // suppress

    // Initialize
    await this.sendReq(server, "initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).href,
      capabilities: {
        textDocument: { definition: {}, references: {}, hover: {}, documentSymbol: {} },
      },
    });
    await this.sendNotif(server, "initialized", {});
    server.ready = true;
    return server;
  }

  sendReq(server, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++server.reqId;
      const timeout = setTimeout(() => { server.pending.delete(id); reject(new Error(`LSP timeout: ${method}`)); }, 15000);
      server.pending.set(id, (msg) => {
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      server.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }

  sendNotif(server, method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    server.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  async openFile(server, filePath) {
    if (server.openedFiles.has(filePath)) return;
    const text = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    await this.sendNotif(server, "textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(filePath).href, languageId: this.getLang(filePath)?.lang || "text", version: 1, text },
    });
    server.openedFiles.add(filePath);
  }

  fmtResult(uri) {
    if (!uri) return "(no result)";
    const u = typeof uri === "string" ? uri : uri.uri || "";
    const m = u.match(/file:\/\/\/?(.*?)(?:#L(\d+)(?:-(\d+))?)?$/);
    if (!m) return u;
    const p = m[1].replace(/\\/g, "/");
    const line = m[2] ? `:${m[2]}` : "";
    return `${p}${line}`;
  }

  async goToDefinition(filePath, line, character) {
    const server = await this.getServer(filePath);
    await this.openFile(server, filePath);
    const result = await this.sendReq(server, "textDocument/definition", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: (line || 1) - 1, character: (character || 1) - 1 },
    });
    const items = Array.isArray(result) ? result : result ? [result] : [];
    if (items.length === 0) return { text: "No definition found", count: 0 };
    const lines = items.map((d, i) => `${i + 1}. ${this.fmtResult(d.targetUri || d.uri)}${d.targetRange ? ` (line ${d.targetRange.start.line + 1})` : ""}`);
    return { text: `Found ${items.length} definition(s):\n${lines.join("\n")}`, count: items.length };
  }

  async findReferences(filePath, line, character) {
    const server = await this.getServer(filePath);
    await this.openFile(server, filePath);
    const result = await this.sendReq(server, "textDocument/references", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: (line || 1) - 1, character: (character || 1) - 1 },
      context: { includeDeclaration: true },
    });
    const items = result || [];
    if (items.length === 0) return { text: "No references found", count: 0 };
    const byFile = {};
    for (const r of items) {
      const f = this.fmtResult(r.uri);
      if (!byFile[f]) byFile[f] = [];
      byFile[f].push(r.range.start.line + 1);
    }
    const lines = Object.entries(byFile).map(([f, ls]) => `  ${f} (lines: ${ls.join(", ")})`);
    return { text: `Found ${items.length} reference(s) in ${Object.keys(byFile).length} file(s):\n${lines.join("\n")}`, count: items.length };
  }

  async hover(filePath, line, character) {
    const server = await this.getServer(filePath);
    await this.openFile(server, filePath);
    const result = await this.sendReq(server, "textDocument/hover", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: (line || 1) - 1, character: (character || 1) - 1 },
    });
    if (!result) return { text: "No hover info", count: 0 };
    const content = typeof result.contents === "string" ? result.contents
      : Array.isArray(result.contents) ? result.contents.map(c => typeof c === "string" ? c : c.value || "").join("\n")
      : result.contents?.value || JSON.stringify(result.contents);
    return { text: content, count: 1 };
  }

  async documentSymbol(filePath) {
    const server = await this.getServer(filePath);
    await this.openFile(server, filePath);
    const result = await this.sendReq(server, "textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(filePath).href },
    });
    const items = result || [];
    if (items.length === 0) return { text: "No symbols found", count: 0 };
    const lines = items.map(s => {
      const line = s.range?.start?.line ?? s.location?.range?.start?.line ?? 0;
      return `  ${s.name} (${s.kind}) — line ${line + 1}`;
    });
    return { text: `Document symbols (${items.length}):\n${lines.join("\n")}`, count: items.length };
  }

  shutdown() {
    for (const [, server] of this.servers) {
      try { server.proc.kill(); } catch { /* ignored */ }
    }
    this.servers.clear();
  }
}

export default new LspManager();
