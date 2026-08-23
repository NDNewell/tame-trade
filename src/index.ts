// src/index.ts

import { Client } from "./client/client.js";
import {
  acquireInstanceLock,
  describeLockHolder,
  LOCK_FILE_PATH,
} from "./config/instanceLock.js";

async function main() {
  // Refuse before touching the exchange. Two instances on one account each
  // place orders the other cannot see or cancel.
  const lock = acquireInstanceLock();

  if (!lock.acquired) {
    console.error(describeLockHolder(lock.holder));
    console.error(
      "Two instances on the same account place orders the other cannot see or cancel."
    );
    console.error(
      `Stop the other one first. If it is already gone, remove ${LOCK_FILE_PATH}.`
    );
    process.exit(1);
  }

  const client = new Client();
  await client.start();
}

main().catch((error) => {
  console.error("An error occurred:", error);
});
