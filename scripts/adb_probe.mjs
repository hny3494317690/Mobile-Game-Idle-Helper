import net from "node:net";
import { generateKeyPairSync } from "node:crypto";
import {
  AdbDaemonTransport,
  AdbPacket,
  AdbPacketSerializeStream,
} from "@yume-chan/adb";
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

if (!host) {
  throw new Error("Usage: node scripts/adb_probe.mjs <adb-host> [port]");
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

console.log(
  JSON.stringify(
    {
      ok: true,
      product: transport.banner.product,
      model: transport.banner.model,
      features: transport.banner.features,
    },
    null,
    2,
  ),
);

await transport.close();
tcp.destroy();
