// Small pure scheduler used by the realtime hook. Coalesces invalidations
// from duplicate or out-of-order events; the authoritative fetch is separate.
export function createScopedRefreshQueue(isVisible:()=>boolean,refresh:()=>void,delay=350){
 let timer:ReturnType<typeof setTimeout>|null=null,disposed=false
 return {
  wake(){
   if(disposed||!isVisible()||timer!==null)return
   timer=setTimeout(()=>{timer=null;if(!disposed&&isVisible())refresh()},delay)
  },
  dispose(){disposed=true;if(timer!==null){clearTimeout(timer);timer=null}}
 }
}
