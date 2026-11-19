import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { chunkArticle, parseSections } from "../src/rag/kb-sections";
import { reciprocalRankFusion } from "../src/rag/rrf";
import { searchKb, toFtsQuery, type SearchDeps } from "../src/rag/search";

const WIFI = `# Wi-Fi keeps dropping

Use this when Wi-Fi drops.

**Safety first:** nothing dangerous here.

## Symptoms

- Disconnects every few minutes
- "No internet"

## Quick fixes

1. Turn Wi-Fi off and on.
2. Restart your laptop.

## Advanced steps

1. Update drivers.

## Escalate when

- Many people are affected
- Adapter missing
`;

describe("parseSections", () => {
  it("extracts title, intro, symptoms, numbered steps and escalation bullets", () => {
    const s = parseSections(WIFI);
    expect(s.title).toBe("Wi-Fi keeps dropping");
    expect(s.intro).toEqual(["Use this when Wi-Fi drops.", "**Safety first:** nothing dangerous here."]);
    expect(s.symptoms).toEqual(["Disconnects every few minutes", '"No internet"']);
    expect(s.steps).toEqual([
      { section: "quick", order: 1, text: "Turn Wi-Fi off and on." },
      { section: "quick", order: 2, text: "Restart your laptop." },
      { section: "advanced", order: 1, text: "Update drivers." },
    ]);
    expect(s.escalateWhen).toHaveLength(2);
  });

  it("rejects articles with missing or reordered sections", () => {
    expect(() => parseSections(WIFI.replace("## Advanced steps", "## Advanced"))).toThrow(/sections must be/);
    expect(() => parseSections("no title")).toThrow(/title/);
  });

  it("chunks into overview/quick/advanced/escalate with stable ids", () => {
    const chunks = chunkArticle("KB-002", "Wi-Fi keeps dropping", ["wifi", "wireless"], parseSections(WIFI));
    expect(chunks.map((c) => c.id)).toEqual(["KB-002#overview", "KB-002#quick", "KB-002#advanced", "KB-002#escalate"]);
    expect(chunks[0]!.text).toContain("Keywords: wifi, wireless");
    expect(chunks[1]!.text.startsWith("Wi-Fi keeps dropping — Quick fixes")).toBe(true);
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards ids that rank well in both lists", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["b", "c", "d"],
    ]);
    expect(fused[0]!.id).toBe("b");
    expect(fused.map((f) => f.id)).toEqual(["b", "c", "a", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it("counts duplicates within a list only once", () => {
    const fused = reciprocalRankFusion([["a", "a", "b"]]);
    expect(fused.find((f) => f.id === "a")!.score).toBeCloseTo(1 / 61);
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe("toFtsQuery", () => {
  it("drops stopwords and punctuation and quotes terms safely", () => {
    expect(toFtsQuery("My wifi keeps dropping!!")).toBe('"wifi"* OR "dropping"*');
    // FTS5 syntax characters and operators can't leak into the query.
    expect(toFtsQuery('vpn" OR 1=1 -- NEAR(')).toBe('"vpn"* OR "near"*');
  });

  it("handles Hinglish filler words", () => {
    expect(toFtsQuery("wifi nahi chal raha")).toBe('"wifi"* OR "chal"*');
  });

  it("returns null when nothing searchable is left", () => {
    expect(toFtsQuery("is it the ?")).toBeNull();
  });
});

describe("searchKb (fake embeddings + real FTS5)", () => {
  const articles = [
    { id: "KB-001", title: "Laptop is running slow", tags: ["slow", "freezing"], os: ["windows", "macos"], cat: "Performance", tc: "hardware" },
    { id: "KB-002", title: "Wi-Fi keeps dropping", tags: ["wifi", "wireless", "dropping"], os: ["windows", "macos"], cat: "Network", tc: "network" },
    { id: "KB-003", title: "VPN won't connect or times out", tags: ["vpn", "timeout"], os: ["windows", "macos"], cat: "Network", tc: "network" },
    { id: "KB-099", title: "Linux-only printer guide", tags: ["printer", "cups"], os: ["linux"], cat: "Printing", tc: "hardware" },
  ];

  beforeAll(async () => {
    for (const a of articles) {
      const body = `# ${a.title}\n\nIntro for ${a.title}.\n\n## Symptoms\n\n- symptom of ${a.tags[0]}\n\n## Quick fixes\n\n1. Fix ${a.tags[0]} step one.\n2. Fix step two.\n\n## Advanced steps\n\n1. Advanced.\n\n## Escalate when\n\n- One\n- Two\n`;
      await env.DB.prepare(
        "INSERT INTO kb_articles (id, title, category, tags, os, ticket_category, priority, action, body, content_hash) VALUES (?, ?, ?, ?, ?, ?, 'MEDIUM', 'troubleshoot', ?, 'h')",
      )
        .bind(a.id, a.title, a.cat, JSON.stringify(a.tags), JSON.stringify(a.os), a.tc, body)
        .run();
      for (const c of chunkArticle(a.id, a.title, a.tags, parseSections(body))) {
        await env.DB.prepare("INSERT INTO kb_fts (chunk_id, article_id, section, title, tags, content) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(c.id, a.id, c.section, a.title, a.tags.join(" "), c.text)
          .run();
      }
    }
  });

  /** Fake semantic layer: each "topic" word maps to one article's chunk with a fixed similarity. */
  function fakeDeps(semantic: Record<string, { id: string; score: number }[]>): SearchDeps & { lastFilter?: unknown } {
    let lastQuery = "";
    const deps: SearchDeps & { lastFilter?: unknown } = {
      db: env.DB,
      ai: {
        run: (async (_model: string, input: { text: string[] }) => {
          lastQuery = input.text[0]!;
          return { data: [new Array(768).fill(0)] };
        }) as unknown as Ai["run"],
      },
      vectorize: {
        query: (async (_v: number[], opts?: VectorizeQueryOptions) => {
          deps.lastFilter = opts?.filter;
          const key = Object.keys(semantic).find((k) => lastQuery.includes(k));
          return { matches: key ? semantic[key]! : [], count: 0 };
        }) as VectorizeIndex["query"],
      },
    };
    return deps;
  }

  it("ranks the article matched by both vector and keyword search first", async () => {
    const deps = fakeDeps({
      "keeps dropping": [
        { id: "KB-002#overview", score: 0.81 },
        { id: "KB-003#overview", score: 0.7 },
      ],
    });
    const r = await searchKb(deps, "wifi keeps dropping");
    expect(r.hits[0]!.articleId).toBe("KB-002");
    expect(r.hits[0]!.keywordMatch).toBe(true);
    expect(r.confident).toBe(true);
    expect(r.hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  it("finds an article by keyword alone when vectors miss (e.g. jargon)", async () => {
    const r = await searchKb(fakeDeps({}), "vpn timeout");
    expect(r.hits[0]!.articleId).toBe("KB-003");
  });

  it("is not confident when the best match is weak", async () => {
    const r = await searchKb(fakeDeps({ "coffee machine": [{ id: "KB-001#overview", score: 0.41 }] }), "the coffee machine is broken");
    expect(r.confident).toBe(false);
  });

  it("filters by OS in both Vectorize and FTS results", async () => {
    const deps = fakeDeps({ printer: [{ id: "KB-099#overview", score: 0.9 }] });
    const r = await searchKb(deps, "printer cups", { os: "windows" });
    expect(deps.lastFilter).toEqual({ os_windows: true });
    expect(r.hits.map((h) => h.articleId)).not.toContain("KB-099");
  });

  it("skips vectors whose article no longer exists", async () => {
    const r = await searchKb(fakeDeps({ slow: [{ id: "KB-404#overview", score: 0.95 }, { id: "KB-001#overview", score: 0.8 }] }), "laptop slow");
    expect(r.hits.map((h) => h.articleId)).not.toContain("KB-404");
    expect(r.hits[0]!.articleId).toBe("KB-001");
  });

  it("returns nothing for an empty query", async () => {
    const r = await searchKb(fakeDeps({}), "   ");
    expect(r).toMatchObject({ hits: [], confident: false });
  });
});
