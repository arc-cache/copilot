import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { workspaceRoot } from "./paths.js";
import { assertDurableArcRuntime, currentArcRuntime, type ArcRuntime } from "./runtime.js";
import { loadArcUiViewModel } from "./ui-data.js";
import { initialArcUiState, renderArcView } from "./ui-view.js";
import { resolveCopilotRoot } from "./copilot-root.js";

const SENTINEL = "agent-run-cache/copilot-tab/v2-rich";
const OLD_SENTINEL = "agent-run-cache/copilot-tab/v1";
const BACKUP_SUFFIX = ".arc-backup";
const CAVEAT = "Copilot does not expose a documented terminal-tab API here, so ARC patches Copilot's bundled app.js. Re-run arc copilot-tab install after Copilot updates or reinstalls.";

export interface CopilotTabResult {
  installed: boolean;
  changed: boolean;
  appJs?: string;
  backupPath?: string;
  runtimeEntrypoint?: string;
  runtimePinned?: boolean;
  reason?: string;
  caveat: string;
}

export async function renderCopilotTabFrame(args: string[], workspace = workspaceRoot()): Promise<string> {
  const width = parseNumberOption(args, "--width", process.stdout.columns || 100);
  const height = parseNumberOption(args, "--height", process.stdout.rows || 32);
  const model = await loadArcUiViewModel(workspace);
  return renderArcView(model, initialArcUiState(), { width, height });
}

export async function installCopilotTab(args: string[] = []): Promise<CopilotTabResult> {
  const runtime = assertDurableArcRuntime(currentArcRuntime());
  const root = resolveCopilotRoot(args);
  if (!root) {
    return {
      installed: false,
      changed: false,
      reason: "Could not find the installed @github/copilot package. Pass --copilot-root <path> if Copilot is installed outside PATH.",
      caveat: CAVEAT
    };
  }
  const appJs = join(root, "app.js");
  if (!existsSync(appJs)) {
    return { installed: false, changed: false, appJs, reason: `Copilot app.js was not found under ${root}.`, caveat: CAVEAT };
  }
  const source = await readFile(appJs, "utf8");
  const patched = patchCopilotAppJs(source, runtime);
  if (patched === source) return { installed: true, changed: false, appJs, runtimeEntrypoint: runtime.entrypoint, runtimePinned: tabRuntimePinned(source, runtime), caveat: CAVEAT };
  const backupPath = `${appJs}${BACKUP_SUFFIX}`;
  if (!existsSync(backupPath)) await copyFile(appJs, backupPath);
  await writeFile(appJs, patched, "utf8");
  return { installed: true, changed: true, appJs, backupPath, runtimeEntrypoint: runtime.entrypoint, runtimePinned: tabRuntimePinned(patched, runtime), caveat: CAVEAT };
}

export async function copilotTabStatus(args: string[] = []): Promise<CopilotTabResult> {
  const runtime = currentArcRuntime();
  const root = resolveCopilotRoot(args);
  if (!root) {
    return {
      installed: false,
      changed: false,
      reason: "Could not find the installed @github/copilot package.",
      caveat: CAVEAT
    };
  }
  const appJs = join(root, "app.js");
  if (!existsSync(appJs)) return { installed: false, changed: false, appJs, reason: "Copilot app.js was not found.", caveat: CAVEAT };
  const source = await readFile(appJs, "utf8");
  return {
    installed: source.includes(SENTINEL),
    changed: false,
    appJs,
    runtimeEntrypoint: runtime.entrypoint,
    runtimePinned: tabRuntimePinned(source, runtime),
    caveat: CAVEAT
  };
}

export async function restoreCopilotTab(args: string[] = []): Promise<CopilotTabResult> {
  const root = resolveCopilotRoot(args);
  if (!root) return { installed: false, changed: false, reason: "Could not find the installed @github/copilot package.", caveat: CAVEAT };
  const appJs = join(root, "app.js");
  const backupPath = `${appJs}${BACKUP_SUFFIX}`;
  if (!existsSync(backupPath)) return { installed: false, changed: false, appJs, backupPath, reason: "No ARC Copilot tab backup exists.", caveat: CAVEAT };
  await copyFile(backupPath, appJs);
  return { installed: false, changed: true, appJs, backupPath, caveat: CAVEAT };
}

export function patchCopilotAppJs(source: string, runtime = currentArcRuntime()): string {
  if (source.includes(SENTINEL)) return replaceExistingRichArcTabComponent(source, runtime);
  if (source.includes(OLD_SENTINEL)) return replaceExistingArcTabComponent(source, runtime);
  if (source.includes("Agent Run Cache discovery page.")) return patchCopilotArcPlaceholderAppJs(source, runtime);
  return patchCleanCopilotAppJs(source, runtime);
}

function patchCleanCopilotAppJs(source: string, runtime: ArcRuntime): string {
  let next = insertArcComponentSource(source, runtime);
  next = ensureArcTabValue(next);
  next = ensureArcNavigationCase(next);
  next = maybeEnsureArcPromptCommand(next);
  return ensureArcRoute(next);
}

function patchCopilotArcPlaceholderAppJs(source: string, runtime: ArcRuntime): string {
  let next = insertArcComponentSource(source, runtime);
  next = replaceOnce(
    next,
    'oe.default.createElement(N,{flexDirection:"column",paddingX:1,marginTop:1,gap:1},oe.default.createElement(C,{bold:!0},"Arc"),oe.default.createElement(C,null,"Agent Run Cache discovery page."),oe.default.createElement(C,null,"This placeholder proves a Copilot top-level page can be routed from the tab bar."))',
    "oe.default.createElement(ARC_AGENT_RUN_CACHE_TAB,null)",
    "Could not find the Copilot Arc placeholder body."
  );
  return next;
}

function insertArcComponentSource(source: string, runtime: ArcRuntime): string {
  const anchor = "Y_n=({activeView:t,defaultRoute:e,children:n})=>{let r=null,o=null;return cz.default.Children.forEach(n,s=>{!cz.default.isValidElement(s)||s.type!==Hf||(s.props.view===e&&(o??=s),!r&&s.props.view===t&&(r=s))}),cz.default.createElement(cz.default.Fragment,null,r??o)};var v0=";
  return replaceOnce(
    source,
    anchor,
    `Y_n=({activeView:t,defaultRoute:e,children:n})=>{let r=null,o=null;return cz.default.Children.forEach(n,s=>{!cz.default.isValidElement(s)||s.type!==Hf||(s.props.view===e&&(o??=s),!r&&s.props.view===t&&(r=s))}),cz.default.createElement(cz.default.Fragment,null,r??o)};${copilotTabComponentSource("cz", "N", "C", "no", runtime)}var v0=`,
    "Could not find the Copilot cached route helper anchor."
  );
}

function ensureArcTabValue(source: string): string {
  if (source.includes('{value:"arc",label:"Arc"}')) return source;
  const tabsPattern = /(Tbn=\[\{value:"copilot",label:"Session"\}[\s\S]*?\{value:"gists",label:"Gists"\})(\])/;
  if (!tabsPattern.test(source)) throw new Error(`Could not find the Copilot tab-list anchor. ${CAVEAT}`);
  return source.replace(tabsPattern, '$1,{value:"arc",label:"Arc"}$2');
}

function ensureArcNavigationCase(source: string): string {
  if (source.includes('case"arc":Ni("arc",{replace:!0});return')) return source;
  const anchor = 'case"gists":Ni("gists",{replace:!0});return}';
  if (!source.includes(anchor)) throw new Error(`Could not find the Copilot tab-navigation anchor. ${CAVEAT}`);
  return source.replace(anchor, 'case"gists":Ni("gists",{replace:!0});return;case"arc":Ni("arc",{replace:!0});return}');
}

function maybeEnsureArcPromptCommand(source: string): string {
  if (source.includes('ke==="/arc"')) return source;
  const anchor = 'let ke=D.trim().toLowerCase();if(ke==="exit"||ke==="quit")return';
  if (!source.includes(anchor)) return source;
  return source.replace(anchor, 'let ke=D.trim().toLowerCase();if(ke==="/arc")return rt("arc"),{handled:!0};if(ke==="exit"||ke==="quit")return');
}

function ensureArcRoute(source: string): string {
  if (source.includes('view:"arc"')) return source;
  const arcRoute = 'oe.default.createElement(Hf,{view:"arc"},oe.default.createElement(Pi,{header:ga?oe.default.createElement(ky,{selectedValue:"arc",enableKeyboardNavigation:hi,enableMouseNavigation:Zy,onNavigate:UE,showGitHubRepositoryTabs:il.isGitHubRepository,showAgentsTab:Qp,sortOrder:Qw,hideTabs:Ji}):void 0,footer:oe.default.createElement(N,{paddingLeft:1},oe.default.createElement(Yt,{hints:{tab:"next tab"}})),scrollable:!1},oe.default.createElement(ARC_AGENT_RUN_CACHE_TAB,null)))';
  const anchors = [
    ')),Jg(Ee)&&oe.default.createElement(Hf,{view:"agents"}',
    ')),oe.default.createElement(Hf,{view:"pull-requests"}',
    ')),oe.default.createElement(Hf,{view:"issues"}',
    ')),oe.default.createElement(Hf,{view:"gists"}'
  ];
  for (const anchor of anchors) {
    const index = source.indexOf(anchor);
    if (index >= 0) return `${source.slice(0, index + 3)},${arcRoute}${source.slice(index + 3)}`;
  }
  throw new Error(`Could not find the Copilot view-route anchor. ${CAVEAT}`);
}

function replaceExistingArcTabComponent(source: string, runtime: ArcRuntime): string {
  const componentPattern = /var ARC_AGENT_RUN_CACHE_TAB_VERSION="agent-run-cache\/copilot-tab\/v1";\nfunction ARC_AGENT_RUN_CACHE_TAB[\s\S]*?\n(?=var LIe=|var v0=)/;
  if (!componentPattern.test(source)) return source;
  return source.replace(componentPattern, copilotTabComponentSource("cz", "N", "C", "no", runtime));
}

function replaceExistingRichArcTabComponent(source: string, runtime: ArcRuntime): string {
  const componentPattern = /var ARC_AGENT_RUN_CACHE_TAB_VERSION="agent-run-cache\/copilot-tab\/v2-rich";\n(?:function ARC_AGENT_RUN_CACHE_TAB|var ARC_AGENT_RUN_CACHE_TAB=)[\s\S]*?\n(?=var LIe=|var v0=)/;
  const match = componentPattern.exec(source);
  if (!match) return source;
  const following = source.slice(match.index + match[0].length, match.index + match[0].length + 8);
  const bindings = existingArcTabBindings(match[0], following);
  return source.replace(componentPattern, copilotTabComponentSource(bindings.react, bindings.box, bindings.text, bindings.requireFn, runtime));
}

function existingArcTabBindings(componentSource: string, following: string): { react: string; box: string; text: string; requireFn: string } {
  const wrapped = componentSource.match(/\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\);\s*$/);
  if (wrapped) return { react: wrapped[1], box: wrapped[2], text: wrapped[3], requireFn: wrapped[4] };
  const oldComponent = componentSource.match(/let R=([A-Za-z_$][\w$]*),h=.*?,B=([A-Za-z_$][\w$]*),T=([A-Za-z_$][\w$]*),/);
  const oldRequire = componentSource.match(/try\{c=([A-Za-z_$][\w$]*)\("node:child_process"\)\.execFile\}/);
  if (oldComponent && oldRequire) return { react: oldComponent[1], box: oldComponent[2], text: oldComponent[3], requireFn: oldRequire[1] };
  if (following.startsWith("var v0=")) return { react: "cz", box: "N", text: "C", requireFn: "no" };
  return { react: "pue", box: "q", text: "P", requireFn: "Re" };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function parseNumberOption(args: string[], name: string, fallback: number): number {
  const raw = optionValue(args, name);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function replaceOnce(source: string, needle: string, replacement: string, error: string): string {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${error} ${CAVEAT}`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

export function copilotTabComponentSource(react: string, box: string, text: string, requireFn: string, runtime: ArcRuntime): string {
  return `var ARC_AGENT_RUN_CACHE_TAB_VERSION="${SENTINEL}";
var ARC_AGENT_RUN_CACHE_TAB=((arcReactBinding,arcBoxComponent,arcTextComponent,arcRequireFn)=>function ARC_AGENT_RUN_CACHE_TAB({onClose:t,initialData:e,loadArc:n,inputSource:o}={}){let R=arcReactBinding,h=(R.default&&R.default.createElement)||R.createElement,B=arcBoxComponent,T=arcTextComponent,[d,S]=R.useState(e||null),[g,E]=R.useState("capsules"),[I,A]=R.useState(0),[q,D]=R.useState(""),[w,W]=R.useState(!1),[x,F]=R.useState(!0),[L,O]=R.useState(""),[P,V]=R.useState("");let refreshArcData=R.useCallback(()=>{let a=!0,l=()=>{if(n){Promise.resolve(n()).then(c=>{a&&(S(c),O(new Date().toLocaleTimeString()),V(""))}).catch(c=>a&&V(String(c).slice(0,140)));return}let c;try{c=arcRequireFn("node:child_process").execFile}catch(u){V("ARC tab unavailable: node:child_process is not available");return}${tabExecCallPrefix(runtime)}{cwd:process.cwd(),timeout:5e3,maxBuffer:5e5},(u,p,m)=>{if(!a)return;if(u){V("ARC tab unavailable. Run arc plugin install, then arc copilot-tab install. "+(m||u.message));return}try{S(JSON.parse(p||"{}")),O(new Date().toLocaleTimeString()),V("")}catch(f){V("ARC returned invalid JSON: "+String(f).slice(0,120))}})};l();let r=setInterval(l,1e3);return()=>{a=!1;clearInterval(r)}},[n]);R.useEffect(refreshArcData,[refreshArcData]);let M=(d&&d.capsules||[]).filter(a=>(!q||[a.title,a.summary,a.kind,a.privacyLabel,a.status,...(a.reuseWhen||[]),...(a.steps||[]),...(a.commands||[])].join("\\n").toLowerCase().includes(q.toLowerCase()))),N=d&&d.recentEvents||[],G=Math.max(0,Math.min(I,Math.max(0,M.length-1))),U=M[G]||null,$=R.useCallback((a,l={})=>{let c=String(a||"");if(w){if(l.escape){W(!1);D("");return}if(l.return||c==="\\r"||c==="\\n"){W(!1);return}if(l.backspace||c==="\\b"||c==="\\x7F"){D(u=>u.slice(0,-1));return}if(c&&c>=" "&&!c.startsWith("\\x1b")){D(u=>(u+c).slice(0,80));return}}if(l.escape||c==="\\x1b"){t&&t();return}if(l.mouse){if(l.mouse.y<=7){E(l.mouse.x>16?"activity":"capsules");return}if(g==="capsules"){let u=Math.max(0,G-2)+Math.max(0,Math.floor((l.mouse.y-8)/4));A(Math.min(u,Math.max(0,M.length-1)));return}}if(c==="1"){E("capsules");return}if(c==="2"||c==="\\t"){E("activity");return}if(c==="r"){let u=refreshArcData();typeof u=="function"&&u();return}if(c==="/"){W(!0);D("");E("capsules");return}if(c==="j"||c==="\\x1b[B"){E("capsules");A(u=>Math.min(u+1,Math.max(0,M.length-1)));return}if(c==="k"||c==="\\x1b[A"){E("capsules");A(u=>Math.max(0,u-1));return}if(c==="\\r"||c==="\\n"){F(u=>!u);return}},[w,M.length,refreshArcData,t,g,G]);R.useEffect(()=>{let a=o||process.stdin;if(!a||typeof a.on!="function")return;let l=c=>{let u=Buffer.isBuffer(c)?c.toString("utf8"):String(c),p=[...u.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)[mM]/g)];if(p.length){for(let m of p)$(m[0],{mouse:{button:Number(m[1]),x:Number(m[2]),y:Number(m[3]),release:m[0].endsWith("m")}});return}if(u==="\\x1b[A"||u==="\\x1b[B"){$(u);return}for(let m of u)$(m)};a.on("data",l);return()=>{typeof a.off=="function"?a.off("data",l):a.removeListener&&a.removeListener("data",l)}},[o,$]);let H=process.stdout&&process.stdout.columns||100,z=H<84,J=K(d?.status?.repo||"repo",24),Q=d?.status?.capsuleCount??0,X=d?.status?.eventCount??0,Y=d?.status?.integration==="copilot-plugin"?"plugin active":d?.status?.hook?.installed?"hook live":"plugin pending";return h(B,{flexDirection:"column",paddingX:1,gap:1},h(B,{alignItems:"center",gap:1},h(T,{color:"cyan",bold:!0},"[mem] ARC"),h(T,{backgroundColor:"blue",color:"white"},String(Q)+" capsules"),h(T,{color:"gray"},J),h(T,{color:"gray"},"refresh "+(L||"--:--:--"))),h(B,{gap:1},h(T,{backgroundColor:g==="capsules"?"cyan":void 0,color:g==="capsules"?"black":"cyan",bold:g==="capsules"}," 1 Capsules "),h(T,{backgroundColor:g==="activity"?"cyan":void 0,color:g==="activity"?"black":"cyan",bold:g==="activity"}," 2 Activity "),h(T,{color:"gray"},Y+" | events "+X+" | / filter | j/k move | enter expand | r refresh")),P?h(T,{color:"red"},P):null,h(T,{color:w?"yellow":"gray"},"filter "+(w?"> ":": ")+(q||"all capsules")),g==="capsules"?h(B,{flexDirection:z?"column":"row",gap:1},h(B,{flexDirection:"column",width:z?void 0:Math.max(36,Math.floor(H*.46)),gap:1},M.length?M.slice(Math.max(0,G-2),Math.max(5,G+3)).map((a,l)=>Z(a,a===U,l)):h(B,{borderStyle:"round",borderColor:"gray",paddingX:1},h(T,{color:"gray"},"No capsules yet. ARC saves verified reusable methods after successful sessions."))),h(B,{flexDirection:"column",width:z?void 0:Math.max(42,Math.floor(H*.48)),borderStyle:"round",borderColor:"blue",paddingX:1},ee(U,x))):h(B,{flexDirection:"column",borderStyle:"round",borderColor:"cyan",paddingX:1},N.length?N.slice(0,z?8:12).map((a,l)=>te(a,l)):h(T,{color:"gray"},"No ARC activity yet.")));function Z(a,l,c){let u=Math.round((a.confidence||0)*100),p=a.status==="local"||a.status==="shareable"||a.status==="shared"?"green":a.status==="rejected"||a.status==="private"?"yellow":"gray";return h(B,{key:a.id||c,flexDirection:"column",borderStyle:l?"round":"single",borderColor:l?"cyan":"gray",paddingX:1},h(B,{gap:1,alignItems:"center"},h(T,{color:p},"o"),h(T,{bold:l},K(a.title,42))),h(B,{gap:1},pill(a.kind||"workflow","magenta"),pill(a.privacyLabel||"local","blue"),h(T,{color:"green"},u+"% "+bar(u)),h(T,{color:"gray"},age(a.updatedAt))),a.summary?h(T,{color:"gray"},K(a.summary,z?64:88)):null)}function ee(a,l){if(!a)return h(T,{color:"gray"},"Select a capsule.");let c=(a.reuseWhen||[]).slice(0,3),u=(a.steps||[]).slice(0,l?5:2),p=(a.commands||[]).slice(0,l?4:2);return h(B,{flexDirection:"column",gap:1},h(T,{bold:!0},a.title||"Untitled capsule"),h(T,{color:"gray"},"id "+(a.shortId||a.id)+" | uses "+(a.useCount||0)+" | "+Math.round((a.confidence||0)*100)+"% confidence"),section("SUMMARY",[a.summary||"No summary."]),section("REUSE WHEN",c),section("STEPS",u),section("COMMAND SHAPES",p))}function section(a,l){let c=(l||[]).filter(Boolean);return h(B,{flexDirection:"column"},h(T,{color:"cyan",bold:!0},a),c.length?c.map((u,p)=>h(T,{key:a+p},(p+1)+". "+K(String(u),z?70:96))):h(T,{color:"gray"},"none recorded"))}function te(a,l){let c=eventColor(a.type),u=eventLabel(a.type),p=K(a.detail||a.title||a.sessionId||"",z?54:88);return h(B,{key:a.id||l,gap:1},h(T,{color:c,bold:!0},K(u,18)),h(T,null,p),h(T,{color:"gray"},age(a.timestamp)))}function pill(a,l){return h(T,{backgroundColor:l,color:"white"}," "+K(String(a).replace(/_/g," "),16)+" ")}function bar(a){let l=Math.max(0,Math.min(10,Math.round(a/10)));return "["+"#".repeat(l)+"-".repeat(10-l)+"]"}function K(a,l){a=String(a||"");return a.length<=l?a:a.slice(0,Math.max(0,l-3))+"..."}function age(a){let l=Date.parse(a||"");if(!Number.isFinite(l))return "";let c=Math.max(0,Date.now()-l),u=Math.floor(c/864e5);if(u>0)return u+"d";let p=Math.floor(c/36e5);if(p>0)return p+"h";let m=Math.floor(c/6e4);return(m||0)+"m"}function eventColor(a){return /created|updated|finalized|saved/.test(a)?"green":/rejected|skipped|declined|superseded/.test(a)?"gray":/prompt|inject/.test(a)?"cyan":"white"}function eventLabel(a){let l={"capsule.created":"Saved","capsule.updated":"Updated","capsule.finalized":"Finalized","capsule.injected":"Injected","capsule.rejected":"Skipped","capsule.superseded":"Invalidated","capsule.privacy_updated":"Privacy","capsule.merged":"Merged"};return l[a]||a}})(${react},${box},${text},${requireFn});
`;
}

function tabExecCallPrefix(runtime: ArcRuntime): string {
  return `${tabRuntimePrefix(runtime)}m?[m,["tab","--json"]]:[process.env.AGENT_RUN_CACHE_NODE||h,[process.env.AGENT_RUN_CACHE_ARC_ENTRYPOINT||g,"tab","--json"]];c(b[0],b[1],`;
}

function tabRuntimePrefix(runtime: ArcRuntime): string {
  return `let m=process.env.AGENT_RUN_CACHE_ARC_BIN,h=${JSON.stringify(runtime.node)},g=${JSON.stringify(runtime.entrypoint)},b=`;
}

function tabRuntimePinned(source: string, runtime: ArcRuntime): boolean {
  return source.includes("AGENT_RUN_CACHE_ARC_ENTRYPOINT")
    && source.includes(JSON.stringify(runtime.node))
    && source.includes(JSON.stringify(runtime.entrypoint));
}
