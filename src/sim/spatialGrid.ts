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
//
// Coordinate contract: all coordinates — item positions at
// insert/update time and query points — MUST be finite. By
// construction non-finite input is unreachable (World spawn puts
// tetras in bounds, wall reflection and clamping keep them bounded,
// and the steering contract guarantees finite vectors), so the hot
// paths deliberately carry no per-call Number.isFinite guards.
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
    // Every cell exists from construction and is never nulled
    // afterwards: the `!` assertions in insert/remove/query tell the
    // type checker what this guarantees (noUncheckedIndexedAccess).
    // They are compile-time advice only — there is no runtime null
    // handling anywhere in this class.
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  /** Drop every item (cell arrays themselves are reused: no
   *  per-step allocation). */
  clear(): void {
    for (const cell of this.cells) cell.length = 0;
    this.indexOf.clear();
  }

  /** Place an item in the cell holding its current position.
   *  Re-inserting a present item moves it (idempotent count: an
   *  item never occupies two cells). The old-cell eviction splices
   *  ONLY at the item's verified own slot — if the bookkeeping ever
   *  goes stale the item is simply absent and nothing is removed:
   *  an implicit splice position (splice(-1)) would evict an
   *  innocent neighbour. */
  insert(item: T): void {
    const cellIndex = this.indexOf.get(item);
    if (cellIndex !== undefined) {
      const cell = this.cells[cellIndex]!;
      const at = cell.indexOf(item);
      if (at >= 0) cell.splice(at, 1);
    }
    const index = this.rowOf(item.y) * this.cols + this.colOf(item.x);
    // index is provably in range: colOf/rowOf clamp to [0, cols) and
    // [0, rows) respectively, so the `!` is pure type advice.
    this.cells[index]!.push(item);
    this.indexOf.set(item, index);
  }

  /** Express intent at the call site that an already-inserted item
   *  moved. A plain alias of insert() — identical behaviour, no
   *  performance difference (an untracked item is simply put in);
   *  it exists so callers read "it moved", not "re-inserted it". */
  update(item: T): void {
    this.insert(item);
  }

  /** Remove an item. Returns true if it was present. Removing an
   *  absent item is a pure no-op: it splices nothing, so a healthy
   *  neighbour (even the last occupant of the same cell) can never
   *  be disturbed. */
  remove(item: T): boolean {
    const cellIndex = this.indexOf.get(item);
    if (cellIndex === undefined) return false;
    const cell = this.cells[cellIndex]!;
    const at = cell.indexOf(item);
    if (at >= 0) cell.splice(at, 1);
    this.indexOf.delete(item);
    return true;
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
        const cell = this.cells[row * this.cols + col]!;
        for (const item of cell) {
          const dx = item.x - x;
          const dy = item.y - y;
          if (dx * dx + dy * dy <= r2) found.push(item);
        }
      }
    }
    return found;
  }

  private colOf(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
  }

  private rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
  }
}
