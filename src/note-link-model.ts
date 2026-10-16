/** The complete wiki-link token to replace, plus text needed to preserve its suffix. */
export interface WikiLinkContext {
  start: number;
  end: number;
  query: string;
  suffix: string;
}

function escaped(value: string, position: number): boolean {
  let count = 0;
  while (position > 0 && value[--position] === "\\") count++;
  return count % 2 === 1;
}

// Textareas do not expose Markdown syntax nodes. Track the two code delimiters
// here so that typing an example does not unexpectedly open note suggestions.
function inCode(value: string, position: number): boolean {
  let fence: { marker: string; length: number } | null = null;
  let inlineLength = 0;
  let offset = 0;
  for (const line of value.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const containsPosition = position <= offset + line.length;
    if (fence) {
      if (containsPosition) return true;
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (!marker[1].startsWith("`") || !marker[2].includes("`"))) {
      if (containsPosition) return true;
      fence = { marker: marker[1][0], length: marker[1].length };
      inlineLength = 0;
    } else {
      if (!line.trim()) inlineLength = 0;
      const limit = containsPosition ? position - offset : line.length;
      for (let i = 0; i < limit; i++) {
        if (line[i] !== "`" || (!inlineLength && escaped(line, i))) continue;
        let end = i + 1;
        while (line[end] === "`") end++;
        const length = end - i;
        if (!inlineLength) inlineLength = length;
        else if (length === inlineLength) inlineLength = 0;
        i = end - 1;
      }
      if (containsPosition) return inlineLength > 0;
    }
    offset += line.length + 1;
  }
  return false;
}

/** Find a filename being edited inside [[...]], without capturing adjacent prose. */
export function findWikiLinkContext(value: string, selectionStart: number, selectionEnd = selectionStart): WikiLinkContext | null {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > value.length) return null;
  const start = value.lastIndexOf("[[", selectionStart - 2);
  if (start < 0 || start + 2 > selectionStart || escaped(value, start) || inCode(value, start)) return null;
  const query = value.slice(start + 2, selectionStart);
  // Heading/block and alias completion are separate from selecting a note.
  if (/[\[\]\r\n#|^`]/.test(query)) return null;

  const rest = value.slice(selectionStart);
  const close = rest.indexOf("]]");
  if (close >= 0 && !/[\[\]\r\n]/.test(rest.slice(0, close))) {
    const body = value.slice(start + 2, selectionStart + close);
    const suffixStart = body.search(/[#|^]/);
    return {
      start,
      end: selectionStart + close + 2,
      query,
      suffix: suffixStart < 0 ? "" : body.slice(suffixStart),
    };
  }

  // Without a closing delimiter, only consume the remainder of this word.
  // Spaces already typed before the caret still belong to the search query.
  const boundary = rest.search(/[\s\[\]`]/);
  let end = boundary < 0 ? value.length : selectionStart + boundary;
  const body = value.slice(start + 2, end);
  const suffixStart = body.search(/[#|^]/);
  // A lone closing bracket is an unfinished delimiter, not adjacent prose.
  if (value[end] === "]") end++;
  return { start, end, query, suffix: suffixStart < 0 ? "" : body.slice(suffixStart) };
}

/** Insert a resolved vault link target; the embed prefix stays outside this range. */
export function completeWikiLink(value: string, context: WikiLinkContext, linktext: string): { value: string; caret: number } {
  const replacement = `[[${linktext}${context.suffix}]]`;
  return {
    value: value.slice(0, context.start) + replacement + value.slice(context.end),
    caret: context.start + replacement.length,
  };
}
