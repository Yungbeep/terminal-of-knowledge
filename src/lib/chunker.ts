export interface Chunk {
  content: string;
  pageNumber: number | null;
  chunkIndex: number;
}

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 200;

export function chunkText(
  text: string,
  pageNumbers?: Map<number, number> // char offset -> page number
): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    // Try to break at a sentence or paragraph boundary
    if (end < text.length) {
      const slice = text.slice(start, end + 100);
      const breakPoints = [
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf(".\n"),
        slice.lastIndexOf("\n"),
      ];
      for (const bp of breakPoints) {
        if (bp > CHUNK_SIZE * 0.5) {
          end = start + bp + 1;
          break;
        }
      }
    }

    end = Math.min(end, text.length);
    const content = text.slice(start, end).trim();

    if (content.length > 0) {
      let pageNumber: number | null = null;
      if (pageNumbers) {
        // Find the page number for the start of this chunk
        for (const [offset, page] of pageNumbers) {
          if (offset <= start) {
            pageNumber = page;
          } else {
            break;
          }
        }
      }

      chunks.push({ content, pageNumber, chunkIndex });
      chunkIndex++;
    }

    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }

  return chunks;
}
