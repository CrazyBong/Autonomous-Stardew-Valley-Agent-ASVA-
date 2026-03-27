import type { Logger } from 'pino';

/**
 * Pathfinder — L2 Execution Layer.
 * Implements A* pathfinding over the 2D tile grid received from the SMAPI bridge.
 *
 * Design constraints (from spec Section 4):
 *  - Must complete any path calculation in <5ms.
 *  - Blocked paths must not cause a hang; they return null for the dispatcher to handle.
 *  - Tile graph is supplied externally per-tick (no internal caching to avoid stale maps).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TilePosition {
  readonly x: number;
  readonly y: number;
  readonly map: string;
}

/**
 * A walkable tile grid for one map.
 * `walkable[y][x] === true` means the tile is passable.
 */
export type TileGrid = ReadonlyArray<ReadonlyArray<boolean>>;

export interface PathResult {
  /** Ordered list of tile positions from start (exclusive) to target (inclusive). */
  readonly steps: TilePosition[];
  /** Estimated cost in tiles traversed. */
  readonly cost: number;
}

// ── Internal A* Node ──────────────────────────────────────────────────────────

interface AStarNode {
  x: number;
  y: number;
  g: number; // cost from start
  h: number; // heuristic to goal
  f: number; // g + h
  parent: AStarNode | null;
}

// ── Pathfinder Class ──────────────────────────────────────────────────────────

export class Pathfinder {
  /**
   * 4-directional movement offsets (no diagonal — Stardew moves in 4 dirs).
   */
  private static readonly DIRS: ReadonlyArray<[number, number]> = [
    [0, -1], // North
    [1, 0],  // East
    [0, 1],  // South
    [-1, 0], // West
  ];

  constructor(private readonly logger: Logger) {}

  /**
   * Finds the shortest walkable path from `start` to `target` on the given tile grid.
   *
   * Returns `null` if:
   *  - Start or target is out of bounds / not walkable.
   *  - No path exists (area is fully blocked).
   *  - Path is within the same tile (start === target → empty steps, cost 0).
   *
   * Performance: O((W * H) log(W * H)) — acceptable for Stardew maps (≤ 120×80).
   */
  public findPath(
    start: TilePosition,
    target: TilePosition,
    grid: TileGrid
  ): PathResult | null {
    // Same-tile trivial case
    if (start.x === target.x && start.y === target.y && start.map === target.map) {
      return { steps: [], cost: 0 };
    }

    // Different maps — cross-map routing not handled here; dispatcher handles warps
    if (start.map !== target.map) {
      this.logger.warn(
        { from: start.map, to: target.map },
        'Pathfinder: cross-map routing requested — returning null; dispatcher must handle warp'
      );
      return null;
    }

    const rows = grid.length;
    const cols = rows > 0 ? (grid[0]?.length ?? 0) : 0;

    if (
      !this.inBounds(start.x, start.y, cols, rows) ||
      !(grid[start.y] ?? [])[start.x]
    ) {
      this.logger.warn({ start }, 'Pathfinder: start tile is out of bounds or not walkable');
      return null;
    }
    if (
      !this.inBounds(target.x, target.y, cols, rows) ||
      !(grid[target.y] ?? [])[target.x]
    ) {
      this.logger.warn({ target }, 'Pathfinder: target tile is out of bounds or not walkable');
      return null;
    }

    // ── A* core ──────────────────────────────────────────────────────────────

    // Simple min-heap via sorted insertion (grid is small enough for this to be <1ms)
    const openSet: AStarNode[] = [];
    const closedSet = new Set<string>();

    const startNode: AStarNode = {
      x: start.x,
      y: start.y,
      g: 0,
      h: this.heuristic(start.x, start.y, target.x, target.y),
      f: 0,
      parent: null,
    };
    startNode.f = startNode.g + startNode.h;
    openSet.push(startNode);

    while (openSet.length > 0) {
      // Pop node with lowest f (openSet is kept sorted)
      const current = openSet.shift()!;
      const key = `${current.x},${current.y}`;

      if (closedSet.has(key)) continue;
      closedSet.add(key);

      // Goal reached — reconstruct path
      if (current.x === target.x && current.y === target.y) {
        return this.reconstructPath(current, start.map);
      }

      for (const [dx, dy] of Pathfinder.DIRS) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        const nKey = `${nx},${ny}`;

        if (!this.inBounds(nx, ny, cols, rows)) continue;
      if (!(grid[ny] ?? [])[nx]) continue;
        if (closedSet.has(nKey)) continue;

        const g = current.g + 1;
        const h = this.heuristic(nx, ny, target.x, target.y);
        const neighbor: AStarNode = { x: nx, y: ny, g, h, f: g + h, parent: current };

        // Insert in sorted order by f
        let inserted = false;
        for (let i = 0; i < openSet.length; i++) {
          const existing = openSet[i];
          if (existing !== undefined && existing.f > neighbor.f) {
            openSet.splice(i, 0, neighbor);
            inserted = true;
            break;
          }
        }
        if (!inserted) openSet.push(neighbor);
      }
    }

    // No path found
    this.logger.warn({ start, target }, 'Pathfinder: no path found between tiles');
    return null;
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  /** Manhattan distance heuristic (admissible for 4-directional movement). */
  private heuristic(x1: number, y1: number, x2: number, y2: number): number {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
  }

  private inBounds(x: number, y: number, cols: number, rows: number): boolean {
    return x >= 0 && y >= 0 && x < cols && y < rows;
  }

  private reconstructPath(goalNode: AStarNode, map: string): PathResult {
    const steps: TilePosition[] = [];
    let current: AStarNode | null = goalNode;

    while (current !== null && current.parent !== null) {
      steps.unshift({ x: current.x, y: current.y, map });
      current = current.parent;
    }

    return { steps, cost: goalNode.g };
  }
}
