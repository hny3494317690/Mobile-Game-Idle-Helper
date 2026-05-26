import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";
import { isAuthorized } from "./auth.js";

const configPath = path.resolve(process.cwd(), "config/default.json");
const fileConfig = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

const PORT = Number(process.env.BRIDGE_PORT || fileConfig.bridgePort || 27183);
const DEFAULT_SERIAL = fileConfig.deviceSerial || "your-adb-host:16384";

const server = new WebSocketServer({ port: PORT });

server.on("connection", (socket, request) => {
  if (!isAuthorized(request)) {
    socket.close(1008, "unauthorized");
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const serial = requestUrl.searchParams.get("serial") || DEFAULT_SERIAL;
  const [host, portText] = serial.split(":");
  const port = Number(portText);

  if (!host || !Number.isInteger(port)) {
    socket.close(1011, "invalid serial");
    return;
  }

  const tcp = net.createConnection({ host, port });

  tcp.on("connect", () => {
    console.log(`bridge connected to ${serial}`);
  });

  tcp.on("data", (chunk) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(chunk);
    }
  });

  tcp.on("error", (error) => {
    console.error(`tcp error for ${serial}:`, error.message);
    socket.close(1011, error.message);
  });

  tcp.on("close", () => {
    socket.close();
  });

  socket.on("message", (data) => {
    tcp.write(data);
  });

  socket.on("close", () => {
    tcp.destroy();
  });

  socket.on("error", () => {
    tcp.destroy();
  });
});

console.log(`ADB WebSocket bridge listening on ws://0.0.0.0:${PORT}`);
