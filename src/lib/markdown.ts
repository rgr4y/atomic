function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s/g, '') // Remove headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
    .replace(/\*([^*]+)\*/g, '$1') // Remove italic
    .replace(/`([^`]+)`/g, '$1') // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // Remove images
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .trim();
}

export function truncateContent(content: string, maxLength: number = 150): string {
  const plainText = stripMarkdown(content).replace(/\n+/g, ' ').trim();

  if (plainText.length <= maxLength) {
    return plainText;
  }

  return plainText.slice(0, maxLength).trim() + '...';
}


export function isValidUrl(url: string): boolean {
  if (!url.trim()) return false;
  try {
    // Try parsing as-is first
    new URL(url);
    return true;
  } catch {
    // If that fails, try adding https:// prefix
    try {
      new URL(`https://${url}`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Find which chunk index contains a given character offset.
 * Used to scroll to the correct chunk when highlighting semantic search results.
 */
export function findChunkIndexForOffset(
  content: string,
  offset: number,
  chunkSize: number = 8000
): number {
  const chunks = chunkMarkdown(content, chunkSize);
  let currentOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkEnd = currentOffset + chunks[i].length;
    if (offset >= currentOffset && offset < chunkEnd) {
      return i;
    }
    // Account for the \n\n separator that was split on
    currentOffset = chunkEnd + 2;
  }

  return chunks.length - 1; // Default to last chunk
}

/**
 * Split markdown content into chunks for progressive rendering.
 * Splits at paragraph boundaries (double newlines) to avoid breaking
 * markdown structure like code blocks, lists, or blockquotes.
 */
export function chunkMarkdown(content: string, targetChunkSize: number = 8000): string[] {
  // For small content, don't bother chunking
  if (content.length <= targetChunkSize) {
    return [content];
  }

  const chunks: string[] = [];

  // Split by double newlines (paragraph boundaries)
  // This is a safe split point that won't break markdown structure
  const paragraphs = content.split(/\n\n+/);

  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed target size and we have content,
    // start a new chunk
    if (currentChunk.length + paragraph.length > targetChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      // Add paragraph to current chunk
      if (currentChunk.length > 0) {
        currentChunk += '\n\n' + paragraph;
      } else {
        currentChunk = paragraph;
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

