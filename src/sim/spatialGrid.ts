// ================================================================
// Uniform spatial hash grid (PRD §1): O(1) average-case neighbor
// queries so the simulation sustains 60 fps with hundreds of
// entities. The grid is rebuilt (cleared + re-inserted) each fixed
// step by the World; it never owns entity lifetime.
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

  constructor(width: number, height: number, cellSize: number) {
    if (!(cellSize > 0)) throw new RangeError("SpatialGrid: cellSize must be positive");
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  /** Drop every item (kept between cells: no per-step allocation). */
  clear(): void {
    for (const cell of this.cells) cell.length = 0;
  }

  /** Place an item into the cell holding its position. */
  insert(item: T): void {
    const cell = this.cells[this.rowOf(item.y) * this.cols + this.colOf(item.x)];
    if (cell) cell.push(item);
  }

  /** Call cb for every item stored in the 3×3 block of cells around
   *  (x, y) — the uniform grid's constant-cost neighborhood probe. */
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
