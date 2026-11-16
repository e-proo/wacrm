import { requireApiKey } from '@/lib/auth/api-context';
export const maxDuration = 60;
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { createBroadcast, BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { enqueueBroadcastDelivery } from '@/lib/whatsapp/broadcast-worker';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return fail('bad_request', 'Request body must be a JSON object', 400);
    const templateName = typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage: typeof body.template_language === 'string' ? body.template_language : null,
      connectionId: typeof body.connection_id === 'string' ? body.connection_id : null,
      recipients: recipients.map((r) => ({ to: typeof r?.to === 'string' ? r.to : '', params: Array.isArray(r?.params) ? r.params : undefined })),
    });
    const queued = await enqueueBroadcastDelivery(ctx.supabase, {
      accountId: ctx.accountId,
      broadcastId: plan.broadcastId,
      headerMediaUrl: typeof body.header_media_url === 'string' ? body.header_media_url : null,
    });
    return ok({ broadcast_id: plan.broadcastId, connection_id: plan.connectionId, provider: plan.provider, status: queued.state, total_recipients: plan.planned.length, accepted: plan.planned.length, rejected: plan.rejected }, 202);
  } catch (err) {
    if (err instanceof BroadcastError) return fail(err.code, err.message, err.status);
    if (err instanceof ContactError) return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}
