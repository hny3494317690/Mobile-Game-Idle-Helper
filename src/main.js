import {
  Adb,
  AdbDaemonTransport,
  AdbPacket,
  AdbPacketSerializeStream,
} from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyPointerId,
  ScrcpyCaptureOrientation,
  ScrcpyLockOrientation,
  ScrcpyOrientation,
} from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { TinyH264Decoder } from "@yume-chan/scrcpy-decoder-tinyh264";
import { Consumable, StructDeserializeStream, pipeFrom } from "@yume-chan/stream-extra";
import "./styles.css";

const DEFAULT_CONFIG = {
  pageUrl: "http://127.0.0.1:22267",
  bridgeUrl: "ws://127.0.0.1:22269",
  deviceSerial: "127.0.0.1:16384",
};

async function loadConfig() {
  try {
    const response = await fetch("/config/default.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const fileConfig = await response.json();
    return {
      ...DEFAULT_CONFIG,
      ...fileConfig,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const APP_CONFIG = await loadConfig();

const PAGE_URL = APP_CONFIG.pageUrl;
const BRIDGE_URL = APP_CONFIG.bridgeUrl;
const DEVICE_SERIAL = APP_CONFIG.deviceSerial;
const DEVICE_SCRCPY_SERVER_PATH = "/data/local/tmp/scrcpy-server.jar";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="workspace">
    <iframe class="target-page" src="${PAGE_URL}" title="target page"></iframe>
    <section class="overlay-shell">
      <div class="scrcpy-panel" id="scrcpy-panel">
        <div class="scrcpy-stage" id="scrcpy-stage">
          <div class="status" id="status">等待连接</div>
        </div>
        <div class="resize-handle" id="resize-handle" aria-label="resize"></div>
      </div>
    </section>
  </main>
`;

const panel = document.querySelector("#scrcpy-panel");
const stage = document.querySelector("#scrcpy-stage");
const statusNode = document.querySelector("#status");
const resizeHandle = document.querySelector("#resize-handle");

let adb;
let transport;
let scrcpyClient;
let decoder;
let stageCanvas;
let renderer;
let connectionAttempt = 0;
let frameWatchTimer = 0;
let decoderLabel = "";

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.error = isError ? "true" : "false";
}

function stringifyError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function canUseWebCodecs() {
  return typeof VideoDecoder !== "undefined";
}

function createVideoDecoder(videoStream, canvas) {
  if (canUseWebCodecs()) {
    decoderLabel = "WebCodecs";
    renderer = new BitmapVideoFrameRenderer(canvas);
    return new WebCodecsVideoDecoder({
      codec: videoStream.metadata.codec,
      renderer,
    });
  }

  decoderLabel = "TinyH264";
  renderer = undefined;
  return new TinyH264Decoder({ canvas });
}

async function withTimeout(label, promise, ms = 10000) {
  let timerId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timerId = window.setTimeout(() => {
          reject(new Error(`${label} 超时（${ms}ms）`));
        }, ms);
      }),
    ]);
  } finally {
    if (timerId) {
      window.clearTimeout(timerId);
    }
  }
}

function setConnected(connected) {
  panel.dataset.connected = connected ? "true" : "false";
}

function makeDraggable(target, handle) {
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element) {
      const interactive = event.target.closest("button, input, select, textarea, a");
      if (interactive) {
        return;
      }
    }

    if (event.button !== 0) {
      return;
    }

    const rect = target.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const rawLeft = startLeft + moveEvent.clientX - startX;
      const rawTop = startTop + moveEvent.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const nextLeft = Math.min(Math.max(0, rawLeft), maxLeft);
      const nextTop = Math.min(Math.max(0, rawTop), maxTop);
      target.style.left = `${nextLeft}px`;
      target.style.top = `${nextTop}px`;
      target.style.right = "auto";
    };

    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

function makeResizable(target, handle) {
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let startLeft = 0;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const rect = target.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startWidth = rect.width;
    startHeight = rect.height;
    startLeft = rect.left;
    handle.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();

    const onMove = (moveEvent) => {
      const rawWidth = startWidth - (moveEvent.clientX - startX);
      const maxWidth = startLeft + startWidth;
      const width = Math.max(320, Math.min(rawWidth, maxWidth));
      const height = width * 9 / 16;
      target.style.width = `${width}px`;
      target.style.height = `${height}px`;
      const nextLeft = Math.min(
        Math.max(0, startLeft + (startWidth - width)),
        window.innerWidth - width,
      );
      target.style.left = `${nextLeft}px`;
      target.style.right = "auto";
    };

    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

class InMemoryCredentialStore {
  constructor() {
    this.keys = [];
  }

  async generateKey() {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-1",
      },
      true,
      ["sign", "verify"],
    );

    const privateKey = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    );
    const key = { buffer: privateKey, name: "browser@alas-scrcpy" };
    this.keys.push(key);
    return key;
  }

  iterateKeys() {
    return this.keys.values();
  }
}

class AdbWebSocketConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    const binaryReadable = new ReadableStream({
      start: (controller) => {
        this.socket.addEventListener("message", (event) => {
          controller.enqueue(new Uint8Array(event.data));
        });
        this.socket.addEventListener("close", () => controller.close());
        this.socket.addEventListener("error", (error) => controller.error(error));
      },
    });

    const binaryWritable = new WritableStream({
      write: async (chunk) => {
        const value =
          chunk && typeof chunk.tryConsume === "function"
            ? await chunk.tryConsume((inner) => inner)
            : chunk;
        this.socket.send(value);
      },
      close: () => {
        this.socket.close();
      },
      abort: () => {
        this.socket.close();
      },
    });

    this.readable = binaryReadable.pipeThrough(new StructDeserializeStream(AdbPacket));
    this.writable = pipeFrom(
      new Consumable.WrapWritableStream(binaryWritable),
      new AdbPacketSerializeStream(),
    );
  }

  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("WebSocket bridge 连接失败")),
        { once: true },
      );
    });
  }
}

function createCanvas() {
  stageCanvas?.remove();
  stageCanvas = document.createElement("canvas");
  stageCanvas.className = "scrcpy-canvas";
  stage.append(stageCanvas);
  return stageCanvas;
}

function stopFrameWatch() {
  if (frameWatchTimer) {
    window.clearInterval(frameWatchTimer);
    frameWatchTimer = 0;
  }
}

function watchFirstFrame() {
  stopFrameWatch();
  stage.classList.remove("video-ready");
  setStatus("已连接，等待首帧...");

  frameWatchTimer = window.setInterval(() => {
    if (!decoder) {
      stopFrameWatch();
      return;
    }

    if (decoder.framesRendered > 0) {
      stopFrameWatch();
      stage.classList.add("video-ready");
      setStatus("已连接");
      return;
    }
  }, 120);
}

function getStageCoordinates(event) {
  const rect = stage.getBoundingClientRect();
  const width = decoder?.width || Math.round(rect.width) || 1;
  const height = decoder?.height || Math.round(rect.height) || 1;
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));

  return {
    pointerX: Math.round((x / rect.width) * width),
    pointerY: Math.round((y / rect.height) * height),
    videoWidth: width,
    videoHeight: height,
  };
}

async function pushServer(adbInstance) {
  const response = await fetch("/resources/scrcpy-server.jar");
  if (!response.ok || !response.body) {
    throw new Error("Missing resources/scrcpy-server.jar. Please run npm run prepare:scrcpy-server first.");
  }

  const serverBuffer = new Uint8Array(await response.arrayBuffer());
  await AdbScrcpyClient.pushServer(
    adbInstance,
    Consumable.ReadableStream.from([serverBuffer]),
    DEVICE_SCRCPY_SERVER_PATH,
  );
}

function bindPointerControls(controller) {
  if (!controller) {
    return;
  }

  const sendTouch = (action, event) => {
    const coordinates = getStageCoordinates(event);
    void controller.injectTouch({
      action,
      pointerId: ScrcpyPointerId.Finger,
      pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
      buttons:
        action === AndroidMotionEventAction.Up
          ? AndroidMotionEventButton.None
          : AndroidMotionEventButton.Primary,
      ...coordinates,
    });
  };

  stage.onpointerdown = (event) => {
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    sendTouch(AndroidMotionEventAction.Down, event);
  };

  stage.onpointermove = (event) => {
    if (!stage.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    sendTouch(AndroidMotionEventAction.Move, event);
  };

  const release = (event) => {
    if (stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    sendTouch(AndroidMotionEventAction.Up, event);
  };

  stage.onpointerup = release;
  stage.onpointercancel = release;
}

async function connectScrcpy() {
  const attemptId = ++connectionAttempt;
  setStatus("正在连接设备...");
  setConnected(true);

  try {
    setStatus("正在连接 bridge...");
    const connection = new AdbWebSocketConnection(
      `${BRIDGE_URL}?serial=${encodeURIComponent(DEVICE_SERIAL)}`,
    );
    await withTimeout("WebSocket bridge 连接", connection.ready(), 5000);
    if (attemptId !== connectionAttempt) {
      return;
    }

    setStatus("正在进行 ADB 握手...");
    transport = await AdbDaemonTransport.authenticate({
      serial: DEVICE_SERIAL,
      connection,
      credentialStore: new InMemoryCredentialStore(),
    });
    if (attemptId !== connectionAttempt) {
      return;
    }

    adb = new Adb(transport);
    setStatus("正在上传 scrcpy server...");
    await pushServer(adb);
    if (attemptId !== connectionAttempt) {
      return;
    }

    const options = new AdbScrcpyOptionsLatest({
      video: true,
      audio: false,
      control: true,
      sendDummyByte: true,
      videoCodec: "h264",
      captureOrientation: new ScrcpyCaptureOrientation(
        ScrcpyLockOrientation.LockedValue,
        ScrcpyOrientation.Orient270,
      ),
    });

    setStatus("正在启动 scrcpy server...");
    scrcpyClient = await withTimeout(
      "scrcpy server 启动",
      AdbScrcpyClient.start(adb, DEVICE_SCRCPY_SERVER_PATH, options),
      10000,
    );
    if (attemptId !== connectionAttempt) {
      return;
    }

    setStatus("正在等待视频流...");
    const videoStream = await withTimeout("视频流初始化", scrcpyClient.videoStream, 10000);
    if (!videoStream) {
      throw new Error("设备没有返回视频流");
    }

    const canvas = createCanvas();
    decoder = createVideoDecoder(videoStream, canvas);

    bindPointerControls(scrcpyClient.controller);
    watchFirstFrame();
    setStatus(`已连接，等待首帧...（${decoderLabel}）`);
    void videoStream.stream.pipeTo(decoder.writable).catch((error) => {
      setStatus(`视频流中断：${stringifyError(error)}`, true);
    });

    stage.classList.add("connected");
  } catch (error) {
    console.error(error);
    await disconnectScrcpy();
    setStatus(stringifyError(error), true);
  }
}

async function disconnectScrcpy() {
  setConnected(false);
  stage.classList.remove("connected");
  stage.classList.remove("video-ready");
  stopFrameWatch();

  if (decoder) {
    decoder.dispose();
    decoder = undefined;
  }

  if (scrcpyClient) {
    await scrcpyClient.close();
    scrcpyClient = undefined;
  }

  if (transport) {
    await transport.close();
    transport = undefined;
  }

  adb = undefined;
  renderer = undefined;
  stageCanvas?.remove();
  stageCanvas = undefined;
  stage.onpointerdown = null;
  stage.onpointermove = null;
  stage.onpointerup = null;
  stage.onpointercancel = null;
}
makeDraggable(panel, panel);
makeResizable(panel, resizeHandle);
void connectScrcpy();
