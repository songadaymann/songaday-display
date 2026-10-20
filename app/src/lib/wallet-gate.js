// Show crypto parts only when this browser has a wallet installed (crypto-wallet-gate skill).
// Sets <html data-wallet="yes|no"> and fires a `wallet-gate` event; pair with the CSS
//   [data-crypto]{display:none!important} html[data-wallet="yes"] [data-crypto]{display:revert!important}
// ?crypto=1 / ?crypto=0 force it on or off (remembered), ?crypto=auto goes back to detection.
import {detectWallet} from './wallet-detect.js';

const KEY='crypto-override';
let pending=null;

function override(){
  try{
    const q=new URLSearchParams(location.search).get('crypto');
    if(q==='auto')localStorage.removeItem(KEY);
    else if(q==='1'||q==='0')localStorage.setItem(KEY,q);
    return localStorage.getItem(KEY);
  }catch{return null;}
}

export function applyWalletGate({root=document.documentElement,timeout}={}){
  pending??=(async()=>{
    const forced=override();
    const result=forced?{hasWallet:forced==='1',evm:forced==='1',solana:false,names:[],forced:true}:await detectWallet({timeout});
    root.dataset.wallet=result.hasWallet?'yes':'no';
    window.dispatchEvent(new CustomEvent('wallet-gate',{detail:result}));
    return result;
  })();
  return pending;
}
