import{describe,test,expect}from"bun:test";import{HooksDispatcher}from"./dispatcher";import type{Plugin,ToolResult}from"@subbrain/plugin";
describe("HooksDispatcher",()=>{
 test("registration order respected for before hooks",async()=>{
  const order:string[]=[];
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onToolBefore(async()=>{order.push("p1");});}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onToolBefore(async()=>{order.push("p2");});}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  await d.runToolBefore("t",{},{});expect(order).toEqual(["p1","p2"]);
 });
 test("error isolation — throw in hook N does not stop hook N+1",async()=>{
  const order:string[]=[];
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onToolBefore(async()=>{throw new Error("boom");});}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onToolBefore(async()=>{order.push("p2");});}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  await d.runToolBefore("t",{},{});expect(order).toEqual(["p2"]);
 });
 test("short-circuit — before hook returns non-success stops remaining",async()=>{
  const order:string[]=[];
  const failResult:ToolResult={kind:"failure",error:{code:"x",message:"m"}};
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onToolBefore(async()=>failResult);}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onToolBefore(async()=>{order.push("p2");});}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  const result=await d.runToolBefore("t",{},{});expect(result).toBe(failResult);expect(order).toEqual([]);
 });
 test("after-hooks run even on short-circuit",async()=>{
  const order:string[]=[];
  const failResult:ToolResult={kind:"failure",error:{code:"x",message:"m"}};
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onToolBefore(async()=>failResult);hooks.onToolAfter(async()=>{order.push("p1-after");});}};
  const d=new HooksDispatcher();d.register(p1);
  const result=await d.runToolBefore("t",{},{});expect(result).toBe(failResult);
  await d.runToolAfter("t",{},failResult);expect(order).toEqual(["p1-after"]);
 });
 test("permission ask default true, one false → false",async()=>{
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onPermissionAsk(async()=>true);}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onPermissionAsk(async()=>false);}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  expect(await d.runPermissionAsk("t",{})).toBe(false);
 });
 test("permission ask default true when no handlers",async()=>{
  const d=new HooksDispatcher();expect(await d.runPermissionAsk("t",{})).toBe(true);
 });
 test("chat params merge — last writer wins",async()=>{
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onChatParams(async()=>({model:"a",messages:[],tools:[]}));}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onChatParams(async()=>({model:"b",messages:[],tools:[]}));}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  const result=await d.runChatParams({model:"x",messages:[],tools:[]});expect(result).toEqual({model:"b",messages:[],tools:[]});
 });
 test("chat params returns undefined when no handlers",async()=>{
  const d=new HooksDispatcher();const result=await d.runChatParams({model:"x",messages:[],tools:[]});expect(result).toBeUndefined();
 });
 test("system transform piping",async()=>{
  const p1:Plugin={name:"p1",setup({hooks}){hooks.onChatSystemTransform(async({system})=>system+"-A");}};
  const p2:Plugin={name:"p2",setup({hooks}){hooks.onChatSystemTransform(async({system})=>system+"-B");}};
  const d=new HooksDispatcher();d.register(p1);d.register(p2);
  const result=await d.runChatSystemTransform("base",{});expect(result).toBe("base-A-B");
 });
});
