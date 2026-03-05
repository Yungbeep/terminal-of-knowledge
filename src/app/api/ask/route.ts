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
  similarity: number;
}

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json(
        { error: "Question is required" },
        { status: 400 }
      );
    }

    // Embed the query
    const queryEmbedding = await generateEmbedding(question);

    // Retrieve top K relevant chunks
    const { data: chunks, error: matchError } = await getSupabase().rpc(
      "match_chunks",
      {
        query_embedding: JSON.stringify(queryEmbedding),
        match_count: 8,
        match_threshold: 0.3,
      }
    );

    if (matchError) throw matchError;

    const typedChunks = (chunks || []) as ChunkResult[];

    if (typedChunks.length === 0) {
      return NextResponse.json({
        answer:
          "I could not find any relevant information in the uploaded materials to answer this question.",
        citations: [],
        sources: [],
        concepts: [],
      });
    }

    // Build context from retrieved chunks
    const context = typedChunks
      .map(
        (c, i) =>
          `[Source ${i + 1}: ${c.filename}${c.page_number ? `, p.${c.page_number}` : ""}]\n${c.content}`
      )
      .join("\n\n---\n\n");

    // Generate answer
    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are a knowledge assistant. Answer the user's question ONLY using the provided source material. Follow these rules strictly:

1. Only use information from the provided sources. Do not use any outside knowledge.
2. Cite your sources inline using [Source N] notation.
3. If the sources do not contain enough information to fully answer the question, say so clearly.
4. Do not hallucinate or make up information.
5. Be concise and direct.

After your answer, on a new line, output a JSON block with exactly this format:
CONCEPTS_JSON: ["concept1", "concept2", ..., "conceptN"]
List 5-8 key concepts/topics from the sources and your answer that the user might want to explore further. Use short, clear phrases.`,
        },
        {
          role: "user",
          content: `Sources:\n\n${context}\n\nQuestion: ${question}`,
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
        // If parsing fails, just use the raw answer
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

      // Upsert edges (increment weight on conflict)
      for (const edge of edges) {
        try {
          await getSupabase().rpc("upsert_concept_edge", {
            p_source: edge.source,
            p_target: edge.target,
          });
        } catch {
          // Silently ignore if the RPC doesn't exist yet
        }
      }
    }

    // Build citations and sources
    const citations = typedChunks.map((c) => ({
      filename: c.filename,
      pageNumber: c.page_number,
      similarity: Math.round(c.similarity * 100) / 100,
    }));

    const sources = typedChunks.map((c) => ({
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
