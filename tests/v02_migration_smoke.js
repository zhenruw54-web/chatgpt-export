// V0.2 migration and scheduler smoke tests: no third-party dependencies.
// Developer-only command: node tests/v02_migration_smoke.js
// Does NOT open Edge, download ZIP files or access real extension storage.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/background.js"), "utf8"
  );
  const db = Object.create(null);
  const alarms = Object.create(null);
  const listeners = { message: [], alarms: [] };
  const sent = [];
  const api = {
    runtime: {
      id: "test-extension",
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} }
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(db, key)) out[key] = db[key];
          }
          return out;
        },
        async set(values) { Object.assign(db, values); }
      }
    },
    alarms: {
      onAlarm: { addListener(fn) { listeners.alarms.push(fn); } },
      async create(name, options) { alarms[name] = options; },
      async clear(name) { delete alarms[name]; return true; }
    },
    tabs: {
      async query() { return [{ id: 8, status: "complete", url: "https://chatgpt.com/" }]; },
      async create() { throw new Error("Unexpected tab creation"); },
      async sendMessage(id, message) {
        sent.push({ id, message });
        if (message.type === "cgx-ping") return { ok: true };
        if (message.type === "cgx-v02-auto-export")
          return { ok: true, count: 1, failed: 0, parts: 1, imageFailures: 0, fileFailures: 0 };
        throw new Error("Unexpected tab message");
      }
    }
  };
  const sandbox = vm.createContext({
    chrome: api, console, Date, Intl, setTimeout, clearTimeout,
    fetch: () => { throw new Error("Unexpected fetch"); }
  });
  vm.runInContext(source + "\n" +
    "globalThis.__test = { read: cgxV02Read, run: cgxV02Run, next: cgxV02NextBeijing2345 };",
    sandbox, { filename: "background.js" });
  await Promise.resolve();
  const exposed = sandbox.__test;
  const toRealm = value =>
    vm.runInContext("JSON.parse(" + JSON.stringify(JSON.stringify(value)) + ")", sandbox);

  async function call(msg, url = "chrome-extension://test-extension/popup/popup.html") {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const fn of listeners.message) {
        const response = fn(toRealm(msg), { url }, resolve);
        if (response === true) { handled = true; break; }
      }
      if (!handled) reject(new Error("No listener"));
    });
  }
  let assertions = 0;
  function check(message, cond) {
    assert.ok(cond, message);
    assertions++;
    process.stdout.write("PASS " + message + "\n");
  }

  const ids = Array.from({ length: 65 }, (_, i) =>
    "conv-" + String(i + 1).padStart(8, "0"));
  const index = Object.fromEntries(ids.map((id, i) => [
    "personal:" + id,
    { fingerprint: String(i % 10).repeat(64), updated_at: "2026-11-16T10:00:00Z" }
  ]));
  const sourceFile = {
    schema: "cgx-index-transfer-v1",
    index,
    last_full_export: Date.now() - 24 * 3600 * 1000
  };
  const baselineFile = {
    schema: "cgx-v01-baseline-v1",
    conversation_ids: ids
  };

  check("Disabled without migration", !(await exposed.read()).indexReady);
  const badSender = await call({
    type: "cgx-v02-import-index", source: sourceFile, baseline: baselineFile
  }, "https://chatgpt.com/c/123");
  check("Content-script sender cannot import", badSender.ok === false);

  const partialIndex = Object.fromEntries(Object.entries(index).slice(1));
  const missing = await call({
    type: "cgx-v02-import-index",
    source: { ...sourceFile, index: partialIndex },
    baseline: baselineFile
  });
  check("Missing one baseline ID refuses migration", missing.ok === false);
  check("Rejected import never writes index", !db["cgx-export-index"]);

  const migrated = await call({
    type: "cgx-v02-import-index", source: sourceFile, baseline: baselineFile
  });
  check("All 65 IDs migrate", migrated.ok && migrated.matchedBaselineIds === 65);
  check("Readback unlocks baseline gate", (await exposed.read()).indexReady === true);

  const again = await call({
    type: "cgx-v02-import-index", source: sourceFile, baseline: baselineFile
  });
  check("No silent overwrite of existing index", again.ok === false);

  const day1 = exposed.next(Date.parse("2026-11-17T09:00:00Z"));
  const day2 = exposed.next(Date.parse("2026-11-17T16:00:00Z"));
  check("23:45 Asia/Shanghai schedule", day1 === Date.parse("2026-11-17T15:45:00Z") &&
    day2 === Date.parse("2026-11-18T15:45:00Z"));

  const enabled = await call({ type: "cgx-v02-set", enabled: true });
  check("Scheduler enabled only after migration", enabled.ok && enabled.indexReady);
  const exported = await exposed.run("manual");
  check("Manual scheduled export starts", exported.ok && exported.count === 1);
  const request = sent.find(x => x.message.type === "cgx-v02-auto-export");
  check("No deletion; incremental ZIP with media and JSON",
    request && request.message.options.incremental === true &&
    request.message.options.autoDeleteAfterExport === false &&
    request.message.options.images === true &&
    request.message.options.files === true &&
    request.message.options.json === true);

  // Simulate damaged imported storage on a later day; the guard must fail closed.
  const corrupted = { ...index };
  delete corrupted["personal:" + ids[0]];
  db["cgx-export-index"] = toRealm(corrupted);
  const state = db["cgx-v02-scheduler"];
  state.lastAttemptAt = 0;
  check("Tampering revokes baseline readiness", !(await exposed.read()).indexReady);
  const blocked = await exposed.run("manual");
  check("Damaged baseline blocks export", !blocked.ok && blocked.status === "blocked_no_baseline");
  const disabled = await call({ type: "cgx-v02-set", enabled: false });
  check("Disabling clears alarm", disabled.ok && Object.keys(alarms).length === 0);

  // Separate synthetic 63 direct + 2 shared-list backing-ID case.
  // A new local migration target is simulated; no real data is touched.
  delete db["cgx-export-index"];
  delete db["cgx-v02-index-migration"];
  delete db["cgx-last-full-export"];
  const sharedPairs = [
    { target: ids[63], backing: "shared-00000001" },
    { target: ids[64], backing: "shared-00000002" }
  ];
  const oldIndex = Object.fromEntries([
    ...ids.slice(0, 63).map((id, i) => [
      "workspace-1:" + id,
      { fingerprint: String(i % 10).repeat(64), updated_at: "2026-11-16T09:00:00Z" }
    ]),
    ...sharedPairs.map((pair, i) => [
      "workspace-1:" + pair.backing,
      { fingerprint: (i ? "a" : "b").repeat(64), updated_at: "2026-11-16T10:00:00Z" }
    ])
  ]);
  const sharedSource = {
    schema: "cgx-index-transfer-v1", index: oldIndex,
    last_full_export: Date.now() - 24 * 3600 * 1000
  };
  const aliasProof = {
    schema: "cgx-v02-shared-alias-proof-v1",
    mappings: sharedPairs.map(pair => ({
      raw: {
        conversation_id: pair.target, backing_conversation_id: pair.backing,
        workspace_id: "workspace-1"
      },
      metadata: { conversation_id: pair.target, workspace_id: "workspace-1" },
      index: {
        key: "workspace-1:" + pair.backing, workspace_id: "workspace-1",
        fingerprint: oldIndex["workspace-1:" + pair.backing].fingerprint,
        updated_at: oldIndex["workspace-1:" + pair.backing].updated_at
      },
      raw_sha256: "a".repeat(64), metadata_sha256: "b".repeat(64)
    }))
  };
  const missingProof = await call({
    type: "cgx-v02-import-index", source: sharedSource, baseline: baselineFile
  });
  check("63+2 without proof blocked", missingProof.ok === false);
  const crossed = JSON.parse(JSON.stringify(aliasProof));
  crossed.mappings[0].raw.backing_conversation_id = sharedPairs[1].backing;
  const crossedResult = await call({
    type: "cgx-v02-import-index", source: sharedSource,
    baseline: baselineFile, aliasProof: crossed
  });
  check("Crossed backing-ID proof rejected", crossedResult.ok === false);
  const timestampMismatch = JSON.parse(JSON.stringify(aliasProof));
  timestampMismatch.mappings[0].index.updated_at = "2000-01-01T00:00:00Z";
  const mismatchedResult = await call({
    type: "cgx-v02-import-index", source: sharedSource,
    baseline: baselineFile, aliasProof: timestampMismatch
  });
  check("Shared proof timestamp mismatch rejected", mismatchedResult.ok === false);
  check("Invalid shared proof cannot write target index",
    !db["cgx-export-index"] && !db["cgx-v02-index-migration"]);
  const sharedImported = await call({
    type: "cgx-v02-import-index", source: sharedSource,
    baseline: baselineFile, aliasProof
  });
  check("63 direct + 2 verified backing aliases accepted",
    sharedImported.ok && sharedImported.matchedBaselineIds === 65 &&
    sharedImported.mappedSharedAliases === 2);
  check("Original index keys and fingerprints remain unchanged",
    JSON.stringify(db["cgx-export-index"]) === JSON.stringify(oldIndex));
  check("Shared alias receipt revalidates after import",
    (await exposed.read()).indexReady === true);
  const damaged = { ...oldIndex };
  delete damaged["workspace-1:" + sharedPairs[0].backing];
  db["cgx-export-index"] = toRealm(damaged);
  check("Loss of a verified shared alias fails closed",
    (await exposed.read()).indexReady === false);

  console.log("PASS TOTAL " + assertions);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
