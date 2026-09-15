'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  BadgeCheck,
  FlaskConical,
  Loader2,
  Plus,
  Rocket,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { getToolCategoryLabel, getToolPermissionLabel, getToolUiText } from '@/lib/ai/ui/platform-i18n';
// ============================================================
// Agent editor — the production control surface for one agent
// revision (always a DRAFT; published revisions are immutable).
//
//   identity  — name/description (agent row)
//   revision  — model, provider connection, prompt, style,
//               language, temperature, token caps, tool rounds,
//               reply cap, handoff member
//   tools     — registry matrix with per-tool permission
//   budget    — daily/monthly policy (existing budget route)
//   tests     — test cases CRUD + simulated evaluation
//   actions   — validate / simulate / publish / discard draft
// ============================================================

interface RegistryTool {
  key: string;
  version: number;
  description: string;
  category: string;
  grantPermissions: string[];
}

interface GrantRow {
  tool_key: string;
  tool_version: number;
  permission: string;
  constraints: Record<string, unknown>;
}

interface RevisionRow {
  id: string;
  revision_number: number;
  status: string;
  provider_connection_id: string | null;
  model: string;
  system_prompt: string | null;
  response_style: string;
  language_policy: string;
  temperature: number | null;
  max_output_tokens: number | null;
  max_tool_rounds: number;
  max_ai_replies_per_conversation: number;
  handoff_human_member_id: string | null;
}

interface ConnectionOption {
  id: string;
  name: string;
  preset_id?: string;
  status?: string;
}

interface MemberOption {
  user_id: string;
  full_name: string;
  role: string;
}

interface BudgetPolicy {
  period: 'daily' | 'monthly';
  max_runs: number;
  max_input_tokens: number;
  max_output_tokens: number;
  soft_threshold: number;
  hard_action: 'handoff' | 'pause' | 'cheaper_agent';
  fallback_agent_id: string | null;
  is_active: boolean;
}

interface TestCaseRow {
  id: string;
  name: string;
  plane: string;
  input_messages: unknown;
  assertions: unknown;
  is_required: boolean;
}

interface CheckResult {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

interface AgentEditorProps {
  agentId: string;
  revisionId: string;
  agentName: string;
  agentDescription: string | null;
  allAgents: Array<{ id: string; name: string }>;
  onPublished: () => void;
  onChanged: () => void;
  onClose: () => void;
}

export function AgentEditor(props: AgentEditorProps) {
  const t = useTranslations('Agents.agentEditor');
  const locale = useLocale();
  const {
    agentId,
    revisionId,
    agentName,
    agentDescription,
    allAgents,
    onPublished,
    onChanged,
    onClose,
  } = props;

  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState<RevisionRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [registryOk, setRegistryOk] = useState(false);
  const [registry, setRegistry] = useState<RegistryTool[]>([]);
  const [grants, setGrants] = useState<Map<string, { permission: string; constraints: Record<string, unknown> }>>(new Map());
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [policies, setPolicies] = useState<Map<string, BudgetPolicy>>(new Map());
  const [testCases, setTestCases] = useState<TestCaseRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);

  // Save feedback appears at the top of a long card — bring it into
  // view so a "saved" or error note can never be silently missed.
  useEffect(() => {
    if (note) noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [note]);

  // identity form
  const [fName, setFName] = useState(agentName);
  const [fDesc, setFDesc] = useState(agentDescription ?? '');
  // revision form
  const [fModel, setFModel] = useState('');
  const [fConn, setFConn] = useState('');
  const [fPrompt, setFPrompt] = useState('');
  const [fStyle, setFStyle] = useState('balanced');
  const [fLang, setFLang] = useState('auto');
  const [fTemp, setFTemp] = useState('');
  const [fMaxTok, setFMaxTok] = useState('');
  const [fRounds, setFRounds] = useState('0');
  const [fCap, setFCap] = useState('3');
  const [fHandoff, setFHandoff] = useState('');
  // test case form
  const [tcName, setTcName] = useState('');
  const [tcPlane, setTcPlane] = useState('customer');
  const [tcMsg1, setTcMsg1] = useState('');
  const [tcMsg2, setTcMsg2] = useState('');
  const [tcMsg3, setTcMsg3] = useState('');
  const [tcAssert, setTcAssert] = useState('{"tool_must_not_call": [], "must_not_leak": []}');
  const [tcRequired, setTcRequired] = useState(false);
  // budget form
  const [budgetPeriod, setBudgetPeriod] = useState<'daily' | 'monthly'>('daily');
  const [bRuns, setBRuns] = useState('1000');
  const [bInTok, setBInTok] = useState('1000000');
  const [bOutTok, setBOutTok] = useState('500000');
  const [bSoft, setBSoft] = useState('0.8');
  const [bHard, setBHard] = useState('handoff');
  const [bFallback, setBFallback] = useState('');
  const [bActive, setBActive] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setRegistryOk(false);
    const [revRes, toolsRes, connRes, memRes, budgetRes, tcRes] = await Promise.all([
      fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}`, { cache: 'no-store' }).catch(() => null),
      fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}/tools`, { cache: 'no-store' }).catch(() => null),
      fetch('/api/ai/connections', { cache: 'no-store' }).catch(() => null),
      fetch('/api/account/members', { cache: 'no-store' }).catch(() => null),
      fetch(`/api/ai-agents/${agentId}/budget`, { cache: 'no-store' }).catch(() => null),
      fetch(`/api/ai-agents/${agentId}/test-cases`, { cache: 'no-store' }).catch(() => null),
    ]);
    if (revRes?.ok) {
      const json = (await revRes.json()) as { revision: RevisionRow };
      const r = json.revision;
      setRevision(r);
      setFModel(r.model ?? '');
      setFConn(r.provider_connection_id ?? '');
      setFPrompt(r.system_prompt ?? '');
      setFStyle(r.response_style ?? 'balanced');
      setFLang(r.language_policy ?? 'auto');
      setFTemp(r.temperature === null ? '' : String(r.temperature));
      setFMaxTok(r.max_output_tokens === null ? '' : String(r.max_output_tokens));
      setFRounds(String(r.max_tool_rounds ?? 0));
      setFCap(String(r.max_ai_replies_per_conversation ?? 3));
      setFHandoff(r.handoff_human_member_id ?? '');
    } else {
      setLoadFailed(true);
    }
    if (toolsRes?.ok) {
      const json = (await toolsRes.json()) as { registry: RegistryTool[]; grants: GrantRow[] };
      setRegistry(json.registry ?? []);
      const map = new Map<string, { permission: string; constraints: Record<string, unknown> }>();
      for (const g of json.grants ?? []) {
        map.set(g.tool_key, { permission: g.permission, constraints: g.constraints ?? {} });
      }
      setGrants(map);
      setRegistryOk(true);
    }
    const conns: ConnectionOption[] = connRes?.ok ? (await connRes.json()).connections ?? [] : [];
    setConnections(conns);
    if (memRes?.ok) setMembers((await memRes.json()).members ?? []);
    if (budgetRes?.ok) {
      const json = (await budgetRes.json()) as { policies: BudgetPolicy[] };
      const m = new Map<string, BudgetPolicy>();
      for (const p of json.policies ?? []) m.set(p.period, p);
      policiesRef.current = m;
      setPolicies(m);
      applyBudgetFromState(budgetPeriodRef.current, m);
    }
    if (tcRes?.ok) setTestCases((await tcRes.json()).testCases ?? []);
    setLoading(false);
  }, [agentId, revisionId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Model catalog for the selected connection (feature-flagged
  // multi-provider path — silently absent on legacy deployments).
  useEffect(() => {
    if (!fConn) {
      setModels([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/ai/connections/${fConn}/models`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((json: { models?: Array<{ id?: string; slug?: string }> }) => {
        if (cancelled) return;
        setModels((json.models ?? []).map((m) => m.id ?? m.slug ?? '').filter(Boolean));
      })
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [fConn]);

  async function saveIdentity() {
    setBusy('identity');
    setNote(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: fName, description: fDesc }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'save failed');
      setNote(t('savedIdentity'));
      onChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveRevision() {
    setBusy('revision');
    setNote(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: fModel,
          providerConnectionId: fConn || null,
          systemPrompt: fPrompt || null,
          responseStyle: fStyle,
          languagePolicy: fLang,
          temperature: fTemp === '' ? null : Number(fTemp),
          maxOutputTokens: fMaxTok === '' ? null : Number(fMaxTok),
          maxToolRounds: Number(fRounds || 0),
          maxAiRepliesPerConversation: Number(fCap || 3),
          handoffHumanMemberId: fHandoff || null,
        }),
      });
      const json = (await res.json()) as { revision?: RevisionRow; error?: string };
      if (!res.ok || !json.revision) throw new Error(json.error ?? 'save failed');
      setRevision(json.revision);
      setNote(t('savedRevision'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveTools() {
    setBusy('tools');
    setNote(null);
    if (!registryOk) {
      // Never PUT against a failed load — that would silently wipe every grant.
      setBusy(null);
      setNote(t('toolsNotLoaded'));
      return;
    }
    const payload = [...grants.entries()].map(([key, g]) => ({
      tool_key: key,
      permission: g.permission,
      constraints: g.constraints,
    }));
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}/tools`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grants: payload }),
      });
      const json = (await res.json()) as { ok?: boolean; count?: number; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'save failed');
      setNote(t('toolsSaved', { count: json.count ?? 0 }));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveBudget() {
    setBusy('budget');
    setNote(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/budget`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          period: budgetPeriod,
          maxRuns: Number(bRuns),
          maxInputTokens: Number(bInTok),
          maxOutputTokens: Number(bOutTok),
          softThreshold: Number(bSoft),
          hardAction: bHard,
          fallbackAgentId: bFallback || null,
          isActive: bActive,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'save failed');
      const json = (await res.json()) as { policy: BudgetPolicy };
      const next = new Map(policiesRef.current).set(budgetPeriod, json.policy);
      policiesRef.current = next;
      setPolicies(next);
      setNote(t('savedBudget'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  function applyBudgetFromState(period: 'daily' | 'monthly', map?: Map<string, BudgetPolicy>) {
    const p = (map ?? policiesRef.current).get(period);
    // Always fill EVERY field (defaults when the period was never
    // saved). The old "only apply when a policy exists" left the
    // previous period's unsaved numbers in the form after tab
    // switches, and the next save silently wrote THEM as the new
    // period's policy.
    setBRuns(String(p?.max_runs ?? 1000));
    setBInTok(String(p?.max_input_tokens ?? 1000000));
    setBOutTok(String(p?.max_output_tokens ?? 500000));
    setBSoft(String(p?.soft_threshold ?? 0.8));
    setBHard(p?.hard_action ?? 'handoff');
    setBFallback(p?.fallback_agent_id ?? '');
    setBActive(p?.is_active ?? true);
  }

  const policiesRef = useRef<Map<string, BudgetPolicy>>(new Map());
  const budgetPeriodRef = useRef<'daily' | 'monthly'>('daily');

  useEffect(() => {
    // Sync the form ONLY on open and on explicit period switches —
    // `policies` is deliberately not a dep: any policies update
    // (e.g. saving the other tab) must not clobber in-progress
    // edits on this one.
    budgetPeriodRef.current = budgetPeriod;
    applyBudgetFromState(budgetPeriod);
  }, [budgetPeriod]);

  async function addTestCase() {
    let assertions: unknown;
    try {
      assertions = JSON.parse(tcAssert);
    } catch {
      setNote(t('badJson'));
      return;
    }
    const messages = [tcMsg1, tcMsg2, tcMsg3].map((m) => m.trim()).filter(Boolean);
    if (!tcName.trim() || messages.length === 0) return;
    setBusy('testcase');
    setNote(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/test-cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: tcName.trim(),
          plane: tcPlane,
          input_messages: messages,
          assertions,
          is_required: tcRequired,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'add failed');
      setTcName('');
      setTcMsg1('');
      setTcMsg2('');
      setTcMsg3('');
      setTcRequired(false);
      const json = (await (await fetch(`/api/ai-agents/${agentId}/test-cases`)).json()) as {
        testCases: TestCaseRow[];
      };
      setTestCases(json.testCases ?? []);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function removeTestCase(id: string) {
    setBusy(`tc:${id}`);
    setNote(null);
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/test-cases/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'delete failed');
      setTestCases(testCases.filter((c) => c.id !== id));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function runValidate() {
    setBusy('validate');
    setNote(null);
    setChecks(null);
    try {
      const res = await fetch(
        `/api/ai-agents/${agentId}/revisions/${revisionId}/validate`,
        { method: 'POST' },
      );
      const json = (await res.json()) as { ok?: boolean; checks?: CheckResult[] };
      setChecks(json.checks ?? []);
      if (json.ok) setNote(t('validationPassed'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function runSimulate() {
    setBusy('simulate');
    setNote(null);
    try {
      const res = await fetch(
        `/api/ai-agents/${agentId}/revisions/${revisionId}/evaluate`,
        { method: 'POST' },
      );
      const json = (await res.json()) as {
        evaluation?: { status: string; failed_cases: number };
        error?: string;
      };
      if (!res.ok || !json.evaluation) throw new Error(json.error ?? 'evaluate failed');
      setNote(
        `${t('simulateResult')}: ${json.evaluation.status} (${t('failedCases')}: ${json.evaluation.failed_cases})`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy('publish');
    setNote(null);
    try {
      const res = await fetch(
        `/api/ai-agents/${agentId}/revisions/${revisionId}/publish`,
        { method: 'POST' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'publish failed');
      onPublished();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    setBusy('discard');
    try {
      const res = await fetch(`/api/ai-agents/${agentId}/revisions/${revisionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'discard failed');
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading || !revision) {
    if (!loading && loadFailed) {
      return (
        <Card className="border-destructive/40">
          <CardContent className="space-y-3 py-6">
            <p className="text-sm text-destructive">{t('loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => void loadAll()}>
              {t('retry')}
            </Button>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
        </CardContent>
      </Card>
    );
  }

  const toggleTool = (tool: RegistryTool, on: boolean) => {
    setGrants((prev) => {
      const next = new Map(prev);
      if (on) {
        const allowed = tool.grantPermissions[0] ?? 'read';
        next.set(tool.key, prev.get(tool.key) ?? { permission: allowed === 'read' ? 'read' : allowed, constraints: {} });
      } else {
        next.delete(tool.key);
      }
      return next;
    });
  };

  return (
    <Card className="border-primary/40">
      <CardHeader className="flex flex-row items-center gap-3">
        <CardTitle className="text-base">
          {t('title')} — {props.agentName}
          {revision.revision_number > 0 ? (
            <span className="ms-2 text-sm text-muted-foreground">
              {t('revisionN', { number: revision.revision_number })}
            </span>
          ) : null}
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {note ? <p ref={noteRef} className="text-sm">{note}</p> : null}

        {/* identity */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('identity')}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <L label={t('name')}>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} />
            </L>
            <L label={t('description')}>
              <Input value={fDesc} onChange={(e) => setFDesc(e.target.value)} />
            </L>
            <div className="flex items-end">
              <Button size="sm" variant="outline" disabled={busy === 'identity'} onClick={() => void saveIdentity()}>
                {busy === 'identity' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t('saveIdentity')}
              </Button>
            </div>
          </div>
        </section>

        {/* revision settings */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('revisionSettings')}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            {connections.length > 0 ? (
              <L label={t('providerConnection')}>
                <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={fConn} onChange={(e) => setFConn(e.target.value)}>
                  <option value="">—</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </L>
            ) : null}
            <L label={t('model')}>
              <Input
                value={fModel}
                onChange={(e) => setFModel(e.target.value)}
                list={models.length > 0 ? 'agent-models' : undefined}
              />
              {models.length > 0 ? (
                <datalist id="agent-models">
                  {models.map((m) => <option key={m} value={m} />)}
                </datalist>
              ) : null}
            </L>
            <L label={t('responseStyle')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={fStyle} onChange={(e) => setFStyle(e.target.value)}>
                <option value="concise">{t('styleConcise')}</option>
                <option value="balanced">{t('styleBalanced')}</option>
                <option value="detailed">{t('styleDetailed')}</option>
              </select>
            </L>
            <L label={t('languagePolicy')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={fLang} onChange={(e) => setFLang(e.target.value)}>
                <option value="auto">auto</option>
                <option value="ar">ar</option>
                <option value="en">en</option>
              </select>
            </L>
            <L label={t('toolRounds')}>
              <Input inputMode="numeric" value={fRounds} onChange={(e) => setFRounds(e.target.value)} />
            </L>
            <L label={t('replyCap')}>
              <Input inputMode="numeric" value={fCap} onChange={(e) => setFCap(e.target.value)} />
            </L>
            <L label={t('temperature')}>
              <Input inputMode="decimal" value={fTemp} onChange={(e) => setFTemp(e.target.value)} placeholder="0-2" />
            </L>
            <L label={t('maxOutputTokens')}>
              <Input inputMode="numeric" value={fMaxTok} onChange={(e) => setFMaxTok(e.target.value)} />
            </L>
            <L label={t('handoffMember')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={fHandoff} onChange={(e) => setFHandoff(e.target.value)}>
                <option value="">—</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.full_name || m.user_id}</option>
                ))}
              </select>
            </L>
          </div>
          <L label={t('systemPrompt')}>
            <Textarea
              rows={4}
              value={fPrompt}
              onChange={(e) => setFPrompt(e.target.value)}
              placeholder={t('systemPromptPlaceholder')}
            />
          </L>
          <Button size="sm" variant="outline" disabled={busy === 'revision'} onClick={() => void saveRevision()}>
            {busy === 'revision' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t('saveRevision')}
          </Button>
        </section>

        {/* tools */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('tools')}</h3>
          <div className="space-y-1">
            {registry.length === 0 && !registryOk ? (
              <p className="text-xs text-destructive">{t('toolsNotLoaded')}</p>
            ) : null}
            {registry.map((tool) => {
              const grant = grants.get(tool.key);
              const ui = getToolUiText(locale, tool.key, tool.description);
              return (
                <div key={tool.key} className="flex flex-wrap items-center gap-2 rounded border px-3 py-1.5 text-sm">
                  <Checkbox
                    checked={Boolean(grant)}
                    onCheckedChange={(v) => toggleTool(tool, v === true)}
                    id={`tool-${tool.key}`}
                  />
                  <label htmlFor={`tool-${tool.key}`} className="min-w-[180px] text-xs">
                    <span className="block font-medium">{ui.label}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {tool.key} · v{tool.version} · {getToolCategoryLabel(locale, tool.category)}
                    </span>
                  </label>
                  <span className="min-w-[220px] flex-1 text-xs text-muted-foreground">{ui.description}</span>
                  {grant ? (
                    <select
                      className="ms-auto rounded border bg-background px-2 py-1 text-xs"
                      value={grant.permission}
                      onChange={(e) =>
                        setGrants(
                          new Map(grants).set(tool.key, { ...grant, permission: e.target.value }),
                        )
                      }
                    >
                      {tool.grantPermissions.map((p) => (
                        <option key={p} value={p}>{getToolPermissionLabel(locale, p)}</option>
                      ))}
                    </select>
                  ) : null}
                </div>
              );
            })}
          </div>
          <Button size="sm" variant="outline" disabled={busy === 'tools'} onClick={() => void saveTools()}>
            {busy === 'tools' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t('saveTools')}
          </Button>
        </section>

        {/* budget */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('budget')}</h3>
          <div className="flex items-center gap-2">
            {(['daily', 'monthly'] as const).map((period) => (
              <Button
                key={period}
                size="sm"
                variant={budgetPeriod === period ? 'default' : 'outline'}
                onClick={() => setBudgetPeriod(period)}
              >
                {period === 'daily' ? t('budgetDaily') : t('budgetMonthly')}
                {policies.get(period)?.is_active ? <span className="ms-1">✓</span> : null}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <L label={t('maxRuns')}><Input inputMode="numeric" value={bRuns} onChange={(e) => setBRuns(e.target.value)} /></L>
            <L label={t('maxInputTokens')}><Input inputMode="numeric" value={bInTok} onChange={(e) => setBInTok(e.target.value)} /></L>
            <L label={t('maxOutputTokensLabel')}><Input inputMode="numeric" value={bOutTok} onChange={(e) => setBOutTok(e.target.value)} /></L>
            <L label={t('softThreshold')}><Input inputMode="decimal" value={bSoft} onChange={(e) => setBSoft(e.target.value)} /></L>
            <L label={t('hardAction')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={bHard} onChange={(e) => setBHard(e.target.value)}>
                <option value="handoff">handoff</option>
                <option value="pause">pause</option>
                <option value="cheaper_agent">cheaper_agent</option>
              </select>
            </L>
            <L label={t('fallbackAgent')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={bFallback} onChange={(e) => setBFallback(e.target.value)}>
                <option value="">—</option>
                {allAgents.filter((a) => a.id !== agentId).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </L>
            <div className="flex items-center gap-2">
              <Checkbox id="budget-active" checked={bActive} onCheckedChange={(v) => setBActive(v === true)} />
              <label htmlFor="budget-active" className="text-sm">{t('budgetActive')}</label>
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={busy === 'budget'} onClick={() => void saveBudget()}>
            {busy === 'budget' ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t('saveBudget')}
          </Button>
        </section>

        {/* test cases */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('testCases')}</h3>
          {testCases.length === 0 ? <p className="text-xs text-muted-foreground">{t('noTestCases')}</p> : null}
          {testCases.map((tc) => (
            <div key={tc.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
              <span className="font-medium">{tc.name}</span>
              <span className="text-xs text-muted-foreground">{tc.plane}</span>
              {tc.is_required ? <span className="text-xs text-amber-600">{t('required')}</span> : null}
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                disabled={busy === `tc:${tc.id}`}
                onClick={() => void removeTestCase(tc.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <L label={t('caseName')}><Input value={tcName} onChange={(e) => setTcName(e.target.value)} /></L>
            <L label={t('casePlane')}>
              <select className="w-full rounded border bg-background px-2 py-1.5 text-sm" value={tcPlane} onChange={(e) => setTcPlane(e.target.value)}>
                <option value="customer">customer</option>
                <option value="admin">admin</option>
              </select>
            </L>
            <L label={t('turn1')}><Input value={tcMsg1} onChange={(e) => setTcMsg1(e.target.value)} /></L>
            <L label={t('turn2')}><Input value={tcMsg2} onChange={(e) => setTcMsg2(e.target.value)} /></L>
            <L label={t('turn3')}><Input value={tcMsg3} onChange={(e) => setTcMsg3(e.target.value)} /></L>
            <div className="flex items-end gap-2">
              <Checkbox id="tc-required" checked={tcRequired} onCheckedChange={(v) => setTcRequired(v === true)} />
              <label htmlFor="tc-required" className="pb-1.5 text-sm">{t('required')}</label>
            </div>
          </div>
          <L label={t('caseAssertions')}>
            <Textarea rows={3} value={tcAssert} onChange={(e) => setTcAssert(e.target.value)} className="font-mono text-xs" />
          </L>
          <Button size="sm" variant="outline" disabled={busy !== null || !tcName.trim() || !tcMsg1.trim()} onClick={() => void addTestCase()}>
            <Plus className="me-1 h-3.5 w-3.5" /> {t('addTestCase')}
          </Button>
        </section>

        {checks && checks.length > 0 ? (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold">{t('checksTitle')}</h3>
            {checks.map((c, i) => (
              <p key={i} className={`text-xs ${c.severity === 'error' ? 'text-destructive' : 'text-amber-600'}`}>
                {c.code}: {c.message}
              </p>
            ))}
          </section>
        ) : null}

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runValidate()}>
            <BadgeCheck className="me-1.5 h-4 w-4" /> {t('validate')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void runSimulate()}>
            <FlaskConical className="me-1.5 h-4 w-4" /> {t('simulate')}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void publish()}>
            {busy === 'publish' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Rocket className="me-1.5 h-4 w-4" />}
            {t('publish')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto text-destructive"
            disabled={busy !== null}
            onClick={() => void discard()}
          >
            {busy === 'discard' ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : null}
            {t('discardDraft')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('draftHint')}</p>
      </CardContent>
    </Card>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
