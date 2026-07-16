import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";

import { copilotTabComponentSource, patchCopilotAppJs, renderCopilotTabFrame } from "../dist/copilot-tab.js";
import { saveCapsule } from "../dist/store.js";

test("Copilot app patch adds an idempotent Arc tab to a clean current bundle shape", () => {
  const fixture = 'var Tbn=[{value:"copilot",label:"Session"},{value:"agents",label:"Agents"},{value:"issues",label:"Issues"},{value:"pull-requests",label:"Pull requests"},{value:"gists",label:"Gists"}],beo=Tbn.filter(t=>t.value!=="issues"&&t.value!=="pull-requests");var cz=Ne(Ve(),1),Hf=({children:t})=>cz.default.createElement(cz.default.Fragment,null,t),Y_n=({activeView:t,defaultRoute:e,children:n})=>{let r=null,o=null;return cz.default.Children.forEach(n,s=>{!cz.default.isValidElement(s)||s.type!==Hf||(s.props.view===e&&(o??=s),!r&&s.props.view===t&&(r=s))}),cz.default.createElement(cz.default.Fragment,null,r??o)};var v0=Ne(Ve(),1);let UE=(0,oe.useCallback)(q=>{switch(q){case"copilot":Ni("main",{replace:!0});return;case"agents":Ni("agents",{replace:!0});return;case"pull-requests":Ni("pull-requests",{replace:!0});return;case"issues":Ni("issues",{replace:!0});return;case"gists":Ni("gists",{replace:!0});return}},[Ni,Ee]);oe.default.createElement(Y_n,{activeView:$a,defaultRoute:"main"},oe.default.createElement(Hf,{view:"main"},oe.default.createElement(cCn,{})),Jg(Ee)&&oe.default.createElement(Hf,{view:"agents"},oe.default.createElement(ort,{})),oe.default.createElement(Hf,{view:"gists"},oe.default.createElement(qot,{})))';
  const patched = patchCopilotAppJs(fixture);

  assert.match(patched, /agent-run-cache\/copilot-tab\/v2-rich/);
  assert.match(patched, /\{value:"arc",label:"Arc"\}/);
  assert.match(patched, /view:"arc"/);
  assert.match(patched, /case"arc":Ni\("arc",\{replace:!0\}\);return/);
  assert.equal(patchCopilotAppJs(patched), patched);
});

test("Copilot app patch replaces the cached Arc placeholder route", () => {
  const fixture = 'var cz=Ne(Ve(),1),Hf=({children:t})=>cz.default.createElement(cz.default.Fragment,null,t),Y_n=({activeView:t,defaultRoute:e,children:n})=>{let r=null,o=null;return cz.default.Children.forEach(n,s=>{!cz.default.isValidElement(s)||s.type!==Hf||(s.props.view===e&&(o??=s),!r&&s.props.view===t&&(r=s))}),cz.default.createElement(cz.default.Fragment,null,r??o)};var v0=Ne(Ve(),1);oe.default.createElement(Hf,{view:"arc"},oe.default.createElement(Pi,{header:ga?oe.default.createElement(ky,{selectedValue:"arc",enableKeyboardNavigation:hi,enableMouseNavigation:Zy,onNavigate:UE,showGitHubRepositoryTabs:il.isGitHubRepository,showAgentsTab:Qp,sortOrder:Qw,hideTabs:Ji}):void 0,footer:oe.default.createElement(N,{paddingLeft:1},oe.default.createElement(Yt,{hints:{tab:"next tab"}})),scrollable:!1},oe.default.createElement(N,{flexDirection:"column",paddingX:1,marginTop:1,gap:1},oe.default.createElement(C,{bold:!0},"Arc"),oe.default.createElement(C,null,"Agent Run Cache discovery page."),oe.default.createElement(C,null,"This placeholder proves a Copilot top-level page can be routed from the tab bar."))))';
  const patched = patchCopilotAppJs(fixture);

  assert.match(patched, /agent-run-cache\/copilot-tab\/v2-rich/);
  assert.match(patched, /ARC_AGENT_RUN_CACHE_TAB/);
  assert.doesNotMatch(patched, /Agent Run Cache discovery page/);
  assert.equal(patchCopilotAppJs(patched), patched);
});

test("injected Copilot Arc component renders designed cards and responds to input", async () => {
  const Component = injectedArcComponent();
  const input = new EventEmitter();
  const view = render(React.createElement(Component, {
    initialData: sampleTabModel(),
    inputSource: input,
    loadArc: async () => sampleTabModel("refreshed")
  }));
  try {
    await settle();

    const first = view.lastFrame();
    assert.match(first, /\[mem\] ARC/);
    assert.match(first, /2 capsules/);
    assert.match(first, /1 Capsules/);
    assert.match(first, /workflow/);
    assert.match(first, /shareable/);
    assert.match(first, /78% \[########--\]/);
    assert.match(first, /REUSE WHEN/);
    assert.match(first, /STEPS/);
    assert.match(first, /COMMAND SHAPES/);

    input.emit("data", Buffer.from("2"));
    await settle();
    const activity = view.lastFrame();
    assert.match(activity, /2 Activity/);
    assert.match(activity, /Saved/);
    assert.match(activity, /Capture skipped because no reusable method was proven/);

    input.emit("data", Buffer.from("\x1b[<0;5;5M"));
    await settle();
    assert.match(view.lastFrame(), /1 Capsules/);

    input.emit("data", Buffer.from("\x1b[<0;8;12M"));
    await settle();
    assert.match(view.lastFrame(), /Hook capture smoke/);

    input.emit("data", Buffer.from("\x1b[<0;20;5M"));
    await settle();
    assert.match(view.lastFrame(), /2 Activity/);

    input.emit("data", Buffer.from("1"));
    input.emit("data", Buffer.from("j"));
    await settle();
    assert.match(view.lastFrame(), /93% \[#########-\]/);

    input.emit("data", Buffer.from("/"));
    await settle();
    input.emit("data", Buffer.from("hook\n"));
    await settle();
    assert.match(view.lastFrame(), /filter : hook/);
    assert.match(view.lastFrame(), /Hook capture smoke/);
  } finally {
    view.unmount();
  }
});

test("Copilot tab frame renders through the shared ARC data and view path", withTabCache(async (workspace) => {
  await saveCapsule({
    id: "copilot-tab-shared-view-capsule",
    runner: "copilot",
    workspace,
    sourceSessionId: "copilot-tab-session",
    kind: "workflow",
    mergeKey: "copilot-tab.shared-view",
    reusable: true,
    confidence: 0.93,
    title: "Shared Copilot tab view",
    summary: "Render the shared ARC view inside the Copilot tab.",
    reuseWhen: ["testing the shared copilot tab view"],
    doNotReuseWhen: [],
    evidence: ["The capsule was saved through the store."],
    provenance: ["test"],
    nextRunInstruction: "Render arc tab --frame.",
    workflow: {
      purpose: "Exercise the Copilot tab frame.",
      parameters: ["workspace"],
      bindingSources: ["test"],
      steps: ["Load the ARC view-model.", "Render the shared frame."],
      commands: ["arc tab --frame"],
      successCriteria: ["The frame includes this capsule."],
      failedAttempts: [],
      validationProbe: ["arc tab --frame --width 100 --height 24"]
    }
  }, workspace);

  const frame = await renderCopilotTabFrame(["--width", "100", "--height", "24"], workspace);
  assert.match(frame, /ARC /);
  assert.match(frame, /Shared Copilot tab view/);
  assert.match(frame, /Active \/ Local only/);
}));

function injectedArcComponent() {
  const reactBinding = {
    default: React,
    createElement: React.createElement,
    useCallback: React.useCallback,
    useEffect: React.useEffect,
    useState: React.useState
  };
  const runtime = {
    node: process.execPath,
    entrypoint: "/tmp/agent-run-cache/dist/cli.js",
    packageRoot: "/tmp/agent-run-cache",
    transient: false
  };
  const source = copilotTabComponentSource("cz", "N", "C", "no", runtime);
  return new Function("cz", "N", "C", "no", `${source}; return ARC_AGENT_RUN_CACHE_TAB;`)(
    reactBinding,
    Box,
    Text,
    () => ({ execFile: () => undefined })
  );
}

function sampleTabModel(label = "initial") {
  const now = new Date().toISOString();
  return {
    status: {
      repo: "tracer-ai",
      workspace: "/tmp/tracer-ai",
      cacheDir: "/tmp/tracer-ai/.agent-run-cache",
      capsuleCount: 2,
      eventCount: 3,
      hook: { installed: true, path: "/tmp/tracer-ai/.github/hooks/agent-run-cache.json" },
      lastInjection: null,
      lastSave: null,
      generatedAt: now
    },
    query: "",
    capsules: [
      {
        id: "project-fact-capsule",
        shortId: "project-",
        title: `Project setup route ${label}`,
        summary: "Use the npm global arc binary and persisted reviewer command before launching Copilot.",
        status: "shareable",
        privacyLabel: "shareable",
        kind: "workflow",
        confidence: 0.78,
        updatedAt: now,
        useCount: 4,
        reuseWhen: ["installing ARC from npm", "checking Copilot hook setup"],
        doNotReuseWhen: [],
        nextRunInstruction: "Run arc doctor before launching Copilot.",
        steps: ["Install the packed package globally.", "Run arc plugin install.", "Launch Copilot normally."],
        commands: ["npm i -g arc-copilot", "arc plugin install"],
        validationProbe: [],
        failedAttempts: []
      },
      {
        id: "hook-capture-smoke",
        shortId: "hook-cap",
        title: "Hook capture smoke",
        summary: "Check that hook events reach ARC after setup.",
        status: "local",
        privacyLabel: "local",
        kind: "project_fact",
        confidence: 0.93,
        updatedAt: now,
        useCount: 1,
        reuseWhen: ["verifying hook capture"],
        doNotReuseWhen: [],
        nextRunInstruction: "Submit a small prompt and exit Copilot.",
        steps: ["Open Copilot.", "Run a tiny successful task.", "Inspect arc events."],
        commands: ["arc events --json"],
        validationProbe: [],
        failedAttempts: []
      }
    ],
    selectedCapsule: null,
    recentEvents: [
      {
        id: "evt-created",
        type: "capsule.created",
        timestamp: now,
        title: "Project setup route",
        detail: "Project setup route"
      },
      {
        id: "evt-rejected",
        type: "capsule.rejected",
        timestamp: now,
        title: "",
        detail: "Capture skipped because no reusable method was proven"
      }
    ]
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function withTabCache(fn) {
  return async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arc-tab-test-"));
    const previousCache = process.env.AGENT_RUN_CACHE_DIR;
    const previousSidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    const previousObserver = process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER;
    process.env.AGENT_RUN_CACHE_DIR = join(workspace, ".agent-run-cache");
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER = "off";
    try {
      await fn(workspace);
    } finally {
      restoreEnv("AGENT_RUN_CACHE_DIR", previousCache);
      restoreEnv("AGENT_RUN_CACHE_MODEL_SIDECAR", previousSidecar);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_OBSERVER", previousObserver);
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
