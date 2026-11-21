// ================================================================
// Uniform spatial hash grid (PRD §1): O(1) average-case neighbor
// queries so the simulation sustains 60 fps with hundreds of
// entities. The World rebuilds it (clear + re-insert) each fixed
// step; the grid never owns entity lifetime.
//
// Query contract: query(x, y, radius) returns every item with
// Euclidean distance <= radius (a CLOSED ball) — radius 0 matches
// the query point exactly. Items stored in the grid are always
// returned even if their position lies outside the domain (they
// clamp into an edge cell). The probe scans the exact cell span the
// query circle overlaps, so it stays correct for any radius vs.
// cell-size ratio; with radius <= cellSize that span is the cheap
// constant 3×3 block.
// ================================================================

/** Anything placeable in the grid: a position in logical tank units. */
export interface Positioned {
  x: number;
  y: number;
}

/** Spatial hash over a fixed [0, width] × [0, height] domain. */
export class SpatialGrid<T extends Positioned> {
  readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: T[][];
  /** Cell index per inserted item: makes update()/remove() O(1)
   *  lookups without scanning cells. */
  private readonly indexOf = new Map<T, number>();

  constructor(width: number, height: number, cellSize: number) {
    if (!(cellSize > 0)) throw new RangeError("SpatialGrid: cellSize must be positive");
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  /** Number of items currently in the grid. */
  get size(): number {
    return this.indexOf.size;
  }

  /** Drop every item (cell arrays themselves are reused: no
   *  per-step allocation). */
  clear(): void {
    for (const cell of this.cells) cell.length = 0;
    this.indexOf.clear();
  }

  /** Place an item in the cell holding its current position.
   *  Re-inserting a present item moves it (idempotent count: an
   *  item never occupies two cells). */
  insert(item: T): void {
    const cellIndex = this.indexOf.get(item);
    if (cellIndex !== undefined) {
      // Already indexed: pull it out of its old cell first so the
      // item can never be reported twice by a query.
      this.cells[cellIndex]?.splice(this.cells[cellIndex]?.indexOf(item) ?? -1, 1);
    }
    const index = this.rowOf(item.y) * this.cols + this.colOf(item.x);
    this.cells[index]?.push(item);
    this.indexOf.set(item, index);
  }

  /** Express intent at the call site that an already-inserted item
   *  moved. A plain alias of insert() — identical behaviour, no
   *  performance difference (an untracked item is simply put in);
   *  it exists so callers read "it moved", not "re-inserted it". */
  update(item: T): void {
    this.insert(item);
  }

  /** Remove an item. Returns true if it was present. */
  remove(item: T): boolean {
    const cellIndex = this.indexOf.get(item);
    if (cellIndex === undefined) return false;
    const cell = this.cells[cellIndex];
    const at = cell ? cell.indexOf(item) : -1;
    if (cell && at >= 0) cell.splice(at, 1);
    this.indexOf.delete(item);
    return true;
  }

  /** True iff the item is currently in the grid. */
  contains(item: T): boolean {
    return this.indexOf.has(item);
  }

  /** All items within Euclidean distance <= radius of (x, y), as a
   *  fresh array (callers own it). Exact set semantics: the probe
   *  visits precisely the cells the closed ball overlaps and then
   *  filters by squared distance, so the result matches brute-force
   *  distance filtering over the same items bit-for-bit. */
  query(x: number, y: number, radius: number): T[] {
    const found: T[] = [];
    const r2 = radius * radius;
    const c0 = this.colOf(x - radius);
    const c1 = this.colOf(x + radius);
    const r0 = this.rowOf(y - radius);
    const r1 = this.rowOf(y + radius);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = this.cells[row * this.cols + col];
        if (!cell) continue;
        for (const item of cell) {
          const dx = item.x - x;
          const dy = item.y - y;
          if (dx * dx + dy * dy <= r2) found.push(item);
        }
      }
    }
    return found;
  }

  /** Call cb for every item stored in the 3×3 block of cells
   *  around (x, y) — the allocation-free variant of the constant
   *  neighborhood probe for callers that filter on the fly. */
  queryNeighbors(x: number, y: number, cb: (item: T) => void): void {
    const cx = this.colOf(x);
    const cy = this.rowOf(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const row = cy + dy;
        const col = cx + dx;
        if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) continue;
        const cell = this.cells[row * this.cols + col];
        if (cell) for (const item of cell) cb(item);
      }
    }
  }

  private colOf(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
  }

  private rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
  }
}
