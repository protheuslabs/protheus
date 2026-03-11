// @lensmap-anchor B358D1
export function add(a: number, b: number): number {
  const url = "http://example.com";
  return a + b; // @lensmap-ref B358D1-3
}

// @lensmap-anchor 296A43
export const mul = (x: number, y: number): number => {
  const z = x * y; // @lensmap-ref 296A43-2
  return z;
};


