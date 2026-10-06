import { listChangeRequests } from '@/lib/ai/runtime/change-requests-service'
import type { ToolContext, ToolResult } from '@/lib/ai/tools/executors'
import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'

export async function executeChangeRequestsListPending(
  ctx: ToolContext,
  args: { limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    const rows = await listChangeRequests(ctx.accountId, {
      status: 'pending',
      limit: Math.min(args.limit ?? 20, 100),
    })
    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        target_type: row.target_type,
        target_id: row.target_id,
        intent: row.intent,
        summary: row.summary,
        proposed_payload: row.proposed_payload,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] pending changes read failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'CHANGE_REQUEST_READ_FAILED',
      message: 'Could not read pending changes.',
    }
  }
}

export const CHANGE_REQUEST_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'change_requests.list_pending',
    version: 1,
    executor: (ctx, args) => executeChangeRequestsListPending(ctx, args as never),
  },
]
