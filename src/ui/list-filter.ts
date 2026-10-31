// The small pieces every Rules list filter shares (C382 batch 4): where this browser remembers the text, and from how many rows a list
// gets a filter bar. The matching, the memory and the bar are the kit's (`accessFilter`, `useAccessFilter`, `ListFilter`).

/** A list shorter than this shows no filter bar, unless a filter is on (a remembered one too). */
export const FILTER_FROM = 8;

/** What this browser remembers is per app (the base path of the app) and per screen: `tb-filter:<app base>:<screen>`. */
export const filterKey = (screen: string): string => {
  try {
    return `tb-filter:${new URL(document.baseURI).pathname}:${screen}`;
  } catch {
    return `tb-filter:${screen}`;
  }
};
