import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("sub-agent hand-off (facets)", () => {
  it("supervisor runs a specialist and gets structured output back", async () => {
    const stub = env.SUPPORT_AGENT.getByName("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const r = await (stub as unknown as { pingSpecialist(m: string): Promise<{ status: string; output?: { echo: string }; summary?: string; error?: string }> }).pingSpecialist("hello");
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("completed");
    expect(r.output?.echo).toBe("HELLO");
    expect(r.summary).toBe('echoed "HELLO"');
  });
});
