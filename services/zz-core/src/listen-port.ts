/**
 * `listenPort` — the port zz-core binds, from its command line.
 *
 * `--port <n>` names it; no `--port` is 8000, which is what a deployment gets because its
 * compose file passes none. No environment variable is read. Anything else stops startup, and
 * the message names what was wrong so the person who typed it can see it.
 */

const DEFAULT_PORT = 8000;

/** Plain decimal only: no sign, no leading zero, no whitespace, no exponent or radix prefix. */
const PORT_DIGITS = /^[1-9][0-9]{0,4}$/;

export function listenPort(argv: readonly string[]): number {
  const args = argv.slice(2);
  let value: string | undefined;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--port=")) {
      throw new Error(`${JSON.stringify(arg)} is not accepted; write --port <n> with a space`);
    }
    if (arg !== "--port") continue;
    if (seen) throw new Error("--port was given more than once");
    seen = true;
    if (i + 1 >= args.length) throw new Error("--port needs a value: --port <n>");
    // The next element is the value whatever it looks like, so `--port --port` names it as bad.
    value = args[++i];
  }
  if (value === undefined) return DEFAULT_PORT;
  const port = PORT_DIGITS.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) {
    throw new Error(`--port ${JSON.stringify(value)} is not a port number: use plain decimal, 1 to 65535`);
  }
  return port;
}
