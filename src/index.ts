// src/index.ts

import { Client } from "./client/client.js";
import inquirer from "inquirer";
import {
  acquireInstanceLock,
  describeLockHolder,
  stopHolder,
  LOCK_FILE_PATH,
} from "./config/instanceLock.js";

async function main() {
  // Refuse before touching the exchange. Two instances on one account each
  // place orders the other cannot see or cancel.
  const lock = acquireInstanceLock();

  if (!lock.acquired) {
    const { pid } = lock.holder;
    console.log(describeLockHolder(lock.holder));
    console.log(
      "Two instances on the same account place orders the other cannot see or cancel."
    );

    // Its interface belongs to the terminal it started in, so it can't be
    // resumed from here -- the choice is to go back to that terminal, or to
    // stop it and take over.
    if (!process.stdin.isTTY) {
      console.error(
        `Stop the other one first. If it is already gone, remove ${LOCK_FILE_PATH}.`
      );
      process.exit(1);
    }

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "That session is running in another terminal.",
        choices: [
          {
            name: "Leave it running and quit (switch to its terminal)",
            value: "quit",
          },
          {
            name: "Stop it and start here — any chase it is running stops; resting orders stay on the exchange",
            value: "takeover",
          },
        ],
      },
    ]);

    if (action === "quit") {
      process.exit(0);
    }

    console.log(`Stopping pid ${pid}...`);
    const stopped = await stopHolder(pid);

    if (!stopped) {
      console.error(
        `Could not stop pid ${pid}. Stop it manually, then start again.`
      );
      process.exit(1);
    }

    const retry = acquireInstanceLock();
    if (!retry.acquired) {
      console.error("Another instance took over in the meantime. Try again.");
      process.exit(1);
    }

    console.log(
      "Stopped. Check the exchange for anything it left resting, and that terminal may need 'reset'."
    );
  }

  const client = new Client();
  await client.start();
}

main().catch((error) => {
  console.error("An error occurred:", error);
});
