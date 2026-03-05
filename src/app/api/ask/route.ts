import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { generateEmbedding } from "@/lib/embeddings";
import OpenAI from "openai";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return _openai;
}

interface ChunkResult {
  id: string;
  document_id: string;
  content: string;
  page_number: number | null;
  chunk_index: number;
  filename: string;
  similarity: number; // assumed 0..1 (or 0..100 depending on RPC—debug logs will reveal)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = body?.question as string;

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    // -----------------------------
    // Command parsing (interface logic)
    // -----------------------------
    const raw = question.trim();
    const input = raw.toLowerCase();

    let mode: "ask" | "explain" | "summarize" | "quiz" = "ask";
    let topic = raw;

    if (input.startsWith("explain ")) {
      mode = "explain";
      topic = raw.replace(/^explain\s+/i, "").trim();
    } else if (input.startsWith("summarize ")) {
      mode = "summarize";
      topic = raw.replace(/^summarize\s+/i, "").trim();
    } else if (input === "quiz me" || input.startsWith("quiz me")) {
      mode = "quiz";
      const m = raw.match(/^quiz me( on )?/i);
      topic = raw.slice(m?.[0]?.length ?? 0).trim();
      if (!topic) topic = "the uploaded materials";
    }

    if (!topic) {
      return NextResponse.json({ error: "Please provide a topic." }, { status: 400 });
    }

    // -----------------------------
    // Retrieval uses TOPIC (not the full command)
    // -----------------------------
    const queryEmbedding = await generateEmbedding(topic);

    const { data: chunks, error: matchError } = await getSupabase().rpc("match_chunks", {
  query_embedding: queryEmbedding,
  match_count: 8,
});

    if (matchError) throw matchError;

    const typedChunks = (chunks || []) as ChunkResult[];

    // ---- Debug: see what you're actually retrieving ----
    const top = typedChunks[0];
    console.log("ASK MODE:", mode);
    console.log("ASK TOPIC:", topic);
    console.log("TOP MATCH:", top ? { sim: top.similarity, file: top.filename, page: top.page_number } : null);

    if (typedChunks.length === 0) {
      return NextResponse.json({
        answer: "I could not find any relevant information in the uploaded materials to answer this request.",
        citations: [],
        sources: [],
        concepts: [],
      });
    }

    // -----------------------------
    // Relevance gate + filtering
    // -----------------------------
    // NOTE: Depending on your SQL RPC, similarity might be 0..1 OR 0..100.
    // We'll normalize to 0..1 if it looks like 0..100.
    const bestRaw = typedChunks[0]?.similarity ?? 0;
    const best = bestRaw > 1 ? bestRaw / 100 : bestRaw;

    // Start permissive; tune later after you see real values in logs.
    const MIN_RELEVANCE = 0.35;

    if (best < MIN_RELEVANCE) {
      return NextResponse.json({
        answer: "I could not find any relevant information in the uploaded materials to answer this request.",
        citations: [],
        sources: [],
        concepts: [],
      });
    }

    // Filter out very low similarity chunks so you don't poison context
    const filteredChunks = typedChunks.filter((c) => {
      const sim = c.similarity > 1 ? c.similarity / 100 : c.similarity;
      return sim >= 0.25;
    });

    // If filtering removed everything, fall back to top 1
    const finalChunks = filteredChunks.length > 0 ? filteredChunks : [typedChunks[0]];

    const context = finalChunks
      .map(
        (c, i) =>
          `[Source ${i + 1}: ${c.filename}${c.page_number ? `, p.${c.page_number}` : ""}]\n${c.content}`
      )
      .join("\n\n---\n\n");

    // -----------------------------
    // Mode-specific prompt
    // -----------------------------
    let modeInstruction = "";
    if (mode === "explain") {
      modeInstruction =
        "Explain the topic clearly and simply, like a professor. Use short paragraphs and one concrete example if the sources include one.";
    } else if (mode === "summarize") {
      modeInstruction =
        "Write a structured summary with 3-6 bullet points. Keep it concise and only use what appears in the sources.";
    } else if (mode === "quiz") {
      modeInstruction =
        "Create ONE multiple-choice question based strictly on the sources (A-D), then give the correct answer and a one-sentence explanation with a citation.";
    } else {
      modeInstruction = "Answer the user's question directly and concisely.";
    }

    const systemPrompt = `You are a knowledge assistant. Answer the user's request ONLY using the provided source material.

Rules:
1. Only use information from the provided sources. Do not use any outside knowledge.
2. Cite your sources inline using [Source N] notation.
3. If the sources do not contain enough information to fully answer the request, say so clearly.
4. Do not hallucinate or make up information.
5. Be concise and direct.
6. Do not output code fences or markdown code blocks.

Task:
${modeInstruction}

After your answer, output ONE line in this exact format (no code block):
CONCEPTS_JSON: ["concept1","concept2",...]
Choose 5-8 short concepts from the sources and your answer.`;

    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Sources:\n\n${context}\n\nUser request: ${topic}`,
        },
      ],
    });

    const rawAnswer = completion.choices[0]?.message?.content || "";

    // Parse concepts from the answer
    let answer = rawAnswer;
    let concepts: string[] = [];

    const conceptMatch = rawAnswer.match(/CONCEPTS_JSON:\s*(\[[\s\S]*?\])/);
    if (conceptMatch) {
      try {
        concepts = JSON.parse(conceptMatch[1]);
        answer = rawAnswer.replace(/CONCEPTS_JSON:\s*\[[\s\S]*?\]/, "").trim();
      } catch {
        // ignore parse errors
      }
    }

    // Store concept co-occurrence edges
    if (concepts.length > 1) {
      const edges: { source: string; target: string }[] = [];
      for (let i = 0; i < concepts.length; i++) {
        for (let j = i + 1; j < concepts.length; j++) {
          const [source, target] = [concepts[i], concepts[j]].sort();
          edges.push({ source, target });
        }
      }

      for (const edge of edges) {
        try {
          await getSupabase().rpc("upsert_concept_edge", {
            p_source: edge.source,
            p_target: edge.target,
          });
        } catch {
          // ignore
        }
      }
    }

    // Build citations and sources based on the chunks actually used for context
    const citations = finalChunks.map((c) => ({
      filename: c.filename,
      pageNumber: c.page_number,
      similarity: Math.round(c.similarity * 100) / 100,
    }));

    const sources = finalChunks.map((c) => ({
      filename: c.filename,
      pageNumber: c.page_number,
      content: c.content,
      similarity: Math.round(c.similarity * 100) / 100,
    }));

    return NextResponse.json({ answer, citations, sources, concepts });
  } catch (err) {
    console.error("Q&A error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process question" },
      { status: 500 }
    );
  }
}