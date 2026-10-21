export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { from: string; to: string };
export type LayoutDirection = "TB" | "LR";

export type LayoutOptions = {
  direction: LayoutDirection;
  /** gap between neighbours within a layer */
  nodeSpacing: number;
  /** gap between consecutive layers */
  layerSpacing: number;
};

/**
 * Layered ("Sugiyama-style") layout for small directed graphs: back edges are
 * ignored for ranking so cycles don't break it, nodes are ranked by longest
 * path from the sources, and each layer is ordered by its neighbours'
 * average position to cut crossings. Returns the top-left position of every
 * node, with the whole graph's top-left corner at the origin.
 */
export const layoutLayered = (
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  { direction, nodeSpacing, layerSpacing }: LayoutOptions,
): Map<string, { x: number; y: number }> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const { from, to } of edges) {
    if (from !== to && byId.has(from) && byId.has(to)) {
      outgoing.get(from)!.push(to);
    }
  }

  // drop the edges that close a cycle (depth-first, in input order)
  const acyclic = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const state = new Map<string, "active" | "done">();
  const visit = (id: string) => {
    state.set(id, "active");
    for (const next of outgoing.get(id)!) {
      const nextState = state.get(next);
      if (nextState === "active") {
        continue;
      }
      acyclic.get(id)!.push(next);
      if (!nextState) {
        visit(next);
      }
    }
    state.set(id, "done");
  };
  const hasIncoming = new Set<string>();
  for (const targets of outgoing.values()) {
    targets.forEach((target) => hasIncoming.add(target));
  }
  // start from the sources so that they end up first, then from anything left
  for (const node of nodes) {
    if (!hasIncoming.has(node.id) && !state.has(node.id)) {
      visit(node.id);
    }
  }
  for (const node of nodes) {
    if (!state.has(node.id)) {
      visit(node.id);
    }
  }

  // longest path ranking
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const targets of acyclic.values()) {
    targets.forEach((t) => indegree.set(t, indegree.get(t)! + 1));
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of acyclic.get(id)!) {
      rank.set(next, Math.max(rank.get(next)!, rank.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
      }
    }
  }

  const layers: string[][] = [];
  for (const node of nodes) {
    (layers[rank.get(node.id)!] ??= []).push(node.id);
  }

  // order each layer by the mean position of its neighbours in the previous
  // (then next) layer, a few sweeps
  const incoming = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [from, targets] of acyclic) {
    targets.forEach((to) => incoming.get(to)!.push(from));
  }
  const position = new Map<string, number>();
  const indexLayers = () =>
    layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  indexLayers();
  const reorder = (layer: string[], neighbours: Map<string, string[]>) => {
    const barycenter = new Map(
      layer.map((id) => {
        const adjacent = neighbours.get(id)!;
        return [
          id,
          adjacent.length
            ? adjacent.reduce((sum, a) => sum + position.get(a)!, 0) /
              adjacent.length
            : position.get(id)!,
        ] as const;
      }),
    );
    layer.sort((a, b) => barycenter.get(a)! - barycenter.get(b)!);
    layer.forEach((id, i) => position.set(id, i));
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) {
      reorder(layers[i], incoming);
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      reorder(layers[i], acyclic);
    }
  }

  // coordinates: layers advance along the main axis, nodes are centred on
  // the cross axis
  const isVertical = direction === "TB";
  const mainSize = (n: LayoutNode) => (isVertical ? n.height : n.width);
  const crossSize = (n: LayoutNode) => (isVertical ? n.width : n.height);

  const layerCross = layers.map((layer) =>
    layer.reduce(
      (sum, id, i) => sum + crossSize(byId.get(id)!) + (i ? nodeSpacing : 0),
      0,
    ),
  );
  const maxCross = Math.max(0, ...layerCross);

  const result = new Map<string, { x: number; y: number }>();
  let main = 0;
  layers.forEach((layer, layerIndex) => {
    let cross = (maxCross - layerCross[layerIndex]) / 2;
    let layerMain = 0;
    for (const id of layer) {
      const node = byId.get(id)!;
      result.set(
        id,
        isVertical ? { x: cross, y: main } : { x: main, y: cross },
      );
      cross += crossSize(node) + nodeSpacing;
      layerMain = Math.max(layerMain, mainSize(node));
    }
    main += layerMain + layerSpacing;
  });

  return result;
};
