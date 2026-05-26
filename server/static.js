import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const resourcesDir = path.join(rootDir, "resources");
const configPath = path.join(rootDir, "config", "default.json");
const host = process.env.HOST || "0.0.0.0";

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

const config = loadConfig();
const port = Number(process.env.PORT || config.appPort || 5173);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function resolveFile(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = cleanPath === "/" ? "/index.html" : cleanPath;

  const distCandidate = path.join(distDir, relativePath);
  if (fs.existsSync(distCandidate) && fs.statSync(distCandidate).isFile()) {
    return distCandidate;
  }

  const resourceCandidate = path.join(rootDir, relativePath);
  if (fs.existsSync(resourceCandidate) && fs.statSync(resourceCandidate).isFile()) {
    return resourceCandidate;
  }

  const resourcesCandidate = path.join(resourcesDir, relativePath.replace(/^\/resources\//, ""));
  if (fs.existsSync(resourcesCandidate) && fs.statSync(resourcesCandidate).isFile()) {
    return resourcesCandidate;
  }

  const spaFallback = path.join(distDir, "index.html");
  if (fs.existsSync(spaFallback)) {
    return spaFallback;
  }

  return null;
}

const server = http.createServer((request, response) => {
  const filePath = resolveFile(request.url || "/");

  if (!filePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Static server listening on http://${host}:${port}`);
});
