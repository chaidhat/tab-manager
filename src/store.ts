import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CapturedLayout, Layout } from './types';

const LAYOUTS_KEY = 'tabManager.layouts';
const ACTIVE_KEY = 'tabManager.activeLayoutId';

/**
 * Persists saved layouts and the currently active one. Layouts live in
 * workspace state because they reference this project's file URIs, and are of
 * no use in another workspace. Emits {@link onDidChange} whenever the data
 * changes so the tree view can refresh.
 */
export class LayoutStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  list(): Layout[] {
    return this.memento.get<Layout[]>(LAYOUTS_KEY, []);
  }

  get(id: string): Layout | undefined {
    return this.list().find((layout) => layout.id === id);
  }

  get activeId(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  /** Saves a new layout from a capture, names it, and makes it active. */
  async add(captured: CapturedLayout): Promise<Layout> {
    const layout: Layout = { ...captured, id: randomUUID(), name: this.nextName() };
    await this.memento.update(LAYOUTS_KEY, [...this.list(), layout]);
    await this.memento.update(ACTIVE_KEY, layout.id);
    this.emitter.fire();
    return layout;
  }

  /** Overwrites a layout's captured arrangement, keeping its id and name. */
  async update(id: string, captured: CapturedLayout): Promise<void> {
    await this.save(this.list().map((l) => (l.id === id ? { ...l, ...captured } : l)));
  }

  async rename(id: string, name: string): Promise<void> {
    await this.save(this.list().map((l) => (l.id === id ? { ...l, name } : l)));
  }

  async remove(id: string): Promise<void> {
    if (this.activeId === id) {
      await this.memento.update(ACTIVE_KEY, undefined);
    }
    await this.save(this.list().filter((l) => l.id !== id));
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.memento.update(ACTIVE_KEY, id);
    this.emitter.fire();
  }

  private async save(layouts: Layout[]): Promise<void> {
    await this.memento.update(LAYOUTS_KEY, layouts);
    this.emitter.fire();
  }

  /** Lowest-numbered "Layout N" name not already in use. */
  private nextName(): string {
    const used = new Set(this.list().map((l) => l.name));
    for (let n = 1; ; n++) {
      const name = `Layout ${n}`;
      if (!used.has(name)) {
        return name;
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
