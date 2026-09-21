import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSecondFlowFixture } from "@zz/contracts";
import { root, sourceFiles, withoutComments } from "../read.ts";
import { check } from "../run.ts";

const STAGES = /"(explore|spec|spec-audit|plan|plan-audit|execute|review)"|sdlc-flow/;

check("the generic host serves a second flow and the kernel never branches on an SDLC stage", () => {
  const kernel = sourceFiles(["packages/contracts/src", "services/zz-core/src/host"], [".ts"]);
  if (kernel.length < 3) return "the kernel sweep reached almost nothing; this check is not looking where it claims";
  const leaks = kernel.filter((f) => STAGES.test(withoutComments(readFileSync(join(root, f), "utf8"))));
  if (leaks.length) return `generic kernel modules branch on SDLC vocabulary: ${leaks.slice(0, 5).join(", ")}`;

  const r = runSecondFlowFixture();
  for (const op of ["run_start", "method_read", "evidence_record", "control_evaluate", "action_claim"]) {
    if (!r.invoked.includes(op)) return `the second-flow fixture never invoked ${op}, so it does not demonstrate the host is generic`;
  }
  if (r.reusedSdlcSemantics) return "the second-flow fixture reused SDLC stage semantics, so it proves nothing about genericity";
});
