// Synthetic V0.2 single-conversation pilot state-machine tests.
// No Edge profile, ChatGPT account, real index, ZIP or V0.1 database is used.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

async function main() {
  const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  const store = Object.create(null);
  const listeners = [];
  let toRealm;
  let exportMode = "success";
  let prepareMode = "success";
  let exportCalls = 0;
  const target = { conversationId: "pilot-00000001", workspaceId: "workspace-1" };
  const targetFingerprint = "f".repeat(64);
  const changeSetDigest = "d".repeat(64);
  const api = {
    runtime: {
      id: "pilot-test-extension",
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} }
    },
    storage: { local: {
      async get(keys) {
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
        }
        return out;
      },
      async set(values) { Object.assign(store, values); }
    } },
    alarms: { onAlarm: { addListener() {} }, async create() {}, async clear() { return true; } },
    tabs: {
      async query() { return [{id: 7, status: "complete", url: "https://chatgpt.com/"}]; },
      async create() { throw new Error("Unexpected tab creation"); },
      async sendMessage(_id, message) {
        if (message.type === "cgx-ping") return toRealm({ok:true});
        if (message.type === "cgx-v02-pilot-prepare") {
          if (prepareMode === "missing") return toRealm({ok:true,listed:67,changed:7,newCount:2,modified:5,selectionCount:0,baselineEntries:65,changeSetDigest,targetFingerprint});
          if (prepareMode === "multiple") return toRealm({ok:true,listed:68,changed:8,newCount:3,modified:5,selectionCount:2,baselineEntries:65,changeSetDigest,targetFingerprint});
          if (prepareMode === "large") return toRealm({ok:true,listed:71,changed:11,newCount:6,modified:5,selectionCount:1,baselineEntries:65,changeSetDigest,targetFingerprint});
          return toRealm({ok:true,listed:67,changed:7,newCount:2,modified:5,selectionCount:1,baselineEntries:65,changeSetDigest,targetFingerprint});
        }
        if (message.type === "cgx-v02-pilot-export") {
          exportCalls++;
          if (exportMode === "cancelled") return toRealm({ok:false,cancelled:true,error:"Export cancelled"});
          if (exportMode === "interrupted") return toRealm({ok:false,error:"ZIP download interrupted"});
          if (exportMode === "media") return toRealm({ok:true,count:0,failed:0,imageFailures:1,fileFailures:0,parts:0});
          if (exportMode === "wrong") return toRealm({ok:true,count:1,failed:0,imageFailures:0,fileFailures:0,parts:1,pilotPending:{schema:"cgx-v02-pilot-browser-receipt-v1"}});
          return toRealm({
            ok:true,count:1,failed:0,imageFailures:0,fileFailures:0,parts:1,
            pilotPending:{
              schema:"cgx-v02-pilot-browser-receipt-v1",
              conversationId:target.conversationId,workspaceId:target.workspaceId,
              indexKey:target.workspaceId+":"+target.conversationId,
              indexEntry:{fingerprint:targetFingerprint,updated_at:"2026-11-17T08:00:00Z",exported_at:"2026-11-17T09:00:00Z"},
              filename:"chatgpt-export_2026-11-17_17-00-00.zip",byteCount:4096,
              zipSha256:"a".repeat(64),manifestSha256:"b".repeat(64),conversationCount:1
            }
          });
        }
        throw new Error("Unexpected tab message: " + message.type);
      }
    }
  };
  const sandbox = vm.createContext({
    chrome: api, console, Date, Intl, TextEncoder, Uint8Array,
    setTimeout, clearTimeout, crypto: webcrypto,
    fetch: () => { throw new Error("Unexpected fetch"); }
  });
  vm.runInContext(source, sandbox, {filename:"background.js"});
  toRealm = value => vm.runInContext("JSON.parse(" + JSON.stringify(JSON.stringify(value)) + ")", sandbox);

  const baselineIds = Array.from({length:65}, (_, index) => "conv-" + String(index + 1).padStart(8, "0"));
  const shared = [
    {targetId:baselineIds[63],sourceIndexKey:"workspace-1:shared-00000001"},
    {targetId:baselineIds[64],sourceIndexKey:"workspace-1:shared-00000002"}
  ];
  const baseIndex = Object.fromEntries([
    ...baselineIds.slice(0, 63).map((id, index) => ["workspace-1:" + id, {fingerprint:String(index % 10).repeat(64),updated_at:"2026-11-16T00:00:00Z"}]),
    ...shared.map((record, index) => [record.sourceIndexKey, {fingerprint:(index ? "a" : "b").repeat(64),updated_at:"2026-11-16T00:00:00Z"}])
  ]);
  const migration = {schema:"cgx-v02-receipt-v1",verified:true,importedAt:"2026-11-17T00:00:00Z",indexCountAtImport:65,baselineIds,sharedAliases:shared};
  function seed() {
    for (const key of Object.keys(store)) delete store[key];
    Object.assign(store, toRealm({
      "cgx-v02-scheduler":{enabled:false,lastStatus:"disabled"},
      "cgx-export-index":baseIndex,
      "cgx-v02-index-migration":migration,
      "cgx-last-full-export":1700000000000
    }));
    prepareMode = "success";
    exportMode = "success";
    exportCalls = 0;
  }
  async function call(message) {
    return new Promise((resolve, reject) => {
      for (const listener of listeners) {
        if (listener(toRealm(message), {url:"chrome-extension://pilot-test-extension/popup/popup.html"}, resolve) === true) return;
      }
      reject(new Error("No message listener"));
    });
  }
  let passed = 0;
  function check(name, condition) { assert.ok(condition, name); passed++; console.log("PASS " + name); }

  check("Content pilot uses exact key selection", content.includes("item._cgxIndexKey===targetKey"));
  check("Content pilot compares independent scan digest", content.includes("delta.changeSetDigest!==opts.v02PilotExpected?.changeSetDigest"));
  check("Content pilot blocks media failure before ZIP finalization", content.indexOf("if(opts.v02Pilot && (errors.length>0 || imageFailures>0 || fileFailures>0))") < content.indexOf("await flush(true)"));
  check("Content pilot never writes real index", content.includes("else if(!opts.v02Pilot) await storageSet"));
  check("Pilot manifest asserts one conversation", content.includes("manifest.conversation_count!==1"));
  check("Pilot ZIP omits full project index metadata", content.includes("const projectsIndex=opts.v02Pilot?[]:listed.projectsIndex"));

  seed();
  prepareMode = "missing";
  check("Missing exact target is rejected", !(await call({type:"cgx-v02-pilot-prepare",target})).ok && exportCalls === 0);
  prepareMode = "multiple";
  check("Multiple target matches are rejected", !(await call({type:"cgx-v02-pilot-prepare",target})).ok && exportCalls === 0);
  prepareMode = "large";
  check("Delta above ten is rejected", !(await call({type:"cgx-v02-pilot-prepare",target})).ok && exportCalls === 0);

  seed();
  const preparedForDrift = await call({type:"cgx-v02-pilot-prepare",target});
  store["cgx-export-index"] = toRealm({...baseIndex,"workspace-1:external-change":{fingerprint:"e".repeat(64)}});
  check("Index drift after selection blocks export", !(await call({type:"cgx-v02-pilot-start",gateToken:preparedForDrift.gateToken})).ok && exportCalls === 0);

  for (const mode of ["cancelled", "interrupted", "media", "wrong"]) {
    seed();
    const prepared = await call({type:"cgx-v02-pilot-prepare",target});
    exportMode = mode;
    const failed = await call({type:"cgx-v02-pilot-start",gateToken:prepared.gateToken});
    check(mode + " export leaves real index unchanged", !failed.ok && Object.keys(store["cgx-export-index"]).length === 65 && !store["cgx-v02-pilot-pending-v1"]);
  }

  seed();
  const prepared = await call({type:"cgx-v02-pilot-prepare",target});
  check("Exact new target prepares one opaque gate", prepared.ok && prepared.selectionCount === 1 && prepared.gateToken && Object.keys(store["cgx-export-index"]).length === 65);
  const downloaded = await call({type:"cgx-v02-pilot-start",gateToken:prepared.gateToken});
  check("Browser completion creates pending receipt only", downloaded.ok && downloaded.indexCommitted === false && store["cgx-v02-pilot-pending-v1"].status === "browser_download_complete_v01_pending");
  check("Browser completion preserves all 65 real index entries", Object.keys(store["cgx-export-index"]).length === 65 && !store["cgx-export-index"][target.workspaceId+":"+target.conversationId]);
  const wrongReceipt = {schema:"cgx-v02-pilot-v01-receipt-v1",status:"accepted",v01_status:"processed_new",conversation_id:target.conversationId,workspace_id:target.workspaceId,zip_sha256:"c".repeat(64),manifest_sha256:"b".repeat(64),conversation_count:1};
  check("Mismatched V0.1 receipt cannot commit", !(await call({type:"cgx-v02-pilot-finalize",receipt:wrongReceipt})).ok && Object.keys(store["cgx-export-index"]).length === 65);
  const receipt = {...wrongReceipt,zip_sha256:"a".repeat(64),verified_at:"2026-11-17T10:00:00+08:00"};
  const committed = await call({type:"cgx-v02-pilot-finalize",receipt});
  check("Verified V0.1 receipt commits only selected key", committed.ok && committed.indexCount === 66 && Object.keys(store["cgx-export-index"]).length === 66);
  check("Original 65 entries remain byte-equivalent", Object.entries(baseIndex).every(([key,value]) => JSON.stringify(store["cgx-export-index"][key]) === JSON.stringify(value)));
  const repeated = await call({type:"cgx-v02-pilot-finalize",receipt});
  check("Repeated receipt is idempotent", repeated.ok && repeated.alreadyCommitted && Object.keys(store["cgx-export-index"]).length === 66);
  check("23:45 scheduler remains disabled", store["cgx-v02-scheduler"].enabled === false);
  check("Pilot never changes last full export timestamp", store["cgx-last-full-export"] === 1700000000000);

  console.log("PASS TOTAL " + passed);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
