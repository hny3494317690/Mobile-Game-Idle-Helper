import net from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Adb,
  AdbDaemonTransport,
  AdbPacket,
  AdbPacketSerializeStream,
} from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { Consumable, StructDeserializeStream, pipeFrom } from "@yume-chan/stream-extra";

class Store {
  constructor() {
    this.keys = [];
  }

  async generateKey() {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
      privateKeyEncoding: {
        format: "der",
        type: "pkcs8",
      },
    });

    const key = {
      buffer: new Uint8Array(privateKey),
      name: "node@test",
    };
    this.keys.push(key);
    return key;
  }

  iterateKeys() {
    return this.keys.values();
  }
}

const host = process.argv[2];
const port = Number(process.argv[3] || "16384");
const path = "/data/local/tmp/scrcpy-server.jar";

if (!host) {
  throw new Error("Usage: node scripts/scrcpy_probe.mjs <adb-host> [port]");
}

const tcp = net.createConnection({ host, port });
await new Promise((resolve, reject) => {
  tcp.once("connect", resolve);
  tcp.once("error", reject);
});

const readable = ReadableStream.from(
  (async function* streamChunks() {
    for await (const chunk of tcp) {
      yield new Uint8Array(chunk);
    }
  })(),
).pipeThrough(new StructDeserializeStream(AdbPacket));

const binaryWritable = new WritableStream({
  write(chunk) {
    tcp.write(Buffer.from(chunk));
  },
  close() {
    tcp.end();
  },
  abort() {
    tcp.destroy();
  },
});

const writable = pipeFrom(
  new Consumable.WrapWritableStream(binaryWritable),
  new AdbPacketSerializeStream(),
);

const transport = await AdbDaemonTransport.authenticate({
  serial: `${host}:${port}`,
  connection: { readable, writable },
  credentialStore: new Store(),
});

const adb = new Adb(transport);
const serverBuffer = await readFile("public/scrcpy-server.bin");
await AdbScrcpyClient.pushServer(
  adb,
  Consumable.ReadableStream.from([new Uint8Array(serverBuffer)]),
  path,
);

const options = new AdbScrcpyOptionsLatest({
  video: true,
  audio: false,
  control: true,
  sendDummyByte: true,
  videoCodec: "h264",
});

const client = await AdbScrcpyClient.start(adb, path, options);
const videoStream = await client.videoStream;

console.log(
  JSON.stringify(
    {
      ok: true,
      codec: videoStream?.metadata.codec,
      size: videoStream?.metadata.size,
      deviceName: videoStream?.metadata.deviceName,
    },
    null,
    2,
  ),
);

await client.close();
await transport.close();
tcp.destroy();
