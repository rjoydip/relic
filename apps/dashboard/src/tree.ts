import type { GraphNodeDto } from "./api";

// Tree rows are paths: files sit at their repo path, symbols become
// selectable leaves under their file. A path that other rows nest under is
// emitted as an implicit directory — kept in the map (clicking the row still
// selects the file node) but omitted from the leaf list, because the trees
// library rejects a leaf path that later gains children
// ("Path collides with an existing file while creating directory").
export function buildTree(list: GraphNodeDto[]) {
  const map = new Map<string, GraphNodeDto>();
  const wanted = new Set<string>();
  for (const n of list) {
    const file = n.filePath?.replaceAll("\\", "/");
    const path = file && n.type !== "file" ? `${file}/${n.name}` : (file ?? n.name);
    if (!map.has(path)) map.set(path, n);
    wanted.add(path);
  }
  // sorted neighbours decide: a path is a directory iff the next sorted path
  // starts with it + "/"
  const sorted = [...wanted].sort();
  const paths: string[] = [];
  let dir: string | null = null;
  for (const p of sorted) {
    if (dir !== null && !p.startsWith(`${dir}/`)) paths.push(dir);
    dir = p;
  }
  if (dir !== null) paths.push(dir);
  return { paths, map };
}

export function ancestorsOf(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) set.add(p.slice(0, i));
  }
  return [...set];
}
