// src/index.ts

import { Client } from "./client/client";

async function main() {
  const client = new Client();
  await client.start();
}

main().catch((error) => {
  console.error("An error occurred:", error);
});
