import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const configPath = path.resolve(process.cwd(), "config/default.json");
const sessionSecret = process.env.AUTH_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function parseCookies(headerValue) {
  const result = {};
  if (!headerValue) {
    return result;
  }

  for (const part of headerValue.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    result[key] = decodeURIComponent(value);
  }

  return result;
}

function signSession(username) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(username)
    .digest("hex");
}

export function isAuthEnabled() {
  const config = loadConfig();
  return Boolean(config.authUsername && config.authPassword);
}

export function isAuthorized(request) {
  if (!isAuthEnabled()) {
    return true;
  }

  const config = loadConfig();
  const cookies = parseCookies(request.headers.cookie);
  const expected = `${config.authUsername}.${signSession(config.authUsername)}`;
  return cookies.alas_auth === expected;
}

export function handleLogin(request, response, bodyText) {
  const config = loadConfig();
  if (!config.authUsername || !config.authPassword) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, message: "auth not configured" }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyText || "{}");
  } catch {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, message: "invalid json" }));
    return;
  }

  if (
    payload.username !== config.authUsername ||
    payload.password !== config.authPassword
  ) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, message: "invalid credentials" }));
    return;
  }

  const token = `${config.authUsername}.${signSession(config.authUsername)}`;
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "set-cookie": `alas_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
  });
  response.end(JSON.stringify({ ok: true }));
}

export function clearAuth(response) {
  response.setHeader(
    "set-cookie",
    "alas_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
}
