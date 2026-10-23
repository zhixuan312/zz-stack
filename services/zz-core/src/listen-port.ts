/**
 * `listenPort` and `listenHost` — the port and address zz-core binds, from its command line.
 *
 * `--port <n>` names the port; no `--port` is 8000, which is what a deployment gets because its
 * compose file passes none. `--host <ip>` names the address; no `--host` is every interface, which
 * a deployment needs inside its container, and a script that starts zz-core on this machine passes
 * `--host 127.0.0.1`. No environment variable is read. Anything else stops startup, and the message
 * names what was wrong so the person who typed it can see it.
 */
import { isIP } from "node:net";

const DEFAULT_PORT = 8000;

/** Plain decimal only: no sign, no leading zero, no whitespace, no exponent or radix prefix. */
const PORT_DIGITS = /^[1-9][0-9]{0,4}$/;

const DEFAULT_HOST = "0.0.0.0";

/** The value after `flag`, or undefined when it is absent; `--flag=x`, a repeat and a missing value stop startup. */
function flagValue(argv: readonly string[], flag: string, shape: string): string | undefined {
  const args = argv.slice(2);
  let value: string | undefined;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(`${flag}=`)) {
      throw new Error(`${JSON.stringify(arg)} is not accepted; write ${flag} <${shape}> with a space`);
    }
    if (arg !== flag) continue;
    if (seen) throw new Error(`${flag} was given more than once`);
    seen = true;
    if (i + 1 >= args.length) throw new Error(`${flag} needs a value: ${flag} <${shape}>`);
    // The next element is the value whatever it looks like, so `--port --port` names it as bad.
    value = args[++i];
  }
  return value;
}

export function listenHost(argv: readonly string[]): string {
  const value = flagValue(argv, "--host", "ip");
  if (value === undefined) return DEFAULT_HOST;
  // An IP literal only: a name would be resolved, and what it resolves to is not on the command line.
  if (!isIP(value)) throw new Error(`--host ${JSON.stringify(value)} is not an IP address: use one, such as 127.0.0.1`);
  return value;
}

export function listenPort(argv: readonly string[]): number {
  const value = flagValue(argv, "--port", "n");
  if (value === undefined) return DEFAULT_PORT;
  const port = PORT_DIGITS.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) {
    throw new Error(`--port ${JSON.stringify(value)} is not a port number: use plain decimal, 1 to 65535`);
  }
  return port;
}
