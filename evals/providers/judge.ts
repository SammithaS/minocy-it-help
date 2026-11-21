/**
 * LLM judge for promptfoo `llm-rubric` assertions, through the app's own model chain (Gemini via AI
 * Gateway → Workers AI fallback). promptfoo sends the grading prompt; we return its JSON verdict.
 */
import { generateText } from "ai";
import { chatModel } from "../../src/lib/llm";
import { evalEnv } from "./env";

export default class JudgeProvider {
  id() {
    return "app-judge";
  }

  async callApi(prompt: string) {
    const env = await evalEnv();
    const { text } = await generateText({ model: chatModel(env, { agent: "eval-judge" }), temperature: 0, prompt });
    // promptfoo expects {"pass": bool, "score": number, "reason": string}; strip any code fences.
    return { output: text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim() };
  }
}
