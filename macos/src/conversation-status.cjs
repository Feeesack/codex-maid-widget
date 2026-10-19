'use strict';
const { displayText, workspaceDisplay } = require('./conversation-display.cjs');

// This service has no watcher, schedule or startup reads. Only an explicit
// trusted UI request may resolve the automatic/manual target and cwd.
class ConversationStatus {
  constructor(options = {}) {
    this.resolveSelected = options.resolveSelected || (async () => ({ status: 'unavailable' }));
    this.readContext = options.readContext || (async () => ({ status: 'unavailable' }));
    this.readCompactions = options.readCompactions || (async () => ({ status: 'unavailable' }));
    this.readProject = options.readProject || (async cwd => workspaceDisplay(cwd));
    this.readGit = options.readGit || (cwd => require('./git-status.cjs').readGitStatus(cwd));
    this.now = options.now || (() => performance.now());
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 5000) : 2500;
    this.pending = null;
    this.generation = 0;
  }

  invalidate() { this.generation++; this.pending = null; }

  read() {
    if (this.pending) return this.pending;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable', reason: '读取超时，请重试',
      context: { status: 'unavailable', reason: '读取超时，请重试' },
      compaction: { status: 'unavailable', reason: '读取超时，请重试' },
      git: { status: 'timeout', reason: '读取超时，请重试' }, elapsedMs: this.timeoutMs }), this.timeoutMs); });
    const request = Promise.race([this.inspect(), deadline]).finally(() => {
      clearTimeout(timer);
      if (this.pending === request) this.pending = null;
    });
    this.pending = request;
    return request;
  }

  async inspect() {
    const started = this.now();
    const generation = this.generation;
    let selectionMode;
    const unavailable = reason => ({ status: 'unavailable', reason,
      context: { status: 'unavailable', reason }, git: { status: 'unavailable', reason },
      compaction: { status: 'unavailable', reason },
      ...(selectionMode ? { selectionMode } : {}),
      elapsedMs: Math.max(0, Math.round(this.now() - started)) });
    let selected;
    try { selected = await this.resolveSelected(); } catch { /* Only fixed errors leave this service. */ }
    selectionMode = selected?.selectionMode === 'auto' ? 'auto' : selected?.selectionMode === 'manual' ? 'manual' : undefined;
    if (selected?.status !== 'ready' || typeof selected.threadId !== 'string' || !selected.threadId) {
      return unavailable(selectionMode === 'auto' ? '未识别当前对话，可手动选择' : '请先选择要查看的对话');
    }
    const [contextResult, gitResult, compactionResult, projectResult] = await Promise.allSettled([
      Promise.resolve().then(() => this.readContext(selected)),
      Promise.resolve().then(() => typeof selected.cwd === 'string' && selected.cwd
        ? this.readGit(selected.cwd) : { status: 'unavailable', reason: '当前对话没有本地工作区' }),
      Promise.resolve().then(() => this.readCompactions(selected)),
      Promise.resolve().then(() => this.readProject(selected.cwd, selected.threadId)),
    ]);
    let current;
    try { current = await this.resolveSelected(); } catch { /* Treat a lost selection as a switch. */ }
    if (generation !== this.generation || current?.status !== 'ready' || current.threadId !== selected.threadId || current.cwd !== selected.cwd ||
        current.rolloutPath !== selected.rolloutPath || current.selectionMode !== selected.selectionMode ||
        current.selectionRevision !== selected.selectionRevision) {
      return unavailable('对话已切换，请再点一次');
    }
    const context = contextResult.status === 'fulfilled' ? contextResult.value : null;
    const git = gitResult.status === 'fulfilled' ? gitResult.value : null;
    const compaction = compactionResult.status === 'fulfilled' ? compactionResult.value : null;
    // Only fixed metrics and explicitly requested display metadata reach the
    // trusted renderer. The local control/MCP tools never expose this response.
    const safeContext = context?.status === 'ready'
      && Number.isSafeInteger(context.usedTokens) && context.usedTokens >= 0
      && Number.isSafeInteger(context.windowTokens) && context.windowTokens > 0
      ? { status: 'ready', usedTokens: context.usedTokens, windowTokens: context.windowTokens,
        percent: Math.max(0, Math.min(100, context.usedTokens / context.windowTokens * 100)) }
      : { status: 'unavailable', reason: '暂无所选对话的上下文数据' };
    const safeGit = git?.status === 'ready' && Number.isSafeInteger(git.count) && git.count >= 0
      ? { status: 'ready', count: git.count }
      : git?.status === 'not-repository' ? { status: 'not-repository', reason: '非 Git 工作区' }
        : git?.status === 'timeout' ? { status: 'timeout', reason: 'Git 读取超时，请重试' }
          : { status: 'unavailable', reason: '暂时无法读取工作区 Git 状态' };
    const title = displayText(current.title);
    const fallbackProject = workspaceDisplay(current.cwd);
    const project = projectResult.status === 'fulfilled' ? projectResult.value : null;
    const projectLabel = displayText(project?.label) || fallbackProject.label;
    const projectDetail = displayText(project?.detail, 2048) || fallbackProject.detail;
    const safeCompaction = compaction?.status === 'ready' && Number.isSafeInteger(compaction.count) && compaction.count >= 0 && typeof compaction.complete === 'boolean'
      ? { status: 'ready', count: compaction.count, complete: compaction.complete,
        ...(!compaction.complete && compaction.incompleteReason === 'legacy-records' ? { incompleteReason: 'legacy-records' } : {}) }
      : { status: 'unavailable', reason: '暂无所选对话的压缩记录' };
    return { status: 'ready', context: safeContext, git: safeGit, compaction: safeCompaction,
      ...(selectionMode ? { selectionMode } : {}), ...(title ? { targetTitle: title } : {}),
      ...(projectLabel ? { targetProject: projectLabel } : {}), ...(projectDetail ? { targetProjectDetail: projectDetail } : {}),
      elapsedMs: Math.max(0, Math.round(this.now() - started)) };
  }
}

module.exports = { ConversationStatus };
