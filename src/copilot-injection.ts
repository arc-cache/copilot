import { recordMemoryEvent } from "./ledger.js";
import { buildInjectionPlan } from "./retrieval.js";
import { claimInvocationLock } from "./invocation-lock.js";
import { debug } from "./store.js";
import type { InjectionPlan } from "./types.js";

export interface InjectionPlanSummary {
  shouldInject: boolean;
  capsuleId?: string;
  capsuleTitle?: string;
  reason: string;
  source?: string;
  judgeDecisionId?: string;
  consultApplied?: boolean;
  consultCapsuleId?: string;
  consultAbstainReason?: string;
  actionRisk?: string;
}

export interface CopilotPromptInjection {
  hookResult: {
    additionalContext?: string;
    modifiedPrompt?: string;
  };
  notice?: string;
  plan: InjectionPlanSummary;
}

export async function buildCopilotPromptInjection(
  prompt: string,
  workspace: string,
  sessionId: string,
  surface: "json-hook" | "sdk-extension"
): Promise<CopilotPromptInjection> {
  if (!prompt || prompt.includes("Agent Run Cache sidecar note:") || prompt.includes("Agent Run Cache consult:")) {
    return {
      hookResult: {},
      plan: { shouldInject: false, reason: "ignored ARC sidecar or empty prompt", source: "local" }
    };
  }
  if (!await claimInvocationLock(workspace, "copilot-prompt-injection", [sessionId, prompt], 30_000)) {
    await debug("copilot.prompt.skipped", { sessionId, surface, reason: "duplicate prompt injection invocation" }, workspace);
    return {
      hookResult: {},
      plan: { shouldInject: false, reason: "duplicate prompt injection invocation", source: "local" }
    };
  }
  const plan = await buildInjectionPlan(prompt, workspace, { runner: "copilot", sessionId });
  const summary = summarizeInjectionPlan(plan);
  if (!plan.shouldInject) {
    await debug("copilot.prompt.no_context", { sessionId, surface, reason: plan.reason }, workspace);
    return { hookResult: {}, plan: summary };
  }
  await debug("copilot.prompt.context", { sessionId, surface, reason: plan.reason, source: plan.source }, workspace);
  await recordMemoryEvent({
    type: "capsule.injected",
    workspace,
    sessionId,
    capsuleId: plan.capsule?.id,
    details: {
      source: plan.source,
      surface,
      reason: plan.reason,
      title: plan.capsule?.title,
      injected: true,
      used: "unknown",
      helped: "unknown",
      judgeDecisionId: plan.judgeDecisionId
    }
  });
  const recall = plan.capsule?.title ? `ARC recalled: ${plan.capsule.title}` : "ARC recalled: matching capsule";
  const context = `${recall}\n\n${plan.message}`;
  return {
    hookResult: {
      additionalContext: context,
      modifiedPrompt: `${context}\n\nUser task:\n${prompt}`
    },
    notice: plan.capsule?.title ? `ARC recalled ${plan.capsule.title}` : "ARC recalled a matching capsule",
    plan: summary
  };
}

function summarizeInjectionPlan(plan: InjectionPlan): InjectionPlanSummary {
  return {
    shouldInject: plan.shouldInject,
    capsuleId: plan.capsule?.id,
    capsuleTitle: plan.capsule?.title,
    reason: plan.reason,
    source: plan.source,
    judgeDecisionId: plan.judgeDecisionId,
    consultApplied: plan.consultApplied,
    consultCapsuleId: plan.consultCapsuleId,
    consultAbstainReason: plan.consultAbstainReason,
    actionRisk: plan.actionRisk
  };
}
