// Minimal static server for the RecallIQ frontend (no dependencies).
// Serves ONLY the files below — never the project folder, so backend/.env and data stay private.
// Usage: node frontend-server.js   (PORT=3000, HOST=127.0.0.1 by default)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const FILES = {
  "/index.html": "text/html; charset=utf-8",
  "/login.html": "text/html; charset=utf-8",
  "/register.html": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/config.js": "text/javascript; charset=utf-8",
  "/api.js": "text/javascript; charset=utf-8",
  "/script.js": "text/javascript; charset=utf-8",
  "/auth-page.js": "text/javascript; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  const type = FILES[pathname];
  if (!type) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
  fs.readFile(path.join(__dirname, pathname), (error, data) => {
    if (error) { res.writeHead(500).end("Read error"); return; }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${url.pathname}`);
}).listen(PORT, HOST, () => console.log(`RecallIQ frontend: http://localhost:${PORT}  (serving app files only)`));
