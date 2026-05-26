import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const configPath = path.resolve("config/default.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

const appConfig = loadConfig();

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: Number(appConfig.appPort || 5173),
  },
});
