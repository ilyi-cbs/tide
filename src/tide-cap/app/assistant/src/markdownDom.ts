const inlinePattern =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;

function inline(parent: HTMLElement, text: string): void {
  let remaining = text;
  while (remaining) {
    const match = inlinePattern.exec(remaining);
    if (!match) {
      parent.append(document.createTextNode(remaining));
      break;
    }
    parent.append(document.createTextNode(remaining.slice(0, match.index)));
    const tag = match[1]
      ? "code"
      : match[2] || match[3]
        ? "strong"
        : match[4] || match[5]
          ? "em"
          : "a";
    const node = document.createElement(tag);
    node.textContent =
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
    if (tag === "code") node.className = "assistantInlineCode";
    if (tag === "a" && /^#\/[^\s]*$/.test(match[7])) {
      // In-app route of the host (e.g. #/OpenItems(...)): same tab.
      node.setAttribute("href", match[7]);
    } else if (tag === "a") {
      try {
        const url = new URL(match[7], document.baseURI);
        if (url.protocol === "https:" || url.protocol === "http:") {
          node.setAttribute("href", url.href);
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      } catch {
        // An invalid destination remains plain link text.
      }
    }
    parent.append(node);
    remaining = remaining.slice(match.index + match[0].length);
  }
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function renderMarkdown(text: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "assistantMarkdown";
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      lines[index + 1].includes("|") &&
      isTableSeparator(lines[index + 1])
    ) {
      const table = document.createElement("table");
      table.className = "assistantMarkdownTable";
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const text of tableCells(line)) {
        const cell = document.createElement("th");
        cell.setAttribute("scope", "col");
        inline(cell, text);
        headerRow.append(cell);
      }
      head.append(headerRow);
      const body = document.createElement("tbody");
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        for (const [cellIndex, text] of tableCells(lines[index]).entries()) {
          const cell = document.createElement("td");
          if (cellIndex < headerRow.children.length) inline(cell, text);
          row.append(cell);
        }
        body.append(row);
        index++;
      }
      table.append(head, body);
      root.append(table);
      continue;
    }
    if (line.startsWith("```")) {
      const code = document.createElement("code");
      index++;
      const body: string[] = [];
      while (index < lines.length && !lines[index].startsWith("```"))
        body.push(lines[index++]);
      code.textContent = body.join("\n");
      const pre = document.createElement("pre");
      pre.className = "assistantCodeBlock";
      pre.append(code);
      root.append(pre);
      index++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const node = document.createElement(
        `h${Math.min(heading[1].length + 3, 6)}`,
      );
      inline(node, heading[2]);
      root.append(node);
      index++;
      continue;
    }
    const unordered = /^[-*]\s+/.test(line);
    const ordered = /^\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const pattern = unordered ? /^[-*]\s+/ : /^\d+\.\s+/;
      while (index < lines.length && pattern.test(lines[index])) {
        const item = document.createElement("li");
        inline(item, lines[index++].replace(pattern, ""));
        list.append(item);
      }
      root.append(list);
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6}\s+|```|[-*]\s+|\d+\.\s+)/.test(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    const node = document.createElement("p");
    inline(node, paragraph.join(" "));
    root.append(node);
  }
  return root;
}
