/**
 * 농가 평가체계 AHP 설문 — 응답 수집 및 결과 계산 (Google Apps Script)
 *
 * 응답:  설문 홈페이지가 보낸 응답을 '응답' 시트에 평가자 번호별로 한 줄씩 저장합니다.
 *        같은 평가자 번호로 다시 제출하면 그 줄을 덮어씁니다.
 * 결과:  시트 상단 메뉴 [AHP] > [결과 계산]을 누르면 아래 세 시트를 새로 씁니다.
 *        - 종합중요도 : 모든 항목의 상위 항목 안 비중과 최종 가중치(통합·평가자별), 최하위 요소 순위
 *        - 세부결과   : 비교 묶음별 쌍대비교 값, 결과 중요도, 비일관성 비율(통합·평가자별),
 *                       Super Decisions 입력용 통합 쌍대비교 행렬
 *        - 민감도     : 1계층(부문) 가중치 ±10% 시 최하위 요소의 최종 가중치·순위와 MAD
 *        - ANP        : 슈퍼매트릭스(비가중·가중), 극한 가중치, AHP 가중치와의 비교
 *
 * TREE와 LINKS는 index.html의 TREE, LINKS와 똑같아야 합니다.
 */

const TREE = {id:"G", name:"농가 단위 가치 평가", children:[
  {id:"E", name:"환경", children:[{id:"E1",name:"토양"},{id:"E2",name:"수질"},{id:"E3",name:"대기"},{id:"E4",name:"생태"}]},
  {id:"S", name:"사회", children:[{id:"S1",name:"인적 기반"},{id:"S2",name:"영농 활동 기반"},{id:"S3",name:"지역사회 기반"}]},
  {id:"C", name:"경제", children:[{id:"C1",name:"수익성"},{id:"C2",name:"생산성"},{id:"C3",name:"안정성"}]},
]};
/* ANP 영향 관계(DEMATEL 유의관계): "A>B" = A가 B에 영향을 준다 */
const LINKS = "E1>E2 E1>E3 E1>E4 E1>S2 E1>C1 E1>C2 E1>C3 E2>E1 E2>E4 E2>S2 E2>C1 E2>C2 E2>C3 E4>C1 S1>E1 S1>S2 S1>S3 S1>C1 S1>C2 S1>C3 S2>C1 S2>C2 S3>S1 S3>S2 S3>C1 S3>C2 S3>C3 C1>S1 C1>S2 C1>S3 C1>C2 C1>C3 C2>S2 C2>C1 C2>C3 C3>S2 C3>C1 C3>C2";
const CR_LIMIT = 0.1;     // 비일관성 비율 기준
const SHOCK = 0.1;        // 민감도 분석 충격 크기(±10%)
const RESP_SHEET = "응답";

const RI = [0,0,0,0.58,0.90,1.12,1.24,1.32,1.41,1.45,1.49,1.51,1.48,1.56,1.57,1.59];

/* ---------- 계층 ---------- */
const NODES = {}, ORDER = [];
(function walk(n, parent, depth){ n.parent=parent; n.depth=depth; NODES[n.id]=n; ORDER.push(n); (n.children||[]).forEach(c=>walk(c,n,depth+1)); })(TREE,null,0);
const GROUPS = ORDER.filter(n=>n.children && n.children.length>=2).map(n=>({id:n.id, node:n, kind:"ahp", label:n.name, items:n.children.map(c=>c.name)}));
const LEAVES = ORDER.filter(n=>!n.children);

/* ---------- ANP 네트워크 ---------- */
const PILLARS = TREE.children;
const ELEMS = PILLARS.reduce((a,p)=>a.concat(p.children),[]);
const LINK = LINKS.trim().split(/\s+/).map(x=>x.split(">"));
function hasLink(a,b){ return LINK.some(l=>l[0]===a&&l[1]===b); }
function sourcesIn(t,P){ return P.children.filter(c=>c.id!==t.id && hasLink(c.id,t.id)); }
function clusterSources(Pt){ return PILLARS.filter(P=>Pt.children.some(t=>sourcesIn(t,P).length>0)); }
const ANP_GROUPS = [];
ELEMS.forEach(t=>PILLARS.forEach(P=>{ const src=sourcesIn(t,P);
  if(src.length>=2) ANP_GROUPS.push({id:"N."+t.id+"."+P.id, kind:"anp", label:"ANP "+t.name+" ← "+P.name+" 요소", items:src.map(c=>c.name)}); }));
PILLARS.forEach(Pt=>{ const src=clusterSources(Pt);
  if(src.length>=2) ANP_GROUPS.push({id:"K."+Pt.id, kind:"anp", label:"ANP 부문 간 영향 → "+Pt.name, items:src.map(P=>P.name)}); });
const ALL_GROUPS = GROUPS.concat(ANP_GROUPS);

/* 묶음별 결과(res) → 비가중 슈퍼매트릭스, 부문 가중치, 가중 슈퍼매트릭스, 극한 가중치
   열 = 영향을 받는 요소, 행 = 영향을 주는 요소 */
function anp_(res){
  const n=ELEMS.length, idx={}; ELEMS.forEach((e,i)=>idx[e.id]=i);
  const Z=()=>{ const m=[]; for(let i=0;i<n;i++){ m.push([]); for(let j=0;j<n;j++) m[i].push(0); } return m; };
  const U=Z(), Wt=Z(), CW={};
  let ok=true;
  PILLARS.forEach(Pt=>{ CW[Pt.id]={}; const src=clusterSources(Pt);
    if(src.length===1) CW[Pt.id][src[0].id]=1;
    else if(src.length>=2){ const r=res["K."+Pt.id]; if(!r){ ok=false; return; } src.forEach((P,k)=>CW[Pt.id][P.id]=r.w[k]); } });
  ELEMS.forEach((t,j)=>{
    const Pt=PILLARS.filter(P=>P.children.indexOf(t)>=0)[0];
    const present=[];
    PILLARS.forEach(P=>{ const src=sourcesIn(t,P); if(!src.length) return;
      let w; if(src.length===1) w=[1]; else { const r=res["N."+t.id+"."+P.id]; if(!r){ ok=false; return; } w=r.w; }
      src.forEach((c,k)=>U[idx[c.id]][j]=w[k]); present.push(P); });
    const tot=present.reduce((a,P)=>a+(CW[Pt.id][P.id]||0),0);
    present.forEach(P=>{ const cw=tot>0?(CW[Pt.id][P.id]||0)/tot:0; sourcesIn(t,P).forEach(c=>Wt[idx[c.id]][j]=U[idx[c.id]][j]*cw); });
  });
  if(!ok) return null;
  const mul=(A,B)=>{ const C=Z(); for(let i=0;i<n;i++) for(let k=0;k<n;k++){ const a=A[i][k]; if(a) for(let j=0;j<n;j++) C[i][j]+=a*B[k][j]; } return C; };
  let Pw=Wt; for(let k=0;k<12;k++) Pw=mul(Pw,Pw);           // W^4096
  const P2=mul(Pw,Wt);                                        // W^4097 (주기성 대비 평균)
  const lim=ELEMS.map((_,i)=>{ let s=0; for(let j=0;j<n;j++) s+=(Pw[i][j]+P2[i][j])/2; return s/n; });
  const tot=lim.reduce((a,b)=>a+b,0); const w=lim.map(x=>tot>0?x/tot:NaN);
  const global={}, local={}; ELEMS.forEach((e,i)=>global[e.id]=w[i]);
  PILLARS.forEach(P=>{ const s=P.children.reduce((a,c)=>a+global[c.id],0); P.children.forEach(c=>local[c.id]=s>0?global[c.id]/s:0); global[P.id]=s; });
  return {U:U, CW:CW, W:Wt, global:global, local:local};
}

/* ---------- AHP 계산 (설문 화면과 같은 식) ---------- */
function pairs(n){ const p=[]; for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) p.push([i,j]); return p; }
function sToA(s){ return s<9 ? 10-s : s===9 ? 1 : 1/(s-8); }
function matrixFrom(n, getA){ const A=[]; for(let i=0;i<n;i++){ A.push([]); for(let j=0;j<n;j++) A[i].push(1); } pairs(n).forEach(([i,j])=>{ const a=getA(i,j); A[i][j]=a; A[j][i]=1/a; }); return A; }
function analyze(A){
  const n=A.length;
  const gm=A.map(r=>Math.pow(r.reduce((x,y)=>x*y,1),1/n));
  const s=gm.reduce((x,y)=>x+y,0), w=gm.map(g=>g/s);
  const Aw=A.map(r=>r.reduce((acc,v,j)=>acc+v*w[j],0));
  const lam=Aw.reduce((acc,v,i)=>acc+v/w[i],0)/n;
  const CI=n>2?(lam-n)/(n-1):0, CR=n>2?Math.max(0,CI/RI[n]):0;
  return {w:w, lam:lam, CI:CI, CR:CR};
}
function groupResult(g, gs){
  if(!gs || !gs.s) return null;
  const n=g.items.length;
  if(!pairs(n).every(([i,j])=>gs.s[i+"-"+j])) return null;
  const A=matrixFrom(n,(i,j)=>sToA(gs.s[i+"-"+j]));
  const r=analyze(A); r.A=A; return r;
}
/* 묶음별 지역 가중치(local) → 모든 항목의 최종 가중치(global) */
function rollUp(localByGroup){
  const local={}, global={}; global[TREE.id]=1;
  ORDER.forEach(n=>{ if(!n.children) return;
    const lw = n.children.length===1 ? [1] : (localByGroup[n.id] ? localByGroup[n.id].w : null);
    n.children.forEach((c,i)=>{ local[c.id]= lw ? lw[i] : NaN; global[c.id]=global[n.id]*local[c.id]; });
  });
  return {local:local, global:global};
}
function ranks(values){ // 큰 값이 1위, 계산할 수 없는 값은 순위 없음
  const ok=values.map((v,i)=>i).filter(i=>isFinite(values[i]));
  ok.sort((a,b)=>values[b]-values[a]); const r=values.map(()=>""); ok.forEach((i,k)=>r[i]=k+1); return r;
}

/* ---------- 응답 받기 ---------- */
function header_(){
  const h=["평가자 번호","제출 시각"];
  ALL_GROUPS.forEach(g=>{ pairs(g.items.length).forEach(([i,j])=>h.push(g.label+": "+g.items[i]+" vs "+g.items[j]+" (a_ij)")); if(g.items.length>2) h.push(g.label+": CR"); h.push(g.label+": 수정요청 후 유지"); });
  h.push("원자료(JSON)");
  return h;
}
function evaluatorOf_(p){ return String(p.evaluator || p.name || p.token || "").trim(); }

function doPost(e){
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try{
    const p=JSON.parse(e.postData.contents);
    const id=evaluatorOf_(p);
    if(!id) throw new Error("평가자 번호가 없습니다");
    const ss=SpreadsheetApp.getActiveSpreadsheet();
    let sh=ss.getSheetByName(RESP_SHEET);
    const head=header_();
    // 문항 구성이 바뀌었으면 기존 응답 시트는 이름을 바꿔 보관하고 새로 시작
    if(sh && sh.getLastRow()>0 && (sh.getLastColumn()!==head.length || sh.getRange(1,1,1,head.length).getValues()[0].join("|")!==head.join("|"))){
      sh.setName(RESP_SHEET+"_이전_"+Utilities.formatDate(new Date(),"Asia/Seoul","MMdd_HHmm")); sh=null;
    }
    if(!sh) sh=ss.insertSheet(RESP_SHEET);
    if(sh.getLastRow()===0){ sh.appendRow(head); sh.setFrozenRows(1); }

    const row=[id, new Date()];
    ALL_GROUPS.forEach(g=>{ const gs=p.groups&&p.groups[g.id], r=groupResult(g,gs);
      pairs(g.items.length).forEach(([i,j])=>row.push(r?Number(r.A[i][j].toFixed(4)):""));
      if(g.items.length>2) row.push(r?Number(r.CR.toFixed(4)):""); row.push(gs&&gs.override?"Y":""); });
    row.push(JSON.stringify(p));

    const last=sh.getLastRow(); let target=0;
    if(last>1){ const ids=sh.getRange(2,1,last-1,1).getValues(); for(let k=0;k<ids.length;k++) if(String(ids[k][0]).trim()===id){ target=k+2; break; } }
    if(target) sh.getRange(target,1,1,row.length).setValues([row]); else sh.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
  }catch(err){
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)})).setMimeType(ContentService.MimeType.JSON);
  }finally{ lock.releaseLock(); }
}
function doGet(){ return ContentService.createTextOutput("AHP 설문 수집기가 작동 중입니다."); }

/* ---------- 메뉴 ---------- */
function onOpen(){
  SpreadsheetApp.getUi().createMenu("AHP")
    .addItem("결과 계산","computeResults")
    .addItem("응답 코드 불러오기","importCode")
    .addToUi();
}

function readResponses_(){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESP_SHEET);
  if(!sh || sh.getLastRow()<2) return [];
  const lastCol=sh.getLastColumn();
  const vals=sh.getRange(2,1,sh.getLastRow()-1,lastCol).getValues();
  return vals.map(r=>{ try{ const p=JSON.parse(r[lastCol-1]); p.id=evaluatorOf_(p); return p; }catch(e){ return null; } })
             .filter(p=>p && p.id && ALL_GROUPS.every(g=>groupResult(g,p.groups&&p.groups[g.id])));
}

/* ---------- 결과 계산 ---------- */
function analyzeAll_(list){
  // 평가자별
  const persons=list.map(p=>{
    const res={}; ALL_GROUPS.forEach(g=>res[g.id]=groupResult(g,p.groups[g.id]));
    return {id:p.id, res:res, w:rollUp(res), anp:anp_(res), override:ALL_GROUPS.filter(g=>p.groups[g.id].override).map(g=>g.id)};
  });
  // 통합: 묶음마다 CR 기준 통과자의 기하평균
  const agg={};
  ALL_GROUPS.forEach(g=>{
    const n=g.items.length;
    const used=persons.filter(x=>n<=2 || x.res[g.id].CR<=CR_LIMIT);
    if(!used.length){ agg[g.id]=null; return; }
    const A=matrixFrom(n,(i,j)=>Math.exp(used.reduce((acc,x)=>acc+Math.log(x.res[g.id].A[i][j]),0)/used.length));
    const r=analyze(A); r.A=A; r.used=used.map(x=>x.id); agg[g.id]=r;
  });
  return {persons:persons, agg:agg, aggW:rollUp(agg), aggANP:anp_(agg)};
}

function writeSheet_(name, rows){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sh=ss.getSheetByName(name); if(!sh) sh=ss.insertSheet(name); else sh.clear();
  const W=Math.max.apply(null, rows.map(r=>r.length).concat([1]));
  const out=rows.map(r=>{ const x=r.map(v=>v===undefined||v===null||(typeof v==="number"&&!isFinite(v))?"":v); while(x.length<W) x.push(""); return x; });
  if(out.length) sh.getRange(1,1,out.length,W).setValues(out);
  sh.setFrozenColumns(1);
  return sh;
}
const r5 = x => (typeof x==="number" && isFinite(x)) ? Number(x.toFixed(5)) : "";
const indent = n => "　".repeat(Math.max(0,(n.depth-1)*2)) + n.name;

function computeResults(){
  const list=readResponses_();
  if(!list.length){ SpreadsheetApp.getUi().alert("완료된 응답이 없습니다."); return; }
  const R=analyzeAll_(list), P=R.persons, ids=P.map(x=>x.id);

  /* 1) 종합중요도 */
  const s1=[];
  s1.push(["계산 시각", new Date()]);
  s1.push(["평가자 수", P.length, "통합 방식", "비교 묶음별로 비일관성 비율 "+CR_LIMIT+" 이하인 평가자 응답의 기하평균"]);
  s1.push([]);
  s1.push(["최하위 요소의 통합결과 순위"]);
  s1.push(["순위","요소","상위 항목","최종 가중치"]);
  const leafG=LEAVES.map(n=>R.aggW.global[n.id]), leafRank=ranks(leafG);
  const missing=GROUPS.filter(g=>!R.agg[g.id]).map(g=>g.label);
  if(missing.length) s1.push(["※ 기준을 통과한 응답이 없는 비교 묶음: "+missing.join(", ")+" — 해당 요소의 통합 가중치를 계산할 수 없습니다."]);
  LEAVES.map((n,i)=>({n:n,g:leafG[i],r:leafRank[i]})).sort((a,b)=>(a.r||1e9)-(b.r||1e9))
    .forEach(x=>s1.push([x.r, x.n.name, x.n.parent.name, r5(x.g)]));
  s1.push([]);
  s1.push(["항목별 중요도 — 상위 항목 안 비중(local)"]);
  s1.push(["항목","통합결과"].concat(ids));
  ORDER.slice(1).forEach(n=>s1.push([indent(n), r5(R.aggW.local[n.id])].concat(P.map(x=>r5(x.w.local[n.id])))));
  s1.push([]);
  s1.push(["항목별 중요도 — 최종 가중치(global) = 상위 항목의 최종 가중치 × 상위 항목 안 비중"]);
  s1.push(["항목","통합결과"].concat(ids));
  ORDER.slice(1).forEach(n=>s1.push([indent(n), r5(R.aggW.global[n.id])].concat(P.map(x=>r5(x.w.global[n.id])))));
  s1.push(["최하위 요소 합계", r5(LEAVES.reduce((a,n)=>a+R.aggW.global[n.id],0))].concat(P.map(x=>r5(LEAVES.reduce((a,n)=>a+x.w.global[n.id],0)))));
  s1.push([]);
  s1.push(["비일관성 비율(CR) — 기준 "+CR_LIMIT+" 이하, * 는 수정 요청 후 응답을 유지한 경우"]);
  s1.push(["비교 묶음","통합결과","통과 인원"].concat(ids));
  ALL_GROUPS.forEach(g=>{ const a=R.agg[g.id];
    s1.push([g.label, g.items.length>2&&a?r5(a.CR):"-", a?a.used.length+"/"+P.length:"0/"+P.length]
      .concat(P.map(x=>g.items.length>2 ? x.res[g.id].CR.toFixed(4)+(x.res[g.id].CR>CR_LIMIT?" 탈락":"")+(x.override.indexOf(g.id)>=0?" *":"") : "-"))); });
  writeSheet_("종합중요도", s1);

  /* 2) 세부결과 */
  const s2=[];
  ALL_GROUPS.forEach(g=>{ const a=R.agg[g.id], n=g.items.length;
    s2.push([g.label + (g.node && !g.node.parent ? " (1계층)" : "")]);
    s2.push(["요소별 평가 값 (a_ij)","통합결과"].concat(ids));
    pairs(n).forEach(([i,j])=>s2.push([g.items[i]+" — "+g.items[j], a?r5(a.A[i][j]):""].concat(P.map(x=>r5(x.res[g.id].A[i][j])))));
    s2.push([g.kind==="anp" ? "※ 1보다 크면 왼쪽 요소가, 1보다 작으면 오른쪽 요소가 더 큰 영향을 준다는 뜻입니다." : "※ 1보다 크면 왼쪽 요소가, 1보다 작으면 오른쪽 요소가 더 중요함을 뜻합니다."]);
    s2.push(["결과 중요도"]);
    g.items.forEach((it,i)=>s2.push([it, a?r5(a.w[i]):""].concat(P.map(x=>r5(x.res[g.id].w[i])))));
    if(n>2) s2.push(["비일관성 비율", a?r5(a.CR):""].concat(P.map(x=>r5(x.res[g.id].CR))));
    if(a){
      s2.push(["통합 쌍대비교 행렬 (Super Decisions 입력용, 행 요소가 열 요소보다 a배)"].concat(g.items));
      g.items.forEach((it,i)=>s2.push([it].concat(g.items.map((_,j)=>r5(a.A[i][j])))));
      s2.push(["통합에 포함된 평가자", a.used.join(", ")]);
    }
    s2.push([]);
  });
  writeSheet_("세부결과", s2);

  /* 3) 민감도: 1계층 요소 가중치 ±SHOCK, 나머지는 비율대로 조정 */
  const s3=[];
  const top=TREE.children, base=R.aggW.local;
  if(R.agg[TREE.id]){
    const scen=[];
    top.forEach((t,ti)=>[+1,-1].forEach(sign=>{
      const wt=base[t.id]*(1+sign*SHOCK), rest=1-base[t.id];
      const newTop={}; top.forEach(o=>newTop[o.id]= o.id===t.id ? wt : base[o.id]*(1-wt)/rest);
      const loc=Object.assign({}, base, newTop);
      const glob={}; glob[TREE.id]=1; ORDER.slice(1).forEach(n=>glob[n.id]=glob[n.parent.id]*loc[n.id]);
      scen.push({label:t.name+(sign>0?" +":" -")+Math.round(SHOCK*100)+"%", top:newTop, g:LEAVES.map(n=>glob[n.id])});
    }));
    scen.forEach(s=>s.r=ranks(s.g));
    s3.push(["민감도 분석 — 1계층 요소의 가중치를 ±"+Math.round(SHOCK*100)+"% 바꾸고, 나머지 1계층 요소는 원래 비율대로 조정"]);
    s3.push([]);
    s3.push(["1계층 가중치","기본"].concat(scen.map(s=>s.label)));
    top.forEach(t=>s3.push([t.name, r5(base[t.id])].concat(scen.map(s=>r5(s.top[t.id])))));
    s3.push([]);
    s3.push(["최하위 요소 순위","기본 순위"].concat(scen.map(s=>s.label)).concat(["MAD"]));
    const order=LEAVES.map((n,i)=>i).sort((a,b)=>(leafRank[a]||1e9)-(leafRank[b]||1e9));
    order.forEach(i=>{ const mad=leafRank[i]===""?"":Number((scen.reduce((a,s)=>a+Math.abs(s.r[i]-leafRank[i]),0)/scen.length).toFixed(2));
      s3.push([LEAVES[i].name, leafRank[i]].concat(scen.map(s=>s.r[i])).concat([mad])); });
    s3.push(["MAD = 시나리오별 순위와 기본 순위 차이의 절댓값 평균 (작을수록 순위가 안정적)"]);
    s3.push([]);
    s3.push(["최하위 요소 최종 가중치","기본"].concat(scen.map(s=>s.label)));
    order.forEach(i=>s3.push([LEAVES[i].name, r5(leafG[i])].concat(scen.map(s=>r5(s.g[i])))));
  } else s3.push(["1계층 비교에서 기준을 통과한 응답이 없어 민감도 분석을 할 수 없습니다."]);
  writeSheet_("민감도", s3);

  /* 4) ANP */
  const s4=[], A=R.aggANP, names=ELEMS.map(e=>e.name);
  s4.push(["ANP — 열은 영향을 받는 요소, 행은 영향을 주는 요소. 묶음별 통합 값(CR 기준 통과자 기하평균)으로 계산"]);
  s4.push(["Super Decisions에서는 받는 쪽 노드에서 주는 쪽 노드로 연결(connection)을 만들고, 받는 쪽 노드를 기준으로 비교합니다."]);
  s4.push([]);
  if(!A){ s4.push(["기준을 통과한 응답이 없는 ANP 묶음이 있어 계산할 수 없습니다. '종합중요도'의 CR 표를 확인하세요."]); }
  else {
    s4.push(["AHP와 ANP 가중치 비교","부문","AHP 최종 가중치","AHP 순위","ANP 극한 가중치","ANP 순위","AHP 부문 안 비중","ANP 부문 안 비중"]);
    const ag=ELEMS.map(e=>R.aggW.global[e.id]), ng=ELEMS.map(e=>A.global[e.id]), ar=ranks(ag), nr=ranks(ng);
    ELEMS.forEach((e,i)=>s4.push([e.name, e.parent.name, r5(ag[i]), ar[i], r5(ng[i]), nr[i], r5(R.aggW.local[e.id]), r5(A.local[e.id])]));
    PILLARS.forEach(Pp=>s4.push([Pp.name+" 부문 합계","",r5(R.aggW.global[Pp.id]),"",r5(A.global[Pp.id])]));
    s4.push(["※ ANP 극한 가중치는 다른 요소에 주는 영향을 반영합니다. 다른 요소에 유의한 영향을 주지 않는 요소는 0이 됩니다."]);
    s4.push([]);
    s4.push(["부문 가중치 (열 = 영향을 받는 부문)"].concat(PILLARS.map(Pp=>Pp.name)));
    PILLARS.forEach(Ps=>s4.push([Ps.name].concat(PILLARS.map(Pt=>r5(A.CW[Pt.id][Ps.id]||0)))));
    s4.push([]);
    s4.push(["비가중 슈퍼매트릭스"].concat(names));
    ELEMS.forEach((e,i)=>s4.push([e.name].concat(A.U[i].map(r5))));
    s4.push([]);
    s4.push(["가중 슈퍼매트릭스 (열 합 = 1)"].concat(names));
    ELEMS.forEach((e,i)=>s4.push([e.name].concat(A.W[i].map(r5))));
    s4.push([]);
    s4.push(["평가자별 ANP 극한 가중치 (평가자 본인 응답 기준, CR과 관계없이 계산)","통합결과"].concat(ids));
    ELEMS.forEach(e=>s4.push([e.name, r5(A.global[e.id])].concat(P.map(x=>x.anp?r5(x.anp.global[e.id]):""))));
  }
  writeSheet_("ANP", s4);

  SpreadsheetApp.getUi().alert("결과를 갱신했습니다 (평가자 "+P.length+"명). '종합중요도', '세부결과', '민감도', 'ANP' 시트를 확인하세요.");
}

/* 네트워크 문제로 '응답 코드'를 받은 경우 시트에 추가 */
function importCode(){
  const ui=SpreadsheetApp.getUi();
  const r=ui.prompt("응답 코드 불러오기","AHP 로 시작하는 응답 코드를 붙여 넣으세요",ui.ButtonSet.OK_CANCEL);
  if(r.getSelectedButton()!==ui.Button.OK) return;
  const t=r.getResponseText().trim();
  if(!/^AHP\d:/.test(t)){ ui.alert("코드 형식이 올바르지 않습니다."); return; }
  const p=JSON.parse(Utilities.newBlob(Utilities.base64Decode(t.slice(5))).getDataAsString("UTF-8"));
  const out=JSON.parse(doPost({postData:{contents:JSON.stringify(p)}}).getContent());
  ui.alert(out.ok ? "평가자 "+evaluatorOf_(p)+"의 응답을 추가했습니다." : "추가하지 못했습니다: "+out.error);
}
