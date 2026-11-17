// Exercises the REAL cgxV02DownloadZip function from src/content.js
// with a synthetic browser bridge. No ChatGPT account or ZIP is accessed.
// Run: node tests/v02_content_download_barrier_smoke.js
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");

const content=fs.readFileSync(path.join(__dirname,"../src/content.js"),"utf8");
const begin=content.indexOf("  async function cgxV02DownloadZip(filename,blob){");
const end=content.indexOf("\n  }\n\n  function exportFileStamp()",begin);
assert.ok(begin>=0&&end>begin,"Scheduled ZIP function not found.");
const fnSource=content.slice(begin,end+4);
assert.ok(content.indexOf("if(opts.v02Scheduled || opts.v02Pilot)") <
  content.indexOf("await api.storage.local.set({'cgx-export-index':nextIndex"),
  "Index commit must occur after scheduled download receipt.");
assert.ok(content.includes("if((opts.v02Scheduled||opts.v02Pilot) && items.length>10)"),
  "Final scan must re-check 10-change ceiling.");
assert.ok(content.includes("totalErrors>0 || totalImageFailures>0 || totalFileFailures>0"),
  "Partial media/conversation failure must refuse index commit.");

let passed=0;
const check=(name,ok)=>{
  assert.ok(ok,name);
  passed++;
  console.log("PASS "+name);
};
const factory=new Function("api","document","URL","Blob","checkCancelled","setTimeout",
  fnSource+"\nreturn cgxV02DownloadZip;");
function sandbox({registered={ok:true,token:"token-1"},
  receipt={ok:true,status:"browser_download_complete",byteCount:1024},
  clickError=null, cancelAfter=999}={}){
  const calls=[];
  let checks=0;
  const api={runtime:{async sendMessage(msg){
    calls.push("message:"+msg.type);
    if(msg.type==="cgx-v02-watch-zip")return registered;
    if(msg.type==="cgx-v02-await-zip")return receipt;
    if(msg.type==="cgx-v02-abort-zip")return {ok:true};
    throw Error("Unexpected message type");
  }}};
  const document={
    createElement(type){
      assert.equal(type,"a");
      return {
        set href(url){calls.push("href");},
        set download(name){calls.push("filename");},
        click(){calls.push("click");if(clickError)throw clickError;},
        remove(){calls.push("remove");}
      };
    },
    body:{appendChild(){calls.push("append");}}
  };
  const url={
    createObjectURL(blob){calls.push("createURL");return "blob:https://chatgpt.com/mock";},
    revokeObjectURL(){calls.push("revoke");}
  };
  const checkCancelled=()=>{
    checks++;
    if(checks===cancelAfter)throw new Error("cancelled");
  };
  const fn=factory(api,document,url,Blob,checkCancelled,fn=>{},);
  return {fn,calls};
}
async function main(){
  check("Scheduled receipt function is extracted from current source",
    fnSource.includes("browser_download_complete"));
  const one=sandbox();
  const downloaded=await one.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)]));
  check("Browser confirmation permits completion",downloaded.ok);
  check("Register happens BEFORE anchor click",
    one.calls.indexOf("message:cgx-v02-watch-zip") < one.calls.indexOf("click"));
  check("Receipt happens AFTER anchor click",
    one.calls.indexOf("message:cgx-v02-await-zip") > one.calls.indexOf("click"));
  const interrupted=sandbox({receipt:{ok:false,error:"ZIP interrupted"}});
  await assert.rejects(interrupted.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)])),/interrupted/i);
  check("Interrupted download blocks scheduled success",true);
  check("Failed download releases observer",
    interrupted.calls.includes("message:cgx-v02-abort-zip"));
  const deniedClick=sandbox({clickError:new Error("click blocked")});
  await assert.rejects(deniedClick.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)])),/click blocked/);
  check("Failed anchor click releases observer",
    deniedClick.calls.includes("message:cgx-v02-abort-zip"));
  const timeout=sandbox({receipt:{ok:false,error:"Timeout; index unchanged"}});
  await assert.rejects(timeout.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)])),/Timeout/i);
  check("Receipt timeout blocks scheduled success",true);
  const unavailable=sandbox({registered:{ok:false,error:"Tracker unavailable"}});
  await assert.rejects(unavailable.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)])),/Tracker unavailable/);
  check("Unregistered download never clicks",!unavailable.calls.includes("click"));
  const cancelled=sandbox({cancelAfter:2});
  await assert.rejects(cancelled.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([new Uint8Array(1024)])),/cancelled/);
  check("Cancellation after receipt blocks success",true);
  const empty=sandbox();
  await assert.rejects(empty.fn("chatgpt-export_2026-11-17_14-00-00.zip",
    new Blob([])),/empty/i);
  check("Empty ZIP cannot begin download",!empty.calls.includes("click"));
  check("Index commit follows awaiting browser receipt in source",
    content.indexOf("if(opts.v02Scheduled || opts.v02Pilot)") <
    content.indexOf("await api.storage.local.set({'cgx-export-index':nextIndex"));
  check("Pilot download never uses ordinary untracked download",
    content.includes("if(opts.v02Scheduled || opts.v02Pilot)"));
  console.log("PASS TOTAL "+passed);
}
main().catch(err=>{console.error(err);process.exitCode=1});
