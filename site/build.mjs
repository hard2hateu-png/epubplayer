import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/server", { recursive: true });
await copyFile("site/worker.mjs", "dist/server/index.js");
