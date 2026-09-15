from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(rel: str, replacements: list[tuple[str, str]]) -> None:
    path = ROOT / rel
    text = path.read_text(encoding='utf-8')
    for old, new in replacements:
        if old not in text:
            raise SystemExit(f'missing anchor in {rel}: {old[:160]!r}')
        text = text.replace(old, new, 1)
    path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Agent editor: make provider/model selection deterministic and observable.
# ---------------------------------------------------------------------------
patch('src/components/agents/agent-editor.tsx', [
    (
        """interface ConnectionOption {\n  id: string;\n  name: string;\n  preset_id?: string;\n  status?: string;\n}\n""",
        """interface ConnectionOption {\n  id: string;\n  name: string;\n  preset_id?: string;\n  status?: string;\n}\n\ninterface ProviderModelOption {\n  id: string;\n  displayName?: string;\n  description?: string;\n  contextWindow?: number;\n  maxOutputTokens?: number;\n  capabilities?: {\n    vision?: boolean;\n    toolCalling?: boolean;\n    jsonMode?: boolean;\n  };\n}\n""",
    ),
    (
        """  const [connections, setConnections] = useState<ConnectionOption[]>([]);\n  const [models, setModels] = useState<string[]>([]);\n  const [members, setMembers] = useState<MemberOption[]>([]);\n""",
        """  const [connections, setConnections] = useState<ConnectionOption[]>([]);\n  const [models, setModels] = useState<ProviderModelOption[]>([]);\n  const [modelCatalogState, setModelCatalogState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');\n  const [modelCatalogWarning, setModelCatalogWarning] = useState<string | null>(null);\n  const [members, setMembers] = useState<MemberOption[]>([]);\n""",
    ),
    (
        """  // Model catalog for the selected connection (feature-flagged\n  // multi-provider path — silently absent on legacy deployments).\n  useEffect(() => {\n    if (!fConn) {\n      setModels([]);\n      return;\n    }\n    let cancelled = false;\n    fetch(`/api/ai/connections/${fConn}/models`, { cache: 'no-store' })\n      .then((res) => (res.ok ? res.json() : { models: [] }))\n      .then((json: { models?: Array<{ id?: string; slug?: string }> }) => {\n        if (cancelled) return;\n        setModels((json.models ?? []).map((m) => m.id ?? m.slug ?? '').filter(Boolean));\n      })\n      .catch(() => !cancelled && setModels([]));\n    return () => {\n      cancelled = true;\n    };\n  }, [fConn]);\n""",
        """  // Provider catalogs are informative but not authoritative for an already-saved\n  // draft: providers can temporarily fail or remove an older model from the list.\n  // Preserve that saved value while clearly marking it as unavailable.\n  useEffect(() => {\n    if (!fConn) {\n      setModels([]);\n      setModelCatalogState('idle');\n      setModelCatalogWarning(null);\n      return;\n    }\n    let cancelled = false;\n    setModelCatalogState('loading');\n    setModelCatalogWarning(null);\n    void fetch(`/api/ai/connections/${fConn}/models`, { cache: 'no-store' })\n      .then(async (res) => {\n        const json = (await res.json().catch(() => ({}))) as {\n          models?: ProviderModelOption[];\n          warning?: string;\n          error?: string;\n        };\n        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);\n        return json;\n      })\n      .then((json) => {\n        if (cancelled) return;\n        const unique = new Map<string, ProviderModelOption>();\n        for (const model of json.models ?? []) {\n          if (model && typeof model.id === 'string' && model.id.trim()) unique.set(model.id, model);\n        }\n        setModels([...unique.values()]);\n        setModelCatalogWarning(json.warning ?? null);\n        setModelCatalogState('ready');\n      })\n      .catch(() => {\n        if (cancelled) return;\n        setModels([]);\n        setModelCatalogState('error');\n      });\n    return () => {\n      cancelled = true;\n    };\n  }, [fConn]);\n""",
    ),
    (
        """  async function saveRevision() {\n    setBusy('revision');\n    setNote(null);\n    setActionError(null);\n    try {\n""",
        """  async function saveRevision() {\n    setNote(null);\n    setActionError(null);\n    setChecks(null);\n\n    const normalizedModel = fModel.trim();\n    if (!fConn) {\n      setActionError(getAgentAdminUiText(locale, 'connectionRequired'));\n      return;\n    }\n    if (!normalizedModel) {\n      setActionError(getAgentAdminUiText(locale, 'modelRequiredForSave'));\n      return;\n    }\n    if (!connections.some((connection) => connection.id === fConn)) {\n      setActionError(getAgentAdminUiText(locale, 'connectionUnavailable'));\n      return;\n    }\n\n    setBusy('revision');\n    try {\n""",
    ),
    (
        """          model: fModel,\n          providerConnectionId: fConn || null,\n""",
        """          model: normalizedModel,\n          providerConnectionId: fConn,\n""",
    ),
    (
        """      setRevision(json.revision);\n      setActionError(null);\n      setNote(t('savedRevision'));\n""",
        """      setRevision(json.revision);\n      setFConn(json.revision.provider_connection_id ?? '');\n      setFModel(json.revision.model ?? '');\n      setActionError(null);\n      setNote(t('savedRevision'));\n""",
    ),
    (
        """  const toggleTool = (tool: RegistryTool, on: boolean) => {\n""",
        """  const selectedConnection = connections.find((connection) => connection.id === fConn);\n  const selectedModel = models.find((model) => model.id === fModel);\n  const savedModelMissingFromCatalog = Boolean(\n    fModel &&\n    revision.provider_connection_id === fConn &&\n    revision.model === fModel &&\n    modelCatalogState === 'ready' &&\n    !selectedModel,\n  );\n  const selectedConnectionInactive = Boolean(\n    selectedConnection?.status && !['active', 'verified'].includes(selectedConnection.status),\n  );\n\n  const toggleTool = (tool: RegistryTool, on: boolean) => {\n""",
    ),
    (
        """          <div className=\"grid grid-cols-1 gap-3 md:grid-cols-4\">\n            {connections.length > 0 ? (\n              <L label={t('providerConnection')}>\n                <select className=\"w-full rounded border bg-background px-2 py-1.5 text-sm\" value={fConn} onChange={(e) => setFConn(e.target.value)}>\n                  <option value=\"\">—</option>\n                  {connections.map((c) => (\n                    <option key={c.id} value={c.id}>{c.name}</option>\n                  ))}\n                </select>\n              </L>\n            ) : null}\n            <L label={t('model')}>\n              <Input\n                value={fModel}\n                onChange={(e) => setFModel(e.target.value)}\n                list={models.length > 0 ? 'agent-models' : undefined}\n              />\n              {models.length > 0 ? (\n                <datalist id=\"agent-models\">\n                  {models.map((m) => <option key={m} value={m} />)}\n                </datalist>\n              ) : null}\n            </L>\n""",
        """          <div className=\"rounded-lg border bg-muted/10 p-3\">\n            <p className=\"mb-3 text-xs text-muted-foreground\">\n              {getAgentAdminUiText(locale, 'providerModelHelp')}\n            </p>\n            <div className=\"grid grid-cols-1 gap-3 md:grid-cols-2\">\n              <L label={t('providerConnection')}>\n                <select\n                  className=\"w-full rounded border bg-background px-2 py-2 text-sm\"\n                  value={fConn}\n                  onChange={(e) => {\n                    const nextConnection = e.target.value;\n                    setFConn(nextConnection);\n                    setFModel(nextConnection === revision.provider_connection_id ? (revision.model ?? '') : '');\n                    setActionError(null);\n                  }}\n                >\n                  <option value=\"\">{getAgentAdminUiText(locale, 'selectConnection')}</option>\n                  {connections.map((connection) => (\n                    <option key={connection.id} value={connection.id}>\n                      {connection.name}{connection.status ? ` — ${connection.status}` : ''}\n                    </option>\n                  ))}\n                </select>\n                {connections.length === 0 ? (\n                  <p className=\"text-xs text-destructive\">{getAgentAdminUiText(locale, 'noConnections')}</p>\n                ) : null}\n                {selectedConnectionInactive ? (\n                  <p className=\"text-xs text-amber-700\">{getAgentAdminUiText(locale, 'connectionInactive')}</p>\n                ) : null}\n              </L>\n              <L label={t('model')}>\n                <select\n                  className=\"w-full rounded border bg-background px-2 py-2 text-sm disabled:opacity-60\"\n                  value={fModel}\n                  disabled={!fConn || modelCatalogState === 'loading'}\n                  onChange={(e) => { setFModel(e.target.value); setActionError(null); }}\n                >\n                  <option value=\"\">\n                    {modelCatalogState === 'loading'\n                      ? getAgentAdminUiText(locale, 'loadingModels')\n                      : getAgentAdminUiText(locale, 'selectModel')}\n                  </option>\n                  {fModel && !models.some((model) => model.id === fModel) ? (\n                    <option value={fModel}>\n                      {fModel} — {getAgentAdminUiText(locale, 'savedModelLabel')}\n                    </option>\n                  ) : null}\n                  {models.map((model) => (\n                    <option key={model.id} value={model.id}>\n                      {model.displayName && model.displayName !== model.id\n                        ? `${model.displayName} — ${model.id}`\n                        : model.id}\n                    </option>\n                  ))}\n                </select>\n                {modelCatalogState === 'error' ? (\n                  <p className=\"text-xs text-destructive\">{getAgentAdminUiText(locale, 'modelCatalogUnavailable')}</p>\n                ) : null}\n                {savedModelMissingFromCatalog ? (\n                  <p className=\"text-xs text-amber-700\">{getAgentAdminUiText(locale, 'savedModelUnavailable')}</p>\n                ) : null}\n                {modelCatalogWarning ? <p className=\"text-xs text-amber-700\">{modelCatalogWarning}</p> : null}\n                {selectedModel?.description ? (\n                  <p className=\"text-xs text-muted-foreground\">{selectedModel.description}</p>\n                ) : null}\n              </L>\n            </div>\n          </div>\n          <div className=\"grid grid-cols-1 gap-3 md:grid-cols-4\">\n""",
    ),
    (
        """          <Button size=\"sm\" variant=\"outline\" disabled={busy === 'revision'} onClick={() => void saveRevision()}>\n""",
        """          <Button type=\"button\" size=\"sm\" variant=\"outline\" disabled={busy === 'revision'} onClick={() => void saveRevision()}>\n""",
    ),
])

# ---------------------------------------------------------------------------
# Revision API: keep provider + model as one coherent, account-bound pair.
# ---------------------------------------------------------------------------
patch('src/app/api/ai-agents/[id]/revisions/[revisionId]/route.ts', [
    (
        ".select('id, status')",
        ".select('id, status, provider_connection_id, model')",
    ),
    (
        """    const { conflict } = await loadDraft(ctx, id, revisionId)\n    if (conflict) return conflict\n\n    let body: UpdateBody\n""",
        """    const { revision: draftRevision, conflict } = await loadDraft(ctx, id, revisionId)\n    if (conflict) return conflict\n\n    let body: UpdateBody\n""",
    ),
    (
        """    const update: Record<string, unknown> = {}\n""",
        """    const current = draftRevision as { provider_connection_id: string | null; model: string | null }\n    const effectiveConnectionId = body.providerConnectionId !== undefined\n      ? (body.providerConnectionId === '' ? null : body.providerConnectionId)\n      : current.provider_connection_id\n    const effectiveModel = body.model !== undefined\n      ? (body.model ?? '').trim().slice(0, 120)\n      : (current.model ?? '').trim()\n\n    if (!effectiveConnectionId && effectiveModel) {\n      return NextResponse.json(\n        { error: 'A provider connection is required when a model is selected.', code: 'PROVIDER_CONNECTION_REQUIRED' },\n        { status: 400 },\n      )\n    }\n    if (effectiveConnectionId && !effectiveModel) {\n      return NextResponse.json(\n        { error: 'A model is required for the selected provider connection.', code: 'MODEL_REQUIRED' },\n        { status: 400 },\n      )\n    }\n    if (effectiveConnectionId) {\n      const { data: connection, error: connectionError } = await ctx.supabase\n        .from('ai_provider_connections')\n        .select('id')\n        .eq('account_id', ctx.accountId)\n        .eq('id', effectiveConnectionId)\n        .maybeSingle()\n      if (connectionError) throw connectionError\n      if (!connection) {\n        return NextResponse.json(\n          { error: 'Provider connection not found in this account.', code: 'CONNECTION_NOT_FOUND' },\n          { status: 400 },\n        )\n      }\n    }\n\n    const update: Record<string, unknown> = {}\n""",
    ),
])

# ---------------------------------------------------------------------------
# Publish validator: report provider problems before the atomic publish RPC.
# ---------------------------------------------------------------------------
patch('src/lib/ai/runtime/builder-service.ts', [
    (
        """  const [agentRes, revisionRes, grantsRes, routesRes, identitiesRes, budgetsRes] =\n    await Promise.all([\n      db.from('ai_agents').select('id, status, published_revision_id').eq('account_id', accountId).eq('id', agentId).maybeSingle(),\n      db.from('ai_agent_revisions').select('id, agent_id, status, provider_connection_id, model, max_tool_rounds').eq('account_id', accountId).eq('id', revisionId).maybeSingle(),\n      db.from('ai_agent_tool_grants')""",
        """  const [agentRes, revisionRes, connectionsRes, grantsRes, routesRes, identitiesRes, budgetsRes] =\n    await Promise.all([\n      db.from('ai_agents').select('id, status, published_revision_id').eq('account_id', accountId).eq('id', agentId).maybeSingle(),\n      db.from('ai_agent_revisions').select('id, agent_id, status, provider_connection_id, model, max_tool_rounds').eq('account_id', accountId).eq('id', revisionId).maybeSingle(),\n      db.from('ai_provider_connections').select('id, status').eq('account_id', accountId),\n      db.from('ai_agent_tool_grants')""",
    ),
    (
        """  if (revisionRes.error) throw revisionRes.error\n  if (grantsRes.error) throw grantsRes.error\n""",
        """  if (revisionRes.error) throw revisionRes.error\n  if (connectionsRes.error) throw connectionsRes.error\n  if (grantsRes.error) throw grantsRes.error\n""",
    ),
    (
        """  const revision = revisionRes.data as { status: string; model: string; max_tool_rounds: number } | null\n""",
        """  const revision = revisionRes.data as { status: string; provider_connection_id: string | null; model: string; max_tool_rounds: number } | null\n  const selectedConnection = revision?.provider_connection_id\n    ? (connectionsRes.data ?? []).find((row) => row.id === revision.provider_connection_id)\n    : null\n""",
    ),
    (
        """  if (revision && revision.status !== 'draft') checks.push({ path: 'revision.status', code: 'REVISION_NOT_DRAFT', message: 'Only draft revisions can be published.', severity: 'error' })\n  if (revision && !revision.model.trim()) checks.push({ path: 'revision.model', code: 'MODEL_REQUIRED', message: 'A model is required.', severity: 'error' })\n""",
        """  if (revision && revision.status !== 'draft') checks.push({ path: 'revision.status', code: 'REVISION_NOT_DRAFT', message: 'Only draft revisions can be published.', severity: 'error' })\n  if (revision && !revision.provider_connection_id) checks.push({ path: 'revision.provider_connection_id', code: 'PROVIDER_CONNECTION_REQUIRED', message: 'A provider connection is required.', severity: 'error' })\n  if (revision?.provider_connection_id && !selectedConnection) checks.push({ path: 'revision.provider_connection_id', code: 'CONNECTION_NOT_FOUND', message: 'The selected provider connection no longer exists in this account.', severity: 'error' })\n  if (selectedConnection && !['active', 'verified'].includes(selectedConnection.status)) checks.push({ path: 'revision.provider_connection_id', code: 'CONNECTION_NOT_ACTIVE', message: 'The selected provider connection is not active.', severity: 'error' })\n  if (revision && !revision.model.trim()) checks.push({ path: 'revision.model', code: 'MODEL_REQUIRED', message: 'A model is required.', severity: 'error' })\n""",
    ),
])

# ---------------------------------------------------------------------------
# Translation map: explicit Arabic/English diagnostics for both surfaces.
# ---------------------------------------------------------------------------
patch('src/lib/ai/ui/agent-admin-i18n.ts', [
    (
        """    acceptedByMeta: 'Accepted by Meta',\n""",
        """    acceptedByMeta: 'Accepted by Meta',\n    verificationSuccess: 'Trusted admin number verified and activated.',\n    otpSixDigits: 'Enter the 6-digit verification code.',\n    otpExpiresHint: 'The code expires after 10 minutes and is locked after repeated incorrect attempts.',\n    continueVerification: 'Enter verification code',\n    providerModelHelp: 'Choose the provider connection first, then choose a model from that connection. The saved model remains visible if a provider catalog is temporarily unavailable.',\n    selectConnection: 'Choose provider connection',\n    selectModel: 'Choose model',\n    loadingModels: 'Loading models…',\n    noConnections: 'No AI provider connections are available. Configure a connection first.',\n    modelCatalogUnavailable: 'Could not load the model catalog for this connection. A previously saved model is preserved, but do not switch models until the catalog loads.',\n    savedModelUnavailable: 'This is the model saved on the draft, but it is not present in the provider catalog right now. Verify the provider before publishing.',\n    savedModelLabel: 'saved on draft',\n    connectionInactive: 'This provider connection is not active. You may save the draft, but publishing will be blocked until the connection is active.',\n    connectionRequired: 'Choose a provider connection before saving the agent settings.',\n    modelRequiredForSave: 'Choose a model for the selected provider connection before saving.',\n    connectionUnavailable: 'The selected provider connection is no longer available in this account. Reload the editor and choose another connection.',\n""",
    ),
    (
        """    acceptedByMeta: 'قبلته Meta',\n""",
        """    acceptedByMeta: 'قبلته Meta',\n    verificationSuccess: 'تم التحقق من الرقم الإداري وتفعيله بنجاح.',\n    otpSixDigits: 'أدخل رمز التحقق المكوّن من 6 أرقام.',\n    otpExpiresHint: 'تنتهي صلاحية الرمز بعد 10 دقائق، ويُقفل بعد تكرار المحاولات الخاطئة.',\n    continueVerification: 'إدخال رمز التحقق',\n    providerModelHelp: 'اختر اتصال مزود الذكاء الاصطناعي أولًا، ثم اختر نموذجًا من كتالوج ذلك الاتصال. يبقى النموذج المحفوظ ظاهرًا إذا تعذر تحميل الكتالوج مؤقتًا.',\n    selectConnection: 'اختر اتصال المزود',\n    selectModel: 'اختر النموذج',\n    loadingModels: 'جارٍ تحميل النماذج…',\n    noConnections: 'لا توجد اتصالات مزود ذكاء اصطناعي متاحة. أضف اتصالًا أولًا.',\n    modelCatalogUnavailable: 'تعذّر تحميل كتالوج النماذج لهذا الاتصال. سيبقى النموذج المحفوظ محفوظًا، لكن لا تغيّر النموذج حتى ينجح تحميل الكتالوج.',\n    savedModelUnavailable: 'هذا هو النموذج المحفوظ في المسودة لكنه غير موجود حاليًا في كتالوج المزود. تحقّق من المزود قبل النشر.',\n    savedModelLabel: 'المحفوظ في المسودة',\n    connectionInactive: 'اتصال المزود غير نشط. يمكنك حفظ المسودة، لكن سيُمنع النشر حتى يصبح الاتصال نشطًا.',\n    connectionRequired: 'اختر اتصال مزود الذكاء الاصطناعي قبل حفظ إعدادات الوكيل.',\n    modelRequiredForSave: 'اختر نموذجًا للاتصال المحدد قبل حفظ إعدادات الوكيل.',\n    connectionUnavailable: 'اتصال المزود المحدد لم يعد متاحًا في هذا الحساب. أعد تحميل المحرر واختر اتصالًا آخر.',\n""",
    ),
    (
        """    REVISION_NOT_DRAFT: 'This revision is no longer a draft. Reload the agent editor.',\n""",
        """    REVISION_NOT_DRAFT: 'This revision is no longer a draft. Reload the agent editor.',\n    PROVIDER_CONNECTION_REQUIRED: 'Choose an AI provider connection before saving.',\n    MODEL_REQUIRED: 'Choose a model before saving.',\n    CONNECTION_NOT_FOUND: 'The selected AI provider connection does not belong to this account or no longer exists.',\n""",
    ),
    (
        """    REVISION_NOT_DRAFT: 'هذه النسخة لم تعد مسودة. حدّث محرر الوكيل.',\n""",
        """    REVISION_NOT_DRAFT: 'هذه النسخة لم تعد مسودة. حدّث محرر الوكيل.',\n    PROVIDER_CONNECTION_REQUIRED: 'اختر اتصال مزود ذكاء اصطناعي قبل الحفظ.',\n    MODEL_REQUIRED: 'اختر نموذجًا قبل الحفظ.',\n    CONNECTION_NOT_FOUND: 'اتصال مزود الذكاء الاصطناعي المحدد لا ينتمي لهذا الحساب أو لم يعد موجودًا.',\n""",
    ),
    (
        """    REVISION_NOT_DRAFT: 'Only a draft revision can be published.',\n    MODEL_REQUIRED: 'Choose a model before publishing.',\n""",
        """    REVISION_NOT_DRAFT: 'Only a draft revision can be published.',\n    PROVIDER_CONNECTION_REQUIRED: 'Choose an AI provider connection before publishing.',\n    CONNECTION_NOT_FOUND: 'The selected AI provider connection no longer exists in this account.',\n    CONNECTION_NOT_ACTIVE: 'The selected AI provider connection is not active. Test or repair the connection before publishing.',\n    MODEL_REQUIRED: 'Choose a model before publishing.',\n""",
    ),
    (
        """    REVISION_NOT_DRAFT: 'لا يمكن نشر إلا نسخة بحالة مسودة.',\n    MODEL_REQUIRED: 'اختر نموذج الذكاء الاصطناعي قبل النشر.',\n""",
        """    REVISION_NOT_DRAFT: 'لا يمكن نشر إلا نسخة بحالة مسودة.',\n    PROVIDER_CONNECTION_REQUIRED: 'اختر اتصال مزود ذكاء اصطناعي قبل النشر.',\n    CONNECTION_NOT_FOUND: 'اتصال مزود الذكاء الاصطناعي المحدد لم يعد موجودًا في هذا الحساب.',\n    CONNECTION_NOT_ACTIVE: 'اتصال مزود الذكاء الاصطناعي المحدد غير نشط. اختبر الاتصال أو أصلحه قبل النشر.',\n    MODEL_REQUIRED: 'اختر نموذج الذكاء الاصطناعي قبل النشر.',\n""",
    ),
    (
        """    VERIFY_CONFLICT: 'The verification state changed. Reload and try again.',\n""",
        """    VERIFY_CONFLICT: 'The verification state changed. Reload and try again.',\n    VERIFY_FAILED: 'The verification request could not be completed.',\n    TRUSTED_ADMIN_CRYPTO_UNAVAILABLE: 'Trusted-admin verification is not ready in the database. Apply migration 068, then retry.',\n""",
    ),
    (
        """    VERIFY_CONFLICT: 'تغيرت حالة التحقق. حدّث الصفحة وحاول مرة أخرى.',\n""",
        """    VERIFY_CONFLICT: 'تغيرت حالة التحقق. حدّث الصفحة وحاول مرة أخرى.',\n    VERIFY_FAILED: 'تعذّر إكمال عملية التحقق.',\n    TRUSTED_ADMIN_CRYPTO_UNAVAILABLE: 'التحقق من الأرقام الإدارية غير جاهز في قاعدة البيانات. طبّق migration 068 ثم أعد المحاولة.',\n""",
    ),
])

# ---------------------------------------------------------------------------
# Trusted-admin panel: six-digit UX, global feedback, resume pending OTP.
# ---------------------------------------------------------------------------
patch('src/components/agents/trusted-admins-panel.tsx', [
    (
        """  const [busy, setBusy] = useState<string | null>(null);\n  const [error, setError] = useState<string | null>(null);\n""",
        """  const [busy, setBusy] = useState<string | null>(null);\n  const [error, setError] = useState<string | null>(null);\n  const [success, setSuccess] = useState<string | null>(null);\n""",
    ),
    (
        """    setError(null);\n    setBusy(resend ? 'resend' : 'register');\n""",
        """    setError(null);\n    setSuccess(null);\n    setBusy(resend ? 'resend' : 'register');\n""",
    ),
    (
        """  async function verify(id: string) {\n    setError(null);\n    setBusy(id);\n""",
        """  async function verify(id: string) {\n    setError(null);\n    setSuccess(null);\n    if (!/^\\d{6}$/.test(otp)) {\n      setError(getAgentAdminUiText(locale, 'otpSixDigits'));\n      return;\n    }\n    setBusy(id);\n""",
    ),
    (
        """      setOtp('');\n      setPendingOtpFor(null);\n      setDelivery(null);\n      await load();\n""",
        """      setOtp('');\n      setPendingOtpFor(null);\n      setDelivery(null);\n      await load();\n      setSuccess(getAgentAdminUiText(locale, 'verificationSuccess'));\n""",
    ),
    (
        """    <div className=\"space-y-6\">\n      <Card>\n""",
        """    <div className=\"space-y-6\">\n      {error ? (\n        <div role=\"alert\" aria-live=\"assertive\" className=\"flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive\">\n          <AlertCircle className=\"mt-0.5 h-4 w-4 shrink-0\" /><span>{error}</span>\n        </div>\n      ) : null}\n      {success ? (\n        <div role=\"status\" aria-live=\"polite\" className=\"rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm\">\n          {success}\n        </div>\n      ) : null}\n      <Card>\n""",
    ),
    (
        """          {error ? (\n            <div role=\"alert\" className=\"flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive\">\n              <AlertCircle className=\"mt-0.5 h-4 w-4 shrink-0\" /><span>{error}</span>\n            </div>\n          ) : null}\n""",
        """""",
    ),
    (
        """                <Input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\\D/g, '').slice(0, 8))} inputMode=\"numeric\" dir=\"ltr\" />\n""",
        """                <Input\n                  value={otp}\n                  onChange={(e) => { setOtp(e.target.value.replace(/\\D/g, '').slice(0, 6)); setError(null); }}\n                  inputMode=\"numeric\"\n                  autoComplete=\"one-time-code\"\n                  maxLength={6}\n                  pattern=\"[0-9]{6}\"\n                  placeholder=\"000000\"\n                  dir=\"ltr\"\n                />\n                <p className=\"text-xs text-muted-foreground\">{getAgentAdminUiText(locale, 'otpExpiresHint')}</p>\n""",
    ),
    (
        """              <Button onClick={() => void verify(pendingOtpFor.id)} disabled={busy === pendingOtpFor.id || !otp.trim()}>\n""",
        """              <Button type=\"button\" onClick={() => void verify(pendingOtpFor.id)} disabled={busy === pendingOtpFor.id || otp.length !== 6}>\n""",
    ),
    (
        """          <Button onClick={() => void register()} disabled={busy === 'register' || !phone}>\n""",
        """          <Button type=\"button\" onClick={() => void register()} disabled={busy === 'register' || !phone}>\n""",
    ),
    (
        """                  {identity.status !== 'revoked' ? (\n                    <Button size=\"sm\" variant=\"outline\" disabled={busy === identity.id} onClick={() => void revoke(identity.id)}>\n                      {busy === identity.id ? <Loader2 className=\"me-1.5 h-4 w-4 animate-spin\" /> : <ShieldOff className=\"me-1.5 h-4 w-4\" />}\n                      {t('trustedAdmins.revoke')}\n                    </Button>\n                  ) : <ShieldCheck className=\"h-4 w-4 text-muted-foreground\" />}\n""",
        """                  {identity.status === 'pending_verification' ? (\n                    <Button\n                      type=\"button\"\n                      size=\"sm\"\n                      variant=\"outline\"\n                      onClick={() => {\n                        setPendingOtpFor({ id: identity.id, phone: identity.normalized_address.startsWith('+') ? identity.normalized_address : `+${identity.normalized_address}`, displayName: identity.display_name });\n                        setOtp('');\n                        setError(null);\n                        setSuccess(null);\n                      }}\n                    >\n                      <ShieldCheck className=\"me-1.5 h-4 w-4\" />\n                      {getAgentAdminUiText(locale, 'continueVerification')}\n                    </Button>\n                  ) : null}\n                  {identity.status !== 'revoked' ? (\n                    <Button type=\"button\" size=\"sm\" variant=\"outline\" disabled={busy === identity.id} onClick={() => void revoke(identity.id)}>\n                      {busy === identity.id ? <Loader2 className=\"me-1.5 h-4 w-4 animate-spin\" /> : <ShieldOff className=\"me-1.5 h-4 w-4\" />}\n                      {t('trustedAdmins.revoke')}\n                    </Button>\n                  ) : <ShieldCheck className=\"h-4 w-4 text-muted-foreground\" />}\n""",
    ),
])

print('admin/agent hardening patch applied')
