/**
 * Set the front-door passphrase.
 *
 * Run this on the server, by the person choosing the passphrase. It prompts,
 * hashes, and writes — the passphrase itself is never echoed, never stored,
 * and never passes through anybody else's hands or terminal history.
 *
 *   node /opt/doorman/set-passphrase.mjs
 *   systemctl restart doorman
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { hashPassphrase } from "./doorman.mjs";

const ENV = process.env.DOOR_ENV || "/etc/doorman.env";

/**
 * Prompt without echoing the passphrase — but DO echo something.
 *
 * The first version of this hid the input completely, which is correct in
 * principle and useless in practice: a prompt that shows nothing at all as you
 * type is indistinguishable from a program that has hung, and the honest
 * response to it is to press ctrl-C. Asterisks cost nothing and tell you the
 * keyboard is being read.
 *
 * Raw mode rather than readline, because readline redraws the line and the
 * muting needed to hide the answer took the question with it.
 */
const ask = question => new Promise((resolve, reject) => {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    reject(new Error("This needs a terminal. Run it directly on the server, "
                   + "not through a piped command."));
    return;
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let buffer = "";
  const onData = ch => {
    if (ch === "\r" || ch === "\n" || ch === "\u0004") {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(buffer);
    } else if (ch === "\u0003") {          // ctrl-C
      stdin.setRawMode(false);
      process.stdout.write("\n");
      process.exit(130);
    } else if (ch === "\u007f" || ch === "\b") {
      if (buffer.length) {
        buffer = buffer.slice(0, -1);
        process.stdout.write("\b \b");
      }
    } else if (ch >= " ") {
      buffer += ch;
      process.stdout.write("*");
    }
  };
  stdin.on("data", onData);
});

console.log("");
console.log("  Front-door passphrase for Waypoint.");
console.log("  Anyone with this can add their address to the allowlist.");
console.log("  Nothing you type will be shown; asterisks confirm it is reading.");
console.log("");

const first = await ask("  New passphrase (12+ characters): ");
if (first.length < 12) {
  console.error("\n  Too short. This is the one thing between the internet and the box.\n");
  process.exit(1);
}

const again = await ask("  Type it again: ");
if (first !== again) {
  console.error("\n  Those do not match. Nothing was changed.\n");
  process.exit(1);
}

const hash = hashPassphrase(first);
const current = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const next = /^DOOR_HASH=/m.test(current)
  ? current.replace(/^DOOR_HASH=.*$/m, `DOOR_HASH=${hash}`)
  : current + (!current || current.endsWith("\n") ? "" : "\n") + `DOOR_HASH=${hash}\n`;

writeFileSync(ENV, next, { mode: 0o600 });
console.log("\n  Saved to " + ENV);
console.log("  Now run:  systemctl restart doorman\n");
