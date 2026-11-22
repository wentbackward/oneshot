// ================================================================
// Viewport stage (ui, PRD §1: ui isolated from sim and render):
// owns the <canvas> element and keeps its backing store fitted to
// the viewport. Toolbar/HUD widgets join this layer later.
// ================================================================

export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private readonly win: Window;

  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, win: Window) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.win = win;
  }

  /** Grab the 2d context, wire viewport resize, do the first fit. */
  static attach(canvas: HTMLCanvasElement, win: Window): Stage {
    if (typeof canvas.getContext !== "function") {
      throw new Error("fishtank: the #game element is not a canvas");
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("fishtank: no 2d canvas context available");
    const stage = new Stage(canvas, ctx, win);
    win.addEventListener("resize", () => stage.refit());
    stage.refit();
    return stage;
  }

  /** Backing-store width/height in DEVICE px (the rendering space;
   *  use cssWidth/cssHeight for pointer coordinates). */
  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** CSS (layout) width of the canvas box in device-INDEPENDENT px:
   *  the space pointer coordinates arrive in. The page template
   *  stretches the canvas to 100vw × 100vh, so this is the window's
   *  CSS viewport. */
  get cssWidth(): number {
    return this.win.innerWidth;
  }

  get cssHeight(): number {
    return this.win.innerHeight;
  }

  /** Refit the backing store to the viewport (device-pixel aware). */
  refit(): void {
    const dpr = this.win.devicePixelRatio > 0 ? this.win.devicePixelRatio : 1;
    this.canvas.width = Math.max(1, Math.round(this.win.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.win.innerHeight * dpr));
  }
}
