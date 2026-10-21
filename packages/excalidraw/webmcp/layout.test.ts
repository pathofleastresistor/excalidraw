import { layoutLayered } from "./layout";

const node = (id: string, width = 100, height = 50) => ({ id, width, height });
const options = {
  direction: "TB" as const,
  nodeSpacing: 40,
  layerSpacing: 60,
};

describe("layoutLayered", () => {
  it("ranks a chain along the main axis", () => {
    const positions = layoutLayered(
      [node("a"), node("b"), node("c")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      options,
    );
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")).toEqual({ x: 0, y: 110 });
    expect(positions.get("c")).toEqual({ x: 0, y: 220 });
  });

  it("lays out left to right", () => {
    const positions = layoutLayered(
      [node("a"), node("b")],
      [{ from: "a", to: "b" }],
      { ...options, direction: "LR" },
    );
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")).toEqual({ x: 160, y: 0 });
  });

  it("centres siblings on the cross axis without overlapping", () => {
    const positions = layoutLayered(
      [node("root"), node("l"), node("r")],
      [
        { from: "root", to: "l" },
        { from: "root", to: "r" },
      ],
      options,
    );
    const l = positions.get("l")!;
    const r = positions.get("r")!;
    expect(l.y).toBe(r.y);
    expect(Math.abs(l.x - r.x)).toBeGreaterThanOrEqual(100 + 40);
    // the parent sits centred above them
    expect(positions.get("root")!.x).toBe((l.x + r.x) / 2);
  });

  it("survives cycles, self loops, unknown ids and disconnected nodes", () => {
    const positions = layoutLayered(
      [node("a"), node("b"), node("c"), node("lonely")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
        { from: "a", to: "a" },
        { from: "a", to: "missing" },
      ],
      options,
    );
    expect(positions.size).toBe(4);
    expect(positions.get("a")!.y).toBeLessThan(positions.get("b")!.y);
    expect(positions.get("b")!.y).toBeLessThan(positions.get("c")!.y);
  });

  it("handles an empty graph", () => {
    expect(layoutLayered([], [], options).size).toBe(0);
  });
});
