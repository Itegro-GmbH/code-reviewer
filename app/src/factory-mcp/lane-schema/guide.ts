// SPDX-License-Identifier: LicenseRef-Proprietary

// Cuts `docs/workflows.md` into the sections `get_lane_schema` hands out (epic #1143, #1144). Pure: the generator (`generate.ts`) reads the
// files and writes `guide.generated.json`, the app imports that (a file outside the app's folder is not part of its build), and a test fails
// when the committed copy is not what the generator makes of the document and the schemas now.
//
// A `##` chapter is a section; the `###` parts below it are its children, so a long chapter (the agent step, the engine) can be read in
// pieces. Nothing is stored twice: the chapter's own text is `lead` and the children follow it.

export type GuideChild = {
  /** The heading as a slug, unique inside the chapter. */
  id: string;
  title: string;
  /** The `###` heading and its text down to the next heading of level 2 or 3. */
  markdown: string;
};

export type GuideSection = {
  /** The heading as a slug: `five-kinds-of-node`. */
  id: string;
  title: string;
  /** The `##` heading and the text before its first `###`. */
  lead: string;
  children: GuideChild[];
};

export type Guide = {
  /** The text before the first `##`: the title and the status paragraph. */
  intro: string;
  sections: GuideSection[];
};

/** A heading as an address: lower case, letters and digits, one dash between words. */
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The whole chapter as the document has it. */
export function chapterMarkdown(section: GuideSection): string {
  return [section.lead, ...section.children.map((child) => child.markdown)]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function splitGuide(markdown: string): Guide {
  const intro: string[] = [];
  const sections: GuideSection[] = [];
  let section: {
    title: string;
    lead: string[];
    children: { title: string; lines: string[] }[];
  } | null = null;
  let inFence = false;

  const closeSection = () => {
    if (section === null) return;
    const used = new Set<string>();
    sections.push({
      id: slugOf(section.title),
      title: section.title,
      lead: section.lead.join("\n").trim(),
      children: section.children.map((child) => {
        let id = slugOf(child.title);
        for (let n = 2; used.has(id); n += 1)
          id = `${slugOf(child.title)}-${n}`;
        used.add(id);
        return {
          id,
          title: child.title,
          markdown: child.lines.join("\n").trim(),
        };
      }),
    });
  };

  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const chapter = inFence ? null : /^## (.+)$/.exec(line);
    const part = inFence ? null : /^### (.+)$/.exec(line);
    if (chapter !== null) {
      closeSection();
      section = {
        title: (chapter[1] as string).trim(),
        lead: [line],
        children: [],
      };
    } else if (section === null) {
      intro.push(line);
    } else if (part !== null) {
      section.children.push({
        title: (part[1] as string).trim(),
        lines: [line],
      });
    } else {
      const last = section.children[section.children.length - 1];
      (last === undefined ? section.lead : last.lines).push(line);
    }
  }
  closeSection();
  return { intro: intro.join("\n").trim(), sections };
}
