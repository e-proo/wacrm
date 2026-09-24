export type PlatformExecutor<TContext, TResult> = (
  ctx: TContext,
  args: Record<string, unknown>,
) => Promise<TResult>

/**
 * Exact-version deterministic dispatcher. New domains register executors here
 * through a domain runtime module instead of adding switch cases to dispatch.ts.
 */
export class ToolExecutorRegistry<TContext, TResult> {
  private readonly handlers = new Map<string, PlatformExecutor<TContext, TResult>>()

  register(input: {
    key: string
    version: number
    executor: PlatformExecutor<TContext, TResult>
  }): this {
    const id = `${input.key}@${input.version}`
    if (this.handlers.has(id)) throw new Error(`Duplicate tool executor: ${id}`)
    this.handlers.set(id, input.executor)
    return this
  }

  has(key: string, version: number): boolean {
    return this.handlers.has(`${key}@${version}`)
  }

  async execute(
    key: string,
    version: number,
    ctx: TContext,
    args: Record<string, unknown>,
  ): Promise<TResult> {
    const executor = this.handlers.get(`${key}@${version}`)
    if (!executor) throw new Error(`TOOL_EXECUTOR_NOT_REGISTERED:${key}@${version}`)
    return executor(ctx, args)
  }
}
