import { Notice, type Plugin } from "obsidian";
import {
  ANN_DIR, GHOST_TYPE, GLOSS_DIR, defaultTypes, currentTypeId, migrateBuiltinTypes, isMdPath, legacySafePath, safePath, unsafePath,
  type GlossDocStore, type GlossEntry, type GlossType,
} from "./types";

const TYPES_PATH = `${GLOSS_DIR}/types.json`;

/**
 * 单文档状态对象：缓存实例、共享加载任务、失效代数、脏版本、写定时器、写队列
 * 全部归属这一个对象。重命名只改 `path` 并把对象整体改挂到新路径索引，
 * 所有调用方（无论用旧路径还是新路径进来）共享同一份缓存与同一条写队列，
 * 不再存在"旧路径 / 新路径"两套并行的加载实例、定时器与写队列。
 */
interface DocState {
  /** 当前文件路径；重命名提交后该对象原子改挂到新路径 */
  path: string;
  /** 已发布的内存 store；loadDoc 的返回值恒 === 本字段（绝不交出脱缓存对象） */
  store: GlossDocStore | null;
  /** 进行中的共享加载；同文档并发 loadDoc 加入同一任务，不产生第二个加载实例 */
  load: Promise<GlossDocStore> | null;
  /** 失效代数：按文档 invalidate() 递增，进行中的加载醒来后不符则重读重试 */
  gen: number;
  /** 文件存在但读取/解析失败：渲染用空数据、禁止写回（保留原文件）；下次成功读取清除 */
  failed: boolean;
  /** failed 的 Notice 只提示一次 */
  failedNoticed: boolean;
  /** 脏版本：0 = 干净。每次修改递增；写入时捕获版本，成功后仅版本未变才清零 */
  dirtyVer: number;
  /** 防抖写定时器（每文档至多一个，含重命名窗口内的延迟重排） */
  timer: ReturnType<typeof setTimeout> | null;
  /** 写队列：每文档一条，所有写盘串行经过 */
  chain: Promise<void>;
  /** 队列中在途写入数（isBusy 判定用） */
  pendingWrites: number;
  baseline: string | null | undefined;
}

/**
 * Gloss 数据层：
 * - .gloss/types.json           批注类型（全库共享）
 * - .gloss/annotations/<p>.json 每篇文档（md/pdf）一个文件
 * 全部本地 JSON，防抖写盘，外部 modify 时失效缓存。
 */
export class GlossStorage {
  private app;
  types: GlossType[] = [];
  private saveTypesTimer: ReturnType<typeof setTimeout> | null = null;
  /** 全部文档状态，按"当前路径"索引；值是每篇文档唯一的状态对象 */
  private docs = new Map<string, DocState>();
  /** store → 其状态对象（saveStore 反查：持有 store 对象的调用方按对象落盘） */
  private storeState = new WeakMap<GlossDocStore, DocState>();
  /** 迁移全局串行；加载与普通写入等待当前批次，迁移内部只使用状态对象。 */
  private migrations: Promise<void> = Promise.resolve();
  private migrationBarrier: Promise<void> | null = null;
  /** types.json 损坏：内存用默认类型，不覆盖原文件，直到用户显式改动类型 */
  private typesFailed = false;
  private typesLoaded = false;
  private typesDirty = false;
  private typesChain: Promise<void> = Promise.resolve();
  private typesBaseline: string | null | undefined;
  private checkingExternal = false;
  private conflictSerial = 0;
  /** 全局失效纪元：invalidate()（全局）递增，让进行中的加载回来时不再入缓存 */
  private invalidEpoch = 0;

  /** 由 main 注入（类型管理/附件目录需要读设置），避免循环引用 */
  plugin: { settings: { attachmentsFolder: string } } | null = null;

  constructor(plugin: Plugin) {
    this.app = plugin.app;
  }

  // ---------- 类型 ----------

  async loadTypes(): Promise<GlossType[]> {
    if (this.typesLoaded) return this.types;
    let raw: string | null = null;
    let fileExisted = false;
    let checkFailed = false;
    try {
      if (await this.app.vault.adapter.exists(TYPES_PATH)) {
        fileExisted = true;
        raw = await this.app.vault.adapter.read(TYPES_PATH);
      }
    } catch { checkFailed = true; } // exists/read 抛异常：状态未知，按"读不出来"保守处理
    this.typesBaseline = checkFailed ? undefined : raw;
    this.typesLoaded = true;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(t => t && typeof t.id === "string" && typeof t.name === "string" && typeof t.color === "string" && /^#[\da-f]{3}([\da-f]{3})?$/i.test(t.color))) {
          this.types = migrateBuiltinTypes(parsed as GlossType[]);
          if (this.types !== parsed) {
            // Persist only after a valid read; a failed migration write leaves the original recoverable.
            this.typesDirty = true;
            try { await this.writeTypesNow(); }
            catch (error) { console.warn("[gloss] type migration write failed", error); new Notice("Gloss：类型已更新，保存失败，将在下次加载时重试"); }
          }
          return this.types;
        }
      } catch { /* 损坏 */ }
      // 文件存在但损坏：内存临时用默认类型，不覆盖原文件（保留恢复可能）
      this.typesFailed = true;
      this.types = defaultTypes();
      new Notice("Gloss：批注类型文件损坏，已临时使用默认类型（原文件未覆盖）");
      return this.types;
    }
    if (fileExisted || checkFailed) {
      // 存在但读不出来（read 失败 / 空内容 / 探测抛异常）：同样禁止覆盖
      this.typesFailed = true;
      new Notice("Gloss：批注类型文件不可读，已临时使用默认类型（原文件未覆盖）");
    }
    this.types = defaultTypes();
    if (!fileExisted && !checkFailed) { this.typesDirty = true; await this.writeTypesNow(); }
    return this.types;
  }

  sortedTypes(): GlossType[] {
    return [...this.types].sort((a, b) => a.order - b.order);
  }

  typeOf(id: string): GlossType {
    return this.types.find((t) => t.id === id) ?? this.types.find(t => t.id === currentTypeId(id)) ?? GHOST_TYPE;
  }

  saveTypes(): void {
    this.typesDirty = true;
    if (this.saveTypesTimer) clearTimeout(this.saveTypesTimer);
    this.saveTypesTimer = setTimeout(() => { this.saveTypesTimer = null; void this.writeTypesNow().catch(e => console.error("[Gloss] types save failed", e)); }, 250);
  }

  private writeTypesNow(): Promise<void> {
    const task = this.typesChain.then(() => this.writeTypesImpl());
    this.typesChain = task.catch(() => undefined);
    return task;
  }

  private async writeTypesImpl(): Promise<void> {
    if (!this.typesDirty || this.typesFailed) return;
    const raw = JSON.stringify(this.types, null, 2);
    await this.assertUnchanged(TYPES_PATH, this.typesBaseline, raw);
    await this.ensureParent(TYPES_PATH);
    await this.app.vault.adapter.write(TYPES_PATH, raw);
    this.typesBaseline = raw;
    if (JSON.stringify(this.types, null, 2) === raw) this.typesDirty = false;
  }

  private async diskText(path: string): Promise<string | null> {
    return await this.app.vault.adapter.exists(path) ? this.app.vault.adapter.read(path) : null;
  }

  /** Adapter polling also works for hidden folders where ordinary Vault events do not fire. */
  async checkExternalChanges(): Promise<boolean> {
    if (this.checkingExternal || this.migrationBarrier) return false;
    this.checkingExternal = true;
    let changed = false;
    try {
      for (const state of this.docs.values()) {
        if (!state.store || this.isBusy(state) || state.baseline === undefined) continue;
        const current = await this.diskText(this.docJsonPath(state.path));
        if (!this.isBusy(state) && current !== state.baseline) { this.invalidate(state.path); changed = true; }
      }
      if (this.typesLoaded && !this.typesDirty && !this.saveTypesTimer && this.typesBaseline !== undefined) {
        const raw = await this.diskText(TYPES_PATH);
        if (!this.typesDirty && raw !== this.typesBaseline) {
          this.typesLoaded = false; this.typesFailed = false;
          await this.loadTypes(); changed = true;
        }
      }
    } catch (error) { console.warn("[Gloss] external change check failed", error); }
    finally { this.checkingExternal = false; }
    return changed;
  }

  /** Fail closed: never replace external edits with a stale local document. */
  private async assertUnchanged(path: string, baseline: string | null | undefined, local: string): Promise<void> {
    const remote = await this.diskText(path);
    if (baseline !== undefined && remote === baseline) return;
    const backup = `${GLOSS_DIR}/conflicts/${Date.now()}-${++this.conflictSerial}.json`;
    await this.ensureParent(backup);
    await this.app.vault.adapter.write(backup, local);
    new Notice(`Gloss：检测到外部修改，已停止覆盖。当前本地版本保存在 ${backup}`);
    throw new Error(`External change conflict: ${path}; local copy: ${backup}`);
  }

  // ---------- 文档批注 ----------

  docJsonPath(docPath: string): string {
    return `${ANN_DIR}/${safePath(docPath)}.json`;
  }

  private createState(path: string): DocState {
    const state: DocState = {
      path, store: null, load: null, gen: 0,
      failed: false, failedNoticed: false,
      dirtyVer: 0, timer: null,
      chain: Promise.resolve(), pendingWrites: 0, baseline: undefined,
    };
    this.docs.set(path, state);
    return state;
  }

  async loadDoc(docPath: string): Promise<GlossDocStore> {
    await this.waitForMigrations();
    return this.loadState(docPath);
  }

  private async waitForMigrations(): Promise<void> {
    while (this.migrationBarrier) await this.migrationBarrier;
  }

  private async loadState(docPath: string): Promise<GlossDocStore> {
    let state = this.docs.get(docPath);
    if (!state) state = this.createState(docPath);
    if (state.store) return state.store;
    if (state.load) return state.load; // 加入进行中的共享加载，不产生第二个加载实例
    const p = this.runLoad(state);
    state.load = p;
    void p.finally(() => {
      // 核对身份：只清自己登记的 Promise，不误清同状态后续的新加载
      if (state.load === p) state.load = null;
    });
    return p;
  }

  /**
   * 一篇文档唯一的加载任务（所有 loadDoc 调用方共享）。
   * 加载期间被失效：重读重试，直到拿到"当前代数/纪元"的结果。
   * 每轮先回到共享状态：已有已发布实例（其中可能含未落盘的修改）时直接返回——
   * 旧任务绝不覆盖当前缓存；超过重试上限也不强行发布过期数据（按读取失败处理）。
   * 代数/纪元每轮读取前重新取：按文档失效（gen++）后，下一轮即可收敛。
   */
  private runLoad(state: DocState): Promise<GlossDocStore> {
    return (async (): Promise<GlossDocStore> => {
      for (let attempt = 0; ; attempt++) {
        // 重新加入共享状态：已发布的实例优先返回（禁止旧读取结果覆盖新缓存）
        if (state.store) return state.store;
        const gen = state.gen;
        const epoch = this.invalidEpoch;
        const store = await this.readDocStore(state, state.path);
        if (state.store) return state.store; // 读取期间他人已发布
        if (gen === state.gen && epoch === this.invalidEpoch) {
          this.publish(state, store);
          return store;
        }
        if (attempt >= 5) {
          // 失效事件连发（异常风暴）：停止重试避免死循环。
          // 此时无法确认"失效事件之后的磁盘数据"仍是最新，强行发布会让后续写入
          // 覆盖更新的外部修改 → 按读取失败处理：缓存最后一次读取供渲染、
          // 禁止写回（保留磁盘原文件，状态栏/通知告知用户）
          state.failed = true;
          if (!state.failedNoticed) {
            state.failedNoticed = true;
            new Notice(`Gloss：${state.path} 的批注数据读取期间反复变化，为保护磁盘数据，本次会话不写回该文档`);
          }
          this.publish(state, store);
          return store;
        }
      }
    })();
  }

  private publish(state: DocState, store: GlossDocStore): void {
    if (state.store && state.store !== store) this.storeState.delete(state.store);
    state.store = store;
    this.storeState.set(store, state);
  }

  private async readDocStore(state: DocState, docPath: string): Promise<GlossDocStore> {
    let store: GlossDocStore | null = null;
    let fileExisted = false;
    let readFailed = false;
    try {
      if (await this.app.vault.adapter.exists(this.docJsonPath(docPath))) {
        fileExisted = true;
        const raw = await this.app.vault.adapter.read(this.docJsonPath(docPath));
        state.baseline = raw;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.docPath === docPath && Array.isArray(parsed.entries)) store = parsed as GlossDocStore;
        else readFailed = true;
      }
    } catch { /* 损坏或读取失败 */ readFailed = true; }
    if (!store) {
      // 存量文件仍是旧版有损编码（/ → __）→ 校验 docPath 后迁移到新编码。
      // 仅在新路径"确认不存在"（exists() 正常返回 false）时尝试：
      // 探测抛异常时状态未知，新文件可能实际存在，迁移会覆盖它
      if (!fileExisted && !readFailed) {
        store = await this.tryLegacyMigration(docPath);
        state.baseline = await this.diskText(this.docJsonPath(docPath));
      }
    }
    if (!store) {
      store = {
        version: 1,
        docPath,
        kind: isMdPath(docPath) ? "md" : "pdf",
        entries: [],
      };
      if (readFailed) {
        // 区分"不存在"与"读不出来"（含 exists 抛异常）：后者缓存空数据仅供渲染，
        // 并标记该文档不可写回，防止 flush 用空文档覆盖原始文件
        state.failed = true;
        if (!state.failedNoticed) {
          state.failedNoticed = true;
          new Notice(`Gloss：${docPath} 的批注数据读取失败，已保留原文件；本次会话的改动不会写盘`);
        }
      }
    } else {
      // 成功读到真实数据（含迁移结果）：此前的"读取失败"标记解除，写回恢复
      state.failed = false;
    }
    return store;
  }

  /**
   * 定位并迁移旧编码（v0：/ → __）的存量文件。
   * 必须校验文件内声明的 docPath：v0 编码有损，`a/b.md` 与 `a_b.md` 会落到同一个
   * 文件名上，无校验的"认领"会吞掉另一篇文档的数据。
   */
  private async tryLegacyMigration(docPath: string): Promise<GlossDocStore | null> {
    const newPath = this.docJsonPath(docPath);
    const legacy = `${ANN_DIR}/${legacySafePath(docPath)}.json`;
    if (legacy === newPath) return null;
    try {
      if (!(await this.app.vault.adapter.exists(legacy))) return null;
      const raw = await this.app.vault.adapter.read(legacy);
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return null;
      if (parsed.docPath !== docPath) {
        console.warn(`[Gloss] 跳过 ${legacy}：其 docPath 为 ${parsed.docPath}，不属于 ${docPath}`);
        return null;
      }
      const store = parsed as GlossDocStore;
      store.docPath = docPath;
      try {
        await this.ensureParent(newPath);
        await this.app.vault.adapter.write(newPath, JSON.stringify(store, null, 2));
        await this.app.vault.adapter.remove(legacy);
      } catch (error) {
        console.warn(`[Gloss] 旧批注可读，迁移稍后重试：${legacy}`, error);
      }
      return store;
    } catch { /* ignore */ }
    return null;
  }

  /** 是否有未落盘的改动：防抖定时器（含延迟重排）、在途写入、或尚未写成功的脏状态 */
  pendingSave(docPath: string): boolean {
    const state = this.docs.get(docPath);
    return state ? this.isBusy(state) : false;
  }

  private isBusy(state: DocState): boolean {
    return state.timer !== null || state.pendingWrites > 0 || state.dirtyVer > 0;
  }

  /** 写回（防抖 300ms）；调用前先改 store 内存对象 */
  saveDoc(docPath: string): void {
    const state = this.docs.get(docPath);
    if (!state || !state.store || state.failed) return;
    this.armSave(state);
  }

  /**
   * 按 store 对象落盘。文档重命名后路径变了，但调用方实际修改的 store 所属的
   * 状态对象没变——提交后按旧路径查会漏掉这批修改。
   * 只接受"当前已发布"的 store：失效后该对象已过期，写回会覆盖更新的磁盘数据，拒绝。
   */
  saveStore(store: GlossDocStore): boolean {
    const state = this.storeState.get(store);
    if (!state || !state.store || state.failed) {
      new Notice("Gloss：批注已更新或暂不可写，请重新打开卡片后重试");
      return false;
    }
    this.armSave(state);
    return true;
  }

  /** store 对应的当前文件路径（状态对象可能已被重命名改挂到新路径） */
  currentPath(store: GlossDocStore): string | null {
    return this.storeState.get(store)?.path ?? null;
  }

  private armSave(state: DocState): void {
    // 每次修改递增脏版本（writeDocNow 按版本比对清除）
    state.dirtyVer++;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.fireSave(state), 300);
  }

  private fireSave(state: DocState): void {
    state.timer = null;
    void (async () => {
      await this.waitForMigrations();
      await this.enqueueWrite(state);
    })().catch(() => { /* 写入失败保留 dirtyVer */ });
  }

  async flushDoc(docPath: string): Promise<void> {
    await this.waitForMigrations();
    const state = this.docs.get(docPath);
    if (state) await this.flushState(state);
  }

  private async flushState(state: DocState): Promise<void> {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    await this.enqueueWrite(state);
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
    }
  }

  /** 按文档串行化写入（同一 DocState 一条队列）；失败不阻塞后续写入 */
  private enqueueWrite(state: DocState): Promise<void> {
    const prev = state.chain;
    const p = prev.then(() => this.writeDocNow(state));
    const stored = p.catch(() => undefined);
    state.chain = stored;
    state.pendingWrites++;
    void stored.finally(() => { state.pendingWrites--; });
    return p;
  }

  private async writeDocNow(state: DocState): Promise<void> {
    const store = state.store;
    if (!store || !state.dirtyVer) return;
    if (state.failed) return; // 读取失败的文档不覆盖原始文件
    const p = state.path;
    if (store.docPath !== p) store.docPath = p;
    const ver = state.dirtyVer;
    try {
      const raw = JSON.stringify(store, null, 2);
      await this.assertUnchanged(this.docJsonPath(p), state.baseline, raw);
      await this.ensureParent(this.docJsonPath(p));
      await this.app.vault.adapter.write(this.docJsonPath(p), raw);
      state.baseline = raw;
      // 仅当"本次写入的版本"仍是当前版本才清脏：
      // V1 写入在途时 V2 已修改，V1 成功不得清除 V2 的脏状态
      if (state.dirtyVer === ver) state.dirtyVer = 0;
    } catch (e) {
      // 保留脏状态：下次 saveDoc / flushAll 会重试；向上传播给链上等待方
      console.error(`[Gloss] 写盘失败 ${state.path}（保留脏状态，将重试）:`, e);
      throw e;
    }
  }

  async addEntry(docPath: string, entry: GlossEntry): Promise<void> {
    const store = await this.loadDoc(docPath);
    const state = this.storeState.get(store);
    if (!state || state.failed) throw new Error("批注文件不可写，已保留原文件");
    const existing = store.entries.findIndex(e => e.note.id === entry.note.id);
    if (existing >= 0) store.entries[existing] = entry;
    else store.entries.push(entry);
    if (!this.saveStore(store)) throw new Error("批注数据已失效，请重试");
  }

  /**
   * 按 store 对象删除条目（调用方已持有内存对象）。
   * 返回实际删除数：0 表示条目不在该 store 中（如文档刚被重命名、
   * store 已过期），调用方不应再把它当作成功删除。
   */
  async removeEntry(store: GlossDocStore, noteId: string): Promise<number> {
    const state = this.storeState.get(store);
    const current = state?.store;
    if (!current || state?.failed) return 0;
    const before = current.entries.length;
    current.entries = current.entries.filter((e) => e.note.id !== noteId);
    const removed = before - current.entries.length;
    if (removed > 0) this.saveStore(current);
    return removed;
  }

  /** 串行迁移。保存/加载等待整批迁移，旧对象在提交后仍指向同一状态。 */
  migrateDoc(oldPath: string, newPath: string): Promise<boolean> {
    if (oldPath === newPath) return Promise.resolve(true);
    const task = this.migrations.then(() => this.migrateNow(oldPath, newPath));
    const barrier = task.then(() => undefined, () => undefined);
    this.migrations = barrier;
    this.migrationBarrier = barrier;
    void barrier.then(() => {
      if (this.migrationBarrier === barrier) this.migrationBarrier = null;
    });
    return task;
  }

  private async migrateNow(oldPath: string, newPath: string): Promise<boolean> {
    try {
      const source = await this.loadState(oldPath);
      const sourceState = this.docs.get(oldPath)!;
      if (!source.entries.length && !sourceState.dirtyVer && sourceState.baseline === null && !sourceState.failed) return true;
      const target = await this.loadState(newPath);
      const state = this.docs.get(oldPath)!;
      const other = this.docs.get(newPath)!;
      if (state.failed || other.failed) throw new Error("源或目标批注不可读，迁移已取消");
      await this.flushState(state);
      await this.flushState(other);

      // 合并的是当前对象，而非较早的磁盘快照；不把已删除的源条目补回来。
      const ids = new Set(source.entries.map((e) => e.note.id));
      const merged = [...source.entries];
      for (const entry of target.entries) {
        if (!ids.has(entry.note.id)) { merged.push(entry); ids.add(entry.note.id); }
      }
      const ver = state.dirtyVer;
      const targetVer = other.dirtyVer;
      const newJson = this.docJsonPath(newPath);
      const migratedRaw = JSON.stringify({ ...source, entries: merged, docPath: newPath }, null, 2);
      await this.assertUnchanged(this.docJsonPath(oldPath), state.baseline, JSON.stringify(source, null, 2));
      await this.assertUnchanged(newJson, other.baseline, migratedRaw);
      await this.ensureParent(newJson);
      await this.app.vault.adapter.write(newJson, migratedRaw);
      state.baseline = migratedRaw;

      // 只补入目标当前仍存在的条目，不把较早快照中已删除的源条目重新添加。
      const currentIds = new Set(source.entries.map((e) => e.note.id));
      for (const entry of target.entries) {
        if (!currentIds.has(entry.note.id)) { source.entries.push(entry); currentIds.add(entry.note.id); }
      }
      // 新文件写成功即提交，保留已发布 source 对象，附件等晚回调仍可保存。
      if (other.timer) { clearTimeout(other.timer); other.timer = null; }
      this.docs.delete(oldPath);
      state.path = newPath;
      source.docPath = newPath;
      this.docs.set(newPath, state);
      this.storeState.set(target, state);
      if (state.dirtyVer === ver && other.dirtyVer === targetVer) state.dirtyVer = 0;
      else this.armSave(state);
      other.store = null;
      try { await this.app.vault.adapter.remove(this.docJsonPath(oldPath)); }
      catch (error) { console.warn(`[Gloss] 迁移已完成，旧批注副本未能清理：${oldPath}`, error); }
      return true;
    } catch (error) {
      console.error(`[Gloss] 批注迁移失败 ${oldPath} → ${newPath}`, error);
      return false;
    }
  }

  /** 全部文档（批注枚举 / 导出用）；递归枚举，兼容编码路径中的子目录 */
  async listAll(): Promise<Array<{ path: string; store: GlossDocStore }>> {
    const names: string[] = [];
    const walk = async (dir: string, base: string): Promise<void> => {
      let res: { files: string[]; folders: string[] };
      try { res = await this.app.vault.adapter.list(dir); } catch { return; }
      // Obsidian 返回库内路径；提取 basename 后按当前目录递归。
      for (const fRaw of res.files) {
        const f = fRaw.split("/").pop();
        if (f) names.push(base + f);
      }
      for (const foRaw of res.folders) {
        const fo = foRaw.split("/").pop();
        if (fo) await walk(`${dir}/${fo}`, `${base}${fo}/`);
      }
    };
    try { await walk(ANN_DIR, ""); } catch { return []; }
    const paths = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await this.app.vault.adapter.read(`${ANN_DIR}/${name}`));
        if (typeof parsed.docPath === "string" && Array.isArray(parsed.entries)) paths.add(parsed.docPath);
      } catch { /* 原文件保留，单个坏文件不阻塞其他文档 */ }
    }
    for (const [path, state] of this.docs) if (state.store) paths.add(path);
    const out: Array<{ path: string; store: GlossDocStore }> = [];
    for (const path of paths) {
      const store = await this.loadDoc(path);
      if (store.entries.length) out.push({ path, store });
    }
    return out;
  }

  /**
   * .gloss 目录被改动时失效缓存。
   * 有未落盘改动（脏/在途写入）的文档不能直接丢缓存（会丢数据），保留等写盘成功；
   * 自身写入触发的 modify 事件在定时器之后到达，不受影响。
   * 全局失效递增纪元：进行中的 loadDoc 回来时因纪元不符不再入缓存，
   * 避免"失效后旧加载把过期数据重新填回缓存"。
   */
  invalidate(docPath?: string): void {
    if (docPath) {
      const state = this.docs.get(docPath);
      if (!state) return;
      if (this.isBusy(state)) return; // 有未落盘改动的文档不能丢缓存（会丢数据）
      if (state.store) this.storeState.delete(state.store);
      state.store = null;
      state.gen++;
      // 进行中的加载不杀（共享 load 是该状态对象的一部分）：它醒来后因代数不符
      // 自动重读；新的 loadDoc 直接加入同一加载任务，不会产生第二个加载实例
    } else {
      this.invalidEpoch++;
      for (const state of this.docs.values()) {
        if (!this.isBusy(state)) { if (state.store) this.storeState.delete(state.store); state.store = null; state.gen++; }
      }
    }
  }

  /** 同步读取内存缓存（渲染时已 load 过） */
  docCacheFor(docPath: string): GlossDocStore | undefined {
    const state = this.docs.get(docPath);
    return state ? (state.store ?? undefined) : undefined;
  }

  /** 插件卸载前把所有防抖写盘落盘（含类型防抖）；单文档失败不中断其余 */
  async flushAll(): Promise<void> {
    await this.waitForMigrations();
    for (const state of this.docs.values()) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
    if (this.saveTypesTimer) { clearTimeout(this.saveTypesTimer); this.saveTypesTimer = null; }
    for (const state of this.docs.values()) {
      if (state.failed || !state.store) continue;
      try { await this.enqueueWrite(state); }
      catch (e) { console.error(`[Gloss] 卸载写盘失败 ${state.path}:`, e); }
    }
    if (!this.typesFailed) {
      try { await this.writeTypesNow(); }
      catch (e) { console.error("[Gloss] 类型写盘失败:", e); }
    }
  }

  // ---------- 附件 ----------

  async ensureAttachmentsDir(): Promise<string> {
    const folder = (this.plugin?.settings.attachmentsFolder || "gloss-attachments").trim() || "gloss-attachments";
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.adapter.mkdir(folder);
    }
    return folder;
  }

  /** 保存二进制附件，返回库内路径。同名自动加序号，避免覆盖/报错 */
  async saveBinary(baseFolder: string, subId: string, name: string, data: Blob | ArrayBuffer): Promise<string> {
    const dir = `${baseFolder}/${subId}`;
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    let existing = new Set<string>();
    try {
      for (const fRaw of (await this.app.vault.adapter.list(dir)).files) {
        const b = fRaw.split("/").pop();
        if (b) existing.add(b);
      }
    } catch { /* 目录刚建，视为空 */ }
    if (existing.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 1;
      while (existing.has(`${stem} (${i})${ext}`)) i++;
      name = `${stem} (${i})${ext}`;
    }
    const path = `${dir}/${name}`;
    const buf: ArrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
    await this.app.vault.createBinary(path, buf);
    return path;
  }
}
