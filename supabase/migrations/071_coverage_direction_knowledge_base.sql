-- ============================================================
-- 071_coverage_direction_knowledge_base.sql
-- Seed a reviewable, account-owned KB reference for the canonical
-- domestic Yemen coverage rule.
--
-- IMPORTANT: the business rule is already enforced in application code,
-- tool contracts and migration 069 DB guards. This KB exists so humans and
-- RAG agents share the same documented terminology; correctness never relies
-- on retrieval alone.
--
-- The document starts as DRAFT on purpose. Migration 067 requires knowledge
-- to follow the account's human review lifecycle before runtime use. After
-- review, activate the document and assign this KB to a DRAFT agent revision;
-- published revision assignments remain immutable by design.
-- ============================================================

create or replace function public.seed_coverage_direction_knowledge_for_account(
  p_account_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base_id uuid;
  v_document_id uuid;
  v_content text := $knowledge$
قواعد خدمة التغطيات المحلية — اتجاه الشمال والجنوب

المبدأ الأساسي:
تصنيف العملية لا يعتمد على كلمة «راجع» أو «عمولة»، ولا على وسيلة الدفع أو الاستلام. التصنيف يعتمد فقط على مكان دفع العميل ومكان استلام العميل.

1) عرض تغطية — الجنوب إلى الشمال
- العميل يدفع في منطقة من مناطق الجنوب.
- العميل يريد استلام المبلغ في منطقة من مناطق الشمال.
- هذه العملية تسمى «عرض تغطية».
- عمولة التغطية تكون راجعة للعميل؛ أي أن العميل يستفيد من مبلغ العمولة وفق السعر المنشور لكل ألف.
- التعبير «راجع للعميل» يصف أثر العمولة ولا يعني وجود خدمة أو نوع عمولة مستقل.
- مثال: العميل يسلم 100,000 SAR نقدًا في حضرموت ويريدها شبكات في صنعاء. حضرموت جنوب وصنعاء شمال، لذلك هذه عرض تغطية وعمولتها راجعة للعميل.

2) طلب تغطية — الشمال إلى الجنوب
- العميل يدفع في منطقة من مناطق الشمال.
- العميل يريد استلام المبلغ في منطقة من مناطق الجنوب.
- هذه العملية تسمى «طلب تغطية».
- العميل هو من يدفع عمولة التغطية وفق السعر المنشور لكل ألف.
- كلمة «عمولة» هنا تصف أثر نفس عمولة التغطية ولا تعني خدمة مختلفة عن حالة «راجع».

3) وسائل التنفيذ
- وسائل مثل نقد، شبكات، حوالة، وإيداع بنكي تصف رجل الدفع أو رجل الاستلام فقط.
- وسيلة التنفيذ لا تغير كون العملية عرضًا أو طلبًا.
- يجب دائمًا حفظ رجلَي العميل كما قالهما: pay = أين/كيف يدفع العميل، receive = أين/كيف يريد العميل الاستلام. لا يجوز عكسهما لأجل المطابقة.

4) التسعير
- السعر المعلن هو عمولة لكل 1000.
- جنوب→شمال يستخدم سعر تغطية سوق الشمال لأنه سوق الاستلام؛ في لوحة الأسعار الحالية هذا هو north_coverage.
- شمال→جنوب يستخدم سعر تغطية سوق الجنوب لأنه سوق الاستلام؛ في لوحة الأسعار الحالية هذا هو south_coverage.
- مبلغ العمولة = المبلغ × العمولة لكل ألف ÷ 1000.
- لا يجوز اختراع سعر. إذا لم توجد لوحة أسعار حالية منشورة أو كانت خانة التغطية المطلوبة فارغة، يجب التصريح بأن السعر غير منشور بدل إعطاء رقم تقديري.

5) المطابقة
- طلب التغطية القانوني شمال→جنوب يطابق عرض تغطية معاكسًا جنوب→شمال.
- المطابقة تكون بين الرجلين المتقابلتين: منطقة استلام الطلب في الجنوب تقابل منطقة دفع العرض في الجنوب، ومنطقة دفع الطلب في الشمال تقابل منطقة استلام العرض في الشمال.
- السجلات المخزنة في النوع المعاكس لاتجاهها تعد بيانات خاطئة ولا تستخدم كصفقة صحيحة.

6) سير وكيل العملاء
- عند سؤال العميل عن حالة محددة، يجمع: المبلغ، العملة، مكان وطريقة الدفع، مكان وطريقة الاستلام.
- يستدعي coverage.get_rates بهذه الأرجل ليحصل على التصنيف والسعر ومبلغ العمولة الموثوق.
- إذا كانت الحالة جنوب→شمال يشرح أنها عرض تغطية وأن العمولة راجعة للعميل، ثم بعد تأكيد العميل يرسلها عبر coverage.propose_offer للموافقة.
- إذا كانت الحالة شمال→جنوب يشرح أنها طلب تغطية وأن العميل يدفع العمولة، ويمكنه التحقق من العروض المقابلة عبر coverage.find_offers، ثم بعد تأكيد العميل يرسلها عبر coverage.propose_request للموافقة.
- لا يعتبر proposal تنفيذًا نهائيًا قبل مسار الموافقة.
$knowledge$;
begin
  insert into public.ai_knowledge_bases (
    account_id,
    name,
    slug,
    description,
    scope,
    status,
    default_trust_level
  )
  values (
    p_account_id,
    'قواعد خدمة التغطيات',
    'coverage-business-rules',
    'مرجع اتجاه العرض/الطلب واحتساب عمولة التغطيات المحلية. القاعدة مفروضة برمجيًا أيضًا.',
    'shared',
    'active',
    'internal'
  )
  on conflict (account_id, slug) do nothing;

  select id
    into v_base_id
    from public.ai_knowledge_bases
   where account_id = p_account_id
     and slug = 'coverage-business-rules';

  if v_base_id is null then
    return;
  end if;

  select id
    into v_document_id
    from public.ai_knowledge_documents
   where account_id = p_account_id
     and knowledge_base_id = v_base_id
     and source_type = 'integration'
     and source_uri = 'system://coverage/domestic-direction-v1'
   order by created_at asc
   limit 1;

  if v_document_id is null then
    insert into public.ai_knowledge_documents (
      account_id,
      knowledge_base_id,
      title,
      content,
      source_type,
      source_uri,
      lifecycle_status,
      trust_level,
      language,
      injection_risk,
      review_notes
    )
    values (
      p_account_id,
      v_base_id,
      'قواعد اتجاه وعمولة التغطيات المحلية',
      v_content,
      'integration',
      'system://coverage/domestic-direction-v1',
      'draft',
      'internal',
      'ar',
      'none',
      'Seeded from migration 071. Review against the desk policy, then activate and assign to a draft coverage-agent revision.'
    )
    returning id into v_document_id;
  end if;

  -- Seed one lexical chunk so the document is immediately retrievable after
  -- human review/activation. Embedding remains nullable by design.
  if not exists (
    select 1
      from public.ai_knowledge_chunks
     where document_id = v_document_id
       and chunk_index = 0
  ) then
    insert into public.ai_knowledge_chunks (
      document_id,
      account_id,
      chunk_index,
      content
    )
    values (
      v_document_id,
      p_account_id,
      0,
      v_content
    );
  end if;
end;
$$;

revoke all on function public.seed_coverage_direction_knowledge_for_account(uuid) from public;
revoke all on function public.seed_coverage_direction_knowledge_for_account(uuid) from anon;
revoke all on function public.seed_coverage_direction_knowledge_for_account(uuid) from authenticated;
grant execute on function public.seed_coverage_direction_knowledge_for_account(uuid) to service_role;

-- Backfill existing accounts.
do $$
declare
  v_account record;
begin
  for v_account in select id from public.accounts loop
    perform public.seed_coverage_direction_knowledge_for_account(v_account.id);
  end loop;
end $$;

-- Seed future accounts as well. This trigger is independent of the default
-- coverage-service trigger; it does not require a service row to exist.
create or replace function public.trg_seed_coverage_direction_knowledge_on_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.seed_coverage_direction_knowledge_for_account(new.id);
  return new;
end;
$$;

revoke all on function public.trg_seed_coverage_direction_knowledge_on_account() from public;
revoke all on function public.trg_seed_coverage_direction_knowledge_on_account() from anon;
revoke all on function public.trg_seed_coverage_direction_knowledge_on_account() from authenticated;

drop trigger if exists accounts_seed_coverage_direction_knowledge on public.accounts;
create trigger accounts_seed_coverage_direction_knowledge
  after insert on public.accounts
  for each row execute function public.trg_seed_coverage_direction_knowledge_on_account();

comment on function public.seed_coverage_direction_knowledge_for_account(uuid) is
  'Seeds the reviewable account-owned knowledge reference for canonical Yemen coverage direction. Runtime correctness is independently enforced by code/tools/DB guards.';
