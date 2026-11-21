/**
 * Triage duplicate-detection eval provider: a new ticket + a pool of recent tickets → the duplicate
 * the Triage agent's retrieval stage would surface (same embedding model, same 0.80 threshold).
 * Cosine similarity is computed in memory so the eval never writes to the production `tickets`
 * namespace in Vectorize. The model's confirm step isn't included — this measures retrieval.
 *
 * Output: { duplicateOf, score, top }
 */
import { DUPLICATE_MIN_SCORE } from "../../src/agents/triage-config";
import { embedPassages } from "../../src/rag/embed";
import { evalEnv } from "./env";

/** Seeded "recent tickets" (last 30 days). */
export const POOL = [
  { number: "INC-5001", text: "Wi-Fi keeps dropping every few minutes on floor 3\nLaptop disconnects from Minocy-Corp every 5–10 minutes since Monday." },
  { number: "INC-5002", text: "VPN times out when working from home\nMinocy Secure Connect spins and times out after 30 seconds." },
  { number: "INC-5003", text: "Printer on floor 2 jams on every job\nThe HP printer near the pantry jams and shows error 13.2." },
  { number: "INC-5004", text: "Outlook not syncing new emails\nInbox stopped updating this morning; webmail shows new mail." },
  { number: "INC-5005", text: "Laptop battery swollen\nThe bottom case of my laptop is bulging and the trackpad is lifting." },
  { number: "INC-5006", text: "Need Figma access for the brand refresh\nRequesting a Figma editor licence." },
  { number: "INC-5007", text: "Teams camera shows a black screen\nCamera works in other apps but Teams shows black." },
  { number: "INC-5008", text: "BitLocker recovery screen at startup\nLaptop asks for a 48-digit recovery key after a BIOS update." },
  { number: "INC-5009", text: "Shared drive F: not connecting\nThe finance shared drive shows a red X and won't open." },
  { number: "INC-5010", text: "Monitor not detected through the dock\nExternal monitors stay black when connected through the USB-C dock." },
];

let poolVectors: Promise<number[][]> | undefined;
const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
};

export default class TriageProvider {
  id() {
    return "triage-duplicates";
  }

  async callApi(_prompt: string, context: { vars: Record<string, string> }) {
    const env = await evalEnv();
    poolVectors ??= embedPassages(env.AI, POOL.map((p) => p.text));
    const [vec] = await embedPassages(env.AI, [`${context.vars.title}\n${context.vars.description}`]);
    const scored = (await poolVectors).map((v, i) => ({ number: POOL[i]!.number, score: cosine(vec!, v) })).sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    return {
      output: JSON.stringify({ duplicateOf: top.score >= DUPLICATE_MIN_SCORE ? top.number : null, score: Number(top.score.toFixed(3)), top: top.number }),
    };
  }
}
