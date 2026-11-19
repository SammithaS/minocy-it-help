import { z } from "zod";
import { SpecialistAgent } from "./base";

const input = z.object({ message: z.string() });
const output = z.object({ echo: z.string(), at: z.number() });

/** Model-free specialist used by tests and the health check to prove sub-agent hand-offs work. */
export class PingAgent extends SpecialistAgent<z.infer<typeof input>, z.infer<typeof output>> {
  readonly displayName = "Ping agent";
  readonly inputSchema = input;
  readonly outputSchema = output;

  protected async run({ message }: z.infer<typeof input>) {
    return { echo: message.toUpperCase(), at: Date.now() };
  }

  protected summarize(o: z.infer<typeof output>) {
    return `echoed "${o.echo}"`;
  }
}
