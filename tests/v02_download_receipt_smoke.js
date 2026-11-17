// Mock-only V0.2 download receipt tests. No real user files.
"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),
  path=require("node:path"),vm=require("node:vm");
async function main(){
  const source=fs.readFileSync(path.join(__dirname,"../src/background.js"),"utf8");
  const content=fs.readFileSync(path.join(__dirname,"../src/content.js"),"utf8");
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"../manifest.json"),"utf8"));
  let seq=0,passed=0;
  const listeners={messages:[],created:[],changed:[]},downloads=new Map();
  const store={};
  const api={
    runtime:{id:"mock-ext",onMessage:{addListener:f=>listeners.messages.push(f)},
      onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    storage:{local:{async get(keys){const out={};for(const k of keys)if(Object.hasOwn(store,k))out[k]=store[k];return out;},
      async set(obj){Object.assign(store,obj);}}},
    alarms:{onAlarm:{addListener(){}},async create(){},async clear(){}},
    tabs:{async query(){return[]},async create(){throw Error("unexpected tab")},async sendMessage(){throw Error("unexpected")}},
    downloads:{
      onCreated:{addListener:f=>listeners.created.push(f)},
      onChanged:{addListener:f=>listeners.changed.push(f)},
      async search(q){return downloads.has(q.id)?[downloads.get(q.id)]:[];}
    }
  };
  const sandbox=vm.createContext({
    chrome:api,URL,Date,Intl,console,setTimeout,clearTimeout,
    crypto:{randomUUID:()=>("mock-token-"+(++seq))}
  });
  vm.runInContext(source+"\nglobalThis.__test={activate(v){cgxV02Active=v;}};",sandbox);
  const who={id:"mock-ext",url:"https://chatgpt.com/c/123456789",tab:{id:42}};
  const call=(message,sender=who)=>new Promise((resolve,reject)=>{
    for(const fn of listeners.messages)if(fn(message,sender,resolve)===true)return;
    reject(Error("No message handler"));
  });
  const check=(name,yes)=>{assert.ok(yes,name);console.log("PASS "+name);passed++};
  const zip=(suffix)=>({
    type:"cgx-v02-watch-zip",
    url:"blob:https://chatgpt.com/"+suffix,
    filename:"chatgpt-export_2026-11-17_14-00-00.zip",
    expectedBytes:2048
  });
  const item=(url,id,size,state="complete")=>({
    url,id,fileSize:size,bytesReceived:size,state,tabId:42,
    filename:"C:\\Users\\Operator\\Downloads\\chatgpt-export_2026-11-17_14-00-00.zip"
  });
  const created=(it)=>listeners.created.forEach(f=>f(it));
  const changed=(id,state)=>listeners.changed.forEach(f=>f({id,state:{current:state}}));
  check("download permission declared",manifest.permissions.includes("downloads"));
  check("manual anchor path preserved",content.includes("function download(filename,blob)"));
  check("scheduled ZIP awaits confirmation",content.includes("if(opts.v02Scheduled) await cgxV02DownloadZip(name,blob)"));
  check("delta rechecked before creating ZIP",content.includes("if(opts.v02Scheduled && items.length>10)"));
  check("disabled scheduler blocks registration",!(await call(zip("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))).ok);
  vm.runInContext("__test.activate(true)",sandbox);
  check("wrong origin is rejected",!(await call(zip("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    {id:"mock-ext",url:"https://other.invalid",tab:{id:42}})).ok);
  check("non-ZIP name is rejected",!(await call({...zip("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),filename:"bad.txt"})).ok);
  const one=zip("11111111-2222-3333-4444-555555555555");
  const reg=await call(one);
  check("valid observer registration",reg.ok&&reg.token);
  const waiting=call({type:"cgx-v02-await-zip",token:reg.token});
  downloads.set(101,item(one.url,101,2048));
  created(item(one.url,101,2048,"in_progress"));
  changed(101,"complete");
  check("same-URL completed ZIP acknowledged",(await waiting).ok);
  check("token consumed once",!(await call({type:"cgx-v02-await-zip",token:reg.token})).ok);
  const two=zip("22222222-2222-3333-4444-555555555555");
  const t2=await call(two),p2=call({type:"cgx-v02-await-zip",token:t2.token});
  downloads.set(102,item(two.url,102,2048));
  created(item(two.url,102,2048,"in_progress"));changed(102,"interrupted");
  check("interrupted ZIP fails closed",!(await p2).ok);
  const three=zip("33333333-2222-3333-4444-555555555555");
  const t3=await call(three),p3=call({type:"cgx-v02-await-zip",token:t3.token});
  downloads.set(103,item(three.url,103,1024));
  created(item(three.url,103,2048,"in_progress"));changed(103,"complete");
  check("size mismatch is rejected",!(await p3).ok);
  const four=zip("44444444-2222-3333-4444-555555555555");
  const t4=await call(four),p4=call({type:"cgx-v02-await-zip",token:t4.token});
  downloads.set(104,item("blob:https://chatgpt.com/different",104,2048));
  created(item(four.url,104,2048,"in_progress"));changed(104,"complete");
  check("wrong blob origin result rejected",!(await p4).ok);
  check("tracker never modifies historical index",!store["cgx-export-index"]);
  console.log("PASS TOTAL "+passed);
}
main().catch(e=>{console.error(e);process.exitCode=1});
