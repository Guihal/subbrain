import type { Hooks, Plugin, ToolResult } from "@subbrain/plugin";
import { logger } from "@subbrain/core/lib/logger";

function le(name:string,err:unknown){logger.error("plugin",name,{meta:{error:err instanceof Error?err.message:String(err)}});}

type B=(args:{toolName:string;args:unknown;ctx:unknown})=>Promise<ToolResult|void>;
type A=(args:{toolName:string;args:unknown;result:ToolResult})=>Promise<void>;
type ChatParams={model:string;messages:unknown[];tools:unknown[];temperature?:number;max_tokens?:number};
type C=(params:ChatParams)=>Promise<void|ChatParams>;
type S=(args:{system:string;ctx:unknown})=>Promise<string>;
type P=(args:{toolName:string;args:unknown})=>Promise<boolean|void>;

class PluginHooks implements Hooks {
  b:B[]=[];a:A[]=[];c:C[]=[];s:S[]=[];p:P[]=[];
  onToolBefore(h:B){this.b.push(h);}
  onToolAfter(h:A){this.a.push(h);}
  onChatParams(h:C){this.c.push(h);}
  onChatSystemTransform(h:S){this.s.push(h);}
  onPermissionAsk(h:P){this.p.push(h);}
}

export class HooksDispatcher {
  private plugins:Plugin[]=[];
  private hooksMap=new Map<Plugin,PluginHooks>();
  register(plugin:Plugin):void{
    const hooks=new PluginHooks();
    this.plugins.push(plugin);
    this.hooksMap.set(plugin,hooks);
    plugin.setup({hooks});
  }
  async runToolBefore(toolName:string,args:unknown,ctx:unknown):Promise<ToolResult|void>{
    for(const plugin of this.plugins){
      for(const handler of this.hooksMap.get(plugin)!.b){
        try {const result=await handler({toolName,args,ctx});if(result&&result.kind!=="success")return result;}
        catch(err){le(plugin.name,err);}
      }
    }
  }
  async runToolAfter(toolName:string,args:unknown,result:ToolResult):Promise<void>{
    for(const plugin of this.plugins){
      for(const handler of this.hooksMap.get(plugin)!.a){
        try {await handler({toolName,args,result});}
        catch(err){le(plugin.name,err);}
      }
    }
  }
  async runChatParams(params:ChatParams):Promise<void|ChatParams>{
    let merged:ChatParams|undefined;
    for(const plugin of this.plugins){
      for(const handler of this.hooksMap.get(plugin)!.c){
        try {const r=await handler(merged??params);if(r)merged=r;}
        catch(err){le(plugin.name,err);}
      }
    }
    return merged;
  }
  async runChatSystemTransform(system:string,ctx:unknown):Promise<string>{
    let out=system;
    for(const plugin of this.plugins){
      for(const handler of this.hooksMap.get(plugin)!.s){
        try {out=await handler({system:out,ctx});}
        catch(err){le(plugin.name,err);}
      }
    }
    return out;
  }
  async runPermissionAsk(toolName:string,args:unknown):Promise<boolean>{
    for(const plugin of this.plugins){
      for(const handler of this.hooksMap.get(plugin)!.p){
        try {const r=await handler({toolName,args});if(r===false)return false;}
        catch(err){le(plugin.name,err);}
      }
    }
    return true;
  }
}
